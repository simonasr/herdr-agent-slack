import { describe, it, expect } from "vitest";
import {
  cleanPaneOutput,
  cleanPaneDelta,
  stripStatusBar,
  extractLatestScreenPrompt,
  extractLatestScreenResponse,
  extractLatestScreenTurn,
  extractResponseSince,
  extractScreenResponse,
  extractScreenDelta,
  lastTurnMark,
} from "../src/output-format.js";

describe("cleanPaneOutput", () => {
  it("keeps useful long and punctuation-heavy streamed deltas", () => {
    const line = `${"A useful streamed answer ".repeat(20)}|~$%`;
    expect(cleanPaneDelta(`${line}\n🛑 Stopped.`)).toBe(`${line}\n🛑 Stopped.`);
  });

  it("preserves long natural lines and shell-like prose in snapshots", () => {
    const line = `A natural answer with symbols $ | ~ ${"and useful words ".repeat(30)}`.trimEnd();
    expect(cleanPaneOutput(line)).toBe(line);
  });

  it("preserves natural CJK text even when a long line has few word boundaries", () => {
    const line = "这是自然中文内容，用于验证快照清理不会误删正常文本。".repeat(20);
    expect(cleanPaneOutput(line)).toBe(line);
  });

  it("still removes tool/thought chrome from streamed deltas", () => {
    expect(cleanPaneDelta("<tool_call>secret</tool_call>\n<tool_result>secret</tool_result>\nvalid delta"))
      .toBe("valid delta");
  });
  it("removes OpenCode tool-call envelopes while preserving the final answer", () => {
    const input = `assistant to=functions.read
parameter=filePath
/home/mvallebr/git/herdr-telegram-plugin/src/daemon.ts
<tool_call>{"name":"read","arguments":{"filePath":"src/daemon.ts"}}</tool_call>
The pane is paired and ready for your next message.`;
    const out = cleanPaneOutput(input);
    expect(out).toBe("The pane is paired and ready for your next message.");
    expect(out).not.toMatch(/functions\.read|parameter=|tool_call|daemon\.ts/);
  });
  it("removes multiline context-mode banner block", () => {
    const input = `some agent output
context-mode active. Hierarchy: ctx_batch_execute > ctx_execute
<session_state source="compaction">
<session_mode>implement</session_mode>
</session_state>
more agent output after`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("context-mode active");
    expect(out).not.toContain("<session_state");
    expect(out).toContain("some agent output");
    expect(out).toContain("more agent output after");
  });

  it("filters individual context-mode lines as a fallback", () => {
    const input = `context-mode active. some text
<session_mode>foo</session_mode>
real output`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("context-mode active");
    expect(out).not.toContain("<session_mode>");
    expect(out).toContain("real output");
  });

  it("filters lines containing long separator runs", () => {
    const input = `─ something nice ──────────────────────
real output`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("─");
    expect(out).toContain("real output");
  });

  it("filters lines longer than 300 chars", () => {
    const longLine = "x".repeat(500);
    const out = cleanPaneOutput(`real\n${longLine}\nafter`);
    expect(out).toContain("real");
    expect(out).toContain("after");
    expect(out).not.toContain(longLine);
  });

  it("removes <session_state> blocks without the context-mode preamble", () => {
    const input = `agent response here
<session_state source="something-else">
<session_mode>plan</session_mode>
<some_other_key>some value</some_other_key>
</session_state>
more response`;
    const out = cleanPaneOutput(input);
    expect(out).not.toContain("<session_state");
    expect(out).not.toContain("</session_state>");
    expect(out).toContain("agent response here");
    expect(out).toContain("more response");
  });

  it("filters status bars / debug overlays (high non-word ratio)", () => {
    const input = `here is a normal sentence
~12 % | $0.50 | 1.2k/300k | ctx=8% | mode=implement | R=99%
the agent continued discussing the topic`;
    const out = cleanPaneOutput(input);
    expect(out).toContain("here is a normal sentence");
    expect(out).toContain("the agent continued");
    expect(out).not.toContain("ctx=8%");
  });

  it("filters lines starting with XML-like opening tags", () => {
    const input = `agent response
<tool_name>bash</tool_name>
<tool_args>ls -la</tool_args>
<result>total 42</result>
the response continues`;
    const out = cleanPaneOutput(input);
    expect(out).toContain("agent response");
    expect(out).toContain("the response continues");
    expect(out).not.toContain("<tool_name>");
    expect(out).not.toContain("<result>");
  });

  it("keeps single-line responses intact", () => {
    const out = cleanPaneOutput("São 13/07/2026, 19:21:47 (horário de Brasília).");
    expect(out).toBe("São 13/07/2026, 19:21:47 (horário de Brasília).");
  });

  it("strips ANSI escape codes from status bars before scoring", () => {
    const input = "real response\n\x1b[32m~12 % | $0.50 | 1.2k/300k\x1b[0m\nmore response";
    const out = cleanPaneOutput(input);
    expect(out).toContain("real response");
    expect(out).toContain("more response");
  });

  it("removes ANSI escape sequences from retained output", () => {
    const input = "\x1b[?25l\x1b[32mvisible response\x1b[0m\x1b[?25h";
    const out = cleanPaneOutput(input);
    expect(out).toBe("visible response");
    expect(out).not.toContain("\x1b");
  });

  it("removes vertical borders at the right edge of lines", () => {
    const input = "┃ useful response │\n┃ another response▕";
    expect(cleanPaneOutput(input)).toBe("useful response\nanother response");
  });

  it("preserves lines with common emoji (🚀, ✅, 🎉)", () => {
    const input = "Recebido com sucesso! 🚀 O teste chegou perfeitamente.\nplain line";
    const out = cleanPaneOutput(input);
    expect(out).toContain("Recebido com sucesso! 🚀 O teste chegou perfeitamente.");
    expect(out).toContain("plain line");
  });

  it("preserves lines with checkmarks and other Unicode symbols (✅, ⏳, ❌)", () => {
    const input = "✅ done\n⏳ working\n❌ failed\nplain";
    const out = cleanPaneOutput(input);
    expect(out).toContain("✅ done");
    expect(out).toContain("⏳ working");
    expect(out).toContain("❌ failed");
  });

  it("preserves lines with non-Latin scripts (Cyrillic, Greek, accented)", () => {
    const input = "Olá mundo\nПривет мир\nΓειά σου Κόσμε";
    const out = cleanPaneOutput(input);
    expect(out).toContain("Olá mundo");
    expect(out).toContain("Привет мир");
    expect(out).toContain("Γειά σου Κόσμε");
  });

  it("still strips visual separators and lines that are pure ANSI noise", () => {
    const input = "real\n──────\nmore real\n\x1b[31m\x1b[0m";
    const out = cleanPaneOutput(input);
    expect(out).toContain("real");
    expect(out).toContain("more real");
    expect(out).not.toContain("──────");
    // Empty line with only ANSI escapes should be filtered as control chars
    expect(out).not.toMatch(/^\s*$/m);
  });
});

describe("cleanPaneOutput — answer structure and TUI chrome", () => {
  it("keeps blank lines so paragraphs survive", () => {
    const input = "Halo!\n\nAda yang bisa aku bantu?";
    expect(cleanPaneOutput(input)).toBe("Halo!\n\nAda yang bisa aku bantu?");
  });

  it("collapses a run of blank lines to a single break", () => {
    expect(cleanPaneOutput("satu\n\n\n\ndua")).toBe("satu\n\ndua");
  });

  it("strips the glyph a TUI draws in front of an assistant message", () => {
    expect(cleanPaneOutput("⏺ Halo! 👋")).toBe("Halo! 👋");
    expect(cleanPaneOutput("● Bisa — aku cek dulu")).toBe("Bisa — aku cek dulu");
  });

  it("leaves markdown bullets alone — they are content", () => {
    expect(cleanPaneOutput("- satu\n* dua\n• tiga")).toBe("- satu\n* dua\n• tiga");
  });

  it("drops a tool-call block whole, keeping only the assistant's text", () => {
    // Verbatim shape from a Claude Code pane: the invocation wraps, its result
    // is indented under ⎿, and the answer follows under its own ⏺.
    const pane = [
      '⏺ Bash(M=/Users/me/memory; ls "$M" 2>&1; echo "--- MEMORY.md ---")',
      "  ⎿  Error: Exit code 1",
      "     --- MEMORY.md ---",
      "     cat: /Users/me/memory/MEMORY.md: No such file or directory",
      "",
      "⏺ Bash(M=/Users/me/memory",
      "      cat > \"$M/slack.md\" <<'EOF'…)",
      "  ⎿  MEMORY.md",
      "     slack.md",
      "",
      "⏺ Sama-sama! 🙌",
      "",
      "  Aku catat identitas Slack kamu ke memori.",
    ].join("\n");
    expect(cleanPaneOutput(pane)).toBe("Sama-sama! 🙌\n\nAku catat identitas Slack kamu ke memori.");
  });

  it("drops a tool result whose invocation fell outside the window", () => {
    const pane = ["  ⎿  MEMORY.md", "     slack.md", "", "⏺ Selesai."].join("\n");
    expect(cleanPaneOutput(pane)).toBe("Selesai.");
  });

  it("keeps prose that merely contains parentheses", () => {
    // Only `Name(` with no space is a tool invocation; a sentence is not.
    const pane = "⏺ Bisa (aku sudah cek dulu tadi).";
    expect(cleanPaneOutput(pane)).toBe("Bisa (aku sudah cek dulu tadi).");
  });

  it("keeps an answer that contains the TUI's attachment lines", () => {
    // `›` marks an attached file here, not a prompt. Treating it as one cut
    // every answer off at its first attachment.
    const pane = [
      "Set dokumen versi Inggris.",
      "› [file] Untuk-Pelanggan/English/007-EN.pdf (370.6KB)",
      "› [file] Untuk-Pelanggan/English/008-EN.pdf (885.5KB)",
      "Empat berkas versi Inggris:",
    ].join("\n");
    // The attachment lines are chrome and go; the prose after them stays.
    expect(cleanPaneOutput(pane)).toBe("Set dokumen versi Inggris.\nEmpat berkas versi Inggris:");
  });

  it("does not stop extraction at an attachment line", () => {
    const content = [
      "❯ kirimkan dokumennya",
      "Ini dokumennya.",
      "› [file] a.pdf (1KB)",
      "Empat berkas versi Inggris:",
    ].join("\n");
    expect(extractResponseSince(content, "kirimkan dokumennya")).toContain("Empat berkas");
  });

  it("drops a terminal prompt line wherever it appears", () => {
    // When the prompt anchor is not found the caller falls back to raw diffs,
    // and another turn's question would otherwise ride along inside the answer.
    const pane = ["jawaban ini", "❯ pertanyaan giliran lain", "lanjutannya"].join("\n");
    expect(cleanPaneOutput(pane)).toBe("jawaban ini\nlanjutannya");
  });

  it("drops the TUI's update notice", () => {
    expect(cleanPaneOutput("jawaban\n✔ Update installed · Restart to update")).toBe("jawaban");
  });

  it("keeps a checkmark an agent wrote as content", () => {
    // `✔` alone is ordinary content; only the update notice is chrome.
    expect(cleanPaneOutput("✔ selesai semua")).toBe("✔ selesai semua");
  });

  it("drops the spinner/summary line", () => {
    const input = "jawaban\n✻ Worked for 2s · done 9:23 pm";
    expect(cleanPaneOutput(input)).toBe("jawaban");
  });

  it("drops the collapsed-tool notice", () => {
    const input = "Called Slack (ctrl+o to expand)\njawaban";
    expect(cleanPaneOutput(input)).toBe("jawaban");
  });

  it("drops the collapsed tool activity line, wherever the turn put it", () => {
    // Before the answer, the usual place.
    expect(cleanPaneOutput("  Ran 1 shell command\n\n● jawaban")).toBe("jawaban");
    // After it: an interrupted turn draws the summary under the last text.
    expect(cleanPaneOutput("● jawaban\n\n  Searched for 2 patterns, ran 17 shell commands\n  ⎿  Interrupted · What should Claude do instead?"))
      .toBe("jawaban");
    expect(cleanPaneOutput("  Listed 1 directory, ran 7 shell commands\n\n● Jalan ✓")).toBe("Jalan ✓");
  });

  it("keeps a sentence that merely opens like a tool summary", () => {
    expect(cleanPaneOutput("Ran 3 tests, all green.")).toBe("Ran 3 tests, all green.");
    expect(cleanPaneOutput("Read 2 files and found the bug in the second.")).toBe("Read 2 files and found the bug in the second.");
  });
});

describe("extractResponseSince", () => {
  it("returns lines after user input anchor", () => {
    const content = "old\n qual a hora?\nresponse line\nmore";
    expect(extractResponseSince(content, "qual a hora?")).toBe("response line\nmore");
  });

  it("uses last non-blank line of user input as anchor", () => {
    const content = "before\n hello world\nagent says hi";
    expect(extractResponseSince(content, "hello\nworld")).toBe("agent says hi");
  });

  it("returns empty when anchor not found", () => {
    expect(extractResponseSince("some pane\ntext", "not in pane")).toBe("");
  });

  it("trims trailing separators, status bars, and empty lines", () => {
    const sep20 = "─".repeat(20);
    const content = `old\noi\nresponse text\n\n${sep20}\n~/foo · cost`;
    expect(extractResponseSince(content, "oi")).toBe("response text");
  });

  it("prefers the prompt line over an agent echoing the same word", () => {
    // The reply opens by echoing the user ("halo" → "Halo! 👋"). Anchoring on
    // that echo would drop the answer's own first line.
    const content = ["❯ halo", "● Halo! 👋", "Ada yang bisa aku bantu?"].join("\n");
    expect(extractResponseSince(content, "halo")).toBe("● Halo! 👋\nAda yang bisa aku bantu?");
  });

  it("still falls back to a substring match when no line is exactly the prompt", () => {
    const content = "before\n❯ query · 12 tokens\nresult line";
    expect(extractResponseSince(content, "query")).toBe("result line");
  });

  it("stops at the next prompt so a later turn is not swallowed", () => {
    // The user kept working in the terminal after this turn finished; that
    // conversation belongs to its own turn, not to this answer.
    const content = [
      "❯ halo",
      "⏺ Halo! 👋",
      "✻ Worked for 2s · done 9:23 pm",
      "❯ kamu bisa baca slack saya ?",
      "⏺ Bisa — ini 5 pesan terakhir…",
    ].join("\n");
    expect(extractResponseSince(content, "halo")).toBe("⏺ Halo! 👋");
  });

  it("consumes every wrapped line of a long prompt", () => {
    // Verbatim shape from a 240-column pane: a 251-character prompt wrapped
    // onto two lines. Anchoring on the first alone handed back "untuk peserta"
    // — the tail of the question — as the answer's opening line.
    const prompt =
      "dalam sesi ssatu saya untuk materi training ini terkait claude code. " +
      "tapi saya ingin menjelaskan seperti apa perbedan penggunaan terminal " +
      "dengan app dan pentingnya context untuk AI ini dalam mencari jawaban. " +
      "buatkan 10 slides dan 1 task untuk peserta";
    const wrapAt = prompt.lastIndexOf(" untuk peserta");
    const content = [
      "❯ " + prompt.slice(0, wrapAt),
      "  " + prompt.slice(wrapAt + 1),
      "",
      "Deck-nya sudah jadi.",
    ].join("\n");
    expect(extractResponseSince(content, prompt)).toBe("Deck-nya sudah jadi.");
  });

  it("consumes a prompt wrapped across three lines", () => {
    const prompt = "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh";
    const content = [
      "❯ satu dua tiga empat",
      "  lima enam tujuh",
      "  delapan sembilan sepuluh",
      "Jawabannya begini.",
    ].join("\n");
    expect(extractResponseSince(content, prompt)).toBe("Jawabannya begini.");
  });

  it("stops consuming when a line stops spelling out the prompt", () => {
    // The answer must not be eaten just because it follows the prompt.
    const prompt = "satu dua tiga";
    const content = ["❯ satu dua", "  tiga", "empat lima", "enam"].join("\n");
    expect(extractResponseSince(content, prompt)).toBe("empat lima\nenam");
  });

  it("stops at the end-of-turn furniture the TUI draws after the answer", () => {
    // The recap wraps across lines, so filtering it line by line would leave
    // its tail ("/config)") stranded in the answer.
    const content = [
      "❯ oi",
      "resposta",
      "✻ Cooked for 17s · done 9:24 pm",
      "※ recap: what we did so far (disable recaps in",
      "/config)",
    ].join("\n");
    expect(extractResponseSince(content, "oi")).toBe("resposta");
  });

  it("drops a prompt the user has typed but not yet sent", () => {
    const content = ["❯ oi", "resposta", "❯ meio digitad"].join("\n");
    expect(extractResponseSince(content, "oi")).toBe("resposta");
  });

  it("keeps answer lines that merely start with a quote or shell character", () => {
    // `>` and `$` are ordinary prose/code characters — only the dedicated
    // prompt glyphs bound a turn.
    const content = ["❯ oi", "> kutipan", "$ npm test", "selesai"].join("\n");
    expect(extractResponseSince(content, "oi")).toBe("> kutipan\n$ npm test\nselesai");
  });

  it("trims a trailing bare prompt marker", () => {
    const content = "❯ oi\nresposta\n\n❯";
    expect(extractResponseSince(content, "oi")).toBe("resposta");
  });

  it("trims trailing shell prompts", () => {
    const content = "before\n query\nresult line\n~/cod · main $";
    expect(extractResponseSince(content, "query")).toBe("result line");
  });
});

describe("extractScreenResponse", () => {
  it("returns empty when the exact prompt is absent instead of leaking terminal text", () => {
    const content = [
      "older output",
      "› a wrapped or transformed prompt",
      "Useful final answer",
      "─".repeat(31),
      "status · 10%",
    ].join("\n");
    expect(extractScreenResponse(content, "original long prompt")).toBe("");
  });

  it("still returns the exact anchored response", () => {
    expect(extractScreenResponse("prompt\nclean reply", "prompt")).toBe("clean reply");
  });

  it("keeps an OpenCode prompt anchor after stripping its terminal border", () => {
    const prompt = "Keep it under 4000 characters. Summarize what we've been working on: original goal, progress, blockers, next steps.";
    const pane = `┃  ${prompt}\n┃\n┃  Original goal\n┃  A clean summary`;
    expect(extractScreenResponse(pane, prompt)).toBe("Original goal\nA clean summary");
  });
});

/**
 * A turn started in the pane itself carries no submitted text to correlate on,
 * so the screen's own prompt marker is the anchor. These fixtures are shaped
 * like a real Claude Code pane read: the echoed `❯` prompt, `⏺`-headed blocks,
 * the `✻`/`※` end-of-turn furniture, then the empty input box and status bar.
 */
describe("extractLatestScreenResponse", () => {
  it("returns the answer to the last prompt the pane shows", () => {
    const pane = [
      "※ recap: an earlier turn. (disable recaps in /config)",
      "",
      "❯ tolong update today hari ini dari logbook",
      "",
      '⏺ Bash(date "+%Y-%m-%d"; echo hi)',
      "  ⎿  2026-09-04",
      "     … +48 lines (ctrl+o to expand)",
      "",
      "⏺ Lima entri sudah dibuat untuk hari ini.",
      "",
      "  - 11:00 Coding",
      "  - 13:00 Review",
      "",
      "✻ Worked for 47s · done 4:59 PM",
      "",
      "※ recap: Goal was updating Today. (disable recaps in /config)",
      "",
      "────────────────────────────────────────",
      "❯",
      "────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");

    expect(extractLatestScreenResponse(pane)).toBe(
      "Lima entri sudah dibuat untuk hari ini.\n\n- 11:00 Coding\n- 13:00 Review",
    );
  });

  it("drops the tail of a prompt the terminal wrapped", () => {
    // The bug this rule exists for: anchoring on the first physical line of a
    // wrapped question and handing its second line back as the answer's
    // opening sentence.
    const pane = [
      "❯ ini pertanyaan yang sangat panjang sehingga terminal membungkusnya ke",
      "  baris berikutnya, dan ekornya bukan bagian dari jawaban",
      "",
      "⏺ Jawabannya singkat.",
      "",
      "✻ Worked for 3s · done",
    ].join("\n");

    const answer = extractLatestScreenResponse(pane);
    expect(answer).toBe("Jawabannya singkat.");
    expect(answer).not.toContain("ekornya");
  });

  it("skips a half-typed next message and answers the prompt that ran", () => {
    const pane = [
      "❯ pertanyaan asli",
      "",
      "⏺ Ini jawabannya.",
      "",
      "✻ Worked for 3s · done",
      "",
      "────────────────────────────────────────",
      "❯ pertanyaan berikutnya yang belum dikirim",
      "────────────────────────────────────────",
    ].join("\n");

    expect(extractLatestScreenResponse(pane)).toBe("Ini jawabannya.");
  });

  it("stops at the next prompt rather than swallowing a later turn", () => {
    const pane = [
      "❯ pertanyaan pertama",
      "",
      "⏺ Jawaban pertama.",
      "",
      "❯ pertanyaan kedua",
      "",
      "⏺ Jawaban kedua.",
      "",
      "✻ Worked for 3s · done",
    ].join("\n");

    expect(extractLatestScreenResponse(pane)).toBe("Jawaban kedua.");
  });

  it("falls back to everything after the prompt when a TUI heads no blocks", () => {
    expect(extractLatestScreenResponse("❯ halo\nHalo juga!")).toBe("Halo juga!");
  });


  it("ignores the ❯ line the TUI draws for a queued message", () => {
    // Send a message while the agent is busy and the TUI puts
    // `❯ Press up to edit queued messages` under the input box. It is shaped
    // exactly like a submitted prompt, and anchoring on it delivered the
    // status bar as the answer to a real question.
    const pane = [
      "❯ restart",
      "",
      "⏺ Restart selesai, dan jalur pemulihannya terbukti.",
      "",
      "✻ Brewed for 13s · done 1:39 PM",
      "",
      "────────────────────────────────────────",
      "❯",
      "❯ Press up to edit queued messages",
      "────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents      ✔ Update installed · Restart to update",
      "                                        /rc",
    ].join("\n");

    const answer = extractLatestScreenResponse(pane);
    expect(answer).toBe("Restart selesai, dan jalur pemulihannya terbukti.");
    expect(answer).not.toContain("auto mode");
    expect(answer).not.toContain("/rc");
  });

  it("still answers a TUI that heads no blocks at all", () => {
    // The block requirement is a preference, not a precondition: a UI with no
    // `⏺` markers must still get its answer through.
    expect(extractLatestScreenResponse("❯ halo\nHalo juga!")).toBe("Halo juga!");
  });
});

/**
 * The bottom two rows of a Claude Code pane. They redraw on their own and are
 * not part of anything the agent said.
 */
describe("terminal chrome along the bottom of the pane", () => {
  const modeRow =
    "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents      ✔ Update installed · Restart to update";

  it("drops the mode row wherever it appears", () => {
    // `✔ Update installed` is drawn RIGHT-ALIGNED on this row, which is why
    // matching it at the start of a line never fired.
    expect(cleanPaneOutput(`An answer.\n${modeRow}`)).toBe("An answer.");
  });

  it("strips the mode row and the slash hint from the tail", () => {
    expect(stripStatusBar(`An answer.\n${modeRow}\n      /rc`)).toBe("An answer.");
  });

  it("leaves a slash command an agent actually wrote", () => {
    // Only the trailing hint is chrome. `/clear` inside an answer is content.
    const body = "Run /clear to save tokens.\nThen try again.";
    expect(stripStatusBar(body)).toBe(body);
  });

  it("returns nothing when the pane shows no submitted prompt", () => {
    expect(extractLatestScreenResponse("⏺ output with no prompt above it")).toBe("");
    expect(extractLatestScreenResponse("❯\n────────────────────────────────────────")).toBe("");
  });
});

/**
 * The question half. A terminal turn is asked where the chat cannot see it, so
 * quoting it is the difference between a thread of answers and a conversation.
 */
describe("extractLatestScreenTurn", () => {
  it("returns the question with its answer", () => {
    const pane = [
      "❯ tolong update today hari ini dari logbook",
      "",
      "⏺ Lima entri sudah dibuat.",
      "",
      "✻ Worked for 47s · done",
    ].join("\n");

    expect(extractLatestScreenTurn(pane)).toEqual({
      prompt: "tolong update today hari ini dari logbook",
      answer: "Lima entri sudah dibuat.",
    });
  });

  it("reassembles a question the terminal wrapped", () => {
    // The continuation lines that get skipped when reading the answer ARE the
    // rest of the question.
    const pane = [
      "❯ ini pertanyaan yang sangat panjang sehingga terminal membungkusnya ke",
      "  baris berikutnya, dan ekornya tetap bagian dari pertanyaan",
      "",
      "⏺ Jawabannya singkat.",
      "",
      "✻ Worked for 3s · done",
    ].join("\n");

    const turn = extractLatestScreenTurn(pane);
    expect(turn?.prompt).toBe(
      "ini pertanyaan yang sangat panjang sehingga terminal membungkusnya ke baris berikutnya, dan ekornya tetap bagian dari pertanyaan",
    );
    expect(turn?.answer).toBe("Jawabannya singkat.");
  });

  it("takes both halves from the same anchor", () => {
    // Read separately, the two calls could land on different prompts and quote
    // a question that belongs to another answer.
    const pane = [
      "❯ pertanyaan pertama",
      "",
      "⏺ Jawaban pertama.",
      "",
      "❯ pertanyaan kedua",
      "",
      "⏺ Jawaban kedua.",
      "",
      "✻ Worked for 3s · done",
    ].join("\n");

    expect(extractLatestScreenTurn(pane)).toEqual({
      prompt: "pertanyaan kedua",
      answer: "Jawaban kedua.",
    });
  });

  it("returns a turn the agent produced with no question above it", () => {
    // The bug this rule exists for. An agent working on something long reports
    // back several times for ONE question; only the first turn has a `❯` line.
    // Bounding at the first `✻` after the prompt meant everything after it was
    // invisible, and the same short reply was re-read and re-suppressed while
    // the answer that mattered sat further down the screen.
    const pane = [
      "❯ yang 512 prompt tidak masalah",
      "",
      "⏺ Baik, saya lanjutkan.",
      "",
      "✻ Churned for 37s · done 5:53 PM",
      "",
      "※ recap: sesi sedang berjalan",
      "",
      "⏺ Selesai. Enam sel, semuanya sah, biaya $2,73.",
      "",
      "✻ Crunched for 50s · done 7:29 PM",
    ].join("\n");

    expect(extractLatestScreenTurn(pane)).toEqual({
      prompt: "",
      answer: "Selesai. Enam sel, semuanya sah, biaya $2,73.",
    });
  });

  it("measures from the end, so the bottom of the screen cannot mislead it", () => {
    // The input box, a half-typed message and the queued-message hint all sit
    // BELOW the last finished turn, and are now out of reach by construction.
    const pane = [
      "❯ pertanyaan",
      "",
      "⏺ Jawabannya.",
      "",
      "✻ Worked for 3s · done",
      "",
      "────────────────────────────────────────",
      "❯ setengah diketik",
      "❯ Press up to edit queued messages",
      "────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle)",
    ].join("\n");

    expect(extractLatestScreenTurn(pane)).toEqual({
      prompt: "pertanyaan",
      answer: "Jawabannya.",
    });
  });

  it("is null when the pane shows no completed turn", () => {
    expect(extractLatestScreenTurn("⏺ output with no prompt above it")).toBeNull();
  });
});

/**
 * Reading the question the moment it is submitted, before any answer exists.
 * `extractLatestScreenTurn` cannot: it needs the answer to know which `❯` line
 * was a real question, and here there is none yet.
 */
describe("extractLatestScreenPrompt", () => {
  it("reads a question that has no answer yet", () => {
    const pane = [
      "✻ Worked for 3s · done",
      "",
      "❯ ini saya pakai akun berbeda dari yang kamu coba awal tadi",
      "",
      "✢ Perambulating… (14m 33s · ↓ 4.9k tokens)",
    ].join("\n");

    expect(extractLatestScreenPrompt(pane)).toBe(
      "ini saya pakai akun berbeda dari yang kamu coba awal tadi",
    );
  });

  it("reassembles a question the terminal wrapped", () => {
    const pane = [
      "❯ ini pertanyaan yang panjang sehingga terminal membungkusnya",
      "  ke baris berikutnya",
      "",
    ].join("\n");

    expect(extractLatestScreenPrompt(pane)).toBe(
      "ini pertanyaan yang panjang sehingga terminal membungkusnya ke baris berikutnya",
    );
  });

  it("skips the hint row the TUI draws for a queued message", () => {
    // Requiring a turn block is what catches this once an answer exists. A
    // prompt read at submit time has no answer to require, so the hint has to
    // be recognised by shape.
    const pane = [
      "❯ pertanyaan sungguhan",
      "",
      "❯ Press up to edit queued messages",
    ].join("\n");

    expect(extractLatestScreenPrompt(pane)).toBe("pertanyaan sungguhan");
  });

  it("stops at the box border and the mode row", () => {
    const pane = [
      "❯ pertanyaan",
      "────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
    ].join("\n");

    expect(extractLatestScreenPrompt(pane)).toBe("pertanyaan");
  });

  it("takes the newest question, not an older one", () => {
    const pane = ["❯ lama", "", "⏺ Jawaban lama.", "", "❯ baru", ""].join("\n");
    expect(extractLatestScreenPrompt(pane)).toBe("baru");
  });

  it("says nothing when the pane shows no question", () => {
    // A TUI that does not echo the prompt gets no announcement rather than a
    // guess — codex panes read this way.
    expect(extractLatestScreenPrompt("⏺ output\n────────\n❯\n────────")).toBe("");
  });
});

describe("extractScreenDelta", () => {
  it("returns only new terminal text when a prompt disappears after submit", () => {
    expect(extractScreenDelta("header\nold", "header\nnew answer")).toBe("new answer");
  });

  it("fails closed when there is no stable shared prefix", () => {
    expect(extractScreenDelta("old", "unrelated")).toBe("");
  });
});

/**
 * The screen from pane `planner` on 2026-09-11, trimmed. One question, typed
 * from Telegram, then TWO finished turns: the answer, and a progress report
 * the agent produced on its own when a background shell completed. Nothing
 * was typed between them. The bridge announced the second as
 * "⌨️ Asked in the terminal: status?" and re-sent the first answer under it.
 */
const twoTurnsOneQuestion = [
  "❯ status?",
  "",
  "⏺ Grup 1 gagal total: runner crash saat bootstrap.",
  "",
  "✻ Worked for 2m 26s · done 1:15 PM · 1 shell still running",
  "",
  "⏺ Background command \"Wait until codex blocks\" completed (exit code 0)",
  "",
  "⏺ Grup 1 sudah lewat bootstrap dan GPU gate.",
  "",
  "✻ Worked for 1m 15s · done 1:25 PM · 1 shell still running",
  "",
  "❯",
].join("\n");

const turnOneMark = "✻ Worked for 2m 26s · done 1:15 PM · 1 shell still running";
const turnTwoMark = "✻ Worked for 1m 15s · done 1:25 PM · 1 shell still running";

describe("lastTurnMark", () => {
  it("is the line that closed the last finished turn", () => {
    expect(lastTurnMark(twoTurnsOneQuestion)).toBe(turnTwoMark);
  });

  it("survives the status-bar strip when the turn is the last thing on screen", () => {
    // The moment right after a turn finishes is exactly when its closing line
    // sits at the bottom, above nothing but the prompt box. `stripStatusBar`
    // pops any bottom line with " · " in it, and this line has two. Eaten,
    // the turn looks unfinished, and the mark that names it is gone with it.
    const screen = [
      "❯ status?",
      "",
      "⏺ Grup 1 gagal total.",
      "",
      "✻ Worked for 2m 26s · done 1:15 PM · 1 shell still running",
      "",
      "❯",
      "──────────────────────────────────────────────",
      "  ⏵⏵ auto mode on · 1 shell · esc to interrupt",
    ].join("\n");
    expect(stripStatusBar(screen).split("\n").at(-1)).toBe(
      "✻ Worked for 2m 26s · done 1:15 PM · 1 shell still running",
    );
    expect(lastTurnMark(stripStatusBar(screen))).toBe(
      "✻ Worked for 2m 26s · done 1:15 PM · 1 shell still running",
    );
  });

  it("does not mistake the spinner for a closing line", () => {
    // Same glyph, different meaning: "✻ Waddling… (2s · thinking)" is a turn
    // in progress. Only "· done" closes one.
    const spinning = [
      "✻ Worked for 9s · done 1:00 PM",
      "",
      "❯ status?",
      "",
      "✻ Waddling… (2s · thinking with high effort)",
    ].join("\n");
    expect(lastTurnMark(spinning)).toBe("✻ Worked for 9s · done 1:00 PM");
    expect(lastTurnMark(spinning, { afterPrompt: "status?" })).toBe("");
  });

  it("is empty when no turn has finished", () => {
    expect(lastTurnMark("❯ status?\n\n⏺ working on it")).toBe("");
  });

  it("counts only marks below the given prompt", () => {
    // A bridge-typed turn is read the moment the agent settles. If its own
    // closing line is not drawn yet, the last mark on screen belongs to the
    // turn BEFORE it — recording that would claim the wrong turn as delivered.
    const pane = [
      "✻ Worked for 9s · done 1:00 PM",
      "",
      "❯ status?",
      "",
      "⏺ still writing",
    ].join("\n");
    expect(lastTurnMark(pane, { afterPrompt: "status?" })).toBe("");
    expect(lastTurnMark(twoTurnsOneQuestion, { afterPrompt: "status?" })).toBe(turnTwoMark);
  });

  it("finds a wrapped prompt by its first line", () => {
    const pane = [
      "✻ Worked for 9s · done 1:00 PM",
      "",
      "❯ ini pertanyaan yang panjang sehingga terminal",
      "  membungkusnya ke baris berikutnya",
      "",
      "⏺ Jawaban.",
      "",
      "✻ Worked for 4s · done 1:02 PM",
    ].join("\n");
    const sent = "ini pertanyaan yang panjang sehingga terminal membungkusnya ke baris berikutnya";
    expect(lastTurnMark(pane, { afterPrompt: sent })).toBe("✻ Worked for 4s · done 1:02 PM");
    // A head that only shares a partial word is somebody else's prompt.
    expect(lastTurnMark(pane, { afterPrompt: "ini pertanyaan yang panjang sehingga terminalku" })).toBe("");
  });
});

describe("extractLatestScreenPrompt — below a delivered turn", () => {
  it("does not report a question that sits above the last delivered turn", () => {
    // `status?` was answered by turn one. Turn two has no question of its
    // own; announcing `status?` for it says a person asked when nobody did.
    expect(extractLatestScreenPrompt(twoTurnsOneQuestion, { afterMark: turnOneMark })).toBe("");
  });

  it("reports a question typed after the delivered turn", () => {
    const pane = twoTurnsOneQuestion + "\n❯ lanjut ke grup 2\n";
    expect(extractLatestScreenPrompt(pane, { afterMark: turnTwoMark })).toBe("lanjut ke grup 2");
    // The same question typed again is a new question when it is below the
    // mark. Position decides, not text.
    const again = twoTurnsOneQuestion + "\n❯ status?\n";
    expect(extractLatestScreenPrompt(again, { afterMark: turnTwoMark })).toBe("status?");
  });

  it("falls back to the latest question when the mark is no longer on screen", () => {
    // Scrolled off means a lot happened since; the latest `❯` is the best
    // available answer, exactly as before this option existed.
    expect(extractLatestScreenPrompt(twoTurnsOneQuestion, { afterMark: "✻ Worked for 1s · done 9:00 AM" }))
      .toBe("status?");
    expect(extractLatestScreenPrompt(twoTurnsOneQuestion, { afterMark: "" })).toBe("status?");
  });
});
