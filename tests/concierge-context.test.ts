import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectConciergeContext } from "../src/concierge.js";
import { getAgentInfoAsync, type AgentInfo } from "../src/herdr-client.js";
import * as jsonl from "../src/readers/jsonl.js";
import * as sessions from "../src/agent-sessions.js";
import type { PaneInfo } from "../src/types.js";

vi.mock("../src/herdr-client.js", async original => ({
  ...await original<typeof import("../src/herdr-client.js")>(), getAgentInfoAsync: vi.fn(),
}));

let dir: string;
let path: string;
const record = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } });
const target = (id = "w1:p1"): PaneInfo => ({ pane_id: id, tab_id: "w1:t1", workspace_id: "w1", label: "Redis reboot", agent: "pi", status: "working" });
const info = (paneId = "w1:p1"): AgentInfo => ({ agent: "pi", pane_id: paneId, tab_id: "w1:t1", workspace_id: "w1", agent_status: "working", agent_session: { kind: "path", path } });
const options = () => ({ query: "shipping-cache-v2 redis reboot", panes: [target()], isAvailable: () => true, canReadContext: () => true });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "concierge-context-"));
  path = join(dir, "session.jsonl");
  writeFileSync(path, record("user", "Reboot shipping-cache-v2 Redis servers") + "\n");
  vi.mocked(getAgentInfoAsync).mockReset().mockImplementation(async id => info(id));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("bounded recent task hints", () => {
  it.each(["pi", "omp", "codex", "claude"])("reads %s user/assistant text, not tools, reasoning, scaffolding or sidechains", agent => {
    const events = agent === "codex" ? [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "shipping-cache-v2" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<system>PRIVATE_SCAFFOLD</system>" }] } },
      { type: "response_item", payload: { type: "function_call_output", output: "PRIVATE_TOOL" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Rebooting" }, { type: "thinking", text: "PRIVATE_REASONING" }] } },
    ] : agent === "claude" ? [
      { type: "user", message: { content: "shipping-cache-v2" } },
      { type: "user", isMeta: true, message: { content: "PRIVATE_SCAFFOLD" } },
      { type: "user", message: { content: [{ type: "tool_result", content: "PRIVATE_TOOL" }] } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "PRIVATE_SIDECHAIN" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Rebooting" }, { type: "thinking", thinking: "PRIVATE_REASONING" }] } },
    ] : [
      JSON.parse(record("user", "shipping-cache-v2")), JSON.parse(record("assistant", "Rebooting")),
      JSON.parse(record("toolResult", "PRIVATE_TOOL")), JSON.parse(record("system", "PRIVATE_SYSTEM")),
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }, { type: "toolCall", arguments: { text: "PRIVATE_TOOL" } }] } },
    ];
    writeFileSync(path, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    const result = jsonl.readRecentTaskContext(path, agent);
    expect(result).toContain("shipping-cache-v2");
    expect(result).toContain("Rebooting");
    expect(result).not.toContain("PRIVATE_");
  });

  it("bounds file bytes, recent messages and per-message text, tolerating partial records", () => {
    writeFileSync(path, record("user", "OUTSIDE_BYTE_WINDOW") + "\n" + "x".repeat(70_000) + "\n" +
      Array.from({ length: 9 }, (_, i) => record("assistant", "message-" + i)).join("\n") + "\n" +
      record("user", "START " + "y".repeat(8_000) + " END") + "\n{partial");
    const result = jsonl.readRecentTaskContext(path, "pi");
    expect(result).not.toContain("OUTSIDE_BYTE_WINDOW");
    expect(result).not.toContain("message-3");
    expect(result).toContain("message-4");
    expect(result).toContain("START");
    expect(result).toContain("END");
    expect(result.length).toBeLessThan(2_200);
  });

  it("fails closed for missing, non-file and unsupported sources", () => {
    expect(jsonl.readRecentTaskContext(join(dir, "missing"), "pi")).toBe("");
    expect(jsonl.readRecentTaskContext(dir, "pi")).toBe("");
    expect(jsonl.readRecentTaskContext(path, "unknown")).toBe("");
  });
});

describe("host-scoped context collection", () => {
  it("reads a working pane without prompting it and verifies its exact session before and after", async () => {
    const contexts = await collectConciergeContext(options());
    expect(contexts.get("w1:p1")).toContain("shipping-cache-v2");
    expect(getAgentInfoAsync).toHaveBeenCalledTimes(2);
  });

  it("skips already-complete metadata and panes outside the host's privacy scope", async () => {
    const read = vi.spyOn(jsonl, "readRecentTaskContext");
    expect((await collectConciergeContext({ ...options(), query: "redis reboot" })).size).toBe(0);
    expect((await collectConciergeContext({ ...options(), canReadContext: () => false })).size).toBe(0);
    expect(getAgentInfoAsync).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["session", "identity", "permission"])("discards evidence when %s changes during discovery", async change => {
    let allowed = true;
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => {
      if (vi.mocked(getAgentInfoAsync).mock.calls.length === 1) return info();
      allowed = false;
      return change === "session" ? { ...info(), agent_session: { kind: "path", path: "/replacement" } }
        : change === "identity" ? { ...info(), pane_id: "other" } : info();
    });
    expect((await collectConciergeContext({ ...options(), canReadContext: () => change !== "permission" || allowed })).size).toBe(0);
  });

  it("caps candidate reads at eight live sessions", async () => {
    const read = vi.spyOn(jsonl, "readRecentTaskContext");
    const contexts = await collectConciergeContext({ ...options(), panes: Array.from({ length: 12 }, (_, i) => target(`w1:p${i}`)) });
    expect(contexts.size).toBe(8);
    expect(read).toHaveBeenCalledTimes(8);
  });

  it("prioritizes partial metadata candidates ahead of unrelated panes when the eight-pane cap applies", async () => {
    const panes = Array.from({ length: 12 }, (_, i) => ({ ...target(`w1:p${i}`), label: i === 11 ? "Redis reboot" : "project" }));
    const contexts = await collectConciergeContext({ ...options(), panes });
    expect(contexts.size).toBe(8);
    expect(contexts.has("w1:p11")).toBe(true);
    expect(vi.mocked(getAgentInfoAsync).mock.calls[0][0]).toBe("w1:p11");
  });

  it("skips unsupported agents before looking up their sessions", async () => {
    expect((await collectConciergeContext({ ...options(), panes: [{ ...target(), agent: "opencode" }] })).size).toBe(0);
    expect(getAgentInfoAsync).not.toHaveBeenCalled();
  });

  it.each(["codex", "claude"])("resolves only the current live %s session ID and reads its structured text", async agent => {
    const locator = vi.spyOn(sessions, agent === "codex" ? "findCodexSessionPath" : "findClaudeSessionPath").mockReturnValue(path);
    const event = agent === "codex"
      ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "shipping-cache-v2" }] } }
      : { type: "user", message: { content: "shipping-cache-v2" } };
    writeFileSync(path, JSON.stringify(event) + "\n");
    vi.mocked(getAgentInfoAsync).mockImplementation(async () => ({ ...info(), agent, agent_session: { kind: "id", id: "live-id" } }));
    expect((await collectConciergeContext({ ...options(), panes: [{ ...target(), agent }] })).get("w1:p1")).toContain("shipping-cache-v2");
    expect(locator).toHaveBeenCalledExactlyOnceWith("live-id");
  });

  it("does not start a file read after a synchronous session lookup exceeds the deadline", async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(jsonl, "readRecentTaskContext");
    vi.spyOn(sessions, "findCodexSessionPath").mockImplementation(() => {
      vi.setSystemTime(Date.now() + 5_100); // Wall clock advances without running timeout callbacks.
      return path;
    });
    vi.mocked(getAgentInfoAsync).mockResolvedValue({ ...info(), agent: "codex", agent_session: { kind: "id", id: "live-id" } });
    expect((await collectConciergeContext({ ...options(), panes: [{ ...target(), agent: "codex" }] })).size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it("ends lookup after five seconds and never reads files after a timed-out metadata call returns", async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(jsonl, "readRecentTaskContext");
    let resolve!: (value: AgentInfo) => void;
    vi.mocked(getAgentInfoAsync).mockImplementation(() => new Promise<AgentInfo>(r => { resolve = r; }));
    const pending = collectConciergeContext(options());
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).size).toBe(0);
    resolve(info());
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
  });
});
