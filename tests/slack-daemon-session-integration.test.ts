import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { getAgentInfoAsync, sendText } from "../src/herdr-client.js";

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
  it.each(["dispatched", "restored", "delivered"])("preserves only owed debt when a follow-up is canceled during shutdown, prior=%s", async (prior) => {
    mocks.live = liveSession(oldPath, "working");
    if (prior === "restored") {
      writeFileSync(join(dir, "pending-turns.json"), JSON.stringify([{ pane_id: "w1:p1", started_at: new Date().toISOString() }]));
    }
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    if (prior !== "restored") await mocks.client!.onUserMessage(thread, "U1", "already dispatched", "2.0");
    expect(sendText).toHaveBeenCalledTimes(prior === "restored" ? 0 : 1);
    if (prior === "delivered") {
      appendFileSync(oldPath, message("first question answered"));
      mocks.live = liveSession(oldPath, "idle");
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "first question answered");
      expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    }
    let releaseStatus!: () => void;
    let releaseStop!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise<void>(resolve => { releaseStatus = resolve; }));
    const followup = mocks.client!.onUserMessage(thread, "U1", "unsent follow-up", "2.1");
    await vi.advanceTimersByTimeAsync(0);
    mocks.stop.mockImplementationOnce(() => new Promise<void>(resolve => { releaseStop = resolve; }));
    const stopping = daemon.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.stop).toHaveBeenCalledOnce();
    releaseStatus();
    await followup;
    const owed = JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"));
    releaseStop();
    await stopping;
    daemon = undefined;
    expect(vi.mocked(sendText).mock.calls).toEqual(prior === "restored" ? [] : [["w1:p1", "already dispatched"]]);
    expect(owed).toEqual(prior === "delivered" ? [] : [expect.objectContaining({ pane_id: "w1:p1" })]);
  });

  it("reserves Q1 before Slack setup so Q2 cannot send first", async () => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = mocks.client!.onUserMessage(thread, "U1", "first before setup", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toBeTypeOf("function");
    const second = mocks.client!.onUserMessage(thread, "U1", "second past setup", "2.1");
    await vi.advanceTimersByTimeAsync(0);
    // Both handlers have reached setup: Q2 has finished its status and mark,
    // but it cannot overtake the earlier reservation before Q1 is released.
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendText)).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect(vi.mocked(sendText).mock.calls).toEqual([
      ["w1:p1", "first before setup"], ["w1:p1", "second past setup"],
    ]);
  });

  it("does not let a failed setup release a later dispatch ahead of an older one", async () => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const previous = mocks.live;
    let release!: (value: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = mocks.client!.onUserMessage(thread, "U1", "first pending question", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    mocks.status.mockRejectedValueOnce(new Error("Slack setup failed"));
    await expect(mocks.client!.onUserMessage(thread, "U1", "failed question", "2.1")).rejects.toThrow("Slack setup failed");
    const third = mocks.client!.onUserMessage(thread, "U1", "third pending question", "2.2");
    await vi.advanceTimersByTimeAsync(0);
    expect(sendText).not.toHaveBeenCalled();
    release(previous);
    await Promise.all([first, third]);
    expect(vi.mocked(sendText).mock.calls).toEqual([
      ["w1:p1", "first pending question"], ["w1:p1", "third pending question"],
    ]);
  });

  it("keeps A's dispatched answer observable when B rebinds its unchanged shared pane", async () => {
    const other = { channel: "C2", threadTs: "2.0" };
    const statePath = join(dir, "state.json");
    const initial = JSON.parse(readFileSync(statePath, "utf8"));
    initial.threads["default|C2:2.0"] = {
      ...initial.threads["default|C1:1.0"], channel: other.channel, thread_ts: other.threadTs,
    };
    writeFileSync(statePath, JSON.stringify(initial));
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    expect(JSON.parse(readFileSync(statePath, "utf8")).threads["default|C2:2.0"].pane_id).toBe("w1:p1");

    await mocks.client!.onUserMessage(thread, "U1", "A's dispatched question", "3.0");
    expect(vi.mocked(sendText).mock.calls).toEqual([["w1:p1", "A's dispatched question"]]);
    const before = JSON.parse(readFileSync(statePath, "utf8"));
    expect(before.asked_from["w1:p1"]).toBe("default|C1:1.0");
    expect(before.marked["w1:p1"].ts).toBe("3.0");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    mocks.live = liveSession(oldPath, "working");
    await vi.advanceTimersByTimeAsync(100);

    await mocks.client!.onUserMessage(other, "U1", "!bind project", "4.0");
    const rebound = JSON.parse(readFileSync(statePath, "utf8"));
    expect(rebound.threads["default|C2:2.0"].pane_id).toBe("w1:p1");
    expect(rebound.asked_from["w1:p1"]).toBe("default|C1:1.0");
    expect(rebound.marked["w1:p1"].ts).toBe("3.0");
    expect(mocks.live!.agent_session).toEqual({ kind: "path", path: oldPath });
    expect(vi.mocked(sendText).mock.calls).toEqual([["w1:p1", "A's dispatched question"]]);

    appendFileSync(oldPath, message("answer after B's rebind"));
    mocks.live = liveSession(oldPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post.mock.calls.filter(([, text]) => text === "answer after B's rebind"))
      .toEqual([[thread, "answer after B's rebind"]]);
    expect(vi.mocked(sendText).mock.calls).toEqual([["w1:p1", "A's dispatched question"]]);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    const settled = JSON.parse(readFileSync(statePath, "utf8"));
    expect(settled.marked["w1:p1"]).toBeUndefined();
    expect(settled.asked_from["w1:p1"]).toBe("default|C1:1.0");
  });

  it.each(["idle", "working"])("leaves %s startup debt to an incoming Slack turn that is still in setup", async (status) => {
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.threads["default|C1:1.0"].context_sent = false;
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(join(dir, "pending-turns.json"), JSON.stringify([{ pane_id: "w1:p1", started_at: new Date().toISOString() }]));
    mocks.live = liveSession(oldPath, status);
    let release!: (value: ThreadMessage[]) => void;
    let sending!: Promise<void>;
    mocks.history.mockImplementationOnce(() => new Promise<ThreadMessage[]>(resolve => { release = resolve; }));
    mocks.start.mockImplementationOnce(async () => {
      // The socket accepts a message before startup's pending-turn resumption.
      sending = mocks.client!.onUserMessage(thread, "U1", "new question during startup", "2.0");
      await vi.advanceTimersByTimeAsync(0);
    });
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    expect(mocks.history).toHaveBeenCalledOnce();
    mocks.live = liveSession(oldPath, "idle");
    appendFileSync(oldPath, message("unrelated answer during startup"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, "utf8")).marked["w1:p1"].ts).toBe("2.0");
    release([]);
    await sending;
    appendFileSync(oldPath, message("answer to the new startup question"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "answer to the new startup question");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });


});
