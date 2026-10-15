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
  history: vi.fn(async (): Promise<ThreadMessage[]> => []),
}));

vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => mocks.home,
}));

vi.mock("../src/herdr-client.js", async (original) => ({
  ...await original<typeof import("../src/herdr-client.js")>(),
  getAgentInfo: vi.fn(() => mocks.live),
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
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    post = mocks.post;
    setStatus = mocks.status;
    react = vi.fn(async () => {});
    unreact = vi.fn(async () => {});
  },
}));

// PaneAgent, ObserveLoopController and the Pi reader are all real here.
import { startSlackDaemon } from "../src/slack-daemon.js";
import { PaneAgent } from "../src/pane-agent.js";

let dir: string;
let oldPath: string;
let daemon: Awaited<ReturnType<typeof startSlackDaemon>> | undefined;
const thread = { channel: "C1", threadTs: "1.0" };

function message(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
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
  it("keeps a deferred reader and its first answer when initial session metadata arrives", async () => {
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: undefined };
    const disposed = vi.spyOn(PaneAgent.prototype, "dispose");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "first question", "2.0");
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-first-session.jsonl"), [
      { role: "user", text: "first question" },
      { role: "assistant", text: "the complete first answer" },
    ].map(({ role, text }) => JSON.stringify({
      type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
    })).join("\n") + "\n");
    mocks.live = { ...mocks.live!, agent_session: { kind: "id", id: "first-session" } };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "the complete first answer");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(disposed).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it.each(["unreachable", "Pi without session"])("upgrades a scrape reader created with %s metadata instead of replaying its screen", async (missing) => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    mocks.live = missing === "unreachable" ? null : { ...liveSession(oldPath, "idle"), agent_session: undefined };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "a quiet question", "2.0");
    mocks.screen = "old screen history must not be replayed";
    mocks.live = liveSession(oldPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    await mocks.client!.onUserMessage(thread, "U1", "a fresh question", "3.0");
    appendFileSync(oldPath, message("fresh structured answer"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "fresh structured answer");
  });

  it("switches agent kinds before the replacement receives its first session identity", async () => {
    const disposed = vi.spyOn(PaneAgent.prototype, "dispose");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: undefined };
    await mocks.client!.onUserMessage(thread, "U1", "first codex question", "2.0");
    expect(disposed).toHaveBeenCalledOnce();
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-agent-swap.jsonl"), [
      { role: "user", text: "first codex question" },
      { role: "assistant", text: "first answer after the agent swap" },
    ].map(({ role, text }) => JSON.stringify({
      type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
    })).join("\n") + "\n");
    mocks.live = { ...mocks.live!, agent_session: { kind: "id", id: "agent-swap" } };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "first answer after the agent swap");
    expect(disposed).toHaveBeenCalledOnce();
  });

  it.each([true, false])("recovers only a matching late-named answer, terminal watcher=%s", async (watcher) => {
    appendFileSync(join(dir, "config.toml"), `relay_terminal_turns = ${watcher}\n`);
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const turn = (prompt: string, answer: string): string => [
      { role: "user", text: prompt }, { role: "assistant", text: answer },
    ].map(({ role, text }) => JSON.stringify({
      type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
    })).join("\n") + "\n";
    writeFileSync(join(sessions, "rollout-prior-codex.jsonl"), turn("old question", "old answer"));
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: { kind: "id", id: "prior-codex" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "!last", "1.1");
    mocks.post.mockClear();
    mocks.live = { ...mocks.live, agent_session: undefined };
    await mocks.client!.onUserMessage(thread, "U1", "new question", "2.0");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    writeFileSync(join(sessions, "rollout-current-codex.jsonl"), turn("new question", "the first fresh answer"));
    mocks.live = { ...mocks.live, agent_session: { kind: "id", id: "current-codex" } };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "the first fresh answer");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked).toEqual({});
    // A different session's unrelated answer must still not settle a question.
    mocks.post.mockClear();
    mocks.live = { ...mocks.live, agent_session: undefined };
    await mocks.client!.onUserMessage(thread, "U1", "another new question", "3.0");
    await vi.advanceTimersByTimeAsync(300);
    writeFileSync(join(sessions, "rollout-unrelated-codex.jsonl"), turn("someone else's question", "unrelated answer"));
    mocks.live = { ...mocks.live, agent_session: { kind: "id", id: "unrelated-codex" } };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it.each(["unreachable", "missing session"])("retries a withheld final after %s metadata recovers, even without the watcher", async (missing) => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "new question", "2.0");
    appendFileSync(oldPath, message("answer retained through metadata outage"));
    mocks.live = missing === "unreachable" ? null : { ...mocks.live!, agent_session: undefined };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.live = liveSession(oldPath, "idle");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "answer retained through metadata outage");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked).toEqual({});
  });

  it.each(["unreachable", "missing session"])("bounds the delivery wait when %s metadata never returns", async (missing) => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\nmax_total_wait_s = 1\n");
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const idleTimers = vi.getTimerCount();
    await mocks.client!.onUserMessage(thread, "U1", "a question before exit", "2.0");
    appendFileSync(oldPath, message("unverifiable answer"));
    mocks.live = missing === "unreachable" ? null : { ...mocks.live!, agent_session: undefined };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked).toEqual({});
    expect(mocks.status).toHaveBeenCalledWith(thread, "");
    expect(vi.getTimerCount()).toBe(idleTimers);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each(["before setup", "during history"])("retains a new question when idle replacement arrives %s", async (when) => {
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.threads["default|C1:1.0"].context_sent = false;
    writeFileSync(statePath, JSON.stringify(state));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const newPath = join(dir, "replacement.jsonl");
    writeFileSync(newPath, message("replacement history"));
    if (when === "before setup") mocks.live = liveSession(newPath, "idle");
    let release!: (value: ThreadMessage[]) => void;
    mocks.history.mockImplementationOnce(() => new Promise<ThreadMessage[]>(resolve => { release = resolve; }));
    const sending = mocks.client!.onUserMessage(thread, "U1", "pending new question", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.history).toHaveBeenCalledOnce();
    if (when === "during history") mocks.live = liveSession(newPath, "idle");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, "utf8")).marked["w1:p1"].ts).toBe("2.0");
    expect(mocks.status).not.toHaveBeenCalledWith(thread, "");
    expect(mocks.post).not.toHaveBeenCalled();
    release([]);
    await sending;
    appendFileSync(newPath, message("reply to the new question"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "reply to the new question");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it("settles an idle replacement on a stale final even with the watcher disabled", async () => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "a pending question", "2.0");
    const newPath = join(dir, "idle.jsonl");
    writeFileSync(newPath, message("unrelated idle history"));
    mocks.live = liveSession(newPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked).toEqual({});
  });

  it.each(["idle replacement", "unbind", "rebind"])("settles an abandoned turn on %s without posting retired output", async (action) => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "a pending question", "2.0");
    mocks.post.mockClear();
    if (action === "idle replacement") {
      const newPath = join(dir, "new.jsonl");
      writeFileSync(newPath, message("unrelated new session history"));
      mocks.live = liveSession(newPath, "idle");
    } else if (action === "unbind") {
      await mocks.client!.onUserMessage(thread, "U1", "!unbind", "3.0");
    } else {
      mocks.extraPanes.push({ pane_id: "w1:p2", label: "other", agent: "pi", status: "idle" });
      await mocks.client!.onUserMessage(thread, "U1", "!bind other", "3.0");
    }
    await vi.advanceTimersByTimeAsync(5_300);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.marked["w1:p1"]).toBeUndefined();
    expect(mocks.status).toHaveBeenCalledWith(thread, "");
    expect(mocks.post.mock.calls.every(([, text]) => !text.includes("history") && !text.includes("Stopped."))).toBe(true);
    if (action === "idle replacement") expect(mocks.post).not.toHaveBeenCalled();
    if (action === "unbind") expect(state.threads["default|C1:1.0"]).toBeUndefined();
    if (action === "rebind") expect(state.threads["default|C1:1.0"].pane_id).toBe("w1:p2");
  });

  it("ignores old-session output and aborted finals without settling the replacement, then delivers new output", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await vi.advanceTimersByTimeAsync(100);
    const newPath = join(dir, "new.jsonl");
    writeFileSync(newPath, message("new session history already on disk"));
    mocks.live = liveSession(newPath);
    appendFileSync(oldPath, message("late old-session output"));
    // The watcher replaces the reader at 5s; the disposed loop aborts later.
    await vi.advanceTimersByTimeAsync(5_100);
    expect(mocks.post).not.toHaveBeenCalled();
    const pending = JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"));
    expect(pending).toEqual([{ pane_id: "w1:p1", started_at: expect.any(String) }]);

    appendFileSync(newPath, message("fresh replacement reply"));
    mocks.live = liveSession(newPath, "idle");
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "fresh replacement reply");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
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
