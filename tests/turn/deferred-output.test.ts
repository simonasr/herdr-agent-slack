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
    communicator, controller, fallback,
    resolve: () => { available = true; },
    finals: () => events.filter(event => event.type === "final"),
    submit(prompt: string) {
      communicator.seedOutputBaseline();
      communicator.sendInput(prompt);
      controller!.markUserInput();
    },
    appendTurn(prompt: string, answer: string, timestamp = Date.now()) {
      appendFileSync(path, [{ role: "user", text: prompt }, { role: "assistant", text: answer }]
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
