import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentInfo } from "../src/herdr-client.js";
import type { PaneAgentOptions } from "../src/pane-agent.js";
import type { SlackClientDeps } from "../src/slack-client.js";

const mocks = vi.hoisted(() => ({
  live: null as AgentInfo | null,
  client: undefined as SlackClientDeps | undefined,
  panes: [] as Array<{ opts: PaneAgentOptions; dispose: ReturnType<typeof vi.fn>; active: boolean }>,
  post: vi.fn(async () => "answer-ts"),
  status: vi.fn(async () => {}),
}));

vi.mock("../src/herdr-client.js", async (original) => ({
  ...await original<typeof import("../src/herdr-client.js")>(),
  getAgentInfo: vi.fn(() => mocks.live),
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
    setStatus = mocks.status;
    react = vi.fn(async () => {});
    unreact = vi.fn(async () => {});
    threadHistory = vi.fn(async () => []);
  },
}));

// Exercise the real daemon wiring and real structured readers, but retain
// direct control of loop emissions (including callbacks after disposal).
vi.mock("../src/pane-agent.js", () => ({
  PaneAgent: class {
    readonly dispose = vi.fn(() => { this.active = false; });
    active = false;
    constructor(readonly opts: PaneAgentOptions) { mocks.panes.push(this); }
    noteExternalTurn() {
      if (this.active) return false;
      this.active = true;
      return true;
    }
    handleMessage() { this.active = true; }
    getPendingPrompt() { return ""; }
    getLastAnswer() { return this.opts.communicator.getLastAnswer(); }
    get verbatim() { return this.opts.communicator.verbatim; }
    canIsolateLastAnswer() { return this.opts.communicator.canIsolateLastAnswer(); }
  },
}));

import { startSlackDaemon } from "../src/slack-daemon.js";

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
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.panes.length = 0;
  mocks.client = undefined;
  dir = mkdtempSync(join(tmpdir(), "slack-session-test-"));
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

  it("clears the latest asking thread, not the thread that created a shared reader", async () => {
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
    old.opts.emit({ type: "final", text: "old answer", source: "delta", reason: "idle" });
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
});
