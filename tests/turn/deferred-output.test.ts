import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentCommunicator } from "../../src/agent-sessions.js";
import { ClaudeJsonlReader, CodexJsonlReader, DeferredReader } from "../../src/readers/jsonl.js";
import { ObserveLoopController, type OutputEvent } from "../../src/turn/observe-loop-controller.js";

vi.mock("../../src/herdr-client.js", () => ({ sendText: vi.fn() }));

const logger = { info() {}, warn() {}, error() {}, debug() {} };
let dir: string;
let controller: ObserveLoopController | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "deferred-output-"));
});

afterEach(async () => {
  controller?.abort();
  await vi.advanceTimersByTimeAsync(15_000);
  controller = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function makeEnv(agent: "codex" | "claude", opts: {
  finalPayload?: "full-turn" | "last-delta";
  maxTurnMs?: number;
  isAgentBusy?: () => boolean;
} = {}) {
  const path = join(dir, "session.jsonl");
  let available = false;
  const concrete = agent === "codex" ? new CodexJsonlReader(path, logger, "test")
    : new ClaudeJsonlReader(() => path, logger, "test");
  const fallback = { kind: "scrape", read: vi.fn(() => "OLD SCREEN HISTORY") };
  const deferred = new DeferredReader(concrete.kind, true, () => available ? concrete : null, logger, "test", fallback);
  const communicator = new AgentCommunicator(deferred, logger, "test");
  const events: OutputEvent[] = [];
  controller = new ObserveLoopController({
    communicator, emit: event => events.push(event), now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    progressIntervalMs: 15_000, stabilityMs: 30_000, maxTurnMs: opts.maxTurnMs ?? 1_800_000,
    finalPayload: opts.finalPayload ?? "full-turn", isAgentBusy: opts.isAgentBusy,
  });
  return {
    communicator, controller, fallback, events,
    resolve: () => { available = true; },
    finals: () => events.filter(event => event.type === "final"),
    submit(prompt: string) {
      communicator.seedOutputBaseline();
      communicator.sendInput(prompt);
      controller!.markUserInput();
    },
    appendTurn(prompt: string | null, answer: string, timestamp = Date.now()) {
      appendFileSync(path, [...(prompt === null ? [] : [{ role: "user", text: prompt }]), { role: "assistant", text: answer }]
        .map(({ role, text }) => JSON.stringify({ timestamp: new Date(timestamp).toISOString(),
          ...(agent === "codex"
            ? { type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] } }
            : { type: role, message: { role, content: [{ type: "text", text }] } }),
        })).join("\n") + "\n");
    },
    appendCompact() {
      // Existing Claude command-log shapes, not an invented assistant answer.
      appendFileSync(path, ["<command-name>/compact</command-name>", "<local-command-stdout>Compacted</local-command-stdout>"]
        .map(content => JSON.stringify({ type: "user", message: { role: "user", content }, timestamp: new Date().toISOString() }))
        .join("\n") + "\n");
    },
  };
}

describe("deferred submitted output — finalization", () => {
  it.each([
    ["codex", "ceiling"], ["claude", "ceiling"],
    ["codex", "aborted"], ["claude", "aborted"],
  ] as const)("does not replay an old repeated %s prompt on %s", async (agent, reason) => {
    const env = makeEnv(agent, { maxTurnMs: 30_000 });
    env.appendTurn("continue", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("continue");
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.communicator.outputReady).toBe(false);
    if (reason === "aborted") env.controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(env.communicator.getTurnResponse()).toBe("");
    expect(env.finals()).toEqual([{ type: "final", text: "", reason, source: "snapshot" }]);
  });

  it.each([
    ["codex", true], ["claude", true], ["codex", false], ["claude", false],
  ] as const)("retains earlier %s output after a repeated prompt (bridge input: %s)", async (agent, bridgeInput) => {
    const env = makeEnv(agent);
    env.appendTurn("old question", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("continue");
    env.appendTurn("continue", "ANSWER A");
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.communicator.outputReady).toBe(true);
    expect(env.communicator.getTurnResponse()).toBe("ANSWER A");
    if (bridgeInput) {
      env.communicator.sendInput("continue");
      env.controller.markUserInput();
    }
    env.appendTurn("continue", "ANSWER B");
    await vi.advanceTimersByTimeAsync(45_000);
    await done;
    expect(env.communicator.getTurnResponse()).toBe("ANSWER A\n\nANSWER B");
    expect(env.finals()).toEqual([{ type: "final", text: "ANSWER A\n\nANSWER B", reason: "idle", source: "delta" }]);
  });

  it.each([
    ["codex", "idle", "full-turn"], ["claude", "idle", "full-turn"],
    ["codex", "ceiling", "full-turn"], ["claude", "ceiling", "full-turn"],
    ["codex", "aborted", "full-turn"], ["claude", "aborted", "full-turn"],
    ["codex", "idle", "last-delta"], ["claude", "idle", "last-delta"],
    ["codex", "ceiling", "last-delta"], ["claude", "ceiling", "last-delta"],
    ["codex", "aborted", "last-delta"], ["claude", "aborted", "last-delta"],
  ] as const)("does not replay %s history for an empty URL-leading prompt on %s in %s mode", async (agent, reason, finalPayload) => {
    const env = makeEnv(agent, { maxTurnMs: reason === "ceiling" ? 30_000 : 1_800_000, finalPayload });
    env.appendTurn("old question", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("<https://example.com/review> review this");
    env.appendTurn("<https://example.com/review> review this", "");
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.communicator.outputReady).toBe(true);
    expect(env.communicator.getTurnResponse()).toBe("");
    if (reason === "aborted") env.controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: "", reason, source: "snapshot" }]);
  });

  it.each([
    ["codex", "full-turn"], ["claude", "full-turn"],
    ["codex", "last-delta"], ["claude", "last-delta"],
  ] as const)("retains a late %s answer after an empty match in %s mode", async (agent, finalPayload) => {
    const env = makeEnv(agent, { finalPayload });
    env.appendTurn("old question", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("<https://example.com/review> review this");
    env.appendTurn("<https://example.com/review> review this", "");
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.communicator.outputReady).toBe(true);
    env.appendTurn(null, "CURRENT ANSWER");
    env.controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: "CURRENT ANSWER", reason: "aborted", source: finalPayload === "full-turn" ? "delta" : "snapshot" }]);
  });

  it.each([
    ["codex", "full-turn", false], ["claude", "full-turn", false],
    ["codex", "last-delta", false], ["claude", "last-delta", false],
    ["codex", "full-turn", true], ["claude", "full-turn", true],
    ["codex", "last-delta", true], ["claude", "last-delta", true],
  ] as const)("recovers unmatched %s output on abort in %s mode (source resolved early: %s)", async (agent, finalPayload, earlySource) => {
    const env = makeEnv(agent, { finalPayload });
    env.appendTurn("continue", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("continue");
    if (earlySource) env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.communicator.outputReady).toBe(false);
    env.appendTurn("continue", "CURRENT ANSWER");
    env.resolve();
    env.controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: "CURRENT ANSWER", reason: "aborted", source: finalPayload === "full-turn" ? "delta" : "snapshot" }]);
    expect(env.events.filter(event => event.type === "delta")).toEqual([]);
    // Final readback is pure: it neither opens the polling fence nor consumes output.
    expect(env.communicator.outputReady).toBe(false);
    expect(env.communicator.getNewOutput()).toBe("CURRENT ANSWER");
    expect(env.communicator.getNewOutput()).toBe("");
  });

  it.each(["codex", "claude"] as const)("keeps old repeated %s history fenced on streaming abort", async agent => {
    const env = makeEnv(agent, { finalPayload: "last-delta" });
    env.appendTurn("continue", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("continue");
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    env.resolve();
    env.controller.abort();
    await vi.advanceTimersByTimeAsync(15_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: "", reason: "aborted", source: "snapshot" }]);
    expect(env.communicator.outputReady).toBe(false);
  });

  it.each(["full-turn", "last-delta"] as const)("keeps a screen answer when abort readback resolves the fallback in %s mode", async finalPayload => {
    const env = makeEnv("codex", { finalPayload, isAgentBusy: () => true });
    env.fallback.read.mockReturnValue("› current question\nCURRENT SCREEN ANSWER\n› unrelated question\nUNRELATED ANSWER");
    env.submit("current question");
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(91_000);
    expect(env.communicator.sourceReady).toBe(false);
    env.controller.abort();
    await vi.advanceTimersByTimeAsync(14_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: "CURRENT SCREEN ANSWER", reason: "aborted", source: "snapshot" }]);
    expect(env.events.filter(event => event.type === "delta")).toEqual([]);
    expect(env.communicator.readerKind).toBe("scrape");
  });

  it.each(["full-turn", "last-delta"] as const)("bounds an unmatched command wait in %s mode without releasing old history", async finalPayload => {
    const env = makeEnv("claude", { finalPayload });
    env.appendTurn("earlier question", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("/compact");
    env.appendCompact();
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(env.finals()).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.finals()).toEqual([{ type: "final", text: "", reason: "idle", source: "snapshot" }]);
    await done;
    expect(env.communicator.outputReady).toBe(false);
    expect(env.communicator.getNewOutput()).toBe("");
    expect(env.fallback.read).not.toHaveBeenCalled();
  });

  it("starts the unmatched-prompt grace when the source resolves, not at dispatch", async () => {
    const env = makeEnv("claude");
    env.submit("/compact");
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(75_000);
    env.appendCompact();
    env.resolve();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(env.finals()).toEqual([]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(env.finals()).toMatchObject([{ reason: "idle", text: "" }]);
    await done;
    expect(env.fallback.read).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a busy pane open beyond the grace, then settles with a current answer: %s", async hasAnswer => {
    let busy = true;
    const env = makeEnv("codex", { isAgentBusy: () => busy });
    env.appendTurn("old question", "OLD HISTORICAL ANSWER", Date.now() - 10_000);
    env.submit("current question");
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(env.finals()).toEqual([]);
    if (hasAnswer) env.appendTurn("current question", "CURRENT ANSWER");
    busy = false;
    await vi.advanceTimersByTimeAsync(45_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: hasAnswer ? "CURRENT ANSWER" : "", reason: "idle", source: hasAnswer ? "delta" : "snapshot" }]);
  });

  it("gives additional input its own unmatched grace without losing an answer arriving within it", async () => {
    const env = makeEnv("claude");
    env.submit("/compact");
    env.appendCompact();
    env.resolve();
    const done = env.controller.start();
    await vi.advanceTimersByTimeAsync(75_000);
    env.communicator.sendInput("second question");
    env.controller.markUserInput();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(env.finals()).toEqual([]);
    env.appendTurn("second question", "CURRENT ANSWER");
    await vi.advanceTimersByTimeAsync(45_000);
    await done;
    expect(env.finals()).toEqual([{ type: "final", text: "CURRENT ANSWER", reason: "idle", source: "delta" }]);
  });
});
