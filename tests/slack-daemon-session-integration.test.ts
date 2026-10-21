import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  extraPanes: [] as Array<{ pane_id: string; label: string; agent: string; status: string; name?: string; title?: string; cwd?: string }>,
  post: vi.fn(async (_thread: SlackThread, _text: string) => "answer-ts"),
  status: vi.fn(async (_thread: SlackThread, _status: string) => {}),
  react: vi.fn(async (_channel: string, _ts: string, _name: string, _on: boolean) => true),
  upload: vi.fn(async (_thread: SlackThread, _path: string, _name: string, _title: string) => {}),
  history: vi.fn(async (): Promise<ThreadMessage[]> => []),
  download: vi.fn(async (_url: string): Promise<Buffer> => Buffer.from("file data")),
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
  sendKeys: vi.fn(),
  createTab: vi.fn(async () => ({ pane_id: "w1:p2", tab_id: "w1:t2" })),
  startAgent: vi.fn(async () => {}),
  closeTab: vi.fn(),
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
    downloadFile = mocks.download;
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
import { closeTab, getAgentInfoAsync, sendKeys, sendText, startAgent } from "../src/herdr-client.js";
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
  mocks.download.mockReset().mockResolvedValue(Buffer.from("file data"));
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

describe("Pane discovery", () => {
  it("distinguishes identical labels in the list, unbound chooser and ambiguous bind reply", async () => {
    mocks.extraPanes.push(
      { pane_id: "w2:p1", label: "1", name: "payments-fix", agent: "pi", status: "working", cwd: join(dir, "payments/fix") },
      { pane_id: "w3:p1", label: "1", name: "payments-review", agent: "claude", status: "idle", cwd: join(dir, "payments/review") },
    );
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const unbound = { channel: "C1", threadTs: "other" };
    for (const prompt of ["!panes", "where can I bind?", "!bind 1"]) {
      mocks.post.mockClear();
      await mocks.client!.onUserMessage(unbound, "U1", prompt, "2.0");
      const text = mocks.post.mock.calls.at(-1)![1];
      expect(text).toContain("*payments-fix* — pi · working");
      expect(text).toContain("*payments-review* — claude · idle");
      expect(text).toContain("~/payments/fix");
      expect(text).toContain("~/payments/review");
      expect(text).toContain("`!bind w2:p1`");
      expect(text).toContain("`!bind w3:p1`");
    }
    expect(mocks.post.mock.calls.at(-1)![1]).toContain('"1" matches 2 panes');
    expect(sendText).not.toHaveBeenCalled();
  });

  it("falls back to titles or labels, escapes Slack mentions and only abbreviates the actual home", async () => {
    mocks.extraPanes.push({
      pane_id: "w2:p1", label: "1", title: "Fix <@UBAD>\nnext", agent: "pi", status: "blocked", cwd: dir + "-other",
    }, { pane_id: "w3:p1", label: "home", agent: "pi", status: "done", cwd: dir });
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await mocks.client!.onUserMessage(thread, "U1", "!panes", "2.0");
    const text = mocks.post.mock.calls.at(-1)![1];
    expect(text).toContain("*Fix &lt;@UBAD&gt; next* — pi · blocked");
    expect(text).not.toContain("<@UBAD>");
    expect(text).toContain(dir + "-other");
    expect(text).toContain("*home* — pi · done\n    ~\n");
    expect(text).toContain("*project* — pi · working"); // old metadata without a name/title/cwd
    expect(text).not.toContain("undefined");
  });
});

describe("Slack input cancellation — real observe loops", () => {
  async function flush() { for (let i = 0; i < 160; i++) await Promise.resolve(); }
  const pending = () => existsSync(join(dir, "pending-turns.json"))
    ? JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8")) : [];

  it.each([
    { cancel: "same-bind", sample: 1 }, { cancel: "same-bind", sample: 2 }, { cancel: "same-bind", sample: 3 },
    { cancel: "shared-unbind", sample: 1 }, { cancel: "last-unbind", sample: 1 },
    { cancel: "stop", sample: 1 },
  ])("does not send after $cancel during metadata sample $sample", async ({ cancel, sample }) => {
    writeFileSync(oldPath, codexTurn("old question", "old answer"));
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex" };
    if (sample >= 2) {
      writeFileSync(oldPath, JSON.stringify({ type: "message", id: "prior-record", message: {
        role: "assistant", content: [{ type: "text", text: "old answer" }],
      } }) + "\n");
      mocks.live = { ...liveSession(oldPath, "idle"), completion_evidence: {
        terminal_id: "terminal", endpoint_identity: "endpoint", state_change_seq: 1,
        completion_seq: 1, screen_detection_skipped: true, launch_pending: false,
      } };
    }
    if (cancel === "shared-unbind") {
      const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
      state.threads["default|C2:other"] = { ...state.threads["default|C1:1.0"], channel: "C2", thread_ts: "other" };
      writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    }
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (value: AgentInfo | null) => void;
    let calls = 0;
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => {
      if (++calls === sample) return new Promise(resolve => { release = resolve; });
      return mocks.live;
    });
    const sending = mocks.client!.onUserMessage(thread, "U1", "cancel me", "2.0");
    await flush();
    expect(release).toBeTypeOf("function");
    expect(calls).toBe(sample);
    expect(sendText).not.toHaveBeenCalled();
    if (cancel === "same-bind") await mocks.client!.onUserMessage(thread, "U1", "!bind project", "3.0");
    else if (cancel.includes("unbind")) await mocks.client!.onUserMessage(thread, "U1", "!unbind", "3.0");
    else await daemon.stop();
    release(mocks.live);
    await sending;
    expect(sendText).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
  });

  it("does not start setup after a held status returns during stop, or replay false debt on restart", async () => {
    writeFileSync(oldPath, codexTurn("answered question", "OLD_ANSWER_NOT_OWED"));
    mocks.live = { ...liveSession(oldPath, "idle"), agent: "codex" };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: () => void;
    mocks.status.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = mocks.client!.onUserMessage(thread, "U1", "cancel at status", "2.0");
    await flush();
    let finishStop!: () => void;
    mocks.stop.mockImplementationOnce(() => new Promise(resolve => { finishStop = resolve; }));
    const stopping = daemon.stop(); await flush();
    expect(finishStop).toBeTypeOf("function");
    mocks.react.mockClear(); mocks.screen = "Teach auto mode about your environment?";
    release(); await flush();
    const effects = { reactions: mocks.react.mock.calls.length, keys: vi.mocked(sendKeys).mock.calls.length, debt: pending() };
    finishStop(); await stopping; mocks.screen = "";
    await vi.advanceTimersByTimeAsync(1500); await sending;
    expect(effects).toEqual({ reactions: 0, keys: 0, debt: [] });
    mocks.post.mockClear(); daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).not.toContain("OLD_ANSWER_NOT_OWED");
  });

  it("does not fetch history after an existing dialog wait returns during stop", async () => {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    state.threads["default|C1:1.0"].context_sent = false;
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    mocks.screen = "Teach auto mode about your environment?";
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const sending = mocks.client!.onUserMessage(thread, "U1", "cancel at dialog", "2.0");
    await flush(); expect(sendKeys).toHaveBeenCalledExactlyOnceWith("w1:p1", "Escape");
    await daemon.stop(); mocks.screen = "";
    await vi.advanceTimersByTimeAsync(1500); await sending;
    expect(mocks.history).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not start prompt setup or another download after a download returns during stop", async () => {
    mocks.live = { ...mocks.live!, cwd: dir };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (bytes: Buffer) => void;
    mocks.download.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const file = { name: "a.txt", size: 10, urlPrivateDownload: "https://example.invalid/a" };
    const incoming = mocks.client!.onUserFiles(thread, "U1", "caption", [file, { ...file, name: "b.txt" }], "2.0");
    await flush(); expect(release).toBeTypeOf("function");
    await daemon.stop(); mocks.status.mockClear(); mocks.react.mockClear();
    release(Buffer.from("file data")); await incoming;
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.react).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(existsSync(join(dir, ".inbox"))).toBe(false);
  });

  it.each(["remove", "fallback"])("does not start another working reaction after %s returns during stop", async mode => {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (mode === "remove") state.marked = { "w1:p1": { channel: "C1", ts: "old", name: "hourglass_flowing_sand" } };
    else appendFileSync(join(dir, "config.toml"), 'mark_working = "custom_mark"\n');
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (ok: boolean) => void;
    mocks.react.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = mocks.client!.onUserMessage(thread, "U1", "cancel at mark", "2.0");
    await flush(); expect(release).toBeTypeOf("function");
    await daemon.stop(); release(mode === "remove"); await sending;
    expect(mocks.react).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("removes a working reaction that finishes being added during stop", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (ok: boolean) => void;
    mocks.react.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const sending = mocks.client!.onUserMessage(thread, "U1", "cancel while adding mark", "2.0");
    await flush(); expect(release).toBeTypeOf("function");
    await daemon.stop(); release(true); await sending;
    expect(mocks.react.mock.calls.map(c => [c[1], c[3]])).toEqual([["2.0", true], ["2.0", false]]);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"]).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("removes a canceled follow-up's mark after stop without erasing restored debt", async () => {
    const debt = [{ pane_id: "w1:p1", started_at: new Date().toISOString() }];
    writeFileSync(join(dir, "pending-turns.json"), JSON.stringify(debt));
    mocks.screen = "Teach auto mode about your environment?";
    let sending!: Promise<void>;
    mocks.start.mockImplementationOnce(async () => {
      sending = mocks.client!.onUserMessage(thread, "U1", "cancel at dialog", "2.0");
      await flush();
    });
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    expect(sendKeys).toHaveBeenCalledExactlyOnceWith("w1:p1", "Escape");
    await daemon.stop(); mocks.screen = "";
    await vi.advanceTimersByTimeAsync(1500); await sending;
    expect(mocks.react.mock.calls.map(c => [c[1], c[3]])).toEqual([["2.0", true], ["2.0", false]]);
    expect(pending()).toEqual(debt);
    expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).marked["w1:p1"]).toBeUndefined();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not close a spawned tab when shutdown cancels its startup menu", async () => {
    mocks.screen = "Update available!\n› 1. Update now\n  2. Skip\n  3. Skip until next version";
    vi.mocked(startAgent).mockRejectedValueOnce(new Error("blocked during startup"));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const spawning = mocks.client!.onUserMessage(thread, "U1", `!spawn ${dir} codex`, "2.0");
    await flush(); expect(sendKeys).toHaveBeenCalledExactlyOnceWith("w1:p2", "Down");
    await daemon.stop(); await vi.advanceTimersByTimeAsync(1000); await spawning;
    expect(closeTab).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("does not continue a startup menu after stop during its key delay", async () => {
    mocks.screen = "Update available!\n› 1. Update now\n  2. Skip\n  3. Skip until next version";
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const sending = mocks.client!.onUserMessage(thread, "U1", "cancel at startup menu", "2.0");
    await flush(); expect(sendKeys).toHaveBeenCalledExactlyOnceWith("w1:p1", "Down");
    await daemon.stop();
    await vi.advanceTimersByTimeAsync(1000); await sending;
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("Slack context commits — real observe loops", () => {
  const state = () => JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  const flags = () => state().threads["default|C1:1.0"];
  const ask = (text: string, ts = "2.0") => mocks.client!.onUserMessage(thread, "U1", text, ts);
  const inputs = () => vi.mocked(sendText).mock.calls.map(c => c[1]);
  const history: ThreadMessage[] = [{ author: "User", userId: "U1", text: "earlier thread detail", ts: "1.5" }];
  function freshContext() {
    const saved = state();
    saved.threads["default|C1:1.0"].context_sent = false;
    saved.threads["default|C1:1.0"].note_version = 0;
    writeFileSync(join(dir, "state.json"), JSON.stringify(saved));
    mocks.history.mockResolvedValue(history);
  }

  it("preserves context through shutdown during history and sends it on retry after restart", async () => {
    freshContext();
    let release!: (messages: ThreadMessage[]) => void;
    mocks.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    const sending = ask("never dispatched");
    for (let i = 0; i < 160; i++) await Promise.resolve();
    expect(release).toBeTypeOf("function");
    expect(sendText).not.toHaveBeenCalled();
    await daemon.stop(); release(history); await sending;
    expect({ context: flags().context_sent, version: flags().note_version }).toEqual({ context: false, version: 0 });
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("retry after restart", "3.0");
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]).toContain("earlier thread detail");
    expect(inputs()[0]).toContain("Slack bridge:");
    expect(flags().context_sent).toBe(true);
  });

  it.each([false, true])("retains context after a failed dispatch for the next input, already queued=%s", async queued => {
    freshContext();
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    vi.mocked(sendText).mockImplementationOnce(() => { throw new Error("stdin dispatch failed"); });
    const failed = expect(ask("failed attempt")).rejects.toThrow("stdin dispatch failed");
    const next = queued ? ask("next attempt", "3.0") : undefined;
    await failed;
    if (!queued) {
      expect({ context: flags().context_sent, version: flags().note_version }).toEqual({ context: false, version: 0 });
      await ask("next attempt", "3.0");
    } else await next;
    expect(inputs()).toHaveLength(2);
    expect(inputs()[1]).toContain("earlier thread detail");
    expect(inputs()[1]).toContain("Slack bridge:");
    expect(flags().context_sent).toBe(true);
  });

  it("commits a successful input before preparing its queued successor", async () => {
    freshContext();
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await Promise.all([ask("first"), ask("second", "3.0")]);
    expect(inputs()).toHaveLength(2);
    expect(inputs()[0]).toContain("earlier thread detail");
    expect(inputs()[0]).toContain("Slack bridge:");
    expect(inputs()[1]).toBe("second");
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect({ context: flags().context_sent, version: flags().note_version }).toEqual({ context: true, version: 3 });
  });

  it("does not downgrade an already sent newer bridge note", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("bare input");
    expect(inputs()).toEqual(["bare input"]);
    expect(flags().note_version).toBe(999);
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it("keeps best-effort history-fetch failure behavior after a successful bare send", async () => {
    freshContext(); mocks.history.mockRejectedValueOnce(new Error("history unavailable"));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("first"); await ask("second", "3.0");
    expect(inputs()[0]).toContain("Slack bridge:");
    expect(inputs()[1]).toBe("second");
    expect(mocks.history).toHaveBeenCalledTimes(1);
    expect(flags().context_sent).toBe(true);
  });
});

describe("Confirmed reader replacement — real observe loops", () => {
  type Kind = "pi" | "codex" | "claude";
  const ask = (text: string, ts = "2.0") => mocks.client!.onUserMessage(thread, "U1", text, ts);
  const pending = () => existsSync(join(dir, "pending-turns.json"))
    ? JSON.parse(readFileSync(join(dir, "pending-turns.json"), "utf8")) : [];
  function transcript(kind: Kind, prompt: string, answer: string): string {
    if (kind === "codex") return codexTurn(prompt, answer);
    if (kind === "pi") return message(answer);
    return [
      { type: "user", message: { role: "user", content: prompt } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ].map(line => JSON.stringify(line)).join("\n") + "\n";
  }
  function session(kind: Kind, id: string, status = "idle") {
    const path = kind === "codex" ? join(dir, ".codex", "sessions", `rollout-${id}.jsonl`)
      : kind === "claude" ? join(dir, ".claude", "projects", "project", `${id}.jsonl`)
      : join(dir, `${id}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    const info: AgentInfo = { ...liveSession(path, status), agent: kind,
      agent_session: kind === "pi" ? { kind: "path", path } : { kind: "id", id } };
    return { path, info };
  }

  it.each([
    ["pi", "pi"], ["codex", "codex"], ["claude", "claude"], ["codex", "claude"],
  ] as const)("retires %s output on confirmed %s replacement and observes only fresh input", async (oldKind, newKind) => {
    const old = session(oldKind, "old-session", "working");
    const next = session(newKind, "new-session");
    writeFileSync(old.path, transcript(oldKind, "old prompt", "old history"));
    writeFileSync(next.path, transcript(newKind, "unrelated prompt", "UNRELATED_REPLACEMENT_HISTORY"));
    mocks.live = old.info;
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1");
    appendFileSync(old.path, transcript(oldKind, "Q1", "WRONG_RETIRED_OUTPUT"));
    mocks.live = next.info;
    await vi.advanceTimersByTimeAsync(500);
    const posts = mocks.post.mock.calls.map(c => c[1]).join("\n");
    expect(posts).not.toContain("WRONG_RETIRED_OUTPUT");
    expect(posts).not.toContain("UNRELATED_REPLACEMENT_HISTORY");
    expect(posts).toMatch(/session.*changed|switched sessions/i);
    expect(pending()).toEqual([]);
    expect(sendText).toHaveBeenCalledTimes(1);
    await ask("Q2", "3.0");
    appendFileSync(next.path, transcript(newKind, "Q2", "FRESH_REPLACEMENT_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).toContain("FRESH_REPLACEMENT_ANSWER");
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it.each(["unavailable", "missing session"])("keeps its reader when metadata is %s, without a false replacement notice", async missing => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1");
    mocks.live = missing === "unavailable" ? null : { ...mocks.live!, agent_status: "idle", agent_session: undefined };
    appendFileSync(oldPath, message("SAME_SESSION_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1])).toEqual(["SAME_SESSION_ANSWER"]);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("cancels input when replacement is discovered inside its metadata await and makes retry visible", async () => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    let release!: (info: AgentInfo | null) => void;
    let calls = 0;
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => {
      if (++calls === 2) return new Promise(resolve => { release = resolve; });
      return mocks.live;
    });
    const sending = ask("never sent");
    for (let i = 0; i < 160; i++) await Promise.resolve();
    expect(release).toBeTypeOf("function");
    const next = session("pi", "next"); writeFileSync(next.path, message("unrelated history"));
    mocks.live = next.info; release(next.info); await sending;
    expect(sendText).not.toHaveBeenCalled();
    expect(pending()).toEqual([]);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).toMatch(/session.*changed|switched sessions/i);
    await ask("retry", "3.0");
    appendFileSync(next.path, message("RETRY_ANSWER")); await vi.advanceTimersByTimeAsync(500);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.map(c => c[1])).toContain("RETRY_ANSWER");
  });

  it.each([true, false])("cancels the first input after an idle swap and observes its explicit retry, terminal relay=%s", async relay => {
    appendFileSync(join(dir, "config.toml"), `relay_terminal_turns = ${relay}\n`);
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1"); appendFileSync(oldPath, message("Q1 answer"));
    await vi.advanceTimersByTimeAsync(500); mocks.post.mockClear();
    const next = session("pi", "idle-next"); writeFileSync(next.path, message("DO_NOT_REPLAY"));
    mocks.live = next.info; await vi.advanceTimersByTimeAsync(5000);
    await ask("Q2", "3.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).toMatch(/session.*changed|switched sessions/i);
    mocks.post.mockClear();
    await ask("retry Q2", "4.0"); appendFileSync(next.path, message("NEW_IDLE_READER_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1])).toEqual(["NEW_IDLE_READER_ANSWER"]);
  });

  it("does not mistake Codex path/id aliases for a different session", async () => {
    const old = session("codex", "alias-session", "working");
    writeFileSync(old.path, codexTurn("old question", "old history")); mocks.live = old.info;
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1");
    mocks.live = { ...old.info, agent_status: "idle", agent_session: { kind: "path", path: old.path } };
    appendFileSync(old.path, codexTurn("Q1", "SAME_ROLLOUT_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1])).toEqual(["SAME_ROLLOUT_ANSWER"]);
  });

  it("pins a deferred reader only after it selects a source, then detects its replacement", async () => {
    const old = session("codex", "deferred-old", "working");
    writeFileSync(old.path, codexTurn("old question", "old history"));
    mocks.live = { ...old.info, agent_session: undefined };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1"); mocks.live = { ...old.info, agent_status: "idle" };
    appendFileSync(old.path, codexTurn("Q1", "DEFERRED_FIRST_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1])).toEqual(["DEFERRED_FIRST_ANSWER"]);
    const next = session("codex", "deferred-next");
    writeFileSync(next.path, codexTurn("unrelated", "wrong old history")); mocks.live = next.info;
    await ask("Q2", "3.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).toMatch(/session.*changed|switched sessions/i);
  });

  it("rejects a prompt-guessed Claude source that conflicts with later authoritative metadata", async () => {
    const guessed = session("claude", "guessed-source", "working");
    const prompt = "Question initially found in a guessed transcript";
    writeFileSync(guessed.path, transcript("claude", prompt, ""));
    mocks.live = { ...guessed.info, agent_session: undefined, cwd: dir };
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask(prompt); await vi.advanceTimersByTimeAsync(100);
    const actual = session("claude", "actual-source");
    writeFileSync(actual.path, transcript("claude", "different question", "unrelated answer"));
    appendFileSync(guessed.path, transcript("claude", prompt, "WRONG_GUESSED_SOURCE_OUTPUT"));
    mocks.live = actual.info; await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).not.toContain("WRONG_GUESSED_SOURCE_OUTPUT");
    expect(pending()).toEqual([]);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).toMatch(/session.*changed|switched sessions/i);
  });

  it("checks a stream-mode follow-up before dispatch without relying on a baseline sample", async () => {
    appendFileSync(join(dir, "config.toml"), 'output_mode = "stream"\n');
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir }); await ask("Q1");
    const next = session("pi", "stream-next"); writeFileSync(next.path, message("old history")); mocks.live = next.info;
    await ask("unsent Q2", "3.0");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(pending()).toEqual([]);
    expect(mocks.post.mock.calls.map(c => c[1]).join("\n")).toContain("before this input was sent");
  });

  it("constructs the replacement from confirmed async metadata rather than a stale synchronous snapshot", async () => {
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir }); await ask("Q1");
    const next = session("pi", "async-next"); writeFileSync(next.path, message("old history"));
    vi.mocked(getAgentInfoAsync).mockResolvedValue(next.info); // getAgentInfo still reports the old path
    await vi.advanceTimersByTimeAsync(500);
    await ask("Q2", "3.0"); appendFileSync(next.path, message("ASYNC_SELECTED_SOURCE_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1])).toContain("ASYNC_SELECTED_SOURCE_ANSWER");
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("does not wait for another pane's started text when replacing this reader", async () => {
    mocks.live = liveSession(oldPath, "idle");
    const peer = session("pi", "peer", "idle");
    peer.info = { ...peer.info, pane_id: "w1:p2" };
    writeFileSync(peer.path, message("peer history"));
    mocks.liveByPane.set("w1:p2", peer.info);
    mocks.extraPanes.push({ pane_id: "w1:p2", label: "peer", agent: "pi", status: "idle" });
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    state.threads["default|C2:other"] = { ...state.threads["default|C1:1.0"], pane_id: "w1:p2", channel: "C2", thread_ts: "other" };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1"); appendFileSync(oldPath, message("Q1 answer")); await vi.advanceTimersByTimeAsync(500);
    await mocks.client!.onUserMessage({ channel: "C2", threadTs: "other" }, "U1", "peer question", "2.0");
    let release!: (ts: string) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    appendFileSync(peer.path, message("abcdefghijklmnopqrstuvwxyz ".repeat(270)));
    await vi.advanceTimersByTimeAsync(500); expect(release).toBeTypeOf("function");
    const next = session("pi", "independent"); writeFileSync(next.path, message("old history")); mocks.live = next.info;
    let completed = false;
    const checking = ask("canceled Q2", "3.0").then(() => { completed = true; });
    for (let i = 0; i < 160; i++) await Promise.resolve();
    const completedBeforePeer = completed;
    release("peer-first-chunk"); await checking; await vi.advanceTimersByTimeAsync(500);
    expect(completedBeforePeer).toBe(true);
  });

  it("finishes already-started answer text before retiring that reader", async () => {
    mocks.live = liveSession(oldPath, "idle");
    daemon = await startSlackDaemon({ configDir: dir, stateDir: dir });
    await ask("Q1");
    let release!: (ts: string) => void;
    mocks.post.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const answer = "abcdefghijklmnopqrstuvwxyz ".repeat(270);
    writeFileSync(join(dir, "after.txt"), "file requested by the retired answer");
    appendFileSync(oldPath, message(answer + "\n@@send: after.txt")); await vi.advanceTimersByTimeAsync(500);
    expect(release).toBeTypeOf("function");
    const next = session("pi", "after-text"); next.info.cwd = dir;
    writeFileSync(next.path, message("old history"));
    mocks.live = next.info;
    const canceled = ask("Q2", "3.0");
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    release("first-chunk"); await canceled; await vi.advanceTimersByTimeAsync(500);
    const text = mocks.post.mock.calls.map(c => c[1]).filter(t => !/session.*changed|switched sessions/i.test(t));
    expect(text).toEqual(formatForSlack(answer.trim()).map(c => c.text));
    expect(mocks.upload).not.toHaveBeenCalled(); // a new file batch must not start after retirement
    expect(sendText).toHaveBeenCalledTimes(1);
    await ask("retry Q2", "4.0"); appendFileSync(next.path, message("AFTER_DRAIN_ANSWER"));
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.post.mock.calls.map(c => c[1])).toContain("AFTER_DRAIN_ANSWER");
  });
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
