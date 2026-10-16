import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentInfo } from "../src/herdr-client.js";
import type { SlackClientDeps, SlackThread, ThreadMessage } from "../src/slack-client.js";

const mocks = vi.hoisted(() => ({
  live: null as AgentInfo | null,
  home: "",
  screen: "",
  client: undefined as SlackClientDeps | undefined,
  extraPanes: [] as Array<{ pane_id: string; label: string; agent: string; status: string }>,
  post: vi.fn(async (_thread: SlackThread, _text: string) => "answer-ts"),
  status: vi.fn(async () => {}),
  upload: vi.fn(async (_thread: SlackThread, _path: string, _name: string, _title: string) => {}),
  history: vi.fn(async (): Promise<ThreadMessage[]> => []),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
}));

vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => mocks.home,
}));

vi.mock("../src/herdr-client.js", async (original) => ({
  ...await original<typeof import("../src/herdr-client.js")>(),
  getAgentInfo: vi.fn(() => mocks.live),
  getAgentInfoAsync: vi.fn(async () => mocks.live),
  getAgents: vi.fn(() => [
    { pane_id: "w1:p1", label: "project", agent: mocks.live?.agent ?? "pi", status: mocks.live?.agent_status ?? "idle" },
    ...mocks.extraPanes,
  ]),
  readPane: vi.fn(() => mocks.screen),
  sendText: vi.fn(),
}));

vi.mock("../src/slack-client.js", async (original) => ({
  ...await original<typeof import("../src/slack-client.js")>(),
  SlackClient: class {
    constructor(deps: SlackClientDeps) { mocks.client = deps; }
    threadHistory = mocks.history;
    rename = vi.fn(async () => {});
    start = mocks.start;
    stop = mocks.stop;
    post = mocks.post;
    setStatus = mocks.status;
    upload = mocks.upload;
    react = vi.fn(async () => {});
    unreact = vi.fn(async () => {});
  },
}));

// PaneAgent, ObserveLoopController and the Pi reader are all real here.
import { startSlackDaemon } from "../src/slack-daemon.js";
import { sendText } from "../src/herdr-client.js";

let dir: string;
let oldPath: string;
let daemon: Awaited<ReturnType<typeof startSlackDaemon>> | undefined;
const thread = { channel: "C1", threadTs: "1.0" };

function message(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
}

function codexTurn(prompt: string, answer = ""): string {
  return [
    { role: "user", text: prompt },
    ...(answer ? [{ role: "assistant", text: answer }] : []),
  ].map(({ role, text }) => JSON.stringify({
    type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
  })).join("\n") + "\n";
}

function codexTurnAt(prompt: string, answer: string, timestamp: number): string {
  return codexTurn(prompt, answer).trimEnd().split("\n")
    .map(line => JSON.stringify({ ...JSON.parse(line), timestamp: new Date(timestamp).toISOString() })).join("\n") + "\n";
}

function liveSession(path: string, status = "working"): AgentInfo {
  return {
    agent: "pi", agent_status: status, pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1",
    agent_session: { kind: "path", path },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "slack-session-integration-"));
  mocks.home = dir;
  mocks.screen = "";
  mocks.client = undefined;
  mocks.extraPanes.length = 0;
  writeFileSync(join(dir, "config.toml"), '[slack]\nbot_token = "test"\napp_token = "test"\nallowed_user_ids = ["U1"]\nprogress_interval_ms = 100\nstability_window_ms = 100\n');
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    threads: { "default|C1:1.0": {
      bot: "default", pane_id: "w1:p1", label: "project", agent: "pi", channel: "C1", thread_ts: "1.0",
      context_sent: true, note_version: 999, last_active: Date.now(),
    } },
  }));
  oldPath = join(dir, "old.jsonl");
  writeFileSync(oldPath, message("old unrelated history"));
  mocks.live = liveSession(oldPath);
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  // Disposal aborts a sleeping loop; let its callback run before removing fixtures.
  await vi.advanceTimersByTimeAsync(100);
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("Slack session routing — real observe loops", () => {
  it.each([
    ["❯", "repeat"], ["›", "repeat"],
    ["❯", "absent"], ["›", "absent"],
    ["❯", "blockquote"], ["›", "blockquote"],
    ["❯", "shell"], ["›", "shell"],
  ] as const)("bounds ordered %s screen readback for %s later input", async (marker, scenario) => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "final"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const first = scenario === "repeat" ? "continue" : "first question";
    const later = scenario === "repeat" ? "status?" : "second\n\nquestion";
    const quotedInput = scenario === "absent" ? "second question\n> second question\n$ second question" :
      `${scenario === "blockquote" ? "> " : scenario === "shell" ? "$ " : ""}second question`;
    const firstAnswer = scenario === "repeat" ? "FIRST CURRENT ANSWER" : `FIRST CURRENT ANSWER\n${quotedInput}\nKEEP THE REST`;
    await mocks.client!.onUserMessage(thread, "U1", first, "2.0");
    mocks.live = { ...mocks.live!, agent_status: "working" };
    const initialScreen = `${marker} ${first}\n\n${firstAnswer}`;
    mocks.screen = initialScreen;
    await vi.advanceTimersByTimeAsync(90_100);
    expect(mocks.post).not.toHaveBeenCalled();
    await mocks.client!.onUserMessage(thread, "U1", later, "3.0");
    mocks.screen = scenario === "absent" ? initialScreen : `${initialScreen}\n\n${marker} ${later}\n\nSECOND CURRENT ANSWER`;
    if (scenario === "repeat") {
      await mocks.client!.onUserMessage(thread, "U1", first, "4.0");
      mocks.screen += `\n\n${marker} ${first}\n\nTHIRD CURRENT ANSWER`;
    }
    expect(sendText).toHaveBeenCalledTimes(scenario === "repeat" ? 3 : 2);
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    // Repeated screen echoes still have no timestamp identity; retain each latest answer once, in send order.
    const expected = scenario === "repeat" ? "SECOND CURRENT ANSWER\n\nTHIRD CURRENT ANSWER" :
      scenario === "absent" ? firstAnswer : `${firstAnswer}\n\nSECOND CURRENT ANSWER`;
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, expected.replaceAll(">", "&gt;"));
  });

  it.each([
    ["❯", 1], ["›", 1], ["❯", 2], ["›", 2],
  ] as const)("includes later input in a %s fallback full-turn readback with %s additional prompts", async (marker, extra) => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "final"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const prompts = ["first question", "second\n\nquestion", "third question"].slice(0, extra + 1);
    const answers = ["FIRST CURRENT ANSWER\nsecond question\nstill part of the first answer", "SECOND CURRENT ANSWER", "THIRD CURRENT ANSWER"].slice(0, extra + 1);
    await mocks.client!.onUserMessage(thread, "U1", prompts[0], "2.0");
    mocks.live = { ...mocks.live!, agent_status: "working" };
    mocks.screen = `${marker} historical question\n\nOLD HISTORICAL ANSWER\n\n${marker} ${prompts[0]}\n\n${answers[0]}`;
    await vi.advanceTimersByTimeAsync(90_100);
    expect(mocks.post).not.toHaveBeenCalled();
    for (let i = 1; i < prompts.length; i++) await mocks.client!.onUserMessage(thread, "U1", prompts[i], `${i + 2}.0`);
    expect(sendText).toHaveBeenCalledTimes(prompts.length);
    mocks.screen = `${marker} historical question\n\nOLD HISTORICAL ANSWER\n\n` +
      prompts.map((prompt, i) => `${marker} ${prompt}\n\n${answers[i]}`).join("\n\n");
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, answers.join("\n\n"));
  });

  it("does not replay an earlier screen answer when a missing rollout falls back in stream mode", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(sendText).mock.calls[0][1];
    mocks.screen = `› historical question\n\nOLD HISTORICAL ANSWER\n\n› ${prompt}\n\nCURRENT ANSWER`;
    await vi.advanceTimersByTimeAsync(91_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "CURRENT ANSWER");
  });

  it.each(["stream", "final"] as const)("retains both duplicate pending answers in %s mode with identical historical prompts", async mode => {
    appendFileSync(join(dir, "config.toml"), `output_mode = "${mode}"\n`);
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "duplicate-pending" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "continue", "2.0");
    await mocks.client!.onUserMessage(thread, "U1", "continue", "3.0");
    expect(sendText).toHaveBeenCalledTimes(2);
    const prompt = vi.mocked(sendText).mock.calls[0][1];
    expect(vi.mocked(sendText).mock.calls[1][1]).toBe(prompt);
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-duplicate-pending.jsonl"),
      codexTurn(prompt, "OLD HISTORICAL ANSWER") + codexTurn(prompt, "FIRST CURRENT ANSWER") + codexTurn(prompt, "SECOND CURRENT ANSWER"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "FIRST CURRENT ANSWER\n\nSECOND CURRENT ANSWER");
  });

  it.each([
    ["coalesced", "stream"], ["separate", "stream"],
    ["coalesced", "final"], ["separate", "final"],
  ] as const)("excludes timestamped historical repetitions for %s duplicate inputs in %s mode", async (logging, mode) => {
    appendFileSync(join(dir, "config.toml"), `output_mode = "${mode}"\n`);
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "timestamped-inputs" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const submittedAt = Date.now();
    await mocks.client!.onUserMessage(thread, "U1", "continue", "2.0");
    await mocks.client!.onUserMessage(thread, "U1", "continue", "3.0");
    expect(sendText).toHaveBeenCalledTimes(2);
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-timestamped-inputs.jsonl"),
      codexTurnAt("continue", "OLD HISTORICAL ANSWER", submittedAt - 10_000) +
      codexTurnAt("continue", "FIRST CURRENT ANSWER", submittedAt) +
      (logging === "separate" ? codexTurnAt("continue", "SECOND CURRENT ANSWER", submittedAt) : ""));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread,
      logging === "separate" ? "FIRST CURRENT ANSWER\n\nSECOND CURRENT ANSWER" : "FIRST CURRENT ANSWER");
  });

  it.each(["stream", "final"] as const)("does not use an old-only fallback screen as the %s final snapshot", async mode => {
    appendFileSync(join(dir, "config.toml"), `output_mode = "${mode}"\n`);
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    mocks.screen = "› historical question\n\nOLD HISTORICAL ANSWER";
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    await vi.advanceTimersByTimeAsync(91_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "✅ Done (no output).");
  });

  it("bounds the first nonempty fallback screen after an empty fallback selection", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    mocks.live = { ...mocks.live!, agent_status: "working" };
    await vi.advanceTimersByTimeAsync(90_100);
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.screen = "› historical question\n\nOLD HISTORICAL ANSWER\n\n› current question\n\nCURRENT ANSWER";
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "CURRENT ANSWER");
  });

  it("retains literal fallback diffs after the submitted prompt scrolls offscreen", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    mocks.live = { ...mocks.live!, agent_status: "working" };
    mocks.screen = "› historical question\n\nOLD HISTORICAL ANSWER\n\n› current question\n\nCURRENT PREFIX";
    await vi.advanceTimersByTimeAsync(90_100);
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.screen = "CURRENT PREFIX\nCURRENT SUFFIX";
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "CURRENT SUFFIX");
  });

  it("waits for a missing known Codex rollout before delivering the bounded screen fallback", async () => {
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "missing-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "screen-only question", "2.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(sendText).mock.calls[0][1];
    mocks.screen = `› ${prompt}\n\nreply available only on screen`;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "reply available only on screen");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("delivers a known Codex rollout that appears while an idle reader is waiting", async () => {
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "late-rollout" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "late transcript question", "2.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    const prompt = vi.mocked(sendText).mock.calls[0][1];
    mocks.screen = `› ${prompt}\n\nstale screen answer`;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.post).not.toHaveBeenCalled();

    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-late-rollout.jsonl"), codexTurn(prompt, "answer from the exact rollout"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "answer from the exact rollout");
  });

  it("excludes historical answers when a delayed Codex rollout resolves in stream mode", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "late-history" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![1];
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-late-history.jsonl"),
      codexTurn("historical question", "historical answer must not replay") + codexTurn(prompt, "current answer"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "current answer");
  });

  it("waits for the submitted prompt when a delayed rollout initially contains only history", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "history-first" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![1];
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "rollout-history-first.jsonl");
    writeFileSync(path, codexTurn("historical question", "historical answer must not replay"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    appendFileSync(path, codexTurn(prompt, "current answer after history"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "current answer after history");
  });

  it.each(["final", "stream"] as const)("retains a cumulative Pi reply arriving during dispatch in %s mode", async mode => {
    appendFileSync(join(dir, "config.toml"), `output_mode = "${mode}"\n`);
    mocks.live = liveSession(oldPath, "idle");
    vi.mocked(sendText).mockImplementationOnce(() => { appendFileSync(oldPath, message("fast current reply")); });
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "fast question", "2.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "fast current reply");
  });

  it.each([
    ["coalesced", "stream"], ["separate", "stream"],
    ["coalesced", "final"], ["separate", "final"],
  ] as const)("retains delayed answers for %s inputs in %s mode through the same active loop", async (mode, outputMode) => {
    appendFileSync(join(dir, "config.toml"), `output_mode = "${outputMode}"\n`);
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "pending-inputs" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "first question", "2.0");
    await mocks.client!.onUserMessage(thread, "U1", "additional question", "3.0");
    expect(sendText).toHaveBeenCalledTimes(2);
    const first = vi.mocked(sendText).mock.calls[0][1];
    const second = vi.mocked(sendText).mock.calls[1][1];
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-pending-inputs.jsonl"),
      codexTurn("historical question", "old answer must not replay") +
      codexTurn(first, "first current answer") + (mode === "separate" ? codexTurn(second, "second current answer") : ""));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread,
      mode === "separate" ? "first current answer\n\nsecond current answer" : "first current answer");
  });

  it("does not consume an active observer's unread output when another input is sent", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    appendFileSync(oldPath, message("unread terminal output"));
    vi.mocked(sendText).mockImplementationOnce(() => { appendFileSync(oldPath, message("fast current reply")); });
    await mocks.client!.onUserMessage(thread, "U1", "additional question", "2.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    mocks.live = liveSession(oldPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "unread terminal output\n\nfast current reply");
  });

  it("reseeds before a later inactive input without replaying output between turns", async () => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    vi.mocked(sendText).mockImplementationOnce(() => { appendFileSync(oldPath, message("first fast reply")); });
    await mocks.client!.onUserMessage(thread, "U1", "first question", "2.0");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "first fast reply");
    appendFileSync(oldPath, message("historical output between inactive turns"));
    vi.mocked(sendText).mockImplementationOnce(() => { appendFileSync(oldPath, message("second fast reply")); });
    await mocks.client!.onUserMessage(thread, "U1", "second question", "3.0");
    await vi.advanceTimersByTimeAsync(300);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenNthCalledWith(2, thread, "second fast reply");
  });

  it("honors the hard ceiling without using unmatched delayed history as a snapshot", async () => {
    appendFileSync(join(dir, "config.toml"), 'max_total_wait_s = 1\n');
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "ceiling-history" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "current question", "2.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-ceiling-history.jsonl"), codexTurn("old question", "historical answer"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "✅ Done (no output).");
  });

  it("preserves last-delta delivery for an ordinary anchored stream-mode question", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, "rollout-stream-anchor.jsonl");
    writeFileSync(path, "");
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "stream-anchor" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "stream question", "2.0");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![1];
    mocks.live = { ...mocks.live!, agent_status: "working" };
    writeFileSync(path, codexTurn(prompt, "answer prefix"));
    await vi.advanceTimersByTimeAsync(100);
    appendFileSync(path, JSON.stringify({ type: "response_item", payload: {
      type: "message", role: "assistant", content: [{ type: "text", text: "answer suffix" }],
    } }) + "\n");
    await vi.advanceTimersByTimeAsync(100);
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "answer suffix");
  });

  it("does not replay a quiet Pi session's cumulative history", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await vi.advanceTimersByTimeAsync(100);
    mocks.live = liveSession(oldPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "✅ Done (no output).");
  });

  it("still delivers newly appended output without replacing a session", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    appendFileSync(oldPath, message("new reply in the same session"));
    mocks.live = liveSession(oldPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "new reply in the same session");
  });
});
