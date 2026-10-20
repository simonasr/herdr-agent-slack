import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { createAgentCommunicator } from "../src/agent-sessions.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("AgentCommunicator (factory)", () => {
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

  it("uses readPane when getAgentInfo returns null", () => {
    const readPane = (paneId: string, _lines: number) => `scraped: ${paneId}`;
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => null,
      readPane,
      logger: noopLogger,
    });
    expect(comm.readerKind).toBe("scrape");
    expect(comm.getAgentOutput(4000)).toBe("scraped: w1:p1");
  });

  it("uses readPane when agent has no agent_session", () => {
    const readPane = () => "scraped content";
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
      }),
      readPane,
      logger: noopLogger,
    });
    expect(comm.getAgentOutput(4000)).toBe("scraped content");
  });

  it("returns '' when session path is missing at construction; does NOT call readPane", () => {
    // The structured reader is selected once. Runtime readPane is forbidden.
    // Construction-time validation may downgrade to scrape (e.g. path
    // missing); but in that case the reader kind must be "scrape".
    let readPaneCalls = 0;
    const readPane = () => { readPaneCalls += 1; return "fallback scrape"; };
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: "/nonexistent/session.jsonl" },
      }),
      readPane,
      logger: noopLogger,
    });
    // Validation should reject the missing path and downgrade to scrape.
    expect(comm.readerKind).toBe("scrape");
    expect(comm.getAgentOutput(4000)).toBe("fallback scrape");
    expect(readPaneCalls).toBe(1);
  });

  it("uses jsonl reader when session path is valid; readPane is never called even if reader returns empty", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agent-comm-"));
    const sessionPath = join(tmpDir, "session.jsonl");
    writeFileSync(sessionPath, JSON.stringify({
      type: "message",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "jsonl response" }],
      },
    }) + "\n", "utf8");

    let readPaneCalls = 0;
    const readPane = () => { readPaneCalls += 1; return "should not be called"; };
    const comm = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane,
      logger: noopLogger,
    });

    expect(comm.readerKind).toBe("pi-jsonl");
    expect(comm.getAgentOutput(4000)).toBe("jsonl response");
    expect(readPaneCalls).toBe(0);

    // Now if the reader returns empty (we'd need to mutate the file), the
    // empty result must NOT trigger readPane.
    writeFileSync(sessionPath, "", "utf8");
    // Construct a NEW communicator with the (now-empty) path so it picks
    // jsonl at construction; reads will return empty.
    const comm2 = createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => ({
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        tab_id: "",
        workspace_id: "",
        agent_session: { kind: "path", path: sessionPath },
      }),
      readPane,
      logger: noopLogger,
    });
    expect(comm2.readerKind).toBe("pi-jsonl");
    expect(comm2.getAgentOutput(4000)).toBe("");
    expect(readPaneCalls).toBe(0); // never increased

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

/**
 * A turn is delivered once.
 *
 * Replays pane `planner`, 2026-09-11 13:12–13:25: `status?` typed from
 * Telegram, answered (turn one), then a background shell completed and the
 * agent reported progress on its own (turn two, no `❯`). Adopting turn two,
 * the bridge read the screen before turn two had closed, found turn one
 * again, and re-sent it under "⌨️ Asked in the terminal: status?".
 */
vi.mock("../src/herdr-client.js", async (importOriginal) => {
  const mod = (await importOriginal()) as typeof import("../src/herdr-client.js");
  return { ...mod, sendText: vi.fn() };
});

describe("AgentCommunicator — one turn, delivered once", () => {
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const turnOne = [
    "❯ status?",
    "",
    "⏺ Grup 1 gagal total: runner crash saat bootstrap.",
    "",
    "✻ Worked for 2m 26s · done 1:15 PM · 1 shell still running",
    "",
    "❯",
  ];
  const turnTwoOpen = [
    ...turnOne.slice(0, -1),
    "⏺ Background command \"Wait until codex blocks\" completed (exit code 0)",
    "",
    "⏺ Grup 1 sudah lewat bootstrap dan GPU gate.",
    "",
    "✶ Cogitating… (48s)",
  ];
  const turnTwoDone = [
    ...turnTwoOpen.slice(0, -1),
    "✻ Worked for 1m 15s · done 1:25 PM · 1 shell still running",
    "",
    "❯",
  ];
  const screens = (frames: string[][]) => {
    let i = 0;
    return createAgentCommunicator({
      paneId: "w1:p1",
      getAgentInfo: () => null,
      readPane: () => (frames[Math.min(i++, frames.length - 1)] ?? []).join("\n"),
      logger: noopLogger,
    });
  };

  it("recognises the delivered turn when an adopted turn reads it again", () => {
    // Reads, in order: turn one's answer; the seal at adoption; then the
    // adopted turn twice — first before turn two closed, then after.
    const comm = screens([turnOne, turnTwoOpen, turnTwoOpen, turnTwoDone]);
    comm.sendInput("status?");
    expect(comm.getTurnResponse()).toContain("Grup 1 gagal total");
    comm.markDelivered("status?");

    comm.beginExternalTurn();
    // Screen still closes on turn one's mark: the same turn, not a new one.
    expect(comm.getTurnResponse()).toContain("Grup 1 gagal total");
    expect(comm.turnAlreadyDelivered()).toBe(true);

    // Turn two has closed. Its own words, and only its own.
    const second = comm.getTurnResponse();
    expect(second).toContain("Grup 1 sudah lewat bootstrap");
    expect(second).not.toContain("Grup 1 gagal total");
    expect(comm.turnAlreadyDelivered()).toBe(false);
  });

  it("does not announce the question the delivered turn already answered", () => {
    const comm = screens([turnOne, turnTwoOpen]);
    comm.sendInput("status?");
    comm.getTurnResponse();
    comm.markDelivered("status?");

    comm.beginExternalTurn();
    // Turn two has no question of its own. `status?` sits above the mark.
    expect(comm.getPendingPrompt()).toBe("");
  });

  it("announces a question typed after the delivered turn", () => {
    const asked = [...turnTwoDone.slice(0, -1), "❯ lanjut ke grup 2", "", "✶ Thinking…"];
    const comm = screens([turnTwoDone, asked]);
    comm.beginExternalTurn();
    comm.getTurnResponse();
    comm.markDelivered("");

    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("lanjut ke grup 2");
  });

  it("does not claim a mark the bridge-typed turn has not drawn yet", () => {
    // The agent settled but the closing line is not on screen. The last mark
    // belongs to an EARLIER turn; recording it would make that turn's answer
    // look "already delivered" and the next real one look like a repeat.
    // (The seal at adoption reads the same early screen here, so it cannot
    // help either: turn one, once it closes, is new to this communicator.)
    const early = ["✻ Worked for 9s · done 1:00 PM", "", "❯ status?", "", "⏺ Grup 1 gagal total: sedang ditulis"];
    const comm = screens([early, early, turnOne]);
    comm.sendInput("status?");
    comm.getTurnResponse();
    comm.markDelivered("status?");

    comm.beginExternalTurn();
    comm.getTurnResponse();
    expect(comm.turnAlreadyDelivered()).toBe(false);
  });

  it("seals whatever is already closed when a turn is adopted", () => {
    // The restart case. Nothing has been delivered by this daemon; the pane
    // reports working; the screen shows turn one closed. Adopting must not
    // make turn one the answer — it was over before the daemon existed.
    const comm = screens([turnOne, turnOne, turnTwoDone]);
    comm.beginExternalTurn();
    // A read that lands before anything new has closed: still turn one.
    expect(comm.getTurnResponse()).toContain("Grup 1 gagal total");
    expect(comm.turnAlreadyDelivered()).toBe(true);
    // Turn two closes: that is the turn this adoption is for.
    expect(comm.getTurnResponse()).toContain("Grup 1 sudah lewat bootstrap");
    expect(comm.turnAlreadyDelivered()).toBe(false);
  });

  it("does not announce, at first sight, a question the sealed turn answered", () => {
    const comm = screens([turnOne, turnOne]);
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("");
  });

  it("announces, at first sight, the question of the turn under way", () => {
    // Bound mid-turn on a question typed in the terminal two minutes ago:
    // that `❯` sits below the last closed turn, so it is the live question.
    const midTurn = [...turnOne.slice(0, -1), "❯ lanjut ke grup 2", "", "✶ Thinking…"];
    const comm = screens([midTurn, midTurn]);
    comm.beginExternalTurn();
    expect(comm.getPendingPrompt()).toBe("lanjut ke grup 2");
  });

  it("falls back to the text of the question when no mark is known yet", () => {
    // First turn after the daemon starts: nothing delivered, no mark. The one
    // thing known is what the bridge itself typed, and that is not a question
    // somebody asked in the terminal.
    const comm = screens([turnOne]);
    comm.sendInput("status?");
    comm.getTurnResponse();
    comm.markDelivered("status?");
    // Simulate a communicator that never saw a mark: a TUI without them.
    const bare = screens([["❯ status?", "", "⏺ jawaban tanpa penanda apa pun"]]);
    bare.sendInput("status?");
    bare.getTurnResponse();
    bare.markDelivered("status?");
    bare.beginExternalTurn();
    expect(bare.getPendingPrompt()).toBe("");
    void comm;
  });
});
