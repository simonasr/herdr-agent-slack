/**
 * PaneAgent — Task 4 of the PaneAgent refactor.
 *
 * One PaneAgent per Herdr pane. Owns:
 *   - exactly one AgentCommunicator (read + write side of the pane),
 *   - at most one ObserveLoopController (the polling loop that emits
 *     `working` / `delta` / `final` events to the daemon).
 *
 * The public surface maps directly to Telegram intents:
 *
 *   - handleMessage  → "user sent text in a bound topic"
 *   - noteExternalTurn → "somebody typed in the pane itself"
 *   - enableFollow   → "/follow [minutes]"
 *   - disableFollow  → "/unfollow"
 *   - stop           → "/stop"
 *   - getLastOutput  → raw pane snapshot (must not consume diff state)
 *   - getLastAnswer  → "/last"  (the answer, cut out of that snapshot)
 *   - dispose        → daemon shutdown
 *
 * Single-loop invariant
 * ---------------------
 * `this.loop` holds the active controller or null. Every entry point
 * (handleMessage / enableFollow) consults it before deciding whether
 * to start a new controller or mutate the existing one. The controller
 * is auto-cleared (set back to null) on its `done` promise resolution,
 * so a fresh message after a finalised turn starts a brand-new
 * controller — exactly the behaviour we want for /last + new-message
 * sequences.
 *
 * Stop-condition wiring
 * ---------------------
 * The daemon's intent flows through the ObserveLoopController's two
 * gates (deadline + waitUntilIdle) via these calls:
 *
 *   - `handleMessage`:  start loop with deadline=null, markUserInput.
 *                       (Existing loop: markUserInput; deadline untouched.)
 *   - `enableFollow`:   start loop with deadline=now+ms, NO markUserInput.
 *                       (Existing loop: updateDeadline(deadline).)
 *   - `disableFollow`:  updateDeadline(null). waitUntilIdle is preserved
 *                       so the loop's stop formula collapses naturally:
 *                         - follow-only then /unfollow: deadline=null +
 *                           waitUntilIdle=false → stop immediately.
 *                         - message then /unfollow:    deadline=null +
 *                           waitUntilIdle=true  → stop on idle.
 *
 * Telegram-agnostic
 * -----------------
 * PaneAgent never imports Telegram types or the grammy client. All
 * output flows through `emit(OutputEvent)`; the daemon receives these
 * and decides how to format / send them. This keeps the unit-testable
 * surface free of network dependencies.
 */
import type { AgentCommunicator } from "./agent-sessions.js";
import type { Config } from "./config.js";
import {
  ObserveLoopController,
  type ObserveLoopControllerDeps,
  type OutputEvent,
} from "./turn/observe-loop-controller.js";

/**
 * Optional construction-time dependencies. All three are injectable
 * for tests; production code lets them default. None are required.
 *
 *   - sleep:           wall-clock-paced sleep for the loop's poll cadence.
 *                      Defaults to a setTimeout-based promise.
 *   - now:             monotonic-ish epoch-ms clock.
 *                      Defaults to Date.now.
 *   - createController: factory for ObserveLoopController instances.
 *                      Tests inject a counting factory to assert the
 *                      single-loop invariant. Defaults to `new`.
 */
export interface PaneAgentDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  createController?: (
    deps: ObserveLoopControllerDeps,
  ) => ObserveLoopController;
}

export interface PaneAgentOptions {
  /** Pane id this agent coordinates. Stored for diagnostics / logs. */
  paneId: string;
  /** Read+write side of the pane (selected-once reader + sendInput). */
  communicator: AgentCommunicator;
  /** Sink for OutputEvents. The agent never formats for Telegram. */
  emit: (event: OutputEvent) => void;
  /** Loop cadence + stability window come from cfg. */
  config: Config;
  /**
   * Whether herdr reports this pane's agent as working. Wired by the daemon;
   * without it a turn ends on screen stability alone.
   */
  isAgentBusy?: () => boolean;
  /** Optional. Production leaves this unset. */
  deps?: PaneAgentDeps;
}

/**
 * Per-pane coordinator. Construct one per pane the daemon tracks.
 *
 * Lifecycle:
 *
 *   const agent = new PaneAgent({ paneId, communicator, emit, config });
 *   agent.handleMessage("hello");
 *   agent.enableFollow(Date.now() + 30 * 60_000);
 *   agent.disableFollow();
 *   agent.getLastOutput();
 *   agent.stop();
 *   agent.dispose();          // permanent shutdown
 */
export class PaneAgent {
  private loop: ObserveLoopController | null = null;
  /**
   * Whether the turn under way was started in the pane rather than the chat.
   * Cleared by `handleMessage`, because a chat message makes the turn the
   * user's whatever started it, and by every final event.
   */
  private externalTurn = false;
  /** Text of the last final event forwarded, so a repeat can be recognised. */
  private lastDelivered = "";
  /**
   * Consecutive finals that re-produced `lastDelivered`. Reset by any final
   * that says something new.
   */
  private repeatedFinals = 0;
  /**
   * How many times a turn may re-produce the last answer before the repeat is
   * believed. Each attempt costs one stability window, so this is a couple of
   * minutes of patience, not an open-ended wait.
   */
  private static readonly MAX_REPEAT_CONTINUATIONS = 3;

  constructor(private readonly opts: PaneAgentOptions) {
    // opts.paneId is currently passed for diagnostics / log enrichment.
    // PaneAgent only needs it implicitly via the communicator, but
    // keeping it on the constructor surface matches the spec and gives
    // future log lines a stable identity.
    void this.opts.paneId;
  }

  /**
   * True when an observe loop is currently running. Public so the
   * daemon (and tests) can inspect liveness without polling internals.
   */
  isLoopActive(): boolean {
    return this.loop !== null;
  }

  /**
   * Whether a follow is active (the loop has a deadline armed).
   */
  isFollowing(): boolean {
    return this.loop !== null && this.loop.hasDeadline();
  }

  /**
   * A user message arrived. Always forwards the input to the pane.
   * If no loop is active, starts one with deadline=null and
   * waitUntilIdle=true (idle-based stop). If a loop is already active
   * (turn in flight, follow in flight, …), just marks waitUntilIdle on
   * it — the deadline gate (if any) is preserved untouched so a
   * follow timer keeps ticking through user messages.
   */
  handleMessage(text: string): void {
    this.opts.communicator.sendInput(text);
    // Whatever started this turn, it is the user's now: their answer must be
    // delivered even if it repeats what the pane said a moment ago.
    this.externalTurn = false;
    if (this.loop) {
      this.loop.markUserInput();
      return;
    }
    this.startLoop({ deadline: null, waitUntilIdle: true });
  }

  /**
   * A turn started in the pane itself — somebody typed in the terminal rather
   * than in the chat. Attaches an observe loop so the answer is delivered too,
   * without sending any input: the prompt has already been submitted.
   *
   * The gates are the ones `handleMessage` uses (deadline=null,
   * waitUntilIdle=true), so the turn ends when the agent settles.
   *
   * No-op while a loop is active. That is what keeps a bridge-started turn
   * from being adopted a second time when herdr reports the pane busy a
   * moment later.
   *
   * Returns whether a loop was actually started, so a caller can tell an
   * adopted turn from one that was already being followed.
   */
  noteExternalTurn(): boolean {
    if (this.loop) return false;
    this.opts.communicator.beginExternalTurn();
    this.externalTurn = true;
    this.startLoop({ deadline: null, waitUntilIdle: true });
    return true;
  }

  /**
   * The question just submitted in this pane, before any answer exists. Read
   * once, when a terminal turn is adopted, so the chat can show what was asked
   * without waiting for the turn to finish.
   */
  getPendingPrompt(): string {
    return this.opts.communicator.getPendingPrompt();
  }

  /**
   * The most recent answer this pane shows, for `/last`. Read-only: it does
   * not consume diff state, so a turn in flight still reports the same
   * content as unseen.
   */
  getLastAnswer(): string {
    return this.opts.communicator.getLastAnswer();
  }

  /**
   * Whether this pane's output is the model's own text. A consumer skips the
   * pane filters for it: there is no chrome to remove, only Markdown to lose.
   */
  get verbatim(): boolean {
    return this.opts.communicator.verbatim;
  }

  /** Prompts the bridge typed into this pane: what finds its Claude session when herdr names none. */
  sentPrompts(): string[] {
    return this.opts.communicator.sentPrompts();
  }

  /** Whether `getLastAnswer` is one answer, not the whole log. See the communicator. */
  canIsolateLastAnswer(): boolean {
    return this.opts.communicator.canIsolateLastAnswer();
  }

  /**
   * Pass an event to the daemon, flagging a final that repeats the answer
   * already delivered for this pane.
   *
   * A turn can begin without the terminal echoing a `❯` prompt — a resumed
   * session, a hook, an agent continuing on its own. The screen anchor then
   * lands on the PREVIOUS question and the extraction returns an answer the
   * user has already read. Only an externally-started turn is checked: asking
   * the same question twice from the chat must answer twice.
   *
   * The event is flagged rather than dropped, because the consumer still has
   * end-of-turn work to do — Telegram's typing indicator runs until a final
   * arrives, and swallowing it here would leave the dots spinning forever.
   *
   * Also the place where a turn that outran `maxTurnMs` is continued rather
   * than reported. See the `"ceiling"` branch.
   */
  private forward(event: OutputEvent): void {
    if (event.type !== "final") {
      this.opts.emit(event);
      return;
    }
    const external = this.externalTurn;
    this.externalTurn = false;
    // `maxTurnMs` expiring is this loop's own guarantee of termination, not
    // the agent finishing. When herdr still reports the pane working, the turn
    // is simply longer than the ceiling: reporting a half-written answer would
    // be wrong, and stopping here would abandon the pane until its NEXT turn —
    // whatever it is working on now would never reach the chat at all.
    //
    // A follow deadline armed on the capped turn is not carried over. A
    // `/follow` window that outlives the ceiling is not worth the bookkeeping,
    // and continuing on the idle gate is the right default for a turn that is
    // demonstrably still running.
    if (event.reason === "ceiling" && this.opts.isAgentBusy?.()) {
      this.externalTurn = external;
      this.startLoop({ deadline: null, waitUntilIdle: true });
      return;
    }
    const body = event.text.trim();
    // Two ways to recognise the answer already sent. By its bytes, which is
    // all a structured reader offers; and by the line that closed its turn,
    // which the communicator remembers for a screen. The bytes alone missed
    // it: the bridge-typed and adopted paths extract one turn differently,
    // and the same answer went out twice under "Asked in the terminal".
    const repeat = external && body.length > 0
      && (event.text === this.lastDelivered || this.opts.communicator.turnAlreadyDelivered());
    if (repeat) {
      // The same answer twice is usually evidence the turn is NOT over: the
      // loop settled before the agent had written anything of its own, so the
      // screen anchor fell back to the previous turn's window. Suppressing
      // that and stopping is how a real question got no reply at all — the
      // answer landed on the pane a minute later and nothing was watching.
      //
      // So keep watching, up to a point. A turn that genuinely repeats itself
      // — a hook, a resumed session — would otherwise be followed forever.
      if (this.repeatedFinals < PaneAgent.MAX_REPEAT_CONTINUATIONS) {
        this.repeatedFinals += 1;
        this.externalTurn = external;
        this.startLoop({ deadline: null, waitUntilIdle: true });
        return;
      }
      this.repeatedFinals = 0;
      this.opts.emit({ ...event, duplicate: true });
      return;
    }
    this.repeatedFinals = 0;
    if (body.length > 0) this.lastDelivered = event.text;
    // A turn started in the pane was asked somewhere the chat never saw. Carry
    // the question with the answer, or the thread reads as a monologue.
    const prompt = external && body.length > 0 ? this.opts.communicator.getTurnPrompt().trim() : "";
    // This turn is going out. Say so before it does, so a read that lands
    // while the send is in flight already knows the turn is spoken for.
    this.opts.communicator.markDelivered(prompt);
    this.opts.emit(prompt ? { ...event, prompt } : event);
  }

  /**
   * Enable follow mode. When no loop is active, starts one with
   * `deadline` and waitUntilIdle=false (timer-only stop — the pane
   * does not have to settle for the loop to end). When a loop is
   * already active, just updates the deadline. The waitUntilIdle
   * flag is left as-is so a /follow that arrives mid-message still
   * honours the "wait for idle" gate on the message turn.
   */
  enableFollow(deadline: number): void {
    if (this.loop) {
      this.loop.updateDeadline(deadline);
      return;
    }
    this.startLoop({ deadline, waitUntilIdle: false });
  }

  /**
   * Disable follow mode. Clears the deadline gate. The loop is kept
   * alive (a final iteration is still needed to emit the final event
   * with the right reason). waitUntilIdle is preserved, so:
   *   - follow-only then /unfollow → waitUntilIdle=false, deadline=null
   *     → stop on the next iteration.
   *   - message then /unfollow     → waitUntilIdle=true,  deadline=null
   *     → stop on the next idle window.
   * No-op when no loop is active.
   */
  disableFollow(): void {
    if (!this.loop) return;
    this.loop.updateDeadline(null);
  }

  /**
   * Abort the active loop. The controller will emit a final event with
   * reason="aborted" and resolve its done promise. We clear this.loop
   * synchronously so a subsequent handleMessage / enableFollow starts
   * a fresh controller without waiting for the abort to land.
   * No-op when no loop is active.
   */
  stop(): void {
    if (!this.loop) return;
    const loop = this.loop;
    this.loop = null;
    loop.abort();
    // The done.then auto-clear hook below is now a no-op (this.loop
    // already points elsewhere), but we let it run for symmetry with
    // the dispose path.
    void loop.done;
  }

  /**
   * Read-only peek for `/last`. Returns whatever the underlying reader
   * reports RIGHT NOW without mutating diff state — a subsequent
   * observe-loop tick still sees what was visible to /last as
   * "unseen" if it changed since. Forwarded to the communicator's
   * `getLatestOutput()` so the AgentCommunicator owns the policy.
   */
  getLastOutput(): string {
    return this.opts.communicator.getLatestOutput();
  }

  /**
   * Permanently shut this PaneAgent down. Aborts the active loop (if
   * any) and clears internal state. After dispose, the agent must
   * not be reused — the daemon's typical pattern is one agent per
   * pane and dispose() only at daemon shutdown.
   */
  dispose(): void {
    if (!this.loop) return;
    const loop = this.loop;
    this.loop = null;
    loop.abort();
    void loop.done;
  }

  /**
   * Internal: construct + start a new ObserveLoopController with the
   * configured gates, register an auto-clear hook on its done promise,
   * and install it as the active loop.
   *
   * The auto-clear hook only clears `this.loop` if it still points to
   * this controller — a stop()/dispose() that already nulled it leaves
   * the hook as a harmless no-op.
   */
  private startLoop(opts: {
    deadline: number | null;
    waitUntilIdle: boolean;
  }): void {
    const factory =
      this.opts.deps?.createController ??
      ((d: ObserveLoopControllerDeps) => new ObserveLoopController(d));
    const sleep =
      this.opts.deps?.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = this.opts.deps?.now ?? Date.now;

    const controller = factory({
      communicator: this.opts.communicator,
      emit: (event) => this.forward(event),
      sleep,
      now,
      progressIntervalMs: this.opts.config.progressIntervalMs,
      stabilityMs: this.opts.config.stabilityWindowMs,
      // In "final" mode the daemon drops every delta, so the final event is
      // the turn's only delivery and has to carry all of it.
      finalPayload: this.opts.config.outputMode === "final" ? "full-turn" : "last-delta",
      isAgentBusy: this.opts.isAgentBusy,
      maxTurnMs: this.opts.config.maxTotalWaitS * 1000,
    });
    controller.updateDeadline(opts.deadline);
    if (opts.waitUntilIdle) controller.markUserInput();
    controller.start();
    // Auto-clear when the loop finalises. Use the captured reference so
    // a stale callback can't clobber a fresh loop started after stop().
    controller.done.then(() => {
      if (this.loop === controller) {
        this.loop = null;
      }
    });
    this.loop = controller;
  }
}