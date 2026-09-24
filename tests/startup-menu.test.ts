import { describe, expect, it } from "vitest";
import { startupMenuChoice } from "../src/slack-daemon.js";

/** The two screens seen in the wild, verbatim. */
const CLAUDE_TRUST = `λ dcomp /tmp → claude

 Accessing workspace:

 /tmp

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team).

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`;

const CODEX_UPDATE = `λ dcomp ~ → codex --yolo
╭─────────────────────────────────────────╮
  ✨ Update available! 0.154.0 -> 0.156.1

  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`npm install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue`;

describe("startupMenuChoice — the menus an agent opens before its prompt", () => {
  it("moves past Claude Code's preselected 'No, exit' to trust the folder", () => {
    // Enter alone would have quit the agent.
    expect(startupMenuChoice(CLAUDE_TRUST)).toEqual({ downs: 1, what: "trust this folder" });
  });

  it("moves past Codex's preselected 'Update now' to Skip", () => {
    // Enter alone would have run npm install.
    expect(startupMenuChoice(CODEX_UPDATE)).toEqual({ downs: 1, what: "skip the update" });
  });

  it("picks Skip, not Skip until next version", () => {
    const choice = startupMenuChoice(CODEX_UPDATE)!;
    const lines = CODEX_UPDATE.split("\n");
    const selected = lines.findIndex((line) => /^\s*›/.test(line));
    expect(lines[selected + choice.downs]).toContain("2. Skip");
  });

  it("presses nothing extra when the wanted line is already selected", () => {
    const already = CLAUDE_TRUST.replace(" ❯ No, exit\n   Yes, I trust this folder", "   No, exit\n ❯ Yes, I trust this folder");
    expect(startupMenuChoice(already)).toEqual({ downs: 0, what: "trust this folder" });
  });

  it("says nothing for a screen it does not know", () => {
    expect(startupMenuChoice("❯ Ask Codex to do anything")).toBeNull();
    expect(startupMenuChoice("Do you want to proceed?\n ❯ 1. Yes\n   2. No")).toBeNull();
    // The words without a menu: an agent talking about trust.
    expect(startupMenuChoice("I do not trust the files in that directory.")).toBeNull();
  });
});
