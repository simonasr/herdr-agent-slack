/**
 * Output-formatting helpers used by the registry's scrape reader, the
 * commands module (/last), and the daemon's topic seeding. Lives in its
 * own module so the scrape reader does not have to take a dependency on
 * Telegram-specific code.
 */

/**
 * Claude Code's collapsed tool activity, drawn as its own line between the
 * prompt and the answer (or after it, when the turn was interrupted):
 * `Ran 3 shell commands`, `Searched for 2 patterns, ran 17 shell commands`,
 * `Listed 1 directory, ran 7 shell commands`. Verbs are the ones the TUI uses
 * for its tools; the line has to be counted clauses and nothing else, so a
 * sentence that merely opens with one ("Ran 3 tests, all green") survives.
 */
const ACTIVITY_VERB = "(?:ran|read|searched|edited|wrote|listed|fetched|created|launched|called|modified|updated|deleted|checked|viewed|explored|queried|opened)";
const ACTIVITY_CLAUSE = `${ACTIVITY_VERB}(?: for)? \\d+ [A-Za-z]+(?: [a-z]+)?`;
const TOOL_ACTIVITY_SUMMARY = new RegExp(`^${ACTIVITY_CLAUSE}(?:, ${ACTIVITY_CLAUSE})*$`, "i");

export function isNaturalLanguageLine(line: string, fullSnapshot = true): boolean {
  // Keep long prose/code lines, but reject unbroken terminal noise. Telegram
  // chunking applies the actual message-size limit later.
  const words = line.match(/\p{L}+/gu) ?? [];
  // CJK text commonly has no spaces, so a long, perfectly natural sentence
  // can look like one low-diversity "word". A modest Han/kana signal is safer
  // than applying the terminal-noise heuristic to that text.
  const cjkCharacters = line.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/gu)?.length ?? 0;
  const likelyCjkText = cjkCharacters >= 12;
  if (!line || (fullSnapshot && line.length > 300 && !likelyCjkText && new Set(words.map((word) => word.toLowerCase())).size < 4)) return false;
  const trimmed = line.trim();
  if (/^\d[\d,.]*\s+tokens$/.test(trimmed) || /^LSPs? are disabled$/.test(trimmed)) return false;
  // OpenCode/OpenCode-agent protocol output occasionally appears in the
  // terminal capture. Never forward the protocol envelope, tool invocation,
  // internal reasoning, or its file/path arguments to Telegram.
  if (/^\s*(?:<\/?(?:think|tool_call|tool_result|function|session_state)|(?:assistant|user)\s+to=|(?:namespace|parameter|function)=|tool_(?:call|result)|reasoning\b|internal\s+(?:status|thought))/i.test(line)) return false;
  if (/\b(?:functions\.(?:bash|read|glob|grep)|apply_patch|multi_tool_use)\b/i.test(line)) return false;
  if (/^\s*(?:\/home\/|\/tmp\/|[A-Za-z]:\\)\S+/.test(line)) return false;
  if (/[─━═]{20,}/.test(line) || /^[─━═\s]+$/.test(trimmed) || /^ctx_\w+ /.test(trimmed) || /^<\/?[a-z_]/i.test(trimmed)) return false;
  // Claude Code TUI chrome: the spinner/summary line ("✻ Worked for 2s · done
  // 9:23 pm") and the collapsed-tool notice. Both refresh independently of the
  // answer and mean nothing outside the terminal.
  if (/^[✻✳✽❋※]\s/.test(trimmed)) return false;
  if (TOOL_ACTIVITY_SUMMARY.test(trimmed)) return false;
  // A prompt line belongs to the terminal, not to an answer. It bounds the
  // extraction when the anchor is found; when the anchor is not and the
  // caller falls back to raw diffs, this is what keeps another turn's
  // question out of the delivered text.
  if (/^❯(\s|$)/.test(trimmed)) return false;
  // The TUI's attachment line: chrome describing a file, not part of the answer.
  if (/^›\s*\[file\]/.test(trimmed)) return false;
  // Claude Code's own update notice, drawn at the bottom of the pane. `✔` is
  // matched only together with that text: a checkmark is otherwise ordinary
  // content an agent writes in a list.
  if (/^[✔✓]\s*Update installed\b/.test(trimmed)) return false;
  // The mode row along the bottom of the pane: `⏵⏵ auto mode on (shift+tab to
  // cycle) · esc to interrupt · ← for agents`. The update notice above is
  // drawn RIGHT-ALIGNED ON THIS SAME ROW, which is why matching it at the
  // start of a line never fired — the row begins with `⏵⏵`.
  if (/^⏵/.test(trimmed)) return false;
  if (/\(ctrl\+[a-z] to expand\)/i.test(trimmed)) return false;
  const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
  // Reject other control characters (keep printable Unicode incl. emoji, scripts).
  if (/\p{C}/u.test(stripped)) return false;
  // `$`, `|`, and `~` are ordinary prose/code characters. Only reject the
  // recognisable status overlay shape, rather than every line containing one.
  if (fullSnapshot && /(?:\b(?:ctx|mode|R)=|~\d+\s*%.*\|.*\$)/i.test(stripped)) return false;
  return true;
}

/** Strip context-mode banners and terminal chrome from scraped output. */
export function cleanPaneOutput(content: string): string {
  return cleanPaneContent(content, true);
}

/** Clean an incremental stream without applying snapshot-only heuristics. */
export function cleanPaneDelta(content: string): string {
  return cleanPaneContent(content, false);
}

/**
 * Claude Code renders a turn as `⏺`-headed blocks: a tool call
 * (`⏺ Bash(cmd)`) with its `⎿` result and indented continuations, then the
 * assistant's own text under its own `⏺`.
 *
 * The marker is the ONLY thing separating a tool invocation from prose — once
 * stripped, `Bash(M=/Users/…; cat "$M/MEMORY.md")` reads as a normal sentence.
 * So a block is classified BEFORE the glyph is removed, and a tool block is
 * dropped whole: the wrapped invocation, the result, and every continuation
 * line up to the next `⏺`.
 */
const BLOCK_START = /^\s*⏺/;
const TOOL_BLOCK_START = /^\s*⏺\s+(?:[A-Z][A-Za-z0-9_]*\(|Called\s)/;
const TOOL_RESULT = /^\s*⎿/;

function cleanPaneContent(content: string, fullSnapshot: boolean): string {
  let clean = content
    .replace(/<session_state[\s\S]*?<\/session_state>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, "");
  // Remove terminal control sequences before line filtering so useful text
  // wrapped in colour/cursor escapes is retained without the escapes.
  clean = clean.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  // Terminal UIs (notably OpenCode) prefix otherwise useful prompt/output
  // lines with a vertical border. Remove that chrome before line filtering so
  // the submitted-prompt anchor remains available for extraction.
  // Horizontal whitespace only: `\s` would match the newline of a blank line
  // and splice it away, collapsing every paragraph break in the answer.
  clean = clean.replace(/^[ \t┃│▏▕]+/gm, "");
  clean = clean.replace(/[ \t┃│▏▕]+$/gm, "");
  clean = clean.split("\n").filter((line) => !line.includes("context-mode active")).join("\n");
  const kept: string[] = [];
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A tool block, or a stray result whose invocation fell outside the
    // extraction window: skip to the next block header.
    if (TOOL_BLOCK_START.test(line) || TOOL_RESULT.test(line)) {
      i += 1;
      while (i < lines.length && !BLOCK_START.test(lines[i])) i += 1;
      i -= 1; // the loop's own increment lands on that next block
      continue;
    }
    if (line.trim() === "") {
      // Blank lines ARE the answer's structure — dropping them collapses every
      // paragraph and list into one wall of text. Runs collapse to a single
      // break so terminal padding does not become a gap.
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (isNaturalLanguageLine(line, fullSnapshot)) kept.push(stripTuiMarker(line));
  }
  return kept.join("\n").trim();
}

/**
 * Drop the glyph a TUI draws in front of an assistant message ("⏺ Halo!" →
 * "Halo!"). Tool blocks are already gone by this point. Markdown bullets
 * (`-`, `*`, `•`) are left alone: they are content, and the Telegram formatter
 * renders them itself.
 */
function stripTuiMarker(line: string): string {
  return line.replace(/^(\s*)[●⏺]\s+/, "$1");
}

/** Remove terminal status lines that refresh independently of agent output. */
export function stripStatusBar(content: string): string {
  const lines = content.split("\n");
  while (lines.length) {
    const last = lines.at(-1)!;
    // The line that closes a turn is not chrome, and it is at the bottom at
    // exactly the moment that matters: right after the turn finishes, before
    // anything else is drawn. The " · " rule below would eat it, and with it
    // the only thing on screen that says the turn is over.
    if (TURN_DONE_LINE.test(last.trim())) break;
    if (
      last.trim() === "" ||
      /^[─━═]{20,}/.test(last.trim()) ||
      /^.{3,} · /.test(last.trim()) ||
      /^Model: /.test(last.trim()) ||
      // A bare, waiting prompt marker: chrome that redraws on its own.
      /^[❯›>$#]$/.test(last.trim()) ||
      // The mode row, and the lone slash-command hint under it (`/rc`). Both
      // redraw on their own and belong to the terminal, not to an answer.
      /^⏵/.test(last.trim()) ||
      /^\/[a-z][a-z-]{0,20}$/.test(last.trim()) ||
      /^\S+\s+\S+\s+[^\s]+\$$/.test(last.trim())
    ) lines.pop();
    else break;
  }
  return lines.join("\n");
}

/**
 * A line the TUI drew as an input prompt.
 *
 * `❯` only. `>` and `$` are ordinary prose and code characters, and `›` —
 * which this rule used to include — is what the TUI puts in front of an
 * attached file (`› [file] report.pdf (370KB)`). Treating that as a prompt cut
 * every answer off at its first attachment.
 */
const PROMPT_LINE = /^❯(\s|$)/;

/**
 * The TUI's end-of-turn furniture: the spinner summary ("✻ Worked for 2s ·
 * done 9:23 pm") and the session recap ("※ recap: …"). Both are drawn AFTER
 * the answer, and the terminal wraps them across several lines — so they have
 * to bound the extraction rather than be filtered line by line, otherwise a
 * wrapped tail like "/config)" survives on its own.
 */
const TURN_END_LINE = /^[✻✳✽❋※]\s/;

/**
 * Just the end-of-turn summary ("✻ Crunched for 50s · done 7:29 PM"), without
 * the session recap that follows it. This is the marker that says a turn
 * FINISHED, which is what bounds an answer — the recap is furniture drawn
 * after it.
 *
 * "· done" is required. The spinner a turn IN PROGRESS draws uses the same
 * glyph ("✻ Waddling… (2s · thinking with high effort)"), and reading it as
 * a finished turn would close a turn the agent is still writing. Every
 * closing line observed reads "<verb> for <time> · done <when>".
 *
 * `stripStatusBar` above refers to this: a module-scope `const` is set at
 * load, and every caller runs after that.
 */
const TURN_DONE_LINE = /^[✻✳✽❋]\s.*\s·\s*done\b/;

/** Strip the marker a TUI draws in front of a submitted prompt. */
function dechromePrompt(line: string): string {
  return line.replace(/^[\s❯›>$]+/, "").trim();
}

/** Collapse runs of whitespace, so a wrapped line compares to an unwrapped one. */
function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Index of the last line of the prompt when the run starting at `start` spells
 * it out exactly, or null when it does not.
 *
 * A terminal wraps a long prompt across several lines. Anchoring on the first
 * of them and taking "everything after" hands the tail of the user's own
 * question back as the answer's opening line — for a 251-character prompt on a
 * 240-column pane, the answer began "untuk peserta".
 *
 * Requiring the run to add up to the WHOLE prompt is what makes a partial
 * first line safe to match on. Without it the match would need a minimum
 * length, and any such number is arbitrary: 80 characters happened to work for
 * that 251-character prompt and left every wrapped prompt shorter than 80
 * unanchored.
 */
function consumePrompt(lines: string[], start: number, target: string): number | null {
  let accumulated = normalizeSpace(dechromePrompt(lines[start]));
  if (!accumulated || !target.startsWith(accumulated)) return null;
  let end = start;
  while (accumulated !== target && end + 1 < lines.length) {
    const next = normalizeSpace(lines[end + 1]);
    if (!next) break;
    const combined = normalizeSpace(`${accumulated} ${next}`);
    if (!target.startsWith(combined)) break;
    accumulated = combined;
    end += 1;
  }
  return accumulated === target ? end : null;
}

/** Return only content after the last occurrence of the submitted prompt. */
export function extractResponseSince(content: string, userInput: string): string {
  const lines = content.split("\n");
  const userLines = userInput.split("\n").filter((line) => line.trim());
  const anchor = userLines.at(-1) ?? userInput;
  const target = normalizeSpace(anchor);
  let index = -1;
  // First pass: a line, or a run of wrapped lines, that spells out the prompt
  // exactly. This also covers the unwrapped case, and it is why an agent that
  // opens its reply by echoing the user ("halo" → "Halo! 👋") cannot steal the
  // anchor and swallow its own first line.
  for (let i = lines.length - 1; i >= 0 && index < 0; i--) {
    const end = consumePrompt(lines, i, target);
    if (end !== null) { index = end; break; }
  }
  // Second pass: the prompt survives only inside a longer line — some UIs
  // append status text to it, or truncate its tail.
  for (let i = lines.length - 1; index < 0 && i >= 0; i--) {
    if (lines[i].includes(anchor)) { index = i; break; }
    if (anchor.length > 80 && lines[i].includes(anchor.slice(0, 80))) { index = i; break; }
  }
  if (index < 0) return "";
  // Stop at the next prompt: everything past it belongs to a later turn (or
  // is a prompt the user has typed but not sent). Without this bound the
  // "answer" runs to the bottom of the screen and swallows whatever the user
  // did next in the terminal.
  let end = lines.length;
  for (let i = index + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (PROMPT_LINE.test(trimmed) || TURN_END_LINE.test(trimmed)) { end = i; break; }
  }
  const after = lines.slice(index + 1, end);
  while (after.length && (after[0].trim() === "")) after.shift();
  return stripStatusBar(after.join("\n"));
}

/**
 * A prompt the terminal echoed with text after it — a question that was
 * submitted, as opposed to the empty input box redrawing at the bottom of the
 * pane, which is a bare `❯`.
 */
const SUBMITTED_PROMPT_LINE = /^❯\s+\S/;

/**
 * The glyphs Claude Code heads each block of a turn with: `⏺` for a tool call
 * or a piece of assistant text, `⎿` for a tool result. They mark where the
 * echoed prompt stops and the answer starts — which is what makes the
 * extraction safe on a prompt the terminal wrapped across several lines,
 * without having to know the prompt's text.
 */
const BLOCK_LINE = /^\s*[⏺⎿]/;

/**
 * The answer to the last prompt VISIBLE in the pane.
 *
 * Used for a turn the bridge did not start: somebody typed in the terminal, so
 * there is no submitted text to correlate against and the screen's own prompt
 * marker is the only anchor left.
 *
 * Scanning bottom-up and keeping the first prompt that yields content is what
 * makes a half-typed next message harmless — it matches, produces nothing, and
 * the scan falls through to the prompt that actually ran.
 */
/**
 * The last turn the pane marked as finished, bounded by its own end-of-turn
 * summary rather than by a question.
 *
 * Anchoring on the question was the mistake. An agent working on something
 * long reports back several times for ONE question — a benchmark run produced
 * four turns, of which only the first had a `❯` line above it:
 *
 *   ❯ yang 512 prompt tidak masalah…
 *   ✻ Churned for 37s · done 5:53 PM      ← the only turn a question owned
 *   ✻ Sautéed for 37s · done 6:47 PM      ← progress, no question
 *   ✻ Sautéed for 39s · done 7:17 PM      ← progress, no question
 *   ✻ Crunched for 50s · done 7:29 PM     ← the actual result, no question
 *
 * Bounding at the first `✻` after the prompt meant the bridge could only ever
 * see the first of those, and re-read it every time — delivering the same
 * short reply while the answer that mattered sat further down the screen.
 *
 * Measuring from the end instead also makes the bottom of the screen
 * irrelevant: the input box, a half-typed message, the queued-message hint all
 * sit BELOW the last finished turn and can no longer be mistaken for one.
 */
function readCompletedTurn(lines: string[]): ScreenTurn | null {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TURN_DONE_LINE.test(lines[i].trim())) { end = i; break; }
  }
  if (end < 0) return null;
  // Back to whatever bounds it: the question that started it, the previous
  // turn's summary, or a recap between the two.
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (TURN_END_LINE.test(trimmed) || PROMPT_LINE.test(trimmed)) { start = i; break; }
  }
  let bodyStart = start + 1;
  let prompt = "";
  // A turn with no question above it is an agent reporting back on its own.
  if (start >= 0 && SUBMITTED_PROMPT_LINE.test(lines[start])) {
    let block = -1;
    for (let i = start + 1; i < end; i++) {
      if (BLOCK_LINE.test(lines[i])) { block = i; break; }
    }
    const wrapped = block > 0 ? lines.slice(start + 1, block) : [];
    prompt = normalizeSpace(
      [dechromePrompt(lines[start]), ...wrapped.map((line) => line.trim())]
        .filter((part) => part.length > 0)
        .join(" "),
    );
    bodyStart = block > 0 ? block : start + 1;
  }
  const answer = cleanPaneOutput(stripStatusBar(lines.slice(bodyStart, end).join("\n")));
  return answer.trim() ? { prompt, answer } : null;
}

export interface ScreenTurn {
  /** The question as the terminal echoed it, unwrapped back onto one line. */
  prompt: string;
  /** The answer to it, filtered. */
  answer: string;
}

/**
 * The last complete turn visible in the pane: the question AND its answer.
 *
 * Both come from the same anchor, in one read. Taking them separately would
 * let the two calls land on different prompts — the screen moves — and quote a
 * question that belongs to another answer.
 */
export function extractLatestScreenTurn(content: string): ScreenTurn | null {
  // Border glyphs only. The indent of a wrapped prompt line is part of what
  // separates it from the answer, so leading spaces are left alone here.
  const lines = content.replace(/^[┃│▏▕]+/gm, "").split("\n");

  // Preferred: the last turn the TUI marked as finished. See readCompletedTurn
  // for why anchoring on the question is not enough.
  const completed = readCompletedTurn(lines);
  if (completed) return completed;

  /** The window an anchor owns: up to the next prompt or end-of-turn line. */
  const windowEnd = (anchor: number): number => {
    for (let i = anchor + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (PROMPT_LINE.test(trimmed) || TURN_END_LINE.test(trimmed)) return i;
    }
    return lines.length;
  };

  const read = (anchor: number, requireBlock: boolean): ScreenTurn | null => {
    const end = windowEnd(anchor);
    // The answer starts at the turn's first block. Everything between the
    // prompt line and it is the prompt's own wrapped continuation, which is
    // how a wrapped question is skipped without knowing where it ends.
    let start = -1;
    for (let i = anchor + 1; i < end; i++) {
      if (BLOCK_LINE.test(lines[i])) { start = i; break; }
    }
    if (start < 0) {
      if (requireBlock) return null;
      start = anchor + 1;
    }
    const answer = cleanPaneOutput(stripStatusBar(lines.slice(start, end).join("\n")));
    if (!answer.trim()) return null;
    // Those same continuation lines ARE the rest of the question, so the
    // wrapped prompt reassembles into the one line the person typed.
    const prompt = normalizeSpace(
      [dechromePrompt(lines[anchor]), ...lines.slice(anchor + 1, start).map((line) => line.trim())]
        .filter((part) => part.length > 0)
        .join(" "),
    );
    return { prompt, answer };
  };

  // Two passes. The first requires the anchor to have produced a turn, which
  // is what tells a submitted question apart from a `❯` line the TUI drew
  // itself: `❯ Press up to edit queued messages` appears under the input box
  // whenever a message is queued — exactly when someone writes in while the
  // agent is busy — and anchoring on it returned the status bar as the answer.
  //
  // The second pass drops that requirement, for a TUI that heads no blocks at
  // all. It runs only when the first found nothing, so a pane that does mark
  // its blocks can never fall through to a chrome line.
  for (const requireBlock of [true, false]) {
    for (let anchor = lines.length - 1; anchor >= 0; anchor--) {
      if (!SUBMITTED_PROMPT_LINE.test(lines[anchor])) continue;
      const turn = read(anchor, requireBlock);
      if (turn !== null) return turn;
    }
  }
  return null;
}

/**
 * Hint rows the TUI draws with a `❯`, which are not questions anybody asked.
 * `❯ Press up to edit queued messages` is the one seen in the wild; requiring
 * a turn block is what catches these once an answer exists, but a prompt read
 * the moment it is submitted has no answer yet to require.
 */
const TUI_HINT = /^Press\s+\S+\s+to\s+\S+/i;
/** Lines that end a prompt: chrome, a block, or the next turn. */
const NOT_PROMPT_TEXT = /^(?:[─━═]{10,}|⏵)/;

/**
 * The question last submitted in the pane, whether or not it has an answer yet.
 *
 * `extractLatestScreenTurn` needs a finished turn, because it reads the answer
 * too. This is for the moment the question is asked — the point of announcing
 * it is that nobody should have to wait out a fifteen-minute turn to find out
 * what was asked.
 */
export function extractLatestScreenPrompt(
  content: string,
  opts: { afterMark?: string } = {},
): string {
  const lines = content.replace(/^[┃│▏▕]+/gm, "").split("\n");
  // Only a `❯` below the last delivered turn is a NEW question. The one above
  // it was answered by that turn — announcing it again for a turn the agent
  // started on its own ("⌨️ Asked in the terminal: status?") told the reader
  // somebody asked when nobody had. Position decides, not text: the same
  // question typed again below the mark is a question again.
  //
  // A mark that is not on screen any more means a lot happened since; the
  // latest `❯` is then the best available answer, as it was before.
  const floor = opts.afterMark ? lastIndexOfLine(lines, opts.afterMark) : -1;
  for (let anchor = lines.length - 1; anchor > floor; anchor--) {
    if (!SUBMITTED_PROMPT_LINE.test(lines[anchor])) continue;
    const head = dechromePrompt(lines[anchor]);
    if (!head || TUI_HINT.test(head)) continue;
    const parts = [head];
    // Continuation lines: the rest of a question the terminal wrapped. Stops
    // at the first thing that is not prompt text.
    for (let i = anchor + 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) break;
      if (BLOCK_LINE.test(line) || PROMPT_LINE.test(trimmed) || TURN_END_LINE.test(trimmed)) break;
      if (NOT_PROMPT_TEXT.test(trimmed)) break;
      parts.push(trimmed);
    }
    return normalizeSpace(parts.join(" "));
  }
  return "";
}

/** Index of the last line equal to `text` once trimmed, or -1. */
function lastIndexOfLine(lines: readonly string[], text: string): number {
  const wanted = text.trim();
  if (!wanted) return -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === wanted) return i;
  }
  return -1;
}

/**
 * The line that closed the last finished turn on screen — the same anchor
 * `readCompletedTurn` uses — or "" when no turn has finished.
 *
 * It names a turn. "✻ Worked for 2m 26s · done 1:15 PM" is not going to be
 * drawn twice, so a bridge that remembers the mark of the turn it delivered
 * can tell, on its next read, whether the turn it is looking at is the same
 * one. Comparing the extracted answers instead compared two different
 * extractions of the same screen, which agreed on the words and disagreed on
 * the bytes; the guard built on that never fired.
 *
 * `afterPrompt` restricts the search to marks below the last line carrying
 * that prompt. A bridge-typed turn is read the moment the agent settles, and
 * if its closing line is not drawn yet, the last mark on screen belongs to
 * the turn before it; claiming that as delivered would be claiming the wrong
 * turn.
 */
export function lastTurnMark(content: string, opts: { afterPrompt?: string } = {}): string {
  const lines = content.replace(/^[┃│▏▕]+/gm, "").split("\n");
  let floor = -1;
  if (opts.afterPrompt?.trim()) {
    const wanted = normalizeSpace(opts.afterPrompt);
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!SUBMITTED_PROMPT_LINE.test(trimmed)) continue;
      // A wrapped prompt shows only its first line here; the rest is on the
      // lines below. A head that is a whole-word prefix of what was sent is
      // that prompt.
      const head = normalizeSpace(dechromePrompt(trimmed));
      if (head === wanted || wanted.startsWith(head + " ")) {
        floor = i;
        break;
      }
    }
    if (floor < 0) return "";
  }
  for (let i = lines.length - 1; i > floor; i--) {
    const trimmed = lines[i].trim();
    if (TURN_DONE_LINE.test(trimmed)) return trimmed;
  }
  return "";
}

/** The answer half of `extractLatestScreenTurn`, or "" when there is none. */
export function extractLatestScreenResponse(content: string): string {
  return extractLatestScreenTurn(content)?.answer ?? "";
}

/** Scrape only a response unambiguously anchored to the submitted prompt. */
export function extractScreenResponse(content: string, userInput: string): string {
  // Locate the prompt before filtering. Long OpenCode prompt lines can carry
  // terminal metadata and exceed the prose filter, but remain the safest
  // correlation anchor for this turn.
  const dechromed = content.replace(/^[ \t┃│▏▕]+/gm, "");
  return cleanPaneOutput(extractResponseSince(dechromed, userInput));
}

/**
 * Fallback when a terminal UI removes the submitted prompt after accepting
 * it. Returns only the changed suffix when a stable snapshot has a shared
 * prefix; callers must use it only for content observed after `submit`.
 */
export function extractScreenDelta(before: string, after: string): string {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let shared = 0;
  while (shared < oldLines.length && shared < newLines.length && oldLines[shared] === newLines[shared]) shared += 1;
  if (shared === 0 || shared === newLines.length) return "";
  return cleanPaneDelta(newLines.slice(shared).join("\n"));
}
