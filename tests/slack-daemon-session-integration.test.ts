import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { AgentInfo } from "../src/herdr-client.js";
import type { SlackClientDeps, SlackThread, ThreadMessage } from "../src/slack-client.js";

const mocks = vi.hoisted(() => ({
  live: null as AgentInfo | null,
  home: "",
  screen: "",
  client: undefined as SlackClientDeps | undefined,
  clients: new Map<string, SlackClientDeps>(),
  liveByPane: new Map<string, AgentInfo>(),
  extraPanes: [] as Array<{ pane_id: string; label: string; agent: string; status: string }>,
  post: vi.fn(async (_thread: SlackThread, _text: string) => "answer-ts"),
  status: vi.fn(async (_thread: SlackThread, _status: string) => {}),
  react: vi.fn(async (_channel: string, _ts: string, _name: string, _on: boolean) => true),
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
  getAgentInfo: vi.fn((paneId: string) => mocks.liveByPane.get(paneId) ?? mocks.live),
  getAgentInfoAsync: vi.fn(async (paneId: string) => mocks.liveByPane.get(paneId) ?? mocks.live),
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
    constructor(private readonly deps: SlackClientDeps) {
      mocks.client = deps;
      mocks.clients.set(deps.name, deps);
    }
    mention() { return `<@U_${this.deps.name}>`; }
    threadHistory = mocks.history;
    rename = vi.fn(async () => {});
    start = mocks.start;
    stop = mocks.stop;
    post = mocks.post;
    setStatus = mocks.status;
    upload = mocks.upload;
    react = mocks.react;
    unreact = vi.fn(async () => {});
  },
}));

// PaneAgent, ObserveLoopController and the Pi reader are all real here.
import { startSlackDaemon } from "../src/slack-daemon.js";
import { getAgentInfoAsync, sendText } from "../src/herdr-client.js";
import { formatForSlack } from "../src/slack-format.js";

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
  mocks.status.mockReset().mockResolvedValue(undefined);
  mocks.post.mockReset().mockResolvedValue("answer-ts");
  mocks.history.mockReset().mockResolvedValue([]);
  mocks.start.mockReset().mockResolvedValue(undefined);
  mocks.stop.mockReset().mockResolvedValue(undefined);
  dir = mkdtempSync(join(tmpdir(), "slack-session-integration-"));
  mocks.home = dir;
  mocks.screen = "";
  mocks.client = undefined;
  mocks.clients.clear();
  mocks.liveByPane.clear();
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
    // Q2 can set its status, but cannot mark, frame or dispatch its input
    // ahead of Q1's reservation.
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


  describe("deferred startup observation", () => {
    const pending = () => JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"));
    let incoming: Promise<void>;
    let release: () => void;
    let reject: (error: Error) => void;
    async function startDeferred(agent = "pi") {
      writeFileSync(join(dir, "pending-turns.json"), JSON.stringify([
        { pane_id: "w1:p1", started_at: new Date().toISOString() },
      ]));
      mocks.live = { ...liveSession(oldPath, "working"), agent };
      if (agent === "codex") writeFileSync(oldPath, codexTurn("owed question"));
      mocks.status.mockImplementationOnce(() => new Promise<void>((resolve, fail) => { release = resolve; reject = fail; }));
      mocks.start.mockImplementationOnce(async () => {
        incoming = mocks.client!.onUserMessage(thread, "U1", "unsent startup input", "3.0");
        await vi.advanceTimersByTimeAsync(0);
      });
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      expect(sendText).not.toHaveBeenCalled();
      expect(pending()).toHaveLength(1);
    }

    it.each(["rebind", "failure", "queued"] as const)("resumes owed observation after %s setup cancellation", async mode => {
      await startDeferred();
      let queued: Promise<void> | undefined;
      if (mode === "queued") {
        queued = mocks.client!.onUserMessage(thread, "U1", "second unsent input", "3.1");
        await vi.advanceTimersByTimeAsync(0);
      }
      if (mode === "failure") {
        const failed = expect(incoming).rejects.toThrow("Slack setup failed");
        reject(new Error("Slack setup failed")); await failed;
      } else {
        await mocks.client!.onUserMessage(thread, "U1", "!bind project", "4.0");
        release(); await incoming; await queued;
      }
      mocks.post.mockClear();
      // The busy transition was already consumed at startup. The exiting
      // reservation must resume it, without waiting for another transition.
      await vi.advanceTimersByTimeAsync(6000);
      appendFileSync(oldPath, message("owed startup answer"));
      mocks.live = liveSession(oldPath, "idle");
      await vi.advanceTimersByTimeAsync(6000);
      expect(sendText).not.toHaveBeenCalled();
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "owed startup answer");
      expect(pending()).toEqual([]);
    });

    it("does not recover old history for a setup-only input whose dispatch fails", async () => {
      writeFileSync(oldPath, codexTurn("old question", "old answer never owed here"));
      mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex" };
      const statePath = join(dir, "state.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.threads["default|C1:1.0"].context_sent = false;
      writeFileSync(statePath, JSON.stringify(state));
      let finishHistory!: (messages: ThreadMessage[]) => void;
      mocks.history.mockImplementationOnce(() => new Promise<ThreadMessage[]>(resolve => { finishHistory = resolve; }));
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      const sending = mocks.client!.onUserMessage(thread, "U1", "input that never dispatches", "3.0");
      await vi.advanceTimersByTimeAsync(0);
      mocks.live = { ...mocks.live!, agent_status: "working" };
      await vi.advanceTimersByTimeAsync(5000); // The watcher defers during setup.
      mocks.live = { ...mocks.live!, agent_status: "idle" };
      vi.mocked(sendText).mockImplementationOnce(() => { throw new Error("dispatch failed"); });
      const failed = expect(sending).rejects.toThrow("dispatch failed");
      finishHistory([]); await failed;
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post).not.toHaveBeenCalled();
      // Keep the pre-existing exception bookkeeping policy; this fix must
      // simply not promote positively unsent debt into immediate recovery.
      expect(pending()).toHaveLength(1);
    });

    it("does not restart deferred observation after shutdown", async () => {
      await startDeferred();
      await daemon!.stop(); daemon = undefined;
      mocks.post.mockClear(); mocks.status.mockClear();
      release(); await incoming;
      appendFileSync(oldPath, message("answer after shutdown"));
      mocks.live = liveSession(oldPath, "idle");
      await vi.advanceTimersByTimeAsync(6000);
      expect(mocks.post).not.toHaveBeenCalled();
      expect(mocks.status.mock.calls.some(([, status]) => status === "is working…")).toBe(false);
      expect(sendText).not.toHaveBeenCalled();
      expect(pending()).toHaveLength(1);
    });

    it.each(["codex", "pi"])("uses safe %s recovery if the pane finishes before setup exits", async agent => {
      await startDeferred(agent);
      await mocks.client!.onUserMessage(thread, "U1", "!bind project", "4.0");
      appendFileSync(oldPath, agent === "codex" ? codexTurn("owed question", "finished while setup waited") : message("finished while setup waited"));
      mocks.live = { ...mocks.live!, agent_status: "idle" };
      mocks.post.mockClear(); release(); await incoming;
      await vi.advanceTimersByTimeAsync(6000);
      if (agent === "codex") {
        expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "🕘 Answered while the bridge was down:\n\nfinished while setup waited");
      } else {
        // A finished Pi log is cumulative: resuming must not send its history.
        expect(mocks.post).not.toHaveBeenCalled();
      }
      expect(sendText).not.toHaveBeenCalled();
      expect(pending()).toEqual([]);
    });
  });

  describe("handoff source message ownership", () => {
    it.each([false, true])("retains the original source timestamp, held=%s", async held => {
      appendFileSync(join(dir, "config.toml"), `max_handoffs = ${held ? 1 : 20}\n\n[slack.other]\nbot_token = "test2"\napp_token = "test2"\nallowed_user_ids = ["U1"]\n`);
      const targetPath = join(dir, "target.jsonl");
      writeFileSync(targetPath, message("target history"));
      mocks.liveByPane.set("w1:p2", { ...liveSession(targetPath, "idle"), pane_id: "w1:p2" });
      mocks.extraPanes.push({ pane_id: "w1:p2", label: "target", agent: "pi", status: "idle" });
      const statePath = join(dir, "state.json");
      const initial = JSON.parse(readFileSync(statePath, "utf8"));
      initial.threads["other|C1:1.0"] = { ...initial.threads["default|C1:1.0"], bot: "other", pane_id: "w1:p2", label: "target" };
      writeFileSync(statePath, JSON.stringify(initial));
      mocks.live = liveSession(oldPath, "idle");
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      const ask = (text: string, ts: string) => mocks.clients.get("default")!.onUserMessage(thread, "U1", text, ts);
      await ask("Q1", "2.0");
      let finishPost!: (ts: string) => void;
      mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { finishPost = resolve; }));
      appendFileSync(oldPath, message("old answer\n@other handle Q1" + (held ? "\ninterlude\n@other held Q1 brief" : "")));
      await vi.advanceTimersByTimeAsync(300);
      expect(finishPost).toBeTypeOf("function");
      await ask("Q2", "3.0");
      mocks.post.mockResolvedValueOnce("q2-answer-ts");
      appendFileSync(oldPath, message("newer answer"));
      await vi.advanceTimersByTimeAsync(300);
      finishPost("q1-handoff-ts"); await vi.advanceTimersByTimeAsync(0);
      if (held) {
        expect(mocks.post.mock.calls.some(([, text]) => text.includes("Holding this one"))).toBe(true);
        await ask("!panes", "4.0"); await vi.advanceTimersByTimeAsync(0);
      }
      const recipient = JSON.parse(readFileSync(statePath, "utf8"));
      expect(recipient.last_answer["w1:p1"].ts).toBe("q2-answer-ts");
      expect(vi.mocked(sendText).mock.calls.at(-1)![1]).toContain(held ? "held Q1 brief" : "handle Q1");
      expect(recipient.marked["w1:p2"].ts).toBe("q1-handoff-ts");
      appendFileSync(targetPath, message("recipient finished"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.react.mock.calls.filter(([, , name, on]) => name === "white_check_mark" && on).at(-1)?.[1]).toBe("q1-handoff-ts");
    });
  });

  describe("started text batches during shutdown", () => {
    const prose = Array.from({ length: 110 }, (_, i) => `part ${i}: ${"a".repeat(60)}`).join("\n\n")
      + "\n@default do not dispatch this brief after shutdown";
    const chunks = formatForSlack(prose).map(m => m.text);

    it.each(["success", "failure"] as const)("waits for the last started text chunk before stopping clients, final request=%s", async outcome => {
      expect(chunks).toHaveLength(3);
      mocks.live = { ...liveSession(oldPath, "idle"), cwd: dir };
      writeFileSync(join(dir, "result.txt"), "result");
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await mocks.client!.onUserMessage(thread, "U1", "long answer please", "2.0");
      let finishFirst!: (ts: string) => void;
      let finishLast: ((ts: string) => void) | undefined;
      let rejectLast!: (err: Error) => void;
      mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { finishFirst = resolve; }))
        .mockResolvedValueOnce("middle-ts")
        .mockImplementationOnce(() => new Promise<string>((resolve, reject) => { finishLast = resolve; rejectLast = reject; }));
      appendFileSync(oldPath, message(prose + "\n@@send: result.txt"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, chunks[0]);
      expect(JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"))).toEqual([]);
      let stopped = false;
      const stopping = daemon.stop().then(() => { stopped = true; });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(stopped).toBe(false);
        expect(mocks.stop).not.toHaveBeenCalled();
        await mocks.client!.onUserMessage(thread, "U1", "do not dispatch during drain", "3.0");
        await mocks.client!.onUserMessage(thread, "U1", "!help", "3.1");
        expect(mocks.post).toHaveBeenCalledOnce();
        await mocks.client!.onUserFiles(thread, "U1", "do not receive during drain", [
          { name: "new.txt", size: 21 * 1024 * 1024, urlPrivateDownload: "https://example.invalid/new" },
        ], "3.2");
        expect(mocks.post).toHaveBeenCalledOnce();
        finishFirst("first-ts"); await vi.advanceTimersByTimeAsync(0);
        expect(mocks.post.mock.calls.map(([, text]) => text)).toEqual(chunks);
        expect(finishLast).toBeTypeOf("function");
        expect(stopped).toBe(false);
        expect(mocks.stop).not.toHaveBeenCalled();
        if (outcome === "failure") rejectLast(new Error("last Slack post failed"));
        else finishLast!("last-ts");
        await stopping;
        expect(mocks.stop).toHaveBeenCalledOnce();
        // Draining text does not start the answer's files, handoffs or UI work.
        expect(mocks.upload).not.toHaveBeenCalled();
        expect(sendText).toHaveBeenCalledExactlyOnceWith("w1:p1", "long answer please");
        const settled = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
        expect(settled.marked["w1:p1"].ts).toBe("2.0");
        expect(settled.delivered["w1:p1"]).toBe(createHash("sha1").update((prose + "\n@@send: result.txt").trim()).digest("hex"));
        daemon = undefined;
        if (outcome === "success") {
          daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
          await vi.advanceTimersByTimeAsync(300);
          expect(mocks.post.mock.calls.map(([, text]) => text)).toEqual(chunks);
        }
      } finally {
        finishFirst("first-ts"); await vi.advanceTimersByTimeAsync(0);
        finishLast?.("last-ts"); await stopping;
      }
    });

    it("still stops a text batch when its captured binding is removed", async () => {
      mocks.live = liveSession(oldPath, "idle");
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await mocks.client!.onUserMessage(thread, "U1", "long answer please", "2.0");
      let finishFirst!: (ts: string) => void;
      mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { finishFirst = resolve; }));
      appendFileSync(oldPath, message(prose)); await vi.advanceTimersByTimeAsync(300);
      expect(finishFirst).toBeTypeOf("function");
      await mocks.client!.onUserMessage(thread, "U1", "!unbind", "3.0");
      finishFirst("first-ts"); await vi.advanceTimersByTimeAsync(0);
      expect(mocks.post.mock.calls.map(([, text]) => text)).not.toContain(chunks[1]);
      expect(mocks.post.mock.calls.map(([, text]) => text)).not.toContain(chunks[2]);
      await daemon.stop(); daemon = undefined;
      expect(mocks.stop).toHaveBeenCalledOnce();
    });
  });

  describe("follow-up ownership and debt", () => {
    const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    const pending = () => JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8"));
    const digest = (text: string) => createHash("sha1").update(text.trim()).digest("hex");
    const ask = (text: string, ts: string) => mocks.client!.onUserMessage(thread, "U1", text, ts);
    function selectCodex() {
      const sessions = join(dir, ".codex", "sessions");
      mkdirSync(sessions, { recursive: true });
      const path = join(sessions, "rollout-followup.jsonl");
      writeFileSync(path, "");
      mocks.live = { ...liveSession(path, "idle"), agent: "codex", agent_session: { kind: "id", id: "followup" } };
      return path;
    }
    function pauseStatus() {
      let release!: () => void;
      mocks.status.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
      return () => release();
    }

    it("does not replay an already-posted answer when its unsent follow-up is canceled on shutdown", async () => {
      const path = selectCodex();
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await ask("Q1", "2.0");
      const release = pauseStatus();
      const q2 = ask("Q2", "3.0");
      await vi.advanceTimersByTimeAsync(0);
      appendFileSync(path, codexTurn("Q1", "paid Q1 answer"));
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "paid Q1 answer");
      await daemon.stop(); daemon = undefined;
      release(); await q2;
      expect(sendText).toHaveBeenCalledExactlyOnceWith("w1:p1", "Q1");
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "paid Q1 answer");
      expect(pending()).toEqual([]);
      expect(state().delivered["w1:p1"]).toBe(digest("paid Q1 answer"));
    });

    it.each(["mark", "context"] as const)("orders the %s with the first and last dispatched input", async aspect => {
      const path = selectCodex();
      const fresh = state();
      fresh.threads["default|C1:1.0"].context_sent = false;
      fresh.threads["default|C1:1.0"].note_version = 0;
      writeFileSync(join(dir, "state.json"), JSON.stringify(fresh));
      mocks.history.mockResolvedValue([{ author: "Reviewer", userId: "U0", ts: "0.5", text: "IMPORTANT CONTEXT" }]);
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      const release = pauseStatus();
      const q1 = ask("Q1", "2.0"); await vi.advanceTimersByTimeAsync(0);
      const q2 = ask("Q2", "3.0"); await vi.advanceTimersByTimeAsync(0);
      expect(sendText).not.toHaveBeenCalled();
      release(); await Promise.all([q1, q2]);
      const prompts = vi.mocked(sendText).mock.calls.map(([, text]) => text);
      expect(prompts[0]).toMatch(/Q1$/); expect(prompts[1]).toMatch(/Q2$/);
      appendFileSync(path, codexTurn(prompts[1], "Q2 final"));
      await vi.advanceTimersByTimeAsync(300);
      if (aspect === "mark") {
        const done = mocks.react.mock.calls.filter(([, , name, on]) => name === "white_check_mark" && on);
        expect(done.map(([, ts]) => ts)).toEqual(["3.0"]);
      } else {
        expect(prompts[0]).toContain("IMPORTANT CONTEXT");
        expect(prompts[0]).toContain("[Slack bridge:");
        expect(prompts[1]).toBe("Q2");
      }
    });

    it.each([
      ["rebind", "dispatched"], ["unbind", "dispatched"],
      ["rebind", "restored"], ["unbind", "restored"],
    ] as const)("preserves unanswered debt on %s cancellation, prior=%s", async (cancel, prior) => {
      const path = selectCodex();
      if (cancel === "unbind") {
        const shared = state(); shared.threads["default|C2:other"] = {
          ...shared.threads["default|C1:1.0"], channel: "C2", thread_ts: "other",
        };
        writeFileSync(join(dir, "state.json"), JSON.stringify(shared));
      }
      if (prior === "restored") {
        writeFileSync(join(dir, "pending-turns.json"), JSON.stringify([
          { pane_id: "w1:p1", started_at: new Date().toISOString() },
        ]));
        mocks.live = { ...mocks.live!, agent_status: "working" };
      }
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      if (prior === "dispatched") await ask("Q1", "2.0");
      expect(pending()).toHaveLength(1);
      mocks.live = { ...mocks.live!, agent_status: "working" };
      const release = pauseStatus();
      const q2 = ask("Q2", "3.0"); await vi.advanceTimersByTimeAsync(0);
      await ask(cancel === "rebind" ? "!bind project" : "!unbind", "4.0");
      release(); await q2;
      expect(vi.mocked(sendText).mock.calls).toEqual(prior === "dispatched" ? [["w1:p1", "Q1"]] : []);
      expect(pending()).toEqual([expect.objectContaining({ pane_id: "w1:p1" })]);
      expect(state().marked["w1:p1"]?.ts).not.toBe("3.0");
      // An empty restored answer still owes a completion notice; losing its
      // ledger entry would incorrectly classify it as an unawaited turn.
      const answer = prior === "restored" ? "" : "Q1 answer after cancellation";
      appendFileSync(path, codexTurn("Q1", answer));
      mocks.live = { ...mocks.live!, agent_status: "idle" };
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post.mock.calls.some(([, text]) => text.includes(answer || "✅ Done (no output)."))).toBe(true);
      expect(pending()).toEqual([]);
      expect(mocks.react.mock.calls.filter(([, ts, name, on]) => ts === "3.0" && name === "white_check_mark" && on)).toEqual([]);
    });

    it.each([{ ageS: 1799, downMs: 0 }, { ageS: 900, downMs: 901_000 }])("starts a fresh dispatched recovery clock after paying Q1 aged $ageS seconds, downtime=$downMs", async ({ ageS, downMs }) => {
      const path = selectCodex();
      const oldTime = new Date(Date.now() - ageS * 1000).toISOString();
      writeFileSync(path, codexTurn("Q1"));
      writeFileSync(join(dir, "pending-turns.json"), JSON.stringify([{ pane_id: "w1:p1", started_at: oldTime }]));
      mocks.live = { ...mocks.live!, agent_status: "working" };
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await vi.advanceTimersByTimeAsync(200);
      const release = pauseStatus();
      const q2 = ask("Q2", "3.0"); await vi.advanceTimersByTimeAsync(0);
      appendFileSync(path, codexTurn("Q1", "paid Q1 answer"));
      mocks.live = { ...mocks.live!, agent_status: "idle" };
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "paid Q1 answer");
      await vi.advanceTimersByTimeAsync(1100);
      // Setup alone must not renew or discard the old entry.
      expect(pending()[0].started_at).toBe(oldTime);
      release(); await q2;
      expect(sendText).toHaveBeenCalledExactlyOnceWith("w1:p1", "Q2");
      const dispatchedAt = new Date().toISOString();
      const afterDispatch = pending();
      await daemon.stop(); daemon = undefined;
      await vi.advanceTimersByTimeAsync(downMs);
      appendFileSync(path, codexTurn("Q2", "fresh Q2 answer owed on restart"));
      mocks.post.mockClear();
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post).toHaveBeenCalledExactlyOnceWith(thread, "🕘 Answered while the bridge was down:\n\nfresh Q2 answer owed on restart");
      expect(afterDispatch).toEqual([{ pane_id: "w1:p1", started_at: dispatchedAt }]);
      expect(pending()).toEqual([]);
    });

    it.each(["dispatched", "restored"] as const)("does not renew an older unanswered %s debt when Q2 dispatches", async prior => {
      selectCodex();
      const oldTime = new Date(Date.now() - (prior === "restored" ? 900_000 : 0)).toISOString();
      if (prior === "restored") {
        writeFileSync(join(dir, "pending-turns.json"), JSON.stringify([{ pane_id: "w1:p1", started_at: oldTime }]));
      }
      mocks.live = { ...mocks.live!, agent_status: "working" };
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      if (prior === "dispatched") await ask("Q1", "2.0");
      const release = pauseStatus();
      const q2 = ask("Q2", "3.0"); await vi.advanceTimersByTimeAsync(5000);
      expect(pending()).toEqual([{ pane_id: "w1:p1", started_at: oldTime }]);
      release(); await q2;
      expect(vi.mocked(sendText).mock.calls.at(-1)).toEqual(["w1:p1", "Q2"]);
      expect(pending()).toEqual([{ pane_id: "w1:p1", started_at: oldTime }]);
      expect(mocks.post).not.toHaveBeenCalled();
    });

    it("retains a newer dispatched debt after paying the old answer during setup", async () => {
      const path = selectCodex();
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await ask("Q1", "2.0");
      const release = pauseStatus();
      const q2 = ask("Q2", "3.0"); await vi.advanceTimersByTimeAsync(0);
      appendFileSync(path, codexTurn("Q1", "paid Q1 answer"));
      await vi.advanceTimersByTimeAsync(300);
      release(); await q2;
      mocks.live = { ...mocks.live!, agent_status: "working" };
      await daemon.stop(); daemon = undefined;
      expect(pending()).toHaveLength(1);
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      appendFileSync(path, codexTurn("Q2", "recovered Q2 answer"));
      mocks.live = { ...mocks.live!, agent_status: "idle" };
      await vi.advanceTimersByTimeAsync(300);
      expect(mocks.post.mock.calls.filter(([, text]) => text.includes("paid Q1 answer"))).toHaveLength(1);
      expect(mocks.post.mock.calls.filter(([, text]) => text.includes("recovered Q2 answer"))).toHaveLength(1);
      expect(pending()).toEqual([]);
    });

    it("does not let an older suspended post overwrite a newer delivery hash", async () => {
      const path = selectCodex();
      // A newer answer may equal the hash from before Q1: value comparison
      // alone cannot prove that no newer delivery has run (the ABA case).
      const initial = state(); initial.delivered = { "w1:p1": digest("newest answer") };
      writeFileSync(join(dir, "state.json"), JSON.stringify(initial));
      daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
      await ask("Q1", "2.0");
      const release = pauseStatus();
      const q2 = ask("Q2", "3.0"); await vi.advanceTimersByTimeAsync(0);
      let finishPost!: (ts: string) => void;
      mocks.post.mockImplementationOnce(() => new Promise<string>(resolve => { finishPost = resolve; }));
      appendFileSync(path, codexTurn("Q1", "older answer"));
      await vi.advanceTimersByTimeAsync(300);
      expect(finishPost).toBeTypeOf("function");
      release(); await q2;
      appendFileSync(path, codexTurn("Q2", "newest answer"));
      await vi.advanceTimersByTimeAsync(300);
      expect(state().delivered["w1:p1"]).toBe(digest("newest answer"));
      finishPost("older-post-ts"); await vi.advanceTimersByTimeAsync(0);
      expect(state().delivered["w1:p1"]).toBe(digest("newest answer"));
      expect(state().last_answer["w1:p1"].ts).toBe("answer-ts");
      expect(pending()).toEqual([]);
    });
  });
});
