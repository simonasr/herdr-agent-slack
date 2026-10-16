import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentInfo } from "../src/herdr-client.js";
import type { PaneAgentOptions } from "../src/pane-agent.js";
import type { SlackClientDeps } from "../src/slack-client.js";

const mocks = vi.hoisted(() => ({
  live: null as AgentInfo | null,
  home: "",
  client: undefined as SlackClientDeps | undefined,
  panes: [] as Array<{ opts: PaneAgentOptions; dispose: ReturnType<typeof vi.fn>; active: boolean }>,
  post: vi.fn(async (_thread: { channel: string; threadTs: string }, _text: string) => "answer-ts"),
  upload: vi.fn(async () => {}),
  status: vi.fn(async () => {}),
  react: vi.fn(async (_channel: string, _ts: string, _name: string, _on: boolean) => true),
  dispatch: undefined as undefined | ((text: string) => Promise<boolean>),
}));

vi.mock("node:os", async (original) => ({
  ...await original<typeof import("node:os")>(),
  homedir: () => mocks.home,
}));

vi.mock("../src/herdr-client.js", async (original) => ({
  ...await original<typeof import("../src/herdr-client.js")>(),
  getAgentInfo: vi.fn(() => mocks.live),
  getAgentInfoAsync: vi.fn(async () => mocks.live),
  getAgents: vi.fn(() => [{ pane_id: "w1:p1", label: "project", agent: "pi", status: mocks.live?.agent_status ?? "idle" }]),
  readPane: vi.fn(() => ""),
  sendText: vi.fn(),
}));

vi.mock("../src/slack-client.js", async (original) => ({
  ...await original<typeof import("../src/slack-client.js")>(),
  SlackClient: class {
    constructor(deps: SlackClientDeps) { mocks.client = deps; }
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    post = mocks.post;
    upload = mocks.upload;
    setStatus = mocks.status;
    react = mocks.react;
    unreact = vi.fn(async () => {});
    threadHistory = vi.fn(async () => []);
    rename = vi.fn(async () => {});
  },
}));

// Exercise the real daemon wiring and real structured readers, but retain
// direct control of loop emissions (including callbacks after disposal).
vi.mock("../src/pane-agent.js", () => ({
  PaneAgent: class {
    readonly dispose = vi.fn(() => { this.active = false; });
    active = false;
    readonly opts: PaneAgentOptions;
    constructor(opts: PaneAgentOptions) {
      this.opts = { ...opts, emit: (event) => {
        if (event.type === "final") this.active = false;
        opts.emit(event);
      } };
      mocks.panes.push(this);
    }
    noteExternalTurn() {
      if (this.active) return false;
      this.active = true;
      return true;
    }
    handleMessage(text: string) {
      if (this.dispose.mock.calls.length) return Promise.resolve(false);
      this.active = true;
      return (mocks.dispatch?.(text) ?? Promise.resolve(true)).then(sent => {
        if (!sent) this.active = false;
        return sent;
      });
    }
    getPendingPrompt() { return ""; }
    getLastAnswer() { return this.opts.communicator.getLastAnswer(); }
    get verbatim() { return this.opts.communicator.verbatim; }
    canIsolateLastAnswer() { return this.opts.communicator.canIsolateLastAnswer(); }
  },
}));

import { startSlackDaemon } from "../src/slack-daemon.js";
import { getAgentInfo, getAgentInfoAsync, sendText } from "../src/herdr-client.js";
import { formatForSlack } from "../src/slack-format.js";

const thread = { channel: "C1", threadTs: "1.0" };
let dir: string;
let daemon: Awaited<ReturnType<typeof startSlackDaemon>> | undefined;

function liveSession(path: string, status = "working"): AgentInfo {
  return {
    agent: "pi", agent_status: status, pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1",
    agent_session: { kind: "path", path },
  };
}

function sessionFile(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    type: "message", message: { role: "assistant", content: [{ type: "text", text }] },
  }) + "\n");
  return path;
}

async function flush() {
  // A delivery now crosses multiple async identity checks before each side effect.
  for (let i = 0; i < 160; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(getAgentInfoAsync).mockReset().mockImplementation(async () => mocks.live);
  vi.mocked(getAgentInfo).mockImplementation(() => mocks.live);
  mocks.panes.length = 0;
  mocks.client = undefined;
  mocks.dispatch = undefined;
  dir = mkdtempSync(join(tmpdir(), "slack-session-test-"));
  mocks.home = dir;
  writeFileSync(join(dir, "config.toml"), '[slack]\nbot_token = "test"\napp_token = "test"\nallowed_user_ids = ["U1"]\n');
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    threads: { "default|C1:1.0": {
      bot: "default", pane_id: "w1:p1", label: "project", agent: "pi", channel: "C1", thread_ts: "1.0",
      context_sent: true, note_version: 999, last_active: Date.now(),
    } },
  }));
  mocks.live = liveSession(sessionFile("old.jsonl", "old unrelated history"));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("Slack daemon — session replacement in the same pane", () => {
  it("keeps a complete unsent answer when pre-dispatch identity is unavailable once", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "owed question", "2.0");
    vi.mocked(getAgentInfoAsync).mockResolvedValueOnce(null);
    mocks.post.mockClear();
    vi.mocked(getAgentInfo).mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "complete retained answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    expect(getAgentInfo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_100);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "complete retained answer");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked).toEqual({});
  });

  it("does not share a hung verification with a later captured final", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (info: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { release = r; }));
    mocks.panes[0].opts.emit({ type: "final", text: "first answer", source: "delta", reason: "idle" });
    await flush();
    await mocks.client!.onUserMessage(thread, "U1", "next question", "2.0");
    mocks.panes[0].opts.emit({ type: "final", text: "second answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "second answer");
    release(mocks.live);
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
  });

  it("routes progress and a final for a supported sessionless scrape pane", async () => {
    mocks.live = { ...mocks.live!, agent: "custom", agent_session: undefined };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "scrape question", "2.0");
    mocks.status.mockClear();
    mocks.post.mockClear();
    vi.mocked(getAgentInfo).mockClear();
    mocks.panes[0].opts.emit({ type: "working", text: "running" });
    await flush();
    expect(mocks.status).toHaveBeenCalledWith(thread, expect.stringContaining("is working…"));
    mocks.panes[0].opts.emit({ type: "final", text: "sessionless scrape answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "sessionless scrape answer");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(getAgentInfo).not.toHaveBeenCalled();
  });

  it("continues remaining chunks best effort after an unavailable post-dispatch check", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "long answer question", "2.0");
    const text = "answer line\n".repeat(900);
    mocks.post.mockClear();
    mocks.post.mockImplementationOnce(async () => {
      vi.mocked(getAgentInfoAsync).mockResolvedValueOnce(null);
      return "answer-ts";
    });
    mocks.panes[0].opts.emit({ type: "final", text, source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post.mock.calls.map(([, packet]) => packet)).toEqual(formatForSlack(text.trim()).map(packet => packet.text));
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked).toEqual({});
  });

  it.each(["available", "unavailable", "unbound"])("keeps dispatched work in its captured thread with %s metadata/binding", async (phase) => {
    const other = { channel: "C1", threadTs: "4.0" };
    const statePath = join(dir, "state.json");
    const initial = JSON.parse(readFileSync(statePath, "utf8"));
    initial.threads["default|C1:4.0"] = { ...initial.threads["default|C1:1.0"], thread_ts: "4.0" };
    writeFileSync(statePath, JSON.stringify(initial));
    mocks.live = { ...mocks.live!, cwd: dir };
    writeFileSync(join(dir, "one.txt"), "one");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "Q1 in A", "2.0");
    mocks.post.mockClear();
    mocks.upload.mockClear();
    let release!: (ts: string) => void;
    mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const prose = "answer line\n".repeat(900) + "@default !last";
    mocks.panes[0].opts.emit({ type: "final", text: "answer line\n".repeat(900) + "@@send: one.txt\n@default !last", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
    await mocks.client!.onUserMessage(other, "U1", "Q2 in B", "5.0");
    const q2 = JSON.parse(readFileSync(statePath, "utf8"));
    const pending = readFileSync(join(dir, "pending-turns.json"), "utf8");
    const statusCalls = mocks.status.mock.calls.length;
    const reactionCalls = mocks.react.mock.calls.length;
    expect(q2.marked["w1:p1"].ts).toBe("5.0");
    expect(mocks.panes).toHaveLength(1);
    if (phase === "unbound") await mocks.client!.onUserMessage(thread, "U1", "!unbind", "6.0");
    if (phase === "unavailable") vi.mocked(getAgentInfoAsync).mockResolvedValueOnce(null);
    const postsBeforeRelease = mocks.post.mock.calls.length;
    release("chunk-one-ts");
    await flush();
    if (phase === "unbound") {
      expect(mocks.post).toHaveBeenCalledTimes(postsBeforeRelease);
      expect(mocks.upload).not.toHaveBeenCalled();
    } else {
      expect(mocks.post.mock.calls).toEqual([
        ...formatForSlack(prose).map(packet => [thread, packet.text]),
        [thread, "old unrelated history"],
      ]);
      expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(thread, join(dir, "one.txt"), "one.txt", "one.txt");
    }
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    expect(after.asked_from["w1:p1"]).toBe("default|C1:4.0");
    expect(after.marked).toEqual(q2.marked);
    expect(after.last_answer).toEqual(q2.last_answer);
    expect(after.delivered).toEqual(q2.delivered);
    expect(readFileSync(join(dir, "pending-turns.json"), "utf8")).toBe(pending);
    expect(mocks.status).toHaveBeenCalledTimes(statusCalls);
    expect(mocks.react).toHaveBeenCalledTimes(reactionCalls);
    expect(mocks.panes).toHaveLength(1);
  });

  it("does not replay a dispatched chunk when the next identity check hangs past the deadline", async () => {
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, readFileSync(configPath, "utf8") + "max_total_wait_s = 1\n");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "long answer", "2.0");
    let release!: (info: AgentInfo | null) => void;
    mocks.post.mockClear();
    mocks.post.mockImplementationOnce(async () => {
      vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { release = r; }));
      return "answer-ts";
    });
    mocks.panes[0].opts.emit({ type: "final", text: "answer line\n".repeat(900), source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    release(mocks.live);
    await flush();
    expect(mocks.post.mock.calls.map(([, packet]) => packet)).toEqual(formatForSlack("answer line\n".repeat(900).trim()).map(packet => packet.text));
  });

  it("keeps a file batch and later handoff after metadata fails at settlement", async () => {
    mocks.live = { ...mocks.live!, cwd: dir };
    writeFileSync(join(dir, "one.txt"), "one");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "send a file", "2.0");
    let outage = false;
    let dropped = false;
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => {
      if (outage && !dropped) { dropped = true; return null; }
      return mocks.live;
    });
    mocks.react.mockImplementation(async (_channel, _ts, name, add) => {
      if (name === "white_check_mark" && add) outage = true;
      return true;
    });
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "files ready\n@@send: one.txt\n@default !last", source: "delta", reason: "idle" });
    await flush();
    expect(dropped).toBe(true);
    expect(mocks.upload).toHaveBeenCalledExactlyOnceWith(thread, join(dir, "one.txt"), "one.txt", "one.txt");
    expect(mocks.post.mock.calls.map(([, text]) => text)).toEqual([
      ...formatForSlack("files ready\n@default !last").map(packet => packet.text), "old unrelated history",
    ]);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it("finishes a begun file batch and resumes a later handoff after one unavailable check", async () => {
    mocks.live = { ...mocks.live!, cwd: dir };
    writeFileSync(join(dir, "one.txt"), "one");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "send a file", "2.0");
    let outage = false;
    let dropped = false;
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => {
      if (outage && !dropped) { dropped = true; return null; }
      return mocks.live;
    });
    mocks.upload.mockImplementationOnce(async () => { outage = true; });
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "files ready\n@@send: one.txt\n@default !last", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(dropped).toBe(true);
    expect(mocks.post.mock.calls).toHaveLength(2);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.map(([, text]) => text)).toEqual([
      ...formatForSlack("files ready\n@default !last").map(packet => packet.text), "old unrelated history",
    ]);
  });

  it("does not abandon Q2 when Q1's setup-captured final reaches its deadline", async () => {
    const configPath = join(dir, "config.toml");
    writeFileSync(configPath, readFileSync(configPath, "utf8") + "max_total_wait_s = 1\n");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "Q1", "2.0");
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const q2 = mocks.client!.onUserMessage(thread, "U1", "Q2", "3.0");
    await flush();
    vi.mocked(getAgentInfoAsync).mockResolvedValue(null);
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "Q1 withheld", source: "delta", reason: "idle" });
    await flush();
    release();
    await q2;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"].ts).toBe("3.0");
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => mocks.live);
    mocks.panes[0].opts.emit({ type: "final", text: "Q2 answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "Q2 answer");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it("keeps other work responsive while a final waits for async identity, without sync metadata", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    vi.mocked(getAgentInfo).mockClear();
    let resolve!: (info: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    mocks.panes[0].opts.emit({ type: "final", text: "nonblocking answer", source: "delta", reason: "idle" });
    await flush();
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(timerRan).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(getAgentInfo).not.toHaveBeenCalled();
    resolve(mocks.live);
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "nonblocking answer");
    expect(getAgentInfo).not.toHaveBeenCalled();
  });

  it("bounds a burst of progress lookups without delaying independent final verification", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await flush();
    mocks.status.mockClear();
    let release!: (info: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockClear();
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { release = r; }));
    for (let i = 0; i < 12; i++) mocks.panes[0].opts.emit({ type: "working", text: `fragment ${i}` });
    await flush();
    expect(getAgentInfoAsync).toHaveBeenCalledTimes(1);
    expect(mocks.status).not.toHaveBeenCalledWith(thread, "is working…");
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "independent final", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "independent final");
    const statusesAfterFinal = mocks.status.mock.calls.length;
    release(mocks.live);
    await flush();
    expect(getAgentInfoAsync).toHaveBeenCalledTimes(2);
    expect(mocks.status).toHaveBeenCalledTimes(statusesAfterFinal);
  });

  it("does not route delayed progress from a replaced session or block another timer", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await flush();
    mocks.status.mockClear();
    const old = mocks.panes[0];
    vi.mocked(getAgentInfo).mockClear();
    let resolve!: (info: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    old.opts.emit({ type: "working", text: "old progress" });
    await flush();
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(timerRan).toBe(true);
    expect(mocks.status).not.toHaveBeenCalled();
    resolve(liveSession(sessionFile("progress-replacement.jsonl", "new"), "idle"));
    await flush();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(mocks.status).not.toHaveBeenCalledWith(thread, "is working…");
    expect(getAgentInfo).not.toHaveBeenCalled();
  });

  it("bounds a hung pre-dispatch verification without posting", async () => {
    const path = join(dir, "config.toml");
    writeFileSync(path, readFileSync(path, "utf8") + "max_total_wait_s = 1\n");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "owed", "2.0");
    let resolve!: (info: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    mocks.panes[0].opts.emit({ type: "final", text: "late answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    resolve(mocks.live);
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("retains Q2 settlement while Q1 verification is pending during Q2 setup", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "Q1", "2.0");
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const q2 = mocks.client!.onUserMessage(thread, "U1", "Q2", "3.0");
    await flush();
    let resolve!: (info: AgentInfo | null) => void;
    vi.mocked(getAgentInfoAsync).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    mocks.panes[0].opts.emit({ type: "final", text: "Q1 answer", source: "delta", reason: "idle" });
    await flush();
    resolve(mocks.live);
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(thread, "Q1 answer");
    release();
    await q2;
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.marked["w1:p1"].ts).toBe("3.0");
    expect(state.last_answer["w1:p1"]).toBeUndefined();
    expect(state.delivered["w1:p1"]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it("retries an unverifiable Q1 answer emitted during Q2 setup without settling Q2", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "Q1", "2.0");
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const q2 = mocks.client!.onUserMessage(thread, "U1", "Q2", "3.0");
    await flush();
    vi.mocked(getAgentInfoAsync).mockResolvedValueOnce(null);
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "Q1 after outage", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    release();
    await q2;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "Q1 after outage");
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.marked["w1:p1"].ts).toBe("3.0");
    expect(state.delivered["w1:p1"]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it("keeps a Q1 setup retry independent when Q2 final verifies first", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "Q1", "2.0");
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise(r => { release = r; }));
    const q2 = mocks.client!.onUserMessage(thread, "U1", "Q2", "3.0");
    await flush();
    vi.mocked(getAgentInfoAsync).mockResolvedValueOnce(null);
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "Q1 late", source: "delta", reason: "idle" });
    await flush();
    release();
    await q2;
    mocks.panes[0].opts.emit({ type: "final", text: "Q2 answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(thread, "Q2 answer");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.post).toHaveBeenCalledWith(thread, "Q1 late");
    expect(mocks.post).toHaveBeenCalledTimes(2);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.last_answer["w1:p1"].ts).toBe("answer-ts");
    expect(state.delivered["w1:p1"]).toBeDefined();
  });

  it("stops later chunks when fresh async metadata reports a new session", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    mocks.post.mockClear();
    mocks.post.mockImplementationOnce(async () => {
      mocks.live = liveSession(sessionFile("replacement.jsonl", "other"));
      return "answer-ts";
    });
    vi.mocked(getAgentInfo).mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "answer line\n".repeat(900), source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.panes[0].dispose).toHaveBeenCalledOnce();
    expect(getAgentInfo).not.toHaveBeenCalled();
  });

  it.each(["unbind", "reader replacement"])("records resolved dispatch only for its live debt after %s", async (race) => {
    const sessions = join(dir, ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "rollout-race-a.jsonl"), "");
    mocks.live = { ...mocks.live!, agent: "codex", agent_session: { kind: "id", id: "race-a" } };
    let finish!: (sent: boolean) => void;
    mocks.dispatch = (text) => {
      sendText("w1:p1", text);
      return new Promise<boolean>(resolve => { finish = resolve; });
    };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const sending = mocks.client!.onUserMessage(thread, "U1", "dispatched question", "2.0");
    await flush();
    expect(finish).toBeTypeOf("function");
    if (race === "unbind") {
      await mocks.client!.onUserMessage(thread, "U1", "!unbind", "3.0");
      expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    } else {
      mocks.live = { ...mocks.live!, agent_status: "working", agent_session: { kind: "id", id: "race-b" } };
      await mocks.client!.onUserMessage(thread, "U1", "!last", "3.0");
      expect(mocks.panes).toHaveLength(2);
    }
    // Simulates successful dispatch whose continuation was delayed beyond
    // binding retirement or a working reader replacement.
    finish(true);
    await sending;
    expect(sendText).toHaveBeenCalledExactlyOnceWith("w1:p1", "dispatched question");
    mocks.post.mockClear();
    writeFileSync(join(sessions, "rollout-race-c.jsonl"), [
      { role: "user", text: "dispatched question" }, { role: "assistant", text: "late answer" },
    ].map(({ role, text }) => JSON.stringify({
      type: "response_item", payload: { type: "message", role, content: [{ type: "text", text }] },
    })).join("\n") + "\n");
    mocks.live = { ...mocks.live!, agent_status: "idle", agent_session: { kind: "id", id: "race-c" } };
    if (race === "unbind") await mocks.client!.onUserMessage(thread, "U1", "!bind project", "4.0");
    else await mocks.client!.onUserMessage(thread, "U1", "!last", "4.0");
    await flush();
    if (race === "reader replacement") expect(mocks.post).toHaveBeenCalledWith(thread, "late answer");
    else expect(mocks.post).not.toHaveBeenCalledWith(thread, "late answer");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
  });

  it("replaces the reader and adopts a new session even while the pane stays working", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    expect(mocks.panes).toHaveLength(1);
    const old = mocks.panes[0];
    expect(old.opts.communicator.getLatestOutput()).toBe("old unrelated history");

    mocks.live = liveSession(sessionFile("new.jsonl", "new session reply"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.panes).toHaveLength(2);
    expect(old.dispose).toHaveBeenCalledOnce();
    const current = mocks.panes[1];
    expect(current.active).toBe(true);
    expect(current.opts.communicator.getLatestOutput()).toBe("new session reply");

    mocks.post.mockClear();
    old.opts.emit({ type: "final", text: "old unrelated history", source: "snapshot", reason: "aborted" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([
      { pane_id: "w1:p1", started_at: expect.any(String) },
    ]);
    current.opts.emit({ type: "final", text: "new session reply", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "new session reply");
  });

  it.each(["idle", "working"])("refreshes on a Slack request while %s without waiting for the watcher", async (status) => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const old = mocks.panes[0];
    mocks.live = liveSession(sessionFile("new.jsonl", "current answer"), status);
    await mocks.client!.onUserMessage(thread, "U1", "!last", "2.0");
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(mocks.panes).toHaveLength(2);
    expect(mocks.panes[1].active).toBe(status === "working");
    expect(mocks.post).toHaveBeenCalledWith(thread, "current answer");
  });

  it("rejects an old final when the delivery lookup discovers replacement", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const old = mocks.panes[0];
    mocks.live = liveSession(sessionFile("new.jsonl", "replacement output"));
    mocks.post.mockClear();
    old.opts.emit({ type: "final", text: "retired output", source: "delta", reason: "idle" });
    await flush();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(mocks.panes[1].active).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it.each(["replacement", "same session"])("stops a suspended old delivery from settling a new turn in %s", async (change) => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "old question", "2.0");
    const old = mocks.panes[0];
    let release!: (ts: string) => void;
    mocks.post.mockClear();
    mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    // A replacement stops remaining chunks; a same-session follow-up must
    // preserve the full answer, but neither may settle the newer question.
    old.opts.emit({ type: "final", text: "old answer line\n".repeat(900), source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledOnce();
    if (change === "replacement") mocks.live = liveSession(sessionFile("new.jsonl", "replacement history"));
    await mocks.client!.onUserMessage(thread, "U1", "new question", "3.0");
    expect(mocks.panes.at(-1)!.active).toBe(true);
    mocks.react.mockClear();
    release("old-answer-ts");
    await flush();
    if (change === "replacement") expect(mocks.post).toHaveBeenCalledOnce();
    else expect(mocks.post.mock.calls.map(([, text]) => text).join("\n").match(/old answer line/g)).toHaveLength(900);
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.marked["w1:p1"].ts).toBe("3.0");
    expect(state.last_answer["w1:p1"]).toBeUndefined();
    expect(state.delivered["w1:p1"]).toBeUndefined();
    expect(mocks.react).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it("posts a same-session final during new-turn setup without settling that new turn", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "old question", "2.0");
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const incoming = mocks.client!.onUserMessage(thread, "U1", "new question", "3.0");
    await flush();
    mocks.post.mockClear();
    mocks.panes[0].opts.emit({ type: "final", text: "complete old answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "complete old answer");
    release();
    await incoming;
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.marked["w1:p1"].ts).toBe("3.0");
    expect(state.last_answer["w1:p1"]).toBeUndefined();
    expect(state.delivered["w1:p1"]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it("finishes a started file batch and its notes after a same-session follow-up", async () => {
    mocks.live = { ...mocks.live!, cwd: dir };
    writeFileSync(join(dir, "one.txt"), "one");
    writeFileSync(join(dir, "two.txt"), "two");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "old question", "2.0");
    let release!: () => void;
    mocks.upload.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    mocks.panes[0].opts.emit({ type: "final", text: "files ready\n@@send: one.txt\n@@send: two.txt\n@@send: missing.txt", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.upload).toHaveBeenCalledOnce();
    await mocks.client!.onUserMessage(thread, "U1", "new question", "3.0");
    release();
    await flush();
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenCalledWith(thread, expect.stringContaining("missing.txt"));
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"].ts).toBe("3.0");
  });

  it("finishes a started self-command handoff after a same-session follow-up", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "old question", "2.0");
    let release!: (ts: string) => void;
    mocks.post.mockResolvedValueOnce("answer-ts").mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    mocks.panes[0].opts.emit({ type: "final", text: "@default !help\n@default !last", source: "delta", reason: "idle" });
    await flush();
    expect(release).toBeTypeOf("function");
    await mocks.client!.onUserMessage(thread, "U1", "new question", "3.0");
    release("help-ts");
    await flush();
    expect(mocks.post).toHaveBeenCalledWith(thread, "old unrelated history");
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"].ts).toBe("3.0");
  });

  it("does not add a done reaction if a new turn starts while the old working reaction is removed", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "old question", "2.0");
    let release!: (ok: boolean) => void;
    mocks.react.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve; }));
    mocks.panes[0].opts.emit({ type: "final", text: "old answer", source: "delta", reason: "idle" });
    await flush();
    expect(release).toBeTypeOf("function");
    await mocks.client!.onUserMessage(thread, "U1", "new question", "3.0");
    mocks.react.mockClear();
    release(true);
    await flush();
    expect(mocks.react).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"].ts).toBe("3.0");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it("withholds old output as soon as the live session changes, before the next tick", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const old = mocks.panes[0];
    mocks.live = liveSession(sessionFile("new.jsonl", "current answer"));
    mocks.post.mockClear();
    mocks.status.mockClear();
    old.opts.emit({ type: "working", text: "old progress" });
    old.opts.emit({ type: "final", text: "old unrelated history", source: "snapshot", reason: "idle" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(mocks.panes[1].active).toBe(true);
    expect(mocks.status).not.toHaveBeenCalledWith(thread, "");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it.each(["stale final", "!last"])("clears the latest asking thread when replacement is discovered by %s", async (discovery) => {
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.threads["default|C1:2.0"] = { ...state.threads["default|C1:1.0"], thread_ts: "2.0" };
    writeFileSync(statePath, JSON.stringify(state));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const old = mocks.panes[0];
    const latest = { channel: "C1", threadTs: "2.0" };
    await mocks.client!.onUserMessage(latest, "U1", "latest question", "3.0");
    mocks.live = liveSession(sessionFile("new.jsonl", "unrelated history"), "idle");
    mocks.status.mockClear();
    if (discovery === "!last") {
      await mocks.client!.onUserMessage(thread, "U1", "!last", "4.0");
      mocks.post.mockClear(); // The explicit readback is not an automatic final.
    } else {
      old.opts.emit({ type: "final", text: "old answer", source: "delta", reason: "idle" });
    }
    await flush();
    expect(mocks.status).toHaveBeenCalledWith(latest, "");
    expect(mocks.status).not.toHaveBeenCalledWith(thread, "");
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it.each(["new turn", "replacement", "shutdown"])("cancels a withheld final on %s", async (action) => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const old = mocks.panes[0];
    const original = mocks.live;
    mocks.live = null;
    old.opts.emit({ type: "final", text: "withheld old answer", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    if (action === "new turn") {
      mocks.live = original;
      let release!: () => void;
      mocks.status.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      const sending = mocks.client!.onUserMessage(thread, "U1", "another question", "2.0");
      await flush();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mocks.post).not.toHaveBeenCalled();
      release();
      await sending;
    } else if (action === "replacement") {
      mocks.live = liveSession(sessionFile("replacement.jsonl", "replacement history"));
      await mocks.client!.onUserMessage(thread, "U1", "!last", "2.0");
    } else {
      await daemon.stop();
      daemon = undefined;
      mocks.live = original;
    }
    mocks.post.mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });

  it.each(["unreachable", "missing session"])("keeps the reader with %s metadata, but withholds unverifiable output", async (missing) => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const original = mocks.live;
    const old = mocks.panes[0];
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.panes).toHaveLength(1);
    mocks.live = missing === "unreachable" ? null : { ...mocks.live!, agent_session: undefined };
    await vi.advanceTimersByTimeAsync(5_000);
    mocks.post.mockClear();
    old.opts.emit({ type: "final", text: "unverified", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.panes).toHaveLength(1);
    expect(old.dispose).not.toHaveBeenCalled();
    mocks.live = original;
    old.opts.emit({ type: "final", text: "verified reply", source: "delta", reason: "idle" });
    await flush();
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "verified reply");
  });

  it("keeps a watcher-adopted terminal owner when an older post resolves", async () => {
    const statePath = join(dir, "state.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    saved.last_answer = { "w1:p1": { channel: "C1", ts: "previous-answer" } };
    writeFileSync(statePath, JSON.stringify(saved));
    // The real PaneWatcher sees idle at startup, then an idle→working tick.
    mocks.live = liveSession(sessionFile("prior.jsonl", "prior answer"), "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "first question", "2.0");
    let release!: (ts: string) => void;
    mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    mocks.panes[0].opts.emit({ type: "final", text: "first answer", source: "delta", reason: "idle" });
    await flush();
    expect(release).toBeTypeOf("function");
    expect(mocks.panes[0].active).toBe(false); // completed, not a fake still-active loop
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
    mocks.live = { ...mocks.live!, agent_status: "working" };
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    // Adoption really happened before the old operation is released.
    expect(mocks.panes[0].active).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
    const adopted = JSON.parse(readFileSync(statePath, "utf8"));
    expect(adopted.marked["w1:p1"].ts).toBe("2.0");
    expect(adopted.last_answer["w1:p1"].ts).toBe("previous-answer");
    mocks.react.mockClear();
    release("first-answer-ts");
    await flush();
    const after = JSON.parse(readFileSync(statePath, "utf8"));
    expect(after.marked["w1:p1"]).toEqual(adopted.marked["w1:p1"]);
    expect(after.last_answer["w1:p1"]).toEqual(adopted.last_answer["w1:p1"]);
    expect(after.delivered["w1:p1"]).toBeUndefined();
    expect(mocks.react).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toHaveLength(1);
  });


});
