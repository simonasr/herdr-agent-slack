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
    react = vi.fn(async () => {});
    unreact = vi.fn(async () => {});
  },
}));

// PaneAgent, ObserveLoopController and the Pi reader are all real here.
import { startSlackDaemon } from "../src/slack-daemon.js";
import { PaneAgent } from "../src/pane-agent.js";
import { getAgentInfoAsync, sendText } from "../src/herdr-client.js";

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
  it.each([false, true])("keeps a deferred reader and its first answer, metadata before rollout=%s", async (metadataFirst) => {
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex", agent_session: undefined };
    const disposed = vi.spyOn(PaneAgent.prototype, "dispose");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "first question", "2.0");
    if (metadataFirst) {
      mocks.live = { ...mocks.live!, agent_status: "working", agent_session: { kind: "id", id: "first-session" } };
      mocks.screen = "old terminal history must not become an answer";
      await vi.advanceTimersByTimeAsync(300);
      expect(disposed).not.toHaveBeenCalled();
      expect(mocks.post).not.toHaveBeenCalled();
    }
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-first-session.jsonl"), [
      { role: "user", text: "first question" },
      { role: "assistant", text: "the complete first answer" },
    ].map(({ role, text }) => JSON.stringify({
      type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
    })).join("\n") + "\n");
    mocks.live = { ...mocks.live!, agent_status: "idle", agent_session: { kind: "id", id: "first-session" } };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "the complete first answer");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(disposed).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it.each((["codex", "claude"] as const).flatMap(agent =>
    ["", "replacement question", "a genuine terminal question"].map(loggedPrompt => ({ agent, loggedPrompt })),
  ))("waits for a replacement $agent transcript without re-quoting a sent prompt, logged=$loggedPrompt", async ({ agent, loggedPrompt }) => {
    const sessions = agent === "codex" ? join(dir, ".codex", "sessions") : join(dir, ".claude", "projects", "project");
    const sessionPath = (id: string) => join(sessions, agent === "codex" ? `rollout-${id}.jsonl` : `${id}.jsonl`);
    mkdirSync(sessions, { recursive: true });
    writeFileSync(sessionPath("reader-old"), "");
    mocks.live = { ...liveSession(oldPath, "idle"), agent, agent_session: { kind: "id", id: "reader-old" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "replacement question", "2.0");
    mocks.live = { ...mocks.live!, agent_status: "working", agent_session: { kind: "id", id: "reader-new" } };
    mocks.screen = "unrelated terminal history";
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    mocks.post.mockClear(); // Explicit readbacks are not automatic answers.
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    writeFileSync(sessionPath("reader-new"), [
      ...(loggedPrompt ? [{ role: "user", text: loggedPrompt }] : []),
      { role: "assistant", text: "full replacement answer" },
    ].map(({ role, text }) => JSON.stringify(agent === "codex" ? {
      type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
    } : { type: role, message: { role, content: role === "user" ? text : [{ type: "text", text }] } })).join("\n") + "\n");
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread,
      loggedPrompt === "a genuine terminal question"
        ? "> a genuine terminal question\n\nfull replacement answer" : "full replacement answer");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it.each(["session-a", "session-b"])("checks a prompt-resolved deferred reader against the first reported identity %s", async (reported) => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "claude", agent_session: undefined, cwd: dir };
    const disposed = vi.spyOn(PaneAgent.prototype, "dispose");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "a unique question for the deferred Claude reader", "2.0");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![1];
    const projects = join(dir, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(projects, { recursive: true });
    const claudeTurn = (question: string, answer: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: question } }) + "\n"
      + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\n";
    const sessionA = join(projects, "session-a.jsonl");
    writeFileSync(sessionA, claudeTurn(prompt, "answer from session A"));
    mocks.live = { ...mocks.live!, agent_status: "working" };
    // Resolve and cache A by prompt while herdr still has no session identity.
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).not.toHaveBeenCalled();
    writeFileSync(join(projects, "session-b.jsonl"), claudeTurn("unrelated question", "answer from session B"));
    mocks.live = { ...mocks.live!, agent_session: { kind: "id", id: reported } };
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, reported === "session-a" ? "answer from session A" : "answer from session B");
    expect(disposed).toHaveBeenCalledTimes(reported === "session-a" ? 0 : 1);
    mocks.post.mockClear();
    appendFileSync(sessionA, claudeTurn("retired follow-up", "later output from session A"));
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    if (reported === "session-b") {
      expect(mocks.post).not.toHaveBeenCalledWith(thread, expect.stringContaining("session A"));
    } else {
      expect(mocks.post).toHaveBeenCalled();
    }
  });

  it("rejects a deferred reader that pins a different session after metadata was already recorded", async () => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "claude", agent_session: undefined, cwd: dir };
    const disposed = vi.spyOn(PaneAgent.prototype, "dispose");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "a unique question before metadata resolves", "2.0");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![1];
    mocks.live = { ...mocks.live!, agent_status: "working", agent_session: { kind: "id", id: "later-b" } };
    // B is named before its transcript exists, so the original reader is unresolved.
    await mocks.client!.onUserMessage(thread, "U1", "!last", "2.1");
    mocks.post.mockClear();
    const projects = join(dir, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(projects, { recursive: true });
    const turn = (question: string, answer: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: question } }) + "\n"
      + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } }) + "\n";
    writeFileSync(join(projects, "earlier-a.jsonl"), turn(prompt, "retired answer from A"));
    mocks.live = { ...mocks.live!, agent_session: undefined };
    await vi.advanceTimersByTimeAsync(300);
    writeFileSync(join(projects, "later-b.jsonl"), turn("unrelated question", "current answer from B"));
    mocks.live = { ...mocks.live!, agent_status: "idle", agent_session: { kind: "id", id: "later-b" } };
    // Delivery itself must revalidate the pinned identity, even without a watcher.
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post).not.toHaveBeenCalled();
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "current answer from B");
    expect(disposed).toHaveBeenCalledOnce();
  });

  it.each([false, true])("respects disabled terminal relaying on replacement, pending Slack turn=%s", async (pending) => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "!last", "1.1");
    if (pending) await mocks.client!.onUserMessage(thread, "U1", "a Slack question", "2.0");
    const replacement = join(dir, "replacement.jsonl");
    writeFileSync(replacement, message("replacement history"));
    mocks.live = liveSession(replacement);
    mocks.post.mockClear();
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "replacement history");
    mocks.post.mockClear();
    appendFileSync(replacement, message("replacement answer"));
    mocks.live = liveSession(replacement, "idle");
    await vi.advanceTimersByTimeAsync(5_000);
    if (pending) {
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "replacement answer");
      expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    } else {
      expect(mocks.post).not.toHaveBeenCalled();
    }
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

  it.each([true, false])("retains the full in-flight replacement answer only for a matching Slack prompt=%s", async (matches) => {
    appendFileSync(join(dir, "config.toml"), "relay_terminal_turns = false\n");
    const projects = join(dir, ".claude", "projects", "project");
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(projects, "partial-old.jsonl"), "");
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "claude", agent_session: { kind: "id", id: "partial-old" } };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "the Slack question being continued", "2.0");
    const prompt = vi.mocked(sendText).mock.calls.at(-1)![1];
    const replacement = join(projects, "partial-new.jsonl");
    const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
    writeFileSync(replacement, JSON.stringify({ type: "user", message: { role: "user", content: matches ? prompt : "unrelated question" } }) + "\n" + assistant("answer prefix"));
    mocks.live = { ...mocks.live!, agent_status: "working", agent_session: { kind: "id", id: "partial-new" } };
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "answer prefix");
    mocks.post.mockClear();
    expect(sendText).toHaveBeenCalledTimes(1); // Adoption must not resend the prompt.
    appendFileSync(replacement, assistant("answer suffix"));
    mocks.live = { ...mocks.live!, agent_status: "idle" };
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, matches ? "answer prefix\n\nanswer suffix" : "answer suffix");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
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

  it.each([
    ["before setup", "idle"], ["during history", "idle"],
    ["before setup", "working"], ["during history", "working"],
  ])("retains a new question when a %s replacement is %s", async (when, status) => {
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.threads["default|C1:1.0"].context_sent = false;
    writeFileSync(statePath, JSON.stringify(state));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const newPath = join(dir, "replacement.jsonl");
    writeFileSync(newPath, message("replacement history"));
    if (when === "before setup") mocks.live = liveSession(newPath, status);
    let release!: (value: ThreadMessage[]) => void;
    mocks.history.mockImplementationOnce(() => new Promise<ThreadMessage[]>(resolve => { release = resolve; }));
    const sending = mocks.client!.onUserMessage(thread, "U1", "pending new question", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.history).toHaveBeenCalledOnce();
    if (when === "during history") mocks.live = liveSession(newPath, status);
    await vi.advanceTimersByTimeAsync(5_000);
    // Any unrelated work in the replacement can finish while setup awaits Slack.
    mocks.live = liveSession(newPath, "idle");
    appendFileSync(newPath, message("unrelated answer during setup"));
    await vi.advanceTimersByTimeAsync(300);
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

  it.each([1, 2])("retains a new question across %s replacements during asynchronous input preparation", async (replacements) => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (value: AgentInfo | null) => void;
    const holdMetadata = () => vi.mocked(getAgentInfoAsync).mockImplementationOnce(
      () => new Promise(resolve => { release = resolve; }),
    );
    holdMetadata();
    const sending = mocks.client!.onUserMessage(thread, "U1", "question during metadata", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(getAgentInfoAsync).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();

    let newPath = oldPath;
    for (let i = 0; i < replacements; i++) {
      const previous = mocks.live;
      newPath = join(dir, `replacement-${i}.jsonl`);
      writeFileSync(newPath, message("replacement history"));
      mocks.live = liveSession(newPath, "idle");
      await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
      mocks.post.mockClear();
      if (i < replacements - 1) holdMetadata();
      release(previous);
      await vi.advanceTimersByTimeAsync(0);
    }
    await sending;

    expect(sendText).toHaveBeenCalledExactlyOnceWith("w1:p1", "question during metadata");
    appendFileSync(newPath, message("reply after metadata replacement"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "reply after metadata replacement");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it("keeps both queued questions in order when their reader is replaced before dispatch", async () => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const previous = mocks.live;
    let release!: (value: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = mocks.client!.onUserMessage(thread, "U1", "first queued question", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    const second = mocks.client!.onUserMessage(thread, "U1", "second queued question", "2.1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sendText).not.toHaveBeenCalled();

    const newPath = join(dir, "replacement.jsonl");
    writeFileSync(newPath, message("replacement history"));
    mocks.live = liveSession(newPath, "idle");
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    mocks.post.mockClear();
    release(previous);
    await Promise.all([first, second]);

    expect(vi.mocked(sendText).mock.calls).toEqual([
      ["w1:p1", "first queued question"], ["w1:p1", "second queued question"],
    ]);
    appendFileSync(newPath, message("reply after both questions"));
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "reply after both questions");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it.each([false, true])("keeps a later question behind an older transfer, shutdown=%s", async (shutdown) => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const previous = mocks.live;
    let release!: (value: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = mocks.client!.onUserMessage(thread, "U1", "first before replacement", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    const newPath = join(dir, "replacement.jsonl");
    writeFileSync(newPath, message("replacement history"));
    mocks.live = liveSession(newPath, "idle");
    const second = mocks.client!.onUserMessage(thread, "U1", "second after replacement", "2.1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sendText).not.toHaveBeenCalled();
    if (shutdown) {
      await daemon.stop();
      daemon = undefined;
    }
    release(previous);
    await Promise.all([first, second]);
    expect(vi.mocked(sendText).mock.calls).toEqual(shutdown ? [] : [
      ["w1:p1", "first before replacement"], ["w1:p1", "second after replacement"],
    ]);
    if (shutdown) expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
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

  it.each(["!unbind", "!bind project"])("does not resubmit unsent input after %s changes its binding", async (command) => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const previous = mocks.live;
    let release!: (value: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = mocks.client!.onUserMessage(thread, "U1", "question before binding change", "2.0");
    await vi.advanceTimersByTimeAsync(0);
    expect(getAgentInfoAsync).toHaveBeenCalledOnce();

    const newPath = join(dir, "replacement.jsonl");
    writeFileSync(newPath, message("replacement history"));
    mocks.live = liveSession(newPath, "idle");
    await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
    await mocks.client!.onUserMessage(thread, "U1", command, "3.1");
    release(previous);
    await sending;
    expect(sendText).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"]).toBeUndefined();
    expect(mocks.status).toHaveBeenCalledWith(thread, "");
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
