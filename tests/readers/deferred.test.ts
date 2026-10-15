import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeferredReader } from "../../src/readers/jsonl.js";
import { createAgentOutputReader } from "../../src/readers/registry.js";
import type { AgentSessionRef } from "../../src/agent-sessions.js";

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("DeferredReader — a log that is not there yet", () => {
  it("reads nothing until the pick succeeds, then delegates for good", () => {
    let picks = 0;
    let available = false;
    const reader = new DeferredReader("x-jsonl", true, () => {
      picks += 1;
      return available ? { kind: "x-jsonl", read: () => "said", lastPrompt: () => "asked", lastAnswer: () => "said" } : null;
    }, logger, "w1:p1");
    expect(reader.kind).toBe("x-jsonl");
    expect(reader.verbatim).toBe(true);
    expect(reader.read(10)).toBe("");
    expect(reader.lastPrompt()).toBe("");
    available = true;
    expect(reader.read(10)).toBe("said");
    expect(reader.lastAnswer()).toBe("said");
    const before = picks;
    reader.read(10);
    expect(picks).toBe(before); // picked once, kept
  });
});

describe("DeferredReader — when the log never comes", () => {
  it("reads the screen after the grace period, and says so as a scrape", () => {
    let t = 1_000_000;
    const warnings: string[] = [];
    const log = { ...logger, warn: (m: string) => { warnings.push(m); } };
    const scrape = { kind: "scrape", read: () => "from the screen" };
    const reader = new DeferredReader("claude-jsonl", true, () => null, log, "w1:p1", scrape, 90_000, () => t);
    expect(reader.read(10)).toBe("");
    expect(reader.kind).toBe("claude-jsonl");
    expect(reader.verbatim).toBe(true);
    t += 60_000;
    expect(reader.read(10)).toBe(""); // still within the grace
    t += 60_000;
    expect(reader.read(10)).toBe("from the screen");
    expect(reader.kind).toBe("scrape");
    expect(reader.verbatim).toBe(false);
    expect(warnings).toHaveLength(1);
    // Once given up, it stays on the screen even if a log would now appear.
    expect(reader.read(10)).toBe("from the screen");
  });

  it("prefers the log when it appears within the grace", () => {
    let t = 0;
    let available = false;
    const scrape = { kind: "scrape", read: () => "screen" };
    const reader = new DeferredReader("claude-jsonl", true, () => (available ? { kind: "claude-jsonl", verbatim: true, read: () => "log" } : null), logger, "w1:p1", scrape, 90_000, () => t);
    reader.read(10);
    t = 30_000; available = true;
    expect(reader.read(10)).toBe("log");
    expect(reader.kind).toBe("claude-jsonl");
  });
});

describe("Codex pane that has no session yet", () => {
  let home: string;
  let previousHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-home-"));
    previousHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("waits for the session instead of settling for the screen", () => {
    let session: AgentSessionRef = undefined;
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "codex",
      session,
      resolveSession: () => session,
      readPane: () => "welcome banner",
      logger,
    });
    expect(reader.kind).toBe("codex-jsonl");
    expect(reader.session).toBeUndefined();
    expect(reader.read(100)).toBe("");
    // The first prompt: herdr learns the id, and the rollout appears.
    const id = `late-${Date.now()}`;
    const dir = join(home, ".codex", "sessions", "2026", "09", "14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-${id}.jsonl`), JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "from rollout" }] },
    }) + "\n");
    session = { kind: "id", id };
    // Metadata alone does not pin the reader; resolving the on-disk log does.
    expect(reader.session).toBeUndefined();
    expect(reader.read(100)).toBe("from rollout");
    expect(reader.session).toEqual({ kind: "id", id });
    session = { kind: "id", id: "replacement" };
    expect(reader.read(100)).toBe("from rollout");
    expect(reader.session).toEqual({ kind: "id", id });
  });

  it("still scrapes when nobody can ask herdr again", () => {
    const reader = createAgentOutputReader({
      paneId: "w1:p1",
      agentName: "codex",
      session: undefined,
      readPane: () => "scraped",
      logger,
    });
    expect(reader.kind).toBe("scrape");
  });
});
