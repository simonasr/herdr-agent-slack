/**
 * Tests for PaneAgent — Task 4 of the PaneAgent refactor.
 *
 * PaneAgent is the per-pane coordinator that owns exactly one
 * AgentCommunicator and at most one ObserveLoopController. The
 * public surface maps directly to Telegram intents:
 *
 *   - handleMessage  → "user sent text in a bound topic"
 *   - enableFollow   → "/follow [minutes]"
 *   - disableFollow  → "/unfollow"
 *   - stop           → "/stop"
 *   - getLastOutput  → "/last"  (must not consume diff state)
 *   - dispose        → daemon shutdown
 *
 * Behavioural invariants covered here:
 *
 *   1. Single observe loop per pane.
 *      - First message: start a loop.
 *      - Subsequent messages during the same turn: reuse the loop.
 *      - enableFollow during the same turn: reuse the loop.
 *      - enableFollow when no loop is active: start one with the deadline.
 *   2. handleMessage marks waitUntilIdle without touching the deadline.
 *      - During a follow-only turn (deadline set, waitUntilIdle=false),
 *        a fresh message switches to deadline+idle mode without resetting
 *        the timer.
 *   3. disableFollow clears the deadline but keeps the loop.
 *      - After a message, disableFollow: loop still alive; waitUntilIdle
 *        was already true so the stop formula becomes idle-based.
 *      - After a follow-only turn, disableFollow: deadline becomes null;
 *        waitUntilIdle was false, so the formula collapses to "stop
 *        immediately" (i.e. waitUntilIdle false + deadline null → stop).
 *   4. stop() and dispose() both abort the active loop and clear it.
 *   5. getLastOutput returns the latest snapshot without mutating diff
 *      state — a subsequent handleMessage still surfaces what was
 *      visible to /last.
 *
 * Test infrastructure: we use a real AgentCommunicator wrapping a fake
 * reader so we exercise the same getNewOutput/getLatestOutput code path
 * as production. We spy on `communicator.sendInput` so we can assert
 * the input was forwarded. We pass a `createController` factory in deps
 * that pushes every constructed controller into a list — tests can both
 * count constructions (the single-loop invariant) and await a specific
 * controller's `done` promise.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AgentCommunicator,
  type AgentOutputReader,
} from "../src/agent-sessions.js";
import {
  ObserveLoopController,
  type ObserveLoopControllerDeps,
  type OutputEvent,
} from "../src/turn/observe-loop-controller.js";
import { PaneAgent } from "../src/pane-agent.js";
import type { Config } from "../src/config.js";
import type { AgentInfo } from "../src/herdr-client.js";

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Mock the herdr-client sendText so `AgentCommunicator.sendInput` does
 * not actually shell out to the `herdr` CLI in tests. We still want to
 * verify the call was forwarded, so we let the spy record the call
 * before the mock short-circuits the implementation.
 *
 * vi.mock is hoisted by vitest above the imports, so this overrides
 * sendText for every test in this file.
 */
vi.mock("../src/herdr-client.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("../src/herdr-client.js");
  return {
    ...mod,
    sendText: vi.fn(),
  };
});

/**
 * A reader whose snapshots advance on every read. Mirrors the fake
 * reader in tests/turn/observe-loop-controller.test.ts so loop-level
 * semantics are identical.
 */
function makeFakeReader(snapshots: string[]): AgentOutputReader & {
  calls: number;
  append(extra: string[]): void;
} {
  let i = 0;
  const reader: AgentOutputReader & {
    calls: number;
    append(extra: string[]): void;
  } = {
    kind: "fake",
    calls: 0,
    append(extra) {
      snapshots.push(...extra);
    },
    read(_max: number): string {
      this.calls += 1;
      return snapshots[Math.min(i++, snapshots.length - 1)] ?? "";
    },
  };
  return reader;
}

/** Minimal Config for tests. progressIntervalMs + stabilityMs are the
 *  knobs the loop reads from cfg. */
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    botToken: "test",
    chatId: null,
    throttleMs: 1000,
    waitTimeoutS: 300,
    maxTotalWaitS: 1800,
    maxProgressUpdates: 60,
    progressIntervalMs: 100,
    stabilityWindowMs: 100,
    followTimeoutMinutes: 30,
    agentPaths: {},
    opencodeIncludeTools: false,
    opencodeIncludeThoughts: false,
    ...overrides,
  };
}

/**
 * Build the controllable environment a PaneAgent runs in. Each pending
 * sleep represents one progressIntervalMs of wall time; step() resolves
 * one pending sleep and advances the clock. drive() walks the active
 * loop until it finalises. `controllers` lets a test assert the
 * single-loop invariant AND await a specific controller's `done`.
 */
function makeEnv(opts: {
  snapshots?: string[];
  config?: Partial<Config>;
} = {}) {
  const cfg = makeConfig(opts.config);
  const reader = makeFakeReader(opts.snapshots ?? ["stable"]);
  const comm = new AgentCommunicator(reader, noopLogger, "w1:p1");
  const events: OutputEvent[] = [];
  const pending: Array<() => void> = [];
  let now = 0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const controllers: ObserveLoopController[] = [];
  const deps = {
    sleep: async (_ms: number) =>
      new Promise<void>((resolve) => pending.push(resolve)),
    now: clock.now,
    createController: (cd: ObserveLoopControllerDeps) => {
      const c = new ObserveLoopController(cd);
      controllers.push(c);
      return c;
    },
  };
  const agent = new PaneAgent({
    paneId: "w1:p1",
    communicator: comm,
    emit: (e) => events.push(e),
    config: cfg,
    deps,
  });
  return {
    agent,
    comm,
    events,
    controllers,
    pending,
    clock,
    step() {
      const next = pending.shift();
      if (!next) return false;
      clock.advance(cfg.progressIntervalMs);
      next();
      return true;
    },
    pendingCount() {
      return pending.length;
    },
    async drive(maxIter = 80) {
      let idleSteps = 0;
      for (let i = 0; i < maxIter; i++) {
        let spins = 0;
        while (pending.length === 0) {
          await Promise.resolve();
          if (++spins > 10) break;
        }
        if (pending.length === 0) {
          if (++idleSteps > 3) return;
          continue;
        }
        idleSteps = 0;
        this.step();
        await Promise.resolve();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 1. handleMessage — first message starts a loop and forwards input
// ---------------------------------------------------------------------------

describe("PaneAgent — handleMessage (first message)", () => {
  it("forwards text via communicator.sendInput and starts an observe loop", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    const spy = vi.spyOn(env.comm, "sendInput");

    env.agent.handleMessage("hello");

    // Input was forwarded to the pane.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hello");
    // A loop is now active.
    expect(env.agent.isLoopActive()).toBe(true);
    // Exactly one controller was constructed.
    expect(env.controllers).toHaveLength(1);
  });

  it("does not start a second loop when called again on the same pane", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    const spy = vi.spyOn(env.comm, "sendInput");

    env.agent.handleMessage("first");
    env.agent.handleMessage("second");

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]).toEqual(["first"]);
    expect(spy.mock.calls[1]).toEqual(["second"]);
    // Single-loop invariant: still exactly one controller.
    expect(env.controllers).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b. noteExternalTurn — a turn that started in the pane itself
// ---------------------------------------------------------------------------

describe("PaneAgent — noteExternalTurn", () => {
  it("attaches an observe loop without sending any input", () => {
    // The prompt has already been submitted in the terminal; sending anything
    // would put a second question into the pane.
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    const spy = vi.spyOn(env.comm, "sendInput");

    env.agent.noteExternalTurn();

    expect(spy).not.toHaveBeenCalled();
    expect(env.agent.isLoopActive()).toBe(true);
    expect(env.controllers).toHaveLength(1);
  });

  it("does nothing while a turn is already in flight", () => {
    // herdr reports the pane busy a moment after a chat message starts a turn.
    // Adopting that would deliver the same answer twice.
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    env.agent.handleMessage("hello");

    env.agent.noteExternalTurn();

    expect(env.controllers).toHaveLength(1);
  });

  it("clears the prompt anchor so the answer is read off the screen", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    const spy = vi.spyOn(env.comm, "beginExternalTurn");

    env.agent.noteExternalTurn();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ends the turn on idle and emits one final event", async () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable", "stable"] });
    env.agent.noteExternalTurn();

    await env.drive();

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ reason: "idle" });
    expect(env.agent.isLoopActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 1c. Repeat suppression on externally-started turns
// ---------------------------------------------------------------------------

/**
 * A turn can begin without the terminal echoing a `❯` prompt — a resumed
 * session, a hook, an agent continuing on its own. The screen anchor then
 * lands on the previous question and the extraction returns an answer already
 * delivered. These tests pin the flag that keeps that off the chat.
 *
 * The controller is stubbed here so a test can emit an exact final payload;
 * driving a real loop to produce the SAME text twice would be testing the
 * communicator's diff state, not this rule.
 */
function makeStubEnv(opts: { busy?: () => boolean } = {}) {
  const cfg = makeConfig();
  const comm = new AgentCommunicator(makeFakeReader(["stable"]), noopLogger, "w1:p1");
  const events: OutputEvent[] = [];
  const emits: Array<(event: OutputEvent) => void> = [];
  const finish: Array<() => void> = [];
  const agent = new PaneAgent({
    paneId: "w1:p1",
    communicator: comm,
    emit: (event) => events.push(event),
    config: cfg,
    isAgentBusy: opts.busy,
    deps: {
      createController: (deps: ObserveLoopControllerDeps) => {
        emits.push(deps.emit);
        let resolve!: () => void;
        const done = new Promise<void>((r) => { resolve = r; });
        finish.push(resolve);
        return {
          done,
          start: () => done,
          updateDeadline() {},
          hasDeadline: () => false,
          markUserInput() {},
          abort() {},
        } as unknown as ObserveLoopController;
      },
    },
  });
  const answer = (
    text: string,
    reason: "idle" | "deadline" | "ceiling" | "aborted" = "idle",
  ): OutputEvent => ({ type: "final", text, reason, source: "delta" });
  return {
    agent,
    comm,
    events,
    /** How many controllers have been constructed for this pane. */
    loops: () => emits.length,
    /** Emit a turn's final through the newest controller and let it settle. */
    async endTurn(text: string, reason?: "idle" | "deadline" | "ceiling" | "aborted") {
      // Pin the index first: emitting a "ceiling" final starts a continuation
      // loop, and resolving THAT one's promise would clear the live loop.
      const index = emits.length - 1;
      emits[index](answer(text, reason));
      finish[index]();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// 1d. A turn longer than the loop's own ceiling
// ---------------------------------------------------------------------------

describe("PaneAgent — turns that outrun maxTurnMs", () => {
  it("continues under a fresh loop instead of reporting a half-written answer", async () => {
    // The ceiling is the loop's guarantee of termination, not the agent
    // finishing. Reporting here would post a partial answer AND abandon the
    // pane until its next turn — the real answer would never arrive.
    const env = makeStubEnv({ busy: () => true });
    env.agent.noteExternalTurn();
    expect(env.loops()).toBe(1);

    await env.endTurn("half an answer so far", "ceiling");

    expect(env.events.filter((e) => e.type === "final")).toHaveLength(0);
    expect(env.loops()).toBe(2);
    expect(env.agent.isLoopActive()).toBe(true);
  });

  it("delivers the answer when the continued turn finally settles", async () => {
    const env = makeStubEnv({ busy: () => true });
    env.agent.noteExternalTurn();
    await env.endTurn("half an answer so far", "ceiling");
    await env.endTurn("the whole answer");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ text: "the whole answer" });
  });

  it("reports the ceiling when herdr says the pane has stopped working", async () => {
    // Then the ceiling really is the end of it: continuing would poll a pane
    // that is doing nothing.
    const env = makeStubEnv({ busy: () => false });
    env.agent.noteExternalTurn();
    await env.endTurn("what there was", "ceiling");

    expect(env.events.filter((e) => e.type === "final")).toHaveLength(1);
    expect(env.loops()).toBe(1);
  });

  it("still reports a follow deadline, which is not the ceiling", async () => {
    const env = makeStubEnv({ busy: () => true });
    env.agent.enableFollow(1_000);
    await env.endTurn("what the follow window saw", "deadline");

    expect(env.events.filter((e) => e.type === "final")).toHaveLength(1);
  });
});

describe("PaneAgent — repeat suppression", () => {
  it("keeps watching when a turn repeats the answer already delivered", async () => {
    // The same answer twice usually means the loop settled before the agent
    // wrote anything of its own, so the screen anchor fell back to the
    // previous turn. Reporting nothing and stopping is how a real question got
    // no reply at all.
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("Lima entri sudah dibuat.");
    expect(env.loops()).toBe(1);

    env.agent.noteExternalTurn();
    await env.endTurn("Lima entri sudah dibuat.");

    expect(env.events.filter((e) => e.type === "final")).toHaveLength(1);
    expect(env.loops()).toBe(3);
    expect(env.agent.isLoopActive()).toBe(true);
  });

  it("delivers the answer the continued turn eventually produces", async () => {
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("stale");
    env.agent.noteExternalTurn();
    await env.endTurn("stale");
    await env.endTurn("the answer that was actually being written");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(2);
    expect(finals[1]).toMatchObject({ text: "the answer that was actually being written" });
    expect(finals[1]).not.toHaveProperty("duplicate", true);
  });

  it("believes the repeat after a few attempts and stops watching", async () => {
    // A turn that genuinely repeats itself — a hook, a resumed session —
    // must not be followed forever.
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("same");
    env.agent.noteExternalTurn();
    for (let attempt = 0; attempt < 4; attempt++) await env.endTurn("same");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(2);
    expect(finals[1]).toMatchObject({ duplicate: true });
    expect(env.agent.isLoopActive()).toBe(false);
  });

  it("does not flag a chat turn, even with an identical answer", async () => {
    // Asking the same question twice must answer twice.
    const env = makeStubEnv();
    env.agent.handleMessage("halo");
    await env.endTurn("Halo!");
    env.agent.handleMessage("halo");
    await env.endTurn("Halo!");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals.every((f) => f.type === "final" && !f.duplicate)).toBe(true);
  });

  it("does not flag a chat turn that follows an identical external one", async () => {
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("same");
    env.agent.handleMessage("ask again");
    await env.endTurn("same");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals[1]).not.toHaveProperty("duplicate", true);
  });

  it("delivers an external turn whose answer differs", async () => {
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("first answer");
    env.agent.noteExternalTurn();
    await env.endTurn("second answer");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals[1]).not.toHaveProperty("duplicate", true);
  });

  it("keeps watching when the communicator says the turn was already delivered", async () => {
    // The text guard above compares bytes, and the bridge-typed and adopted
    // paths extract the same turn into different bytes. The communicator
    // compares the turn's closing line instead. Its word must reach the same
    // continuation branch, or the answer goes out twice — which it did.
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("the answer, as the bridge-typed path extracted it");
    const spy = vi.spyOn(env.comm, "turnAlreadyDelivered").mockReturnValue(true);
    env.agent.noteExternalTurn();
    await env.endTurn("the answer, as the adopted path extracted it");

    expect(env.events.filter((e) => e.type === "final")).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
    spy.mockReturnValue(false);
    await env.endTurn("what the agent actually said next");
    const finals = env.events.filter((e) => e.type === "final");
    expect(finals).toHaveLength(2);
    expect(finals[1]).toMatchObject({ text: "what the agent actually said next" });
    spy.mockRestore();
  });

  it("tells the communicator what was delivered, question included", async () => {
    const env = makeStubEnv();
    const mark = vi.spyOn(env.comm, "markDelivered");
    vi.spyOn(env.comm, "getTurnPrompt").mockReturnValue("apa kabar?");
    env.agent.noteExternalTurn();
    await env.endTurn("Baik!");
    expect(mark).toHaveBeenCalledWith("apa kabar?");

    // A chat turn: the communicator already holds the typed question.
    env.agent.handleMessage("halo");
    await env.endTurn("Halo!");
    expect(mark).toHaveBeenLastCalledWith("");

    // A repeat that is still being watched is not a delivery.
    mark.mockClear();
    vi.spyOn(env.comm, "turnAlreadyDelivered").mockReturnValue(true);
    env.agent.noteExternalTurn();
    await env.endTurn("Halo!");
    expect(mark).not.toHaveBeenCalled();
  });

  it("carries the question when the turn was started in the pane", async () => {
    const env = makeStubEnv();
    const spy = vi.spyOn(env.comm, "getTurnPrompt").mockReturnValue("apa kabar?");
    env.agent.noteExternalTurn();
    await env.endTurn("Baik!");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals[0]).toMatchObject({ text: "Baik!", prompt: "apa kabar?" });
    spy.mockRestore();
  });

  it("carries no question for a turn the chat can already see", async () => {
    const env = makeStubEnv();
    env.agent.handleMessage("apa kabar?");
    await env.endTurn("Baik!");

    expect(env.events.filter((e) => e.type === "final")[0]).not.toHaveProperty("prompt");
  });

  it("never flags an empty final", async () => {
    // "no output" twice in a row is a lifecycle report, not a repeated answer.
    const env = makeStubEnv();
    env.agent.noteExternalTurn();
    await env.endTurn("");
    env.agent.noteExternalTurn();
    await env.endTurn("");

    const finals = env.events.filter((e) => e.type === "final");
    expect(finals.every((f) => f.type === "final" && !f.duplicate)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. enableFollow — no loop → start one with the deadline
// ---------------------------------------------------------------------------

describe("PaneAgent — enableFollow", () => {
  it("starts a loop with the deadline when no loop is active", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    expect(env.agent.isLoopActive()).toBe(false);

    env.agent.enableFollow(env.clock.now() + 500);

    expect(env.agent.isLoopActive()).toBe(true);
    expect(env.controllers).toHaveLength(1);
  });

  it("updates the existing loop's deadline rather than creating a new loop", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    env.agent.handleMessage("a");
    expect(env.controllers).toHaveLength(1);

    env.agent.enableFollow(env.clock.now() + 500);

    // Single-loop invariant: still one controller.
    expect(env.controllers).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
  });
});

describe("PaneAgent — isFollowing", () => {
  it("reports a follow only while the active loop has a deadline", () => {
    const env = makeEnv({ snapshots: ["stable", "stable"] });

    expect(env.agent.isFollowing()).toBe(false);

    env.agent.handleMessage("message turn");
    expect(env.agent.isFollowing()).toBe(false);

    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.agent.isFollowing()).toBe(true);

    env.agent.disableFollow();
    expect(env.agent.isFollowing()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. disableFollow — clears deadline, keeps loop
// ---------------------------------------------------------------------------

describe("PaneAgent — disableFollow", () => {
  it("clears the deadline but keeps the loop running", () => {
    const env = makeEnv({ snapshots: ["stable", "stable", "stable"] });
    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.agent.isLoopActive()).toBe(true);

    env.agent.disableFollow();

    // Loop should still be alive — we just removed the timer gate.
    expect(env.agent.isLoopActive()).toBe(true);
    expect(env.controllers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. handleMessage during a follow — marks waitUntilIdle, preserves deadline
// ---------------------------------------------------------------------------

describe("PaneAgent — message during follow", () => {
  it("forwards the input and reuses the existing loop (no second controller)", () => {
    const env = makeEnv({ snapshots: ["x", "x y", "x y", "x y"] });
    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.controllers).toHaveLength(1);

    const spy = vi.spyOn(env.comm, "sendInput");
    env.agent.handleMessage("interrupt");

    // Input forwarded.
    expect(spy).toHaveBeenCalledWith("interrupt");
    // Single-loop invariant: still one controller.
    expect(env.controllers).toHaveLength(1);
    expect(env.agent.isLoopActive()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. disableFollow after message — keeps waitUntilIdle (stop on idle)
// ---------------------------------------------------------------------------

describe("PaneAgent — unfollow after message", () => {
  it("keeps waitUntilIdle so the loop drains on idle after /unfollow", async () => {
    // Pane grows then settles. With markUserInput=true and deadline=null,
    // the loop finalises on idle alone. We disableFollow after the
    // message — the loop should stay alive until the pane settles.
    const env = makeEnv({
      snapshots: ["seed", "seed tail", "seed tail", "seed tail", "seed tail"],
    });
    env.agent.handleMessage("a");
    expect(env.controllers).toHaveLength(1);
    const loop = env.controllers[0]!;

    env.agent.disableFollow();

    // Loop must still be active — the stop formula is now
    // deadline=null (always reached) AND waitUntilIdle=true → stop on idle.
    expect(env.agent.isLoopActive()).toBe(true);

    // Drive the loop until it finalises.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
    expect(env.controllers).toHaveLength(1);
  });

  it("stops immediately when /unfollow lands on a follow-only loop", async () => {
    // Follow only (waitUntilIdle=false, deadline set). Unfollow clears
    // the deadline but does NOT flip waitUntilIdle to true — so the
    // formula becomes deadline=null (reached) AND !waitUntilIdle (true)
    // → stop on the very next iteration.
    const env = makeEnv({
      snapshots: ["stable", "stable", "stable", "stable"],
    });
    env.agent.enableFollow(env.clock.now() + 500);
    expect(env.agent.isLoopActive()).toBe(true);
    const loop = env.controllers[0]!;

    env.agent.disableFollow();

    // Drive — the loop must finalise on the next iteration.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
    expect(env.controllers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. stop() — aborts and clears
// ---------------------------------------------------------------------------

describe("PaneAgent — stop", () => {
  it("aborts the active loop and clears it", async () => {
    const env = makeEnv({
      // Long-lived: stabilityMs large so the loop doesn't finalise on
      // its own. We need stop() to be the one ending it.
      snapshots: ["x", "x y", "x y z", "x y z w"],
    });
    env.agent.handleMessage("a");
    expect(env.agent.isLoopActive()).toBe(true);
    const loop = env.controllers[0]!;

    env.agent.stop();

    // The controller only checks the abort latch AFTER its current
    // sleep resolves, so drive one tick to let the abort propagate
    // through the loop's per-iteration check.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
  });

  it("is a no-op when no loop is active", () => {
    const env = makeEnv();
    expect(env.agent.isLoopActive()).toBe(false);
    expect(() => env.agent.stop()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 7. dispose() — aborts and clears (idempotent)
// ---------------------------------------------------------------------------

describe("PaneAgent — dispose", () => {
  it("aborts the active loop and clears it", async () => {
    const env = makeEnv({
      snapshots: ["x", "x y", "x y z", "x y z w"],
    });
    env.agent.handleMessage("a");
    const loop = env.controllers[0]!;

    env.agent.dispose();

    // Same as stop: the abort latch is checked after the next sleep
    // resolves, so drive to let the abort propagate.
    await env.drive();
    await loop.done;
    expect(env.agent.isLoopActive()).toBe(false);
  });

  it("is a no-op when no loop is active", () => {
    const env = makeEnv();
    expect(() => env.agent.dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 8. getLastOutput — readback does not consume diff state
// ---------------------------------------------------------------------------

describe("PaneAgent — getLastOutput", () => {
  it("returns communicator.getLatestOutput() without touching diff state", () => {
    // Use a stable snapshot so reader state does not advance
    // underneath getNewOutput between calls. The fake reader returns
    // the next snapshot per read(), so a static ["x"] means every read
    // returns "x".
    const env = makeEnv({ snapshots: ["x"] });

    // Seed the diff state — first call returns "" and sets sentTail="x".
    expect(env.comm.getNewOutput()).toBe("");

    // Spy on getNewOutput to prove getLastOutput did NOT consume it.
    const newOutputSpy = vi.spyOn(env.comm, "getNewOutput");

    // /last is a pure read; it should NOT call getNewOutput.
    const last = env.agent.getLastOutput();
    expect(last).toBe("x");
    expect(newOutputSpy).not.toHaveBeenCalled();

    // After /last, a getNewOutput call still finds nothing new.
    expect(env.comm.getNewOutput()).toBe("");
  });
});

async function flushMicrotasks() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** Metadata and reader are independent: neither one alone can close a turn. */
function completionEnv(opts: {
  mode?: "final" | "stream"; capture?: boolean; sync?: boolean; maxTotalWaitS?: number;
  reader?: AgentOutputReader;
  metadata?: (info: AgentInfo | null, call: number) => AgentInfo | null | Promise<AgentInfo | null>;
} = {}) {
  let info: AgentInfo | null = {
    agent: "pi", agent_status: "idle", pane_id: "w1:p1", tab_id: "t", workspace_id: "w",
    agent_session: { kind: "path", path: "/tmp/session.jsonl" },
    completion_evidence: {
      terminal_id: "terminal", state_change_seq: 0, completion_seq: null,
      screen_detection_skipped: true, launch_pending: false, endpoint_identity: "[socket:1]",
    },
  };
  let answer: string | null = null;
  let mismatched = false;
  let throwInfo = false;
  let metadataCalls = 0;
  let captured = 0;
  let sent = 0;
  const reader: AgentOutputReader = opts.reader ?? {
    kind: "pi-jsonl",
    read: () => "old answer", // deliberately stale snapshot/anchor
    lastPrompt: () => "old prompt",
    lastAnswer: () => "old answer",
    captureTurn: opts.capture === false ? undefined : (expected) => {
      if (expected && (expected.kind !== "path" || expected.path !== "/tmp/session.jsonl")) return null;
      captured++;
      const boundary = sent;
      return () => sent > boundary && answer ? { prompt: mismatched ? "old prompt" : "ask", text: answer } : null;
    },
  };
  const comm = new AgentCommunicator(reader, noopLogger, "w1:p1");
  const actualSend = comm.sendInput.bind(comm);
  vi.spyOn(comm, "sendInput").mockImplementation((text) => {
    sent++;
    actualSend(text);
    if (opts.sync) {
      answer = "new synchronous answer";
      complete();
    }
  });
  const events: OutputEvent[] = [];
  const pending: Array<() => void> = [];
  let now = 0;
  const config = makeConfig({ outputMode: opts.mode ?? "final", progressIntervalMs: 2000,
    stabilityWindowMs: 30000, ...(opts.maxTotalWaitS === undefined ? {} : { maxTotalWaitS: opts.maxTotalWaitS }) });
  const agent = new PaneAgent({
    paneId: "w1:p1", communicator: comm, config,
    getCompletionInfo: () => {
      metadataCalls++;
      if (throwInfo) throw new Error("metadata unavailable");
      return opts.metadata ? opts.metadata(info, metadataCalls) : info;
    },
    isAgentBusy: () => info?.agent_status === "working",
    emit: (event) => events.push(event),
    deps: { now: () => now, sleep: () => new Promise<void>(resolve => pending.push(resolve)) },
  });
  function change(fields: Partial<AgentInfo> & { completion_evidence?: AgentInfo["completion_evidence"] }) {
    info = info && { ...info, ...fields, completion_evidence: {
      ...info.completion_evidence!, ...fields.completion_evidence,
    } };
  }
  function complete(state = 8) {
    change({ agent_status: "idle", completion_evidence: { ...info!.completion_evidence!, state_change_seq: state, completion_seq: state } });
  }
  async function tick() {
    expect(pending.length).toBeGreaterThan(0);
    now += 2000;
    pending.shift()!();
    await flushMicrotasks();
  }
  return {
    agent, comm, events, change, complete, tick, setAnswer: (text: string | null) => { answer = text; },
    setInfo: (value: AgentInfo | null) => { info = value; },
    getInfo: () => info!, captured: () => captured, sent: () => sent,
    metadataCalls: () => metadataCalls,
    mismatch: () => { mismatched = true; }, throwMetadata: () => { throwInfo = true; },
    restoreMetadata: () => { throwInfo = false; },
    finals: () => events.filter(e => e.type === "final"),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("PaneAgent — asynchronous metadata and turn ownership", () => {
  it("delivers both answers when a new input arrives during the ceiling decision", async () => {
    const ceiling = deferred<AgentInfo | null>();
    let prompt = "first";
    let answer = "";
    let transcript = "";
    const e = completionEnv({ maxTotalWaitS: 1,
      reader: { kind: "pi-jsonl", read: () => transcript,
        lastPrompt: () => prompt, lastAnswer: () => answer },
      metadata: (info, call) => call === 2 ? ceiling.promise : info });
    await e.agent.handleMessage("first");
    answer = transcript = "first answer";
    await e.tick();
    expect(e.metadataCalls()).toBe(2);
    expect(e.events.filter(event => event.type === "delta").map(event => event.text.trim()))
      .toEqual(["first answer"]);

    const dispatch = vi.mocked(e.comm.sendInput).getMockImplementation()!;
    const finalsAtDispatch: number[] = [];
    vi.mocked(e.comm.sendInput).mockImplementation(text => {
      finalsAtDispatch.push(e.finals().length);
      dispatch(text);
    });
    const second = e.agent.handleMessage("second");
    await flushMicrotasks();
    const sentWhileDeciding = e.sent();
    ceiling.resolve(e.getInfo());
    await second;
    prompt = "second";
    answer = "second answer";
    transcript += "\n" + answer;
    await e.tick();

    // Final-only consumers suppressed the first delta. A later final must not
    // be mistaken for recovery of the preceding controller's lost payload.
    expect(e.finals().map(event => event.text)).toEqual(["first answer", "second answer"]);
    expect(sentWhileDeciding).toBe(1);
    expect(finalsAtDispatch).toEqual([1]);
    expect(e.sent()).toBe(2);
    expect(e.agent.isLoopActive()).toBe(false);
  });

  it("falls back after an asynchronous metadata rejection and still sends once", async () => {
    const e = completionEnv({ metadata: () => Promise.reject(new Error("unavailable")) });
    await e.agent.handleMessage("ask");
    expect(e.sent()).toBe(1);
    expect(e.captured()).toBe(0);
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("uses nonblocking fresh metadata to continue a working pane at the ceiling", async () => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: "working" });
    await e.tick();
    expect(e.metadataCalls()).toBe(3);
    expect(e.finals()).toHaveLength(0);
    ceiling.resolve(e.getInfo());
    await flushMicrotasks();
    expect(e.agent.isLoopActive()).toBe(true);
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
    expect(e.finals()).toMatchObject([{ reason: "aborted" }]);
  });

  it("does not restart a stopped pane when ceiling metadata arrives late", async () => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: "working" });
    await e.tick();
    expect(e.metadataCalls()).toBe(3);
    e.agent.stop();
    ceiling.resolve(e.getInfo());
    await flushMicrotasks();
    expect(e.agent.isLoopActive()).toBe(false);
    expect(e.finals()).toHaveLength(0);
  });

  it.each(["idle", "working"])("applies follow after the %s ceiling outcome without replacing it", async (status) => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: status });
    await e.tick();
    expect(e.metadataCalls()).toBe(3);
    expect(e.agent.isLoopActive()).toBe(true);
    expect(e.agent.noteExternalTurn()).toBe(false);
    e.agent.enableFollow(10_000);
    expect(e.agent.isFollowing()).toBe(true);
    expect(e.finals()).toHaveLength(0);
    ceiling.resolve(e.getInfo());
    await flushMicrotasks();
    expect(e.agent.isLoopActive()).toBe(true);
    expect(e.agent.isFollowing()).toBe(true);
    expect(e.finals()).toHaveLength(status === "idle" ? 1 : 0);
    e.agent.stop();
    await e.tick();
    expect(e.finals().at(-1)).toMatchObject({ reason: "aborted" });
  });

  it.each(["idle", "working"])("honors unfollow during the %s ceiling decision", async (status) => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: status });
    await e.tick();
    e.agent.enableFollow(10_000);
    e.agent.disableFollow();
    expect(e.agent.isFollowing()).toBe(false);
    ceiling.resolve(e.getInfo());
    await flushMicrotasks();
    expect(e.agent.isFollowing()).toBe(false);
    expect(e.agent.isLoopActive()).toBe(status === "working");
    expect(e.finals()).toHaveLength(status === "idle" ? 1 : 0);
    if (status === "working") {
      e.agent.stop();
      await e.tick();
    }
  });

  it.each(["final", "stream"] as const)("preserves %s-mode diff-only output across busy ceiling decisions", async (mode) => {
    const ceiling = deferred<AgentInfo | null>();
    let transcript = "";
    const e = completionEnv({ mode, maxTotalWaitS: 1,
      reader: { kind: "opencode-db", read: () => transcript },
      metadata: (info, call) => call === (mode === "final" ? 2 : 1) ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: "working" });
    transcript = "before ceiling";
    await e.tick();
    transcript += "\nduring decision";
    ceiling.resolve(e.getInfo());
    await flushMicrotasks();
    expect(e.agent.isLoopActive()).toBe(true);
    expect(e.finals()).toHaveLength(0);
    transcript += "\nafter continuation";
    await e.tick(); // still busy: carry output through another ceiling
    expect(e.finals()).toHaveLength(0);
    transcript += "\nfinished";
    e.change({ agent_status: "idle" });
    await e.tick();
    expect(e.finals()).toHaveLength(1);
    expect(e.finals()[0]!.reason).toBe("ceiling");
    if (mode === "final") {
      expect(e.finals()[0]!.text).toBe("before ceiling\nduring decision\nafter continuation\nfinished");
    } else {
      expect(e.events.filter(event => event.type === "delta").map(event => event.text.trim()))
        .toEqual(["before ceiling", "during decision\nafter continuation", "finished"]);
    }
    expect(e.agent.isLoopActive()).toBe(false);
  });

  it.each(["idle", "working"])("queues arrivals in order behind the %s ceiling outcome", async (status) => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: status });
    await e.tick();
    const second = e.agent.handleMessage("second");
    const third = e.agent.handleMessage("third");
    await flushMicrotasks();
    expect(e.sent()).toBe(1);
    expect(e.agent.isLoopActive()).toBe(true);
    ceiling.resolve(e.getInfo());
    await Promise.all([second, third]);
    expect(vi.mocked(e.comm.sendInput).mock.calls.map(([text]) => text))
      .toEqual(["ask", "second", "third"]);
    expect(e.finals()).toHaveLength(status === "idle" ? 1 : 0);
    e.agent.stop();
    await e.tick();
  });

  it.each(["stop", "dispose"] as const)("%s cancels input queued behind a ceiling decision", async (action) => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: "working" });
    await e.tick();
    const canceled = e.agent.handleMessage("canceled");
    await flushMicrotasks();
    expect(e.sent()).toBe(1);
    e.agent[action]();
    expect(e.agent.isLoopActive()).toBe(false);
    ceiling.resolve(e.getInfo());
    await canceled;
    expect(e.sent()).toBe(1);
    expect(e.finals()).toHaveLength(0);
    expect(e.agent.isLoopActive()).toBe(false);
  });

  it("does not make post-stop input wait for the canceled ceiling decision", async () => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3 ? ceiling.promise : info });
    await e.agent.handleMessage("ask");
    e.change({ agent_status: "working" });
    await e.tick();
    const oldWorking = e.getInfo();
    e.agent.stop();
    e.change({ agent_status: "idle" });
    await e.agent.handleMessage("fresh");
    expect(e.sent()).toBe(2);
    ceiling.resolve(oldWorking);
    await flushMicrotasks();
    expect(e.finals()).toHaveLength(0);
    expect(e.agent.isLoopActive()).toBe(true);
    e.agent.stop();
    await e.tick();
    expect(e.finals()).toMatchObject([{ reason: "aborted" }]);
  });

  it("releases queued input after ceiling metadata rejects", async () => {
    const ceiling = deferred<AgentInfo | null>();
    const e = completionEnv({ maxTotalWaitS: 1,
      metadata: (info, call) => call === 3
        ? ceiling.promise.then(() => { throw new Error("metadata unavailable"); }) : info });
    await e.agent.handleMessage("ask");
    await e.tick();
    const next = e.agent.handleMessage("next");
    await flushMicrotasks();
    expect(e.sent()).toBe(1);
    ceiling.resolve(null);
    await next;
    expect(e.finals()).toMatchObject([{ reason: "ceiling" }]);
    expect(e.sent()).toBe(2);
    e.agent.stop();
    await e.tick();
  });

  it("lets a new message proceed after stop without waiting for canceled preparation", async () => {
    const baseline = deferred<AgentInfo | null>();
    const e = completionEnv({ metadata: (info, call) => call === 1 ? baseline.promise : info });
    const canceled = e.agent.handleMessage("canceled");
    await flushMicrotasks();
    e.agent.stop();
    await e.agent.handleMessage("ask");
    expect(e.sent()).toBe(1);
    expect(e.captured()).toBe(1);
    baseline.resolve(null);
    await canceled;
    e.setAnswer("new turn");
    e.complete();
    await e.tick();
    expect(e.finals()).toMatchObject([{ reason: "idle", text: "new turn" }]);
    expect(vi.mocked(e.comm.sendInput).mock.calls.map(([text]) => text)).toEqual(["ask"]);
  });

  it("shares one poll sample and only revalidates after a reader candidate", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.metadataCalls()).toBe(2);
    await e.tick(); // no completion, no reader candidate
    expect(e.metadataCalls()).toBe(3);
    e.complete();
    await e.tick(); // metadata complete, but no persisted reader output
    expect(e.metadataCalls()).toBe(4);
    e.setAnswer("ready");
    await e.tick();
    expect(e.metadataCalls()).toBe(6); // shared observation + fresh post-reader check
    expect(e.finals()).toMatchObject([{ text: "ready", reason: "idle" }]);
  });

  it("skips the second pre-dispatch sample when capture has no proof", async () => {
    const e = completionEnv({ capture: false });
    await e.agent.handleMessage("ask");
    expect(e.metadataCalls()).toBe(1);
    expect(e.sent()).toBe(1);
    e.agent.stop();
    await e.tick();
  });

  it("queues input in arrival order and invalidates proof before preparation finishes", async () => {
    const baseline = deferred<AgentInfo | null>();
    const e = completionEnv({ metadata: (info, call) => call === 1 ? baseline.promise : info });
    const first = e.agent.handleMessage("ask");
    await flushMicrotasks();
    expect(e.agent.isLoopActive()).toBe(true);
    expect(e.agent.noteExternalTurn()).toBe(false);
    const second = e.agent.handleMessage("second");
    expect(e.sent()).toBe(0);
    baseline.resolve(e.getInfo());
    await Promise.all([first, second]);
    expect(vi.mocked(e.comm.sendInput).mock.calls.map(([text]) => text)).toEqual(["ask", "second"]);
    expect(e.captured()).toBe(0);
    e.setAnswer("must settle normally");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it.each(["stop", "dispose"] as const)("%s cancels all pending input before dispatch", async action => {
    const baseline = deferred<AgentInfo | null>();
    const e = completionEnv({ metadata: (info, call) => call === 1 ? baseline.promise : info });
    const first = e.agent.handleMessage("ask");
    await flushMicrotasks();
    const second = e.agent.handleMessage("second");
    e.agent[action]();
    expect(e.agent.isLoopActive()).toBe(false);
    baseline.resolve(e.getInfo());
    await Promise.all([first, second]);
    expect(e.sent()).toBe(0);
    expect(e.captured()).toBe(0);
    expect(e.finals()).toHaveLength(0);
    if (action === "dispose") {
      await e.agent.handleMessage("after disposal");
      e.agent.enableFollow(60_000);
      expect(e.sent()).toBe(0);
      expect(e.agent.isLoopActive()).toBe(false);
    }
  });

  it("preserves follow/unfollow while preparation is in flight without arming proof", async () => {
    const baseline = deferred<AgentInfo | null>();
    const e = completionEnv({ metadata: (info, call) => call === 1 ? baseline.promise : info });
    const input = e.agent.handleMessage("ask");
    await flushMicrotasks();
    e.agent.enableFollow(60_000);
    baseline.resolve(e.getInfo());
    await input;
    expect(e.agent.isFollowing()).toBe(true);
    expect(e.captured()).toBe(0);
    e.agent.disableFollow();
    e.setAnswer("ready");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0); // user input retained the idle gate
    e.agent.stop();
    await e.tick();
  });

  it("invalidates proof immediately while a poll's metadata is pending", async () => {
    const poll = deferred<AgentInfo | null>();
    const e = completionEnv({ metadata: (info, call) => call === 3 ? poll.promise : info });
    await e.agent.handleMessage("ask");
    e.setAnswer("old turn proof");
    e.complete();
    await e.tick(); // enters suspended metadata
    await e.agent.handleMessage("second");
    poll.resolve(e.getInfo());
    await flushMicrotasks();
    expect(e.sent()).toBe(2);
    expect(e.finals()).toHaveLength(0);
    expect(e.metadataCalls()).toBe(3); // no post-reader query for invalid proof
    e.agent.stop();
    await e.tick();
  });

  it("does not let an old aborted final erase a new turn's proof", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    e.agent.stop();
    await e.agent.handleMessage("ask");
    e.setAnswer("new answer");
    e.complete();
    await e.tick(); // old controller's aborted final arrives after new capture
    expect(e.finals()).toMatchObject([{ reason: "aborted" }]);
    await e.tick();
    expect(e.finals()).toMatchObject([{ reason: "aborted" }, { reason: "idle", text: "new answer" }]);
  });

  it("rejects stale post-reader revalidation without clearing replacement proof", async () => {
    const revalidation = deferred<AgentInfo | null>();
    const e = completionEnv({ metadata: (info, call) => call === 4 ? revalidation.promise : info });
    await e.agent.handleMessage("ask");
    e.setAnswer("old candidate");
    e.complete();
    await e.tick(); // suspended after reading the candidate
    expect(e.metadataCalls()).toBe(4);
    e.agent.stop();
    await e.agent.handleMessage("ask");
    revalidation.resolve(null);
    await flushMicrotasks();
    expect(e.finals()).toMatchObject([{ reason: "aborted" }]);
    e.setAnswer("new answer");
    e.complete(16);
    await e.tick();
    expect(e.finals()).toMatchObject([{ reason: "aborted" }, { reason: "idle", text: "new answer" }]);
  });
});

describe("PaneAgent — completion-aware final polling", () => {
  it("delivers a fresh full turn at the next 2s poll, with no historical output", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("current full turn\nsecond line");
    e.complete();
    await e.tick();
    expect(e.finals()).toEqual([{ type: "final", text: "current full turn\nsecond line", reason: "idle", source: "delta" }]);
    expect(e.sent()).toBe(1);
  });

  it("rejects a cached old reader when current metadata already names a new session", async () => {
    const e = completionEnv();
    e.change({ agent_session: { kind: "path", path: "/tmp/new-session.jsonl" } });
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(0); // wrong selected source cannot affirm current metadata
    e.setAnswer("stale reader answer");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("captures a copied source before dispatch, not a mutable metadata session", async () => {
    const e = completionEnv();
    const capture = vi.spyOn(e.comm, "captureCompletedResponse");
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    const source = capture.mock.calls[0]?.[1];
    expect(source).toEqual({ kind: "path", path: "/tmp/session.jsonl" });
    expect(source).not.toBe(e.getInfo().agent_session);
    (e.getInfo().agent_session as { kind: "path"; path: string }).path = "/tmp/new-session.jsonl";
    expect(source).toEqual({ kind: "path", path: "/tmp/session.jsonl" });
    e.setAnswer("stale reader answer");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("does not swallow completion that lands synchronously during sendInput and before seed", async () => {
    const e = completionEnv({ sync: true });
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    await e.tick();
    expect(e.finals()).toMatchObject([{ text: "new synchronous answer", source: "delta" }]);
  });

  it("accepts a missed working status and a large state counter gap, not stale idle", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    e.setAnswer("new");
    e.change({ agent_status: "done" }); // presentation change, not a new completion
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.complete(500);
    await e.tick();
    expect(e.finals()).toMatchObject([{ text: "new", reason: "idle" }]);
  });

  it("rejects a complete old/mismatched user boundary instead of replaying it", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("old answer");
    e.mismatch();
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("a metadata read error disables the fast path for the rest of the turn", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.throwMetadata();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.restoreMetadata();
    e.setAnswer("ready");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("waits for persisted current-request output even after fresh metadata", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.setAnswer("persisted later");
    await e.tick();
    expect(e.finals()).toMatchObject([{ text: "persisted later" }]);
  });

  it("does not arm unsupported readers, absent metadata, or non-final mode", async () => {
    for (const opts of [{ capture: false }, { mode: "stream" as const }, {}]) {
      const e = completionEnv(opts);
      if (!Object.keys(opts).length) e.setInfo(null);
      await e.agent.handleMessage("ask");
      expect(e.captured()).toBe(0);
      e.setAnswer("ready");
      if (e.getInfo()) e.complete();
      await e.tick();
      expect(e.finals()).toHaveLength(0);
      e.agent.stop();
      await e.tick();
    }
  });

  it("does not arm when evidence is absent or the session is empty", async () => {
    for (const invalid of ["evidence", "session"] as const) {
      const e = completionEnv();
      if (invalid === "evidence") e.setInfo({ ...e.getInfo(), completion_evidence: undefined });
      else e.change({ agent_session: { kind: "path", path: "" } });
      await e.agent.handleMessage("ask");
      expect(e.captured()).toBe(0);
      e.setAnswer("ready");
      await e.tick();
      expect(e.finals()).toHaveLength(0);
      e.agent.stop();
      await e.tick();
    }
  });

  it("does not arm if metadata changes during capture, and rejects old prompt output", async () => {
    const e = completionEnv();
    const original = e.comm.captureCompletedResponse.bind(e.comm);
    vi.spyOn(e.comm, "captureCompletedResponse").mockImplementation(text => {
      const read = original(text);
      e.change({ completion_evidence: { ...e.getInfo().completion_evidence!, state_change_seq: 1 } });
      return read;
    });
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("old");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it.each(["working", "blocked", "unknown"])("never affirms %s status", async status => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("ready");
    e.complete();
    e.change({ agent_status: status });
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it.each(["screen", "launch"])("requires full authority, not %s", async flag => {
    const e = completionEnv();
    e.change({ completion_evidence: { ...e.getInfo().completion_evidence!,
      ...(flag === "screen" ? { screen_detection_skipped: false } : { launch_pending: true }) } });
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(0);
    e.setAnswer("ready");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it.each(["agent", "pane_id", "terminal_id", "agent_session", "endpoint_identity", "regression", "missing"])(
    "permanently disables fast completion after %s replacement or regression", async field => {
      const e = completionEnv();
      if (field === "regression") e.change({ completion_evidence: { ...e.getInfo().completion_evidence!, state_change_seq: 2 } });
      await e.agent.handleMessage("ask");
      expect(e.captured()).toBe(1);
      const prior = e.getInfo();
      if (field === "agent") e.change({ agent: "omp" });
      if (field === "pane_id") e.change({ pane_id: "other" });
      if (field === "agent_session") e.change({ agent_session: { kind: "path", path: "/other" } });
      if (field === "terminal_id") e.change({ completion_evidence: { ...prior.completion_evidence!, terminal_id: "other" } });
      if (field === "endpoint_identity") e.change({ completion_evidence: { ...prior.completion_evidence!, endpoint_identity: "other" } });
      if (field === "regression") e.change({ completion_evidence: { ...prior.completion_evidence!, state_change_seq: 0, completion_seq: null } });
      if (field === "missing") e.setInfo(null);
      // For regression, first establish an observed counter above baseline.
      await e.tick();
      e.setInfo(prior);
      e.setAnswer("ready");
      e.complete();
      await e.tick();
      expect(e.finals()).toHaveLength(0);
      e.agent.stop();
      await e.tick();
    },
  );

  it("disables the turn after an observed completion counter regresses", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.complete(8);
    await e.tick(); // no output yet; remember completion 8
    expect(e.finals()).toHaveLength(0);
    e.change({ completion_evidence: { ...e.getInfo().completion_evidence!, state_change_seq: 9, completion_seq: 7 } });
    await e.tick();
    e.setAnswer("ready");
    e.complete(10);
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("invalidates a turn before a second input, including one from readiness extraction", async () => {
    const e = completionEnv();
    const original = e.comm.captureCompletedResponse.bind(e.comm);
    vi.spyOn(e.comm, "captureCompletedResponse").mockImplementation(text => {
      const read = original(text);
      return read && (() => { e.agent.handleMessage("second"); return read(); });
    });
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("stale proof");
    e.complete();
    await e.tick();
    expect(e.sent()).toBe(2);
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
    expect(e.finals()).toHaveLength(1);
    expect(e.finals()[0]).toMatchObject({ reason: "aborted" });
  });

  it("rechecks metadata after extraction and permanently rejects a changed candidate", async () => {
    const e = completionEnv();
    const original = e.comm.captureCompletedResponse.bind(e.comm);
    vi.spyOn(e.comm, "captureCompletedResponse").mockImplementation(text => {
      const read = original(text);
      return read && (() => { const result = read(); e.complete(9); return result; });
    });
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("ready");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.complete(10);
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("coalesces a normal second message permanently into fallback, without resending", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    await e.agent.handleMessage("second");
    expect(e.sent()).toBe(2);
    e.setAnswer("new");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
    expect(e.finals()).toHaveLength(1);
  });

  it.each(["stop", "dispose"] as const)("%s invalidates proof and emits only an aborted final", async action => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(1);
    e.setAnswer("ready");
    e.complete();
    e.agent[action]();
    expect(e.finals()).toHaveLength(0);
    await e.tick();
    expect(e.finals()).toMatchObject([{ reason: "aborted" }]);
  });

  it("a follow-only loop stays fallback-only when it receives a new input", async () => {
    const e = completionEnv();
    e.agent.enableFollow(60_000);
    await e.agent.handleMessage("ask");
    expect(e.captured()).toBe(0);
    e.setAnswer("ready");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    e.agent.stop();
    await e.tick();
  });

  it("preserves one final per distinct user boundary even when answers have equal bytes", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    e.setAnswer("same");
    e.complete(8);
    await e.tick();
    expect(e.finals()).toHaveLength(1);
    await Promise.resolve(); // done auto-clears the old controller
    await e.agent.handleMessage("ask");
    e.complete(80);
    await e.tick();
    expect(e.finals()).toHaveLength(2);
    expect(e.finals().map(f => f.text)).toEqual(["same", "same"]);
    expect(e.sent()).toBe(2);
  });

  it("holds a future follow deadline and revalidates proof at the deadline", async () => {
    const e = completionEnv();
    await e.agent.handleMessage("ask");
    e.agent.enableFollow(6000);
    e.setAnswer("ready");
    e.complete();
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    await e.tick();
    expect(e.finals()).toHaveLength(0);
    await e.tick();
    expect(e.finals()).toMatchObject([{ text: "ready", reason: "idle" }]);
  });
});