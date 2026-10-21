import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
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

describe("Slack daemon — captured same-session settlement", () => {
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
    expect(after.delivered["w1:p1"]).toBe(createHash("sha1").update("first answer").digest("hex"));
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
    expect(state.delivered["w1:p1"]).toBe(createHash("sha1").update("complete old answer").digest("hex"));
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

});
