/**
 * ObserveLoopController — Task 3 of the PaneAgent refactor.
 *
 * Replaces the ad-hoc observe-loop function with a stateful controller
 * that:
 *
 *   - owns ONE observe loop per pane (at most one active),
 *   - reads unseen output via AgentCommunicator.getNewOutput() (NOT its
 *     own diff state — the communicator owns `sentTail`),
 *   - chunks unseen content into delta events via chunkForTelegram,
 *   - emits bare `working` ticks when the pane is unchanged, on the
 *     cadence supplied by `progressIntervalMs`,
 *   - evaluates the stop condition via `shouldStop(state)` from
 *     ./stop-condition.ts,
 *   - emits a single `final` event on stop, whose payload depends on
 *     `finalPayload`: "last-delta" (default) prefers the most recent
 *     emitted delta, "full-turn" carries everything observed during the
 *     turn. Either way it falls back to communicator.getLatestOutput()
 *     (truncated to MAX_CHUNK_TOTAL) when nothing was observed.
 *
 * The controller is TELEGRAM-AGNOSTIC: it never speaks to Telegram. The
 * daemon receives OutputEvents and decides how to format / send them.
 *
 * Event types:
 *
 *   { type: "working"; text: string }
 *     — bare heartbeat; emitted only on iterations where no unseen
 *       content was observed. NEVER co-emitted with a delta event in
 *       the same iteration (chunks carry their own working-suffix when
 *       formatWorkingSuffix returns non-empty).
 *
 *   { type: "delta"; text: string }
 *     — one chunk of unseen content, possibly including a working
 *       suffix injected by formatDelta. Multiple deltas may fire in
 *       one iteration when chunkForTelegram splits unseen > MAX_CHUNK_TOTAL.
 *
 *   { type: "final"; text; reason: "idle"|"deadline"|"ceiling"|"aborted"; source }
 *     — terminal event. The loop never emits more events after this.
 *       `source` says whether the payload is accumulated delta output or a
 *       whole-pane snapshot readback.
 *
 * Lifecycle:
 *
 *   const c = new ObserveLoopController(deps);
 *   c.updateDeadline(nowMs);     // optional — set before/after start
 *   c.markUserInput();           // optional — enables waitUntilIdle gate
 *   const done = c.start();      // kick off the polling loop
 *   c.abort("aborted");          // request graceful stop; final fires
 *   await done;                  // (or await c.done)
 */
import type { AgentCommunicator } from "../agent-sessions.js";
import {
  chunkForTelegram,
  MAX_CHUNK_TOTAL,
} from "../output-diff.js";
import { shouldStop, type StopState } from "./stop-condition.js";

/**
 * Discriminated union of every event the controller emits.
 * The daemon maps these to Telegram actions.
 */
export type OutputEvent =
  | { type: "working"; text: string }
  | { type: "delta"; text: string }
  | {
      type: "final";
      text: string;
      /**
       * Why the turn ended.
       *
       *   - "idle"     — the agent settled. The ordinary end of a turn.
       *   - "deadline" — a `/follow` window expired.
       *   - "ceiling"  — `maxTurnMs` expired. This one says nothing about the
       *                  agent: it is the loop's own guarantee of termination,
       *                  and the pane may well still be working. A consumer
       *                  that can check must not report it as an answer.
       *   - "aborted"  — `/stop`.
       */
      reason: "idle" | "deadline" | "ceiling" | "aborted";
      /**
       * Which output filter the payload still needs.
       *
       * "snapshot" is a raw whole-pane readback, taken when nothing was
       * observed during the turn, and still carries terminal chrome.
       * "delta" is turn output — accumulated diffs, or a prompt-anchored
       * read that already had the snapshot heuristics applied — so it wants
       * the gentler incremental filter rather than a second snapshot pass.
       */
      source: "delta" | "snapshot";
      /**
       * The payload repeats the answer already delivered for this pane.
       *
       * Set by PaneAgent, never by the controller. A consumer must still run
       * its end-of-turn cleanup — stopping a typing indicator, say — but must
       * not post the text. See `PaneAgent.forward`.
       */
      duplicate?: boolean;
      /**
       * The question this turn answered, when it was asked somewhere the chat
       * cannot see — typed into the pane itself. Set by PaneAgent. A consumer
       * quotes it so the thread does not read as answers with no questions.
       */
      prompt?: string;
    };

/**
 * Construction-time dependencies. All are required except the three
 * formatter callbacks, which have sensible defaults.
 */
export interface ObserveLoopControllerDeps {
  /** Source of unseen / latest output. Must already be constructed
   *  (use createAgentCommunicator in production code, AgentCommunicator
   *  directly in tests). */
  communicator: AgentCommunicator;
  /** Sink for OutputEvents. The controller never formats for Telegram
   *  — formatting is the daemon's job. */
  emit: (event: OutputEvent) => void;
  /** Wall-clock-paced sleep. Production: real `setTimeout`. Tests: a
   *  queued-resolve fake so the loop is deterministic. */
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in epoch ms. Tests pass a fake. */
  now: () => number;
  /** Cadence at which the controller polls the communicator and emits
   *  bare working ticks when there is no unseen content. */
  progressIntervalMs: number;
  /** Required ms of pane stability before isIdle() returns true. */
  stabilityMs: number;
  /**
   * Optional. Build the trailing working-suffix embedded in each
   * chunked delta via chunkForTelegram. Default: "" — chunks carry no
   * suffix and the consumer is responsible for any visual indicator.
   */
  formatWorkingSuffix?: (elapsedMs: number) => string;
  /**
   * Optional. Transform a chunked delta before emission. Receives the
   * chunk text (already split by chunkForTelegram with the
   * formatWorkingSuffix suffix appended) and the elapsed ms. Default:
   * identity. Use to inject Telegram markup, pane-id prefixes, etc.
   */
  formatDelta?: (chunk: string, elapsedMs: number) => string;
  /**
   * Optional. Build the bare working tick text. Default:
   * `"⏳ Working (Xs)."` using `Math.floor(elapsedMs / 1000)`.
   */
  formatWorkingTick?: (elapsedMs: number) => string;
  /**
   * Optional. What the single `final` event carries.
   *
   *   - "last-delta" (default): the most recent chunk emitted as a delta —
   *     a short recap of content the user has already seen streamed.
   *   - "full-turn": everything observed since the turn started. Used when
   *     the consumer suppresses deltas and delivers the answer only once,
   *     so the final event is the ONLY delivery of the turn.
   */
  finalPayload?: "last-delta" | "full-turn";
  /**
   * A submitted turn or ceiling continuation shares a previously captured diff
   * baseline. Carry any undelivered full-turn output and retain the first read
   * as new instead of treating it as historical seed. Empty string retains
   * the first read without carrying old output.
   */
  initialOutput?: string;
  /**
   * Optional. Whether the agent is still working, per herdr. When it returns
   * true the idle gate cannot close, so a long quiet turn is not cut short.
   * Defaults to "no opinion" — the stability window decides alone.
   */
  isAgentBusy?: () => boolean;
  /** One metadata observation shared by busy and completion checks for this poll. */
  observe?: () => { agentBusy: boolean; completedOutput: string | null } |
    Promise<{ agentBusy: boolean; completedOutput: string | null }>;
  /**
   * Optional hard ceiling on one turn, in ms. Guarantees termination even if
   * `isAgentBusy` never goes false (a wedged agent, or a stale herdr status).
   * Defaults to no ceiling.
   */
  maxTurnMs?: number;
}

/** Suffix prepended when the snapshot is truncated for the final payload. */
const ELLIPSIS_PREFIX = "…\n";

/**
 * One ObserveLoopController owns ONE polling loop. start() is idempotent;
 * a second call returns the same promise. updateDeadline / markUserInput
 * / abort can be called before OR after start() — they mutate the same
 * fields the loop reads on each iteration.
 */
export class ObserveLoopController {
  private readonly communicator: AgentCommunicator;
  private readonly emit: (event: OutputEvent) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly progressIntervalMs: number;
  private readonly stabilityMs: number;
  private readonly formatWorkingSuffix: (elapsedMs: number) => string;
  private readonly formatDelta: (chunk: string, elapsedMs: number) => string;
  private readonly formatWorkingTick: (elapsedMs: number) => string;
  private readonly finalPayload: "last-delta" | "full-turn";
  private readonly initialOutput: string | undefined;
  private readonly isAgentBusy: () => boolean;
  private readonly observe: NonNullable<ObserveLoopControllerDeps["observe"]>;
  private readonly maxTurnMs: number | null;
  private ceilingOutput: { lastDeltaText: string; turnText: string } | null = null;

  /**
   * Stop-condition gates. `deadline=null` means "always reached" (used
   * for message-only turns whose real bound is the agent settling).
   * `waitUntilIdle=false` means the idle check is ignored (used for
   * follow-only turns whose real bound is the timer).
   *
   * Defaults: `null` + `false`. PaneAgent is expected to call
   * updateDeadline / markUserInput to install the right gate before
   * start() — running with the defaults would finalise on the first
   * poll, which is never what callers want.
   */
  private deadline: number | null = null;
  private waitUntilIdle: boolean = false;
  private inputRevision = 0;

  /**
   * Abort latch. When non-null, the loop short-circuits to the final
   * event with reason="aborted". Stored as an object so the type
   * matches the spec; the actual reason is always "aborted" today.
   */
  private aborted: { reason: "aborted" } | null = null;

  /** Cached run promise so start() is idempotent. */
  private started: Promise<void> | null = null;
  /** Resolver for the public `done` promise. */
  private resolveDone!: () => void;

  /** Resolves when the polling loop exits (after the final event). */
  readonly done: Promise<void>;

  constructor(deps: ObserveLoopControllerDeps) {
    this.communicator = deps.communicator;
    this.emit = deps.emit;
    this.sleep = deps.sleep;
    this.now = deps.now;
    this.progressIntervalMs = deps.progressIntervalMs;
    this.stabilityMs = deps.stabilityMs;
    this.formatWorkingSuffix = deps.formatWorkingSuffix ?? (() => "");
    this.formatDelta = deps.formatDelta ?? ((chunk) => chunk);
    this.formatWorkingTick =
      deps.formatWorkingTick ??
      ((elapsedMs) => `⏳ Working (${Math.floor(elapsedMs / 1000)}s).`);
    this.finalPayload = deps.finalPayload ?? "last-delta";
    this.initialOutput = deps.initialOutput;
    this.isAgentBusy = deps.isAgentBusy ?? (() => false);
    this.observe = deps.observe ?? (() => ({ agentBusy: this.isAgentBusy(), completedOutput: null }));
    this.maxTurnMs = deps.maxTurnMs ?? null;
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  /**
   * Start the polling loop. Idempotent: a second call returns the same
   * promise. The promise resolves once the loop has emitted its final
   * event (idle / deadline / aborted).
   *
   * The very first action inside the loop is a single
   * `communicator.getNewOutput()` call. Fresh follow/adoption loops discard
   * that seed to avoid history replay; submitted turns and continuations retain
   * it against their captured baseline, including replies arriving during send.
   */
  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = this.run();
    return this.started;
  }

  /**
   * Update the deadline gate. `null` means "always reached" so the
   * formula collapses to a pure idle check. Safe to call before or
   * after start(); the new value is picked up on the next iteration.
   */
  updateDeadline(deadline: number | null): void {
    this.deadline = deadline;
  }

  /**
   * Whether the deadline gate is currently armed.
   */
  hasDeadline(): boolean {
    return this.deadline !== null;
  }

  /**
   * A user message arrived during this turn. Enables the idle gate and
   * invalidates observations/stability from before this dispatch, even when
   * the idle gate was already enabled or a follow deadline is armed.
   */
  markUserInput(): void {
    this.inputRevision++;
    this.waitUntilIdle = true;
  }

  /**
   * Request a graceful stop. The current sleep is awaited so we don't
   * abandon a half-finalised iteration; the loop then short-circuits
   * to the final event with reason="aborted". The reason parameter
   * exists for forward compatibility but the only legal value today
   * is "aborted".
   */
  abort(reason: "aborted" = "aborted"): void {
    this.aborted = { reason };
  }

  /**
   * Core loop. See the file header for the per-iteration semantics.
   * The `try/finally` guarantees the public `done` promise resolves
   * even if the run throws (the error is re-thrown after resolving).
   */
  private async run(): Promise<void> {
    try {
      // Fresh follow/adoption loops ignore their seed so history is not replayed.
      // Submitted turns and continuations inherit a baseline: output since it
      // is new, even if it appeared while the busy/idle decision was pending.
      const seeded = this.communicator.getNewOutput();
      let resumed = this.initialOutput === undefined ? "" : seeded;

      const startedAt = this.now();
      // lastChangeAt anchors the stability window. It is bumped every
      // time we observe unseen content; left untouched while the pane
      // is stable so the stability window can elapse.
      let lastChangeAt = startedAt;
      let inputRevision = this.inputRevision;
      // lastDeltaText remembers the most recent non-empty chunk we
      // emitted as a delta. The final payload falls back to this when
      // the pane goes idle — it's the most recent content the user has
      // already seen on Telegram and acts as a durable recap.
      let lastDeltaText = this.initialOutput ?? "";
      // turnText accumulates every byte of unseen output observed during
      // this turn, before chunking. It is the `finalPayload: "full-turn"`
      // payload — the complete answer for consumers that suppress deltas.
      let turnText = this.initialOutput ?? "";

      while (true) {
        await this.sleep(this.progressIntervalMs);

        // Honour an abort that arrived during the sleep.
        if (this.aborted) {
          // Preserve already-consumed output without reading or streaming again.
          if (resumed) {
            turnText += turnText ? `\n${resumed}` : resumed;
            lastDeltaText = resumed;
          }
          this.emitFinal("aborted", lastDeltaText, turnText);
          return;
        }

        const now = this.now();
        if (inputRevision !== this.inputRevision) {
          inputRevision = this.inputRevision;
          lastChangeAt = now;
        }
        const elapsedMs = now - startedAt;
        const fresh = this.communicator.getNewOutput();
        const unseen = resumed && fresh ? `${resumed}\n${fresh}` : resumed || fresh;
        resumed = "";

        if (unseen.length > 0) {
          turnText += turnText ? `\n${unseen}` : unseen;
          // Chunk via chunkForTelegram. The suffix comes from
          // formatWorkingSuffix (empty by default). Each chunk is
          // formatted independently and emitted as its own delta event.
          // We do NOT also emit a bare working tick this iteration —
          // the chunks carry the cadence.
          const suffix = this.formatWorkingSuffix(elapsedMs);
          const chunks = chunkForTelegram(unseen, suffix);
          for (const chunk of chunks) {
            const text = this.formatDelta(chunk, elapsedMs);
            this.emit({ type: "delta", text });
            // Remember the raw chunk (without formatDelta wrapping) as
            // the fallback Final payload — this matches the original
            // observe-loop behaviour where the user has already seen
            // the post-formatDelta text on Telegram, so it is the most
            // semantically stable fallback.
            lastDeltaText = chunk;
          }
          lastChangeAt = now;
        } else {
          // No new content this iteration — emit exactly one bare
          // working tick. The progress interval drives the cadence.
          this.emit({
            type: "working",
            text: this.formatWorkingTick(elapsedMs),
          });
        }

        // Stop-condition check. We evaluate AFTER emission so the
        // caller sees one last "you're done" tick worth of output
        // before the final.
        // The ceiling wins over every other gate, because it is what
        // guarantees this loop terminates at all: with herdr reporting the
        // pane busy, the idle gate can stay shut indefinitely. It is reported
        // under its own reason so a consumer can tell it apart from a turn
        // that actually ended.
        if (this.maxTurnMs !== null && elapsedMs >= this.maxTurnMs) {
          this.emitFinal("ceiling", lastDeltaText, turnText);
          return;
        }
        // No proof survives a poll: a follow deadline can be added or a
        // session can be replaced while the same controller is running.
        const { agentBusy, completedOutput: completed } = await this.observe();
        if (this.aborted) {
          this.emitFinal("aborted", lastDeltaText, turnText);
          return;
        }
        const checkedAt = this.now();
        if (this.maxTurnMs !== null && checkedAt - startedAt >= this.maxTurnMs) {
          this.emitFinal("ceiling", lastDeltaText, turnText);
          return;
        }
        // Input dispatched during the query invalidates ordinary settling as
        // well as completion proof. Abort and ceiling still take priority.
        if (inputRevision !== this.inputRevision) {
          inputRevision = this.inputRevision;
          lastChangeAt = checkedAt;
          continue;
        }
        const state: StopState = {
          // Query latency is not evidence that newly observed output settled.
          now,
          lastChangeAt,
          stabilityMs: this.stabilityMs,
          deadline: this.deadline,
          waitUntilIdle: this.waitUntilIdle,
          agentBusy,
          completionConfirmed: completed !== null && completed.trim().length > 0,
        };
        if (shouldStop(state)) {
          // A stable fallback can grow while metadata is pending. Drain it
          // before settling, then use the normal next tick to emit the suffix
          // and restart stability. Proven completions and timer-only follows
          // retain their existing stop rules.
          if (this.waitUntilIdle && !state.completionConfirmed) {
            resumed = this.communicator.getNewOutput();
            // An unresolved source is not stable empty output. Keep polling
            // until it resolves or its bounded screen fallback takes over.
            if (resumed || !this.communicator.outputReady) continue;
          }
          // Distinguish "idle" vs "deadline" in the final reason. The
          // single rule: if waitUntilIdle is true, the idle gate was
          // required, so the reason is "idle". Otherwise the timer
          // forced the stop and the reason is "deadline". This is
          // consistent across message-only, follow-only, follow+message
          // and unfollow scenarios.
          const reason: "idle" | "deadline" = this.waitUntilIdle
            ? "idle"
            : "deadline";
          this.emitFinal(reason, lastDeltaText, turnText, completed ?? undefined);
          return;
        }
      }
    } finally {
      // Resolve the public done promise regardless of how the loop
      // exited (clean stop, abort, or thrown error). The awaiter on
      // `done` is therefore guaranteed to settle.
      this.resolveDone();
    }
  }

  /**
   * Choose what a `full-turn` final carries.
   *
   * A prompt-anchored read of the final snapshot wins wherever the reader can
   * produce one: for a screen-scrape source it is the ONLY reliable answer,
   * because its per-poll diffs are terminal redraws and accumulating them
   * replays the scrollback. When no anchor is available the choice turns on
   * why: a structured reader offers none but diffs reliably, so its
   * accumulated turn IS the answer; a scrape reader that could not find its
   * prompt has unreliable diffs, so fall back to the last chunk rather than
   * dumping the whole screen history.
   */
  private turnPayload(turnText: string, lastDeltaText: string): string {
    const anchored = this.communicator.getTurnResponse();
    if (anchored.trim().length > 0) return anchored;
    return this.communicator.readerKind === "scrape" ? lastDeltaText : turnText;
  }

  /**
   * Rebuild an owned ceiling final after asynchronous busy/idle revalidation.
   * Queued input must not change the prompt or diff baseline until this read.
   */
  refreshCeilingFinal(event: Extract<OutputEvent, { type: "final" }>): Extract<OutputEvent, { type: "final" }> {
    const output = this.ceilingOutput;
    if (event.reason !== "ceiling" || !output) return event;
    this.ceilingOutput = null;
    const unseen = this.communicator.getNewOutput();
    if (unseen) {
      output.turnText += output.turnText ? `\n${unseen}` : unseen;
      // This suffix was never streamed, so the refreshed final must carry it.
      output.lastDeltaText = unseen;
    }
    return this.buildFinal("ceiling", output.lastDeltaText, output.turnText);
  }

  /**
   * Build and emit the single terminal event.
   *
   * Payload rule:
   *   1. Prefer the observed turn output if non-blank — `turnText` under
   *      `finalPayload: "full-turn"` (the whole answer, because the
   *      consumer suppressed the deltas), `lastDeltaText` otherwise (a
   *      durable recap of content already streamed). Neither is truncated:
   *      the consumer owns splitting for its transport.
   *   2. Otherwise read back the screen or an isolated structured answer,
   *      never cumulative history. This does NOT mutate diff state.
   *   3. Truncate the fallback to MAX_CHUNK_TOTAL with an ellipsis
   *      prefix so Telegram never sees an over-long message.
   *
   * The function does not return; the caller is expected to follow
   * the emit with `return` from run().
   */
  private emitFinal(
    reason: "idle" | "deadline" | "ceiling" | "aborted",
    lastDeltaText: string,
    turnText: string,
    confirmed?: string,
  ): void {
    if (reason === "ceiling") this.ceilingOutput = { lastDeltaText, turnText };
    this.emit(this.buildFinal(reason, lastDeltaText, turnText, confirmed));
  }

  private buildFinal(
    reason: "idle" | "deadline" | "ceiling" | "aborted",
    lastDeltaText: string,
    turnText: string,
    confirmed?: string,
  ): Extract<OutputEvent, { type: "final" }> {
    const observed = confirmed ?? (this.finalPayload === "full-turn"
      ? this.turnPayload(turnText, lastDeltaText)
      : lastDeltaText);
    let text: string;
    let source: "delta" | "snapshot" = "delta";
    if (observed.trim().length > 0) {
      text = observed;
    } else {
      source = "snapshot";
      // Some structured readers expose only cumulative assistant history,
      // even through getLastAnswer(). Never replay that history as a reply
      // when this turn produced no output. Screens retain their readback.
      const latest = this.communicator.readerKind === "scrape"
        ? this.communicator.getLatestOutput()
        : this.communicator.outputReady && this.communicator.canIsolateLastAnswer() ? this.communicator.getLastAnswer() : "";
      if (latest.trim().length === 0) {
        text = "";
      } else if (this.finalPayload === "full-turn") {
        // Hand the snapshot over whole. A "full-turn" consumer splits the
        // payload across as many messages as it needs and applies its own
        // ceiling; truncating here to one message — the shape the streaming
        // consumer expects — is what put a bare "…" at the top of an answer
        // and threw away everything above it.
        text = latest;
      } else {
        text =
          latest.length > MAX_CHUNK_TOTAL
            ? ELLIPSIS_PREFIX +
              latest.slice(-(MAX_CHUNK_TOTAL - ELLIPSIS_PREFIX.length))
            : latest;
      }
    }
    return { type: "final", text, reason, source };
  }
}