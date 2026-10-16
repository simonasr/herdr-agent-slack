import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AgentOutputReader, CompletedReaderTurn } from "./types.js";
import type { AgentSessionRef } from "../agent-sessions.js";
import type { Logger } from "../logger.js";

function extractTextFromContent(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) => {
      if ((c?.type === "text" || c?.type === "output_text" || c?.type === "input_text") && typeof c.text === "string") {
        return c.text;
      }
      return "";
    })
    .filter((s: string) => s.length > 0)
    .join("\n\n");
}

export function readPiCumulativeSnapshot(path: string): string {
  if (!existsSync(path)) return "";
  const raw = readFileSync(path, "utf8");
  const chunks: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== "message") continue;
    const msg = ev.message;
    if (!msg || msg.role !== "assistant") continue;
    const text = extractTextFromContent(msg.content);
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n").trim();
}

function completionSnapshot(path: string): { bytes: Buffer; identity: string } | null {
  try {
    const before = statSync(path, { bigint: true });
    if (!before.isFile()) return null;
    const bytes = readFileSync(path);
    const after = statSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.ctimeNs !== after.ctimeNs ||
        before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) return null;
    return { bytes, identity: `${after.dev}:${after.ino}:${after.birthtimeNs}` };
  } catch {
    return null;
  }
}

function appendedCompletedTurn(raw: string, parent: string, previousIds: Set<string>): CompletedReaderTurn | null {
  const lines = raw.trim().split("\n");
  const ids = new Set(previousIds);
  const pending = new Set<string>();
  const toolIds = new Set<string>();
  const chunks: string[] = [];
  let prompt = "";
  let final = false;
  for (let i = 0; i < lines.length; i++) {
    const entry = JSON.parse(lines[i]);
    if (entry?.type !== "message" || typeof entry.id !== "string" || !entry.id.trim() ||
        ids.has(entry.id) || entry.parentId !== parent) return null;
    ids.add(entry.id);
    parent = entry.id;
    const message = entry.message;
    if (!message || typeof message !== "object") return null;
    final = false;
    if (i === 0) {
      if (message.role !== "user") return null;
      prompt = typeof message.content === "string" ? message.content
        : extractTextFromContent(message.content);
      if (!prompt.trim()) return null;
      continue;
    }
    if (message.role === "toolResult") {
      if (!pending.delete(message.toolCallId)) return null;
      continue;
    }
    if (message.role !== "assistant" || pending.size || !Array.isArray(message.content)) return null;
    let calls = 0;
    for (const part of message.content) {
      if (part?.type === "toolCall") {
        if (typeof part.id !== "string" || !part.id.trim() || toolIds.has(part.id)) return null;
        pending.add(part.id);
        toolIds.add(part.id);
        calls++;
      } else if (part?.type === "text") {
        if (typeof part.text !== "string") return null;
      } else if (part?.type !== "thinking") return null;
    }
    const text = extractTextFromContent(message.content);
    if (text) chunks.push(text);
    if (message.stopReason === "stop" && !calls && text.trim()) final = true;
    else if (message.stopReason !== "toolUse" || !calls) return null;
  }
  return final && !pending.size ? { prompt, text: chunks.join("\n\n").trim() } : null;
}

export class PiJsonlReader implements AgentOutputReader {
  readonly kind = "pi-jsonl";
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly paneId: string,
    private readonly agentName: string,
  ) {}

  captureTurn(expectedSession?: AgentSessionRef): (() => CompletedReaderTurn | null) | null {
    if (expectedSession !== undefined &&
        (expectedSession?.kind !== "path" || expectedSession.path !== this.path)) return null;
    try {
      const baseline = completionSnapshot(this.path);
      if (!baseline?.bytes.length || baseline.bytes.at(-1) !== 10) return null;
      const records = new TextDecoder("utf-8", { fatal: true }).decode(baseline.bytes).trim().split("\n").map(line => JSON.parse(line));
      const parent = records.at(-1)?.id;
      if (typeof parent !== "string" || !parent.trim()) return null;
      const ids = new Set<string>(records.map(entry => entry?.id).filter(id => typeof id === "string"));
      const digest = createHash("sha256").update(baseline.bytes).digest("hex");
      const length = baseline.bytes.length;
      const identity = baseline.identity;
      return () => {
        try {
          const current = completionSnapshot(this.path);
          if (!current || current.identity !== identity || current.bytes.length <= length ||
              current.bytes.at(-1) !== 10 ||
              createHash("sha256").update(current.bytes.subarray(0, length)).digest("hex") !== digest) return null;
          const tail = new TextDecoder("utf-8", { fatal: true }).decode(current.bytes.subarray(length));
          return appendedCompletedTurn(tail, parent, ids);
        } catch {
          return null;
        }
      };
    } catch {
      return null;
    }
  }

  read(_maxLines: number): string {
    try {
      return readPiCumulativeSnapshot(this.path);
    } catch (err) {
      this.logger.warn("pi jsonl read failed", {
        paneId: this.paneId,
        agent: this.agentName,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

/** The pieces of a rollout the bridge cares about, in order. See `ClaudeTurns`. */
interface CodexTurns {
  answers: string[];
  latestAnswerStart: number;
  latestPrompt: string;
}

/**
 * What the person (or the bridge) typed, or "" for a `user` line Codex wrote
 * itself: `<environment_context>`, the `# AGENTS.md instructions for …`
 * preamble. A bridge prompt starts with `[` and counts.
 */
function codexPromptText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || /^# AGENTS\.md instructions/.test(trimmed)) return "";
  return trimmed;
}

function readCodexTurns(path: string): CodexTurns {
  const turns: CodexTurns = { answers: [], latestAnswerStart: 0, latestPrompt: "" };
  if (!existsSync(path)) return turns;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== "response_item" || ev?.payload?.type !== "message") continue;
    if (ev.payload.role === "user") {
      const prompt = codexPromptText(extractTextFromContent(ev.payload.content));
      if (!prompt) continue;
      turns.latestPrompt = prompt;
      turns.latestAnswerStart = turns.answers.length;
      continue;
    }
    if (ev.payload.role !== "assistant") continue;
    const text = extractTextFromContent(ev.payload.content);
    if (text) turns.answers.push(text);
  }
  return turns;
}

export function readCodexCumulativeSnapshot(path: string): string {
  return readCodexTurns(path).answers.join("\n\n").trim();
}

export class CodexJsonlReader implements AgentOutputReader {
  readonly kind = "codex-jsonl";
  constructor(
    private readonly path: string,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {}

  read(_maxLines: number): string {
    return this.turns().answers.join("\n\n").trim();
  }

  lastPrompt(): string {
    return this.turns().latestPrompt;
  }

  lastAnswer(): string {
    const turns = this.turns();
    return turns.answers.slice(turns.latestAnswerStart).join("\n\n").trim();
  }

  private turns(): CodexTurns {
    try {
      return readCodexTurns(this.path);
    } catch (err) {
      this.logger.warn("codex jsonl read failed", {
        paneId: this.paneId,
        agent: "codex",
        message: err instanceof Error ? err.message : String(err),
      });
      return { answers: [], latestAnswerStart: 0, latestPrompt: "" };
    }
  }
}

export function validatePathSession(path: string): string | null {
  if (!existsSync(path)) return `session path does not exist: ${path}`;
  try {
    const st = statSync(path);
    if (!st.isFile()) return `session path is not a regular file: ${path}`;
  } catch (err) {
    return `cannot stat session path: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

// --- Claude Code ------------------------------------------------------------

/**
 * One line of a Claude Code transcript, as far as the bridge reads it. The
 * file under `~/.claude/projects/<cwd>/<session>.jsonl` logs both sides of
 * the conversation, one content block per line for the assistant.
 */
interface ClaudeTranscriptLine {
  type?: string;
  /** A subagent's traffic, logged into the same file. Never the answer. */
  isSidechain?: boolean;
  /** Bridge/skill scaffolding injected as the user, not something they typed. */
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
}

/** The pieces of a Claude Code transcript the bridge cares about, in order. */
interface ClaudeTurns {
  /** Assistant text blocks, in the order they were written. */
  answers: string[];
  /** Index into `answers` at which the text for the latest prompt begins. */
  latestAnswerStart: number;
  /** The last thing the user actually typed; "" when the log has none. */
  latestPrompt: string;
}

/**
 * The user's own words, or "" for a line the user did not write. Claude Code
 * logs a lot as `user` that nobody typed: tool results, task notifications,
 * slash-command expansions (`<command-name>`), shell passthrough
 * (`<bash-input>`), interruptions (`[Request interrupted…]`), attachments.
 * Every one of those is wrapped in `<…>` or `[…]`; a typed prompt is not.
 */
function claudePromptText(line: ClaudeTranscriptLine): string {
  if (line.isMeta || line.isSidechain) return "";
  const content = line.message?.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? extractTextFromContent(content) : "";
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<")) return "";
  // Claude Code's own bracketed notes; a bridge prompt also starts with `[`
  // and is a prompt.
  if (/^\[(?:Request interrupted|Attached:|System:|Image|Pasted)/.test(trimmed)) return "";
  return trimmed;
}

function readClaudeTurns(path: string): ClaudeTurns {
  const turns: ClaudeTurns = { answers: [], latestAnswerStart: 0, latestPrompt: "" };
  if (!existsSync(path)) return turns;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: ClaudeTranscriptLine;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type === "user") {
      const prompt = claudePromptText(ev);
      if (!prompt) continue;
      turns.latestPrompt = prompt;
      turns.latestAnswerStart = turns.answers.length;
      continue;
    }
    if (ev?.type !== "assistant" || ev.isSidechain) continue;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    // Only `text` blocks are the answer. `thinking` and `tool_use` share the
    // message, and `extractTextFromContent` already leaves them out.
    const text = extractTextFromContent(content);
    if (text) turns.answers.push(text);
  }
  return turns;
}

/** Every assistant message so far, oldest first — the cumulative snapshot the diff path expects. */
export function readClaudeCumulativeSnapshot(path: string): string {
  return readClaudeTurns(path).answers.join("\n\n").trim();
}

/**
 * Reads the transcript Claude Code writes as it goes. Unlike the screen it
 * is the model's own Markdown — fences, emphasis, tables intact — with none
 * of the TUI drawn around it, and it logs the prompts too, so a question
 * typed into the terminal can be quoted with its answer.
 *
 * The file appears with the session's first prompt, and a pane bound fresh
 * has not had one yet — so the path is looked up on each read until found,
 * rather than once when the reader is chosen.
 */
export class ClaudeJsonlReader implements AgentOutputReader {
  readonly kind = "claude-jsonl";
  readonly verbatim = true;
  private path: string | null;
  constructor(
    private readonly locate: () => string | null,
    private readonly logger: Logger,
    private readonly paneId: string,
  ) {
    this.path = locate();
  }

  read(_maxLines: number): string {
    return this.turns().answers.join("\n\n").trim();
  }

  lastPrompt(): string {
    return this.turns().latestPrompt;
  }

  lastAnswer(): string {
    const turns = this.turns();
    return turns.answers.slice(turns.latestAnswerStart).join("\n\n").trim();
  }

  private turns(): ClaudeTurns {
    try {
      this.path ??= this.locate();
      if (!this.path) return { answers: [], latestAnswerStart: 0, latestPrompt: "" };
      return readClaudeTurns(this.path);
    } catch (err) {
      this.logger.warn("claude jsonl read failed", {
        paneId: this.paneId,
        agent: "claude",
        message: err instanceof Error ? err.message : String(err),
      });
      return { answers: [], latestAnswerStart: 0, latestPrompt: "" };
    }
  }
}

// --- Not yet ------------------------------------------------------------------

/**
 * A structured reader for a pane whose log cannot be found yet — the agent
 * has just started and herdr has no session for it, or the file is not
 * written until the first prompt. `pick` is tried on every read until it
 * returns one; until then there is nothing, which is the truth: the agent
 * has not said anything. Chosen instead of the screen, because the screen
 * of a pane that has said nothing is its welcome banner, and that has been
 * delivered as an answer.
 *
 * But not forever. A log that has not appeared `graceMs` after the first
 * read is not coming — the daemon runs as another user than the agent, the
 * agent keeps its files somewhere else — and a pane that answers into a
 * void is worse than a pane read off its screen. After the grace the
 * `fallback` takes over, for good, and the log says so. `kind` and
 * `verbatim` follow whichever reader is answering, so the communicator's
 * scrape-or-structured decisions follow too.
 */
export class DeferredReader implements AgentOutputReader {
  private inner: AgentOutputReader | null = null;
  private firstReadAt: number | null = null;
  private gaveUp = false;
  constructor(
    private readonly expectedKind: string,
    private readonly expectedVerbatim: boolean,
    private readonly pick: () => AgentOutputReader | null,
    private readonly logger: Logger,
    private readonly paneId: string,
    private readonly fallback: AgentOutputReader | null = null,
    private readonly graceMs = 90_000,
    private readonly now: () => number = Date.now,
  ) {}

  get kind(): string {
    return this.inner?.kind ?? this.expectedKind;
  }

  get verbatim(): boolean {
    return this.inner ? this.inner.verbatim === true : this.expectedVerbatim;
  }

  get session() {
    return this.inner?.session;
  }

  private resolved(): AgentOutputReader | null {
    if (this.inner) return this.inner;
    this.firstReadAt ??= this.now();
    const found = this.pick();
    if (found) {
      this.inner = found;
      this.logger.info("structured source found", { paneId: this.paneId, kind: found.kind });
      return found;
    }
    if (this.fallback && !this.gaveUp && this.now() - this.firstReadAt > this.graceMs) {
      this.gaveUp = true;
      this.inner = this.fallback;
      this.logger.warn("structured source never appeared; reading the screen instead", {
        paneId: this.paneId,
        expected: this.expectedKind,
        afterMs: this.now() - this.firstReadAt,
      });
      return this.fallback;
    }
    return null;
  }

  read(maxLines: number): string {
    return this.resolved()?.read(maxLines) ?? "";
  }

  captureTurn(expectedSession?: AgentSessionRef): (() => CompletedReaderTurn | null) | null {
    return this.resolved()?.captureTurn?.(expectedSession) ?? null;
  }

  lastPrompt(): string {
    return this.resolved()?.lastPrompt?.() ?? "";
  }

  lastAnswer(): string {
    return this.resolved()?.lastAnswer?.() ?? "";
  }
}
