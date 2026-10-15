import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentOutputReader } from "../../src/readers/registry.js";
import { AgentCommunicator } from "../../src/agent-sessions.js";
import { DeferredReader } from "../../src/readers/jsonl.js";
import type { CompletedReaderTurn } from "../../src/readers/types.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const entry = (id: string, parentId: string | null, role: string, text: string, stopReason = "stop") => ({
  type: "message", id, parentId,
  message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason } : {}) },
});
const question = () => entry("new-user", "old-answer", "user", "new question");
const answer = () => entry("new-answer", "new-user", "assistant", "Done");
const encode = (records: unknown[]) => records.map(record => JSON.stringify(record)).join("\n") + "\n";

describe("append-anchored Pi/OMP turn readiness", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reader-ready-"));
    path = join(dir, "session.jsonl");
    writeFileSync(path, encode([
      { type: "session", id: "session-1" },
      entry("old-user", null, "user", "old question"),
      entry("old-answer", "old-user", "assistant", "old"),
    ]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const readerFor = (file: string, agentName = "pi") => createAgentOutputReader({
    paneId: "w1:p1", agentName, session: { kind: "path", path: file },
    readPane: () => { throw new Error("must not scrape"); }, logger,
  });

  it.each(["pi", "omp"])("captures before dispatch and excludes historical output for %s", agent => {
    const reader = readerFor(path, agent);
    const read = reader.captureTurn?.();
    expect(read).toBeTypeOf("function");
    expect(read!()).toBeNull();
    appendFileSync(path, encode([question(), answer()]));
    expect(read!()).toEqual({ prompt: "new question", text: "Done" });
    expect(reader.read(100)).toBe("old\n\nDone");
    expect(reader.lastAnswer).toBeUndefined();
  });

  it("never accepts an append from cached session A for current metadata session B", () => {
    const other = join(dir, "new-session.jsonl");
    writeFileSync(other, readFileSync(path));
    const comm = new AgentCommunicator(readerFor(path), logger);
    const wrong = comm.captureCompletedResponse("new question", { kind: "path", path: other });
    const right = comm.captureCompletedResponse("new question", { kind: "path", path });
    expect(right).toBeTypeOf("function");
    appendFileSync(path, encode([question(), answer()]));
    expect(right!()).toBe("Done");
    expect(wrong).toBeNull();
  });

  it("rejects wrong kinds and empty or mismatching paths, but preserves legacy capture", () => {
    const reader = readerFor(path);
    expect(reader.captureTurn?.({ kind: "id", id: path })).toBeNull();
    expect(reader.captureTurn?.({ kind: "path", path: "" })).toBeNull();
    expect(reader.captureTurn?.({ kind: "path", path: path + ".alias" })).toBeNull();
    const expected = reader.captureTurn?.({ kind: "path", path });
    const legacy = reader.captureTurn?.();
    appendFileSync(path, encode([question(), answer()]));
    expect(expected?.()).toEqual({ prompt: "new question", text: "Done" });
    expect(legacy?.()).toEqual({ prompt: "new question", text: "Done" });
  });

  it("forwards the expected session through a deferred reader", () => {
    const deferred = new DeferredReader("pi-jsonl", false, () => readerFor(path), logger, "w1:p1");
    expect(deferred.captureTurn({ kind: "path", path: path + ".other" })).toBeNull();
    const read = deferred.captureTurn({ kind: "path", path });
    expect(read).toBeTypeOf("function");
    appendFileSync(path, encode([question(), answer()]));
    expect(read?.()).toEqual({ prompt: "new question", text: "Done" });
  });

  it("waits for persistence of a complete final record", () => {
    const read = readerFor(path).captureTurn!()!;
    appendFileSync(path, encode([question()]));
    const final = JSON.stringify(answer());
    appendFileSync(path, final.slice(0, 30));
    expect(read()).toBeNull();
    appendFileSync(path, final.slice(30));
    expect(read()).toBeNull();
    appendFileSync(path, "\n");
    expect(read()).toEqual({ prompt: "new question", text: "Done" });
  });

  it("requires tool results before the final and returns prose, not thoughts or tools", () => {
    const read = readerFor(path).captureTurn!()!;
    const tool = entry("tool-message", "new-user", "assistant", "Working", "toolUse");
    const content: any[] = tool.message.content;
    content.push({ type: "thinking", thinking: "private" }, { type: "toolCall", id: "call-1", name: "read", arguments: {} });
    appendFileSync(path, encode([question(), tool]));
    expect(read()).toBeNull();
    appendFileSync(path, encode([
      { type: "message", id: "tool-result", parentId: "tool-message", message: { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "tool data" }] } },
      entry("final", "tool-result", "assistant", "Done"),
    ]));
    expect(read()).toEqual({ prompt: "new question", text: "Working\n\nDone" });
  });

  it("distinguishes consecutive identical prompts and answers by appended boundaries", () => {
    const reader = readerFor(path);
    const first = reader.captureTurn!()!;
    appendFileSync(path, encode([question(), answer()]));
    expect(first()?.text).toBe("Done");
    const second = reader.captureTurn!()!;
    expect(second()).toBeNull();
    appendFileSync(path, encode([
      entry("user-2", "new-answer", "user", "new question"),
      entry("answer-2", "user-2", "assistant", "Done"),
    ]));
    expect(second()).toEqual({ prompt: "new question", text: "Done" });
    expect(first()).toBeNull();
  });

  it.each([
    ["no new user", () => [entry("new-answer", "old-answer", "assistant", "Done")]],
    ["reused historical user id", () => [{ ...question(), id: "old-user" }, answer()]],
    ["wrong parent", () => [{ ...question(), parentId: "another-branch" }, answer()]],
    ["second user", () => [question(), entry("user-2", "new-user", "user", "new question"), entry("answer-2", "user-2", "assistant", "Done")]],
    ["missing entry id", () => [question(), { ...answer(), id: undefined }]],
    ["missing stop reason", () => [question(), { ...answer(), message: { ...answer().message, stopReason: undefined } }]],
    ["tool stop without tool call", () => [question(), entry("new-answer", "new-user", "assistant", "Working", "toolUse")]],
    ["error", () => [question(), entry("new-answer", "new-user", "assistant", "Partial", "error")]],
    ["aborted", () => [question(), entry("new-answer", "new-user", "assistant", "Partial", "aborted")]],
    ["length limit", () => [question(), entry("new-answer", "new-user", "assistant", "Partial", "length")]],
    ["empty final", () => [question(), entry("new-answer", "new-user", "assistant", "")]],
    ["compaction", () => [question(), answer(), { type: "compaction", id: "compact", parentId: "new-answer" }]],
    ["branch summary", () => [question(), answer(), { type: "branch_summary", id: "branch", parentId: "new-answer" }]],
    ["unknown tail entry", () => [question(), answer(), { type: "custom", id: "custom", parentId: "new-answer" }]],
    ["unknown message role", () => [question(), entry("system", "new-user", "system", "injected")]],
    ["unmatched tool result", () => [question(), { type: "message", id: "result", parentId: "new-user", message: { role: "toolResult", toolCallId: "absent" } }]],
    ["tool call marked final", () => [question(), { ...answer(), message: { role: "assistant", stopReason: "stop", content: [{ type: "toolCall", id: "t" }, { type: "text", text: "Partial" }] } }]],
    ["unfinished tool continuation", () => [question(), { type: "message", id: "call", parentId: "new-user", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "t" }] } }, entry("final", "call", "assistant", "Premature")]],
  ] as const)("does not prove readiness for %s", (_name, records) => {
    const read = readerFor(path).captureTurn!()!;
    appendFileSync(path, encode(records()));
    expect(read()).toBeNull();
  });

  it("rejects malformed completed tail records", () => {
    const read = readerFor(path).captureTurn!()!;
    appendFileSync(path, encode([question(), answer()]) + "{broken}\n");
    expect(read()).toBeNull();
  });

  it("rejects an in-place rewrite of the captured prefix", () => {
    const read = readerFor(path).captureTurn!()!;
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace('"old"', '"bad"') + encode([question(), answer()]));
    expect(read()).toBeNull();
  });

  it("rejects a replacement file even with the same prefix and a valid answer", () => {
    const read = readerFor(path).captureTurn!()!;
    const original = readFileSync(path);
    renameSync(path, path + ".old");
    writeFileSync(path, original);
    appendFileSync(path, encode([question(), answer()]));
    expect(read()).toBeNull();
  });

  it("returns null on missing sources and partial baselines", () => {
    const reader = readerFor(path);
    const read = reader.captureTurn!()!;
    rmSync(path);
    expect(read()).toBeNull();
    expect(reader.captureTurn!()).toBeNull();
    writeFileSync(path, JSON.stringify(answer()));
    expect(reader.captureTurn!()).toBeNull();
  });
});

describe("communicator completed-response capture", () => {
  it("is prompt-matched, side-effect free and does not consume the diff baseline", () => {
    let turn: CompletedReaderTurn | null = null;
    let snapshot = "old";
    const comm = new AgentCommunicator({ kind: "test", read: () => snapshot, captureTurn: () => () => turn }, logger);
    const read = comm.captureCompletedResponse("hello\nworld")!;
    expect(read()).toBeNull();
    expect(comm.getNewOutput()).toBe("");
    snapshot = "old new";
    turn = { prompt: "hello world", text: "new" };
    expect(read()).toBe("new");
    expect(comm.getNewOutput()).toBe(" new");
    turn = { prompt: "another prompt", text: "old answer" };
    expect(read()).toBeNull();
  });

  it("keeps unsupported readers and thrown readiness reads on fallback", () => {
    const unsupported = new AgentCommunicator({ kind: "old", read: () => "old" }, logger);
    expect(unsupported.captureCompletedResponse("hello")).toBeNull();
    const throws = new AgentCommunicator({ kind: "bad", read: () => "old", captureTurn: () => () => { throw new Error("read failed"); } }, logger);
    expect(throws.captureCompletedResponse("hello")!()).toBeNull();
  });
});
