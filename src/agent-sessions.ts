/**
 * Per-agent output extraction strategies.
 *
 * Herdr exposes agent metadata via `herdr agent get <target>` — most useful
 * is `agent_session.path` (and `agent_session_id`) reported by agent
 * integrations.  When that path points at a jsonl session log (pi, omp, …),
 * we can read the response directly instead of screen-scraping the pane.
 *
 * For agents without a structured session log, fall back to screen scraping
 * via herdr pane read (handled by the caller).
 *
 * Output strategy is selected ONCE at construction via
 * `createAgentCommunicator`. Every known structured agent validates its
 * source up-front; if validation fails we warn once and fall back to a
 * scrape reader. Once selected, the reader is permanent — runtime read
 * failures return empty output (not a fallback to readPane).
 */
import { extractLatestScreenPrompt, extractLatestScreenResponse, extractLatestScreenTurn, extractScreenResponse, extractSubmittedScreenResponses, lastTurnMark } from "./output-format.js";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createLogger, type Logger } from "./logger.js";
import { createAgentOutputReader } from "./readers/registry.js";
import type { CompletedReaderTurn } from "./readers/types.js";
import { sendText } from "./herdr-client.js";
import {
  SENT_TAIL_MAX,
  tailOf,
  deriveUnseen,
} from "./output-diff.js";

// Use createRequire so we can `require("node:sqlite")` from this ESM
// module without bundler or async-loading ceremony. node:sqlite is built
// into Node 22.5+; on older runtimes we'll fall back to a meaningful
// validation error.
const require_ = createRequire(import.meta.url);

interface NodeSqliteModule {
  DatabaseSync: new (path: string) => NodeSqliteDatabase;
}

interface NodeSqliteDatabase {
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

function tryLoadNodeSqlite(): NodeSqliteModule | null {
  try {
    const mod = require_("node:sqlite") as NodeSqliteModule;
    if (!mod?.DatabaseSync) return null;
    return mod;
  } catch {
    return null;
  }
}

// --- Agent data paths ------------------------------------------------------

/**
 * Default per-agent data store paths. Each key is an agent name (e.g.
 * "opencode", "codex"); each value is a map from data kind to the default
 * path on disk, computed from $HOME. Callers can override these via the
 * config.toml [agents.<name>] section.
 */
export function defaultAgentPaths(): Record<string, Record<string, string>> {
  const home = process.env.HOME ?? homedir();
  return {
    opencode: {
      db: join(home, ".local/share/opencode/opencode.db"),
    },
    codex: {
      // Codex sessions live under ~/.codex/sessions — path is resolved
      // dynamically by findCodexSessionPath, so no static default needed.
    },
    pi: {
      // Pi sessions are referenced directly via agent_session.path.
    },
    omp: {
      // Omp sessions are referenced directly via agent_session.path.
    },
  };
}

/**
 * Resolve the path for an agent's data store. Looks up the agent's
 * configured override in `agentPaths`, falling back to the default path
 * computed from $HOME.
 *
 * Returns null when no path is known for the agent/key pair.
 */
export function getAgentDataPath(
  agentName: string,
  key: string,
  agentPaths?: Record<string, Record<string, string>>,
): string | null {
  // Check user override first
  if (agentPaths?.[agentName]?.[key]) {
    return agentPaths[agentName][key];
  }
  // Fall back to default
  const defaults = defaultAgentPaths();
  return defaults[agentName]?.[key] ?? null;
}

export type AgentSessionRef =
  | { kind: "path"; path: string }
  | { kind: "id"; id: string }
  | undefined;

/** A single piece of content extracted from a session log. */
export interface AgentResponse {
  /** Plain text of the assistant's last response. */
  text: string;
  /** ISO timestamp of when that response was produced. */
  timestamp: string;
  /** Source strategy used (e.g. "pi-jsonl", "omp-jsonl", "screen-scrape"). */
  source: string;
}

/** Best-effort text join of a pi/omp message content array. */
function extractTextFromContent(content: any[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if ((c?.type === "text" || c?.type === "output_text" || c?.type === "input_text") && typeof c.text === "string") return c.text;
      // Skip thinking blocks — they aren't part of the response the user sees.
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n\n");
}

function matchesPrompt(text: string, prompt?: string): boolean {
  if (!prompt) return true;
  return text.replace(/\s+/g, " ").trim() === prompt.replace(/\s+/g, " ").trim();
}

/**
 * Read the last assistant response from a pi session jsonl, after `sinceMs`.
 *
 * Format (each line is JSON):
 *   {"type":"message", "timestamp":"<iso>", "message":{"role":"assistant"|"user",
 *     "content":[{"type":"text"|"thinking", "text":...}]}}
 */
const codexSessionCache = new Map<string, string>();

/** Resolve Herdr's Codex session id to its local rollout file. */
export function findCodexSessionPath(sessionId: string): string | null {
  const cached = codexSessionCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const root = join(homedir(), ".codex", "sessions");
  const visit = (dir: string): string | null => {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = visit(path);
          if (found) return found;
        } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
          return path;
        }
      }
    } catch {
      return null;
    }
    return null;
  };
  const found = visit(root);
  if (found) codexSessionCache.set(sessionId, found);
  return found;
}

const claudeSessionCache = new Map<string, string>();

/**
 * Where Claude Code keeps a session's transcript: one `<session>.jsonl` under
 * a per-project directory named after the working directory. The directory
 * name is derived from the cwd in a way that is not worth reproducing here —
 * the file is named after the id, so looking one level down is enough.
 */
export function findClaudeSessionPath(sessionId: string): string | null {
  const cached = claudeSessionCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  const root = join(homedir(), ".claude", "projects");
  let projects: string[];
  try {
    projects = readdirSync(root, { encoding: "utf8" });
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(root, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) {
      claudeSessionCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

/**
 * Find a Claude Code session by what was typed into it, when herdr cannot
 * say which session a pane runs — its Claude integration is not installed
 * on that machine. The bridge knows the exact text it sent, and that text
 * is unique to one session: it carries the bridge note and the thread's
 * question. A transcript under the pane's project directory that logs it
 * as a user prompt is the pane's; every other file is left alone.
 *
 * Bounded to files touched in the last day, in the directory Claude Code
 * names after `cwd` (`/home/x/app` → `-home-x-app`), falling back to every
 * project directory when that one is not there.
 */
export function findClaudeSessionByPrompt(cwd: string | undefined, prompts: Iterable<string>): string | null {
  const wanted = [...prompts].map((text) => text.trim()).filter((text) => text.length >= 20);
  if (wanted.length === 0) return null;
  const root = join(homedir(), ".claude", "projects");
  const encoded = cwd ? cwd.replace(/[^A-Za-z0-9]/g, "-") : "";
  let dirs: string[];
  try {
    const all = readdirSync(root, { encoding: "utf8" });
    dirs = encoded && all.includes(encoded) ? [encoded] : all;
  } catch {
    return null;
  }
  const since = Date.now() - 24 * 60 * 60 * 1000;
  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir), { encoding: "utf8" }).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of files) {
      const path = join(root, dir, name);
      try {
        if (statSync(path).mtimeMs < since) continue;
        const raw = readFileSync(path, "utf8");
        // The prompt is logged JSON-encoded; compare against the encoded form
        // so line breaks and quotes match as written.
        if (wanted.some((text) => raw.includes(JSON.stringify(text).slice(1, -1)))) {
          return name.slice(0, -".jsonl".length);
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// --- AgentOutputReader interface --------------------------------------------

/**
 * Single, source-agnostic reader selected ONCE at AgentCommunicator
 * construction. Implementations live in `./readers/` and are selected
 * by `./readers/registry.ts` — see `createAgentOutputReader`. The class
 * itself is still exposed here because `AgentCommunicator` depends on it.
 *
 * Once selected, runtime read errors return "" (NOT a fallback).
 */
export interface AgentOutputReader {
  /** Short identifier for logs ("scrape", "jsonl", "opencode-db"). */
  readonly kind: string;
  /** False while a deferred source is unresolved, not merely empty. Omitted means ready. */
  readonly ready?: boolean;
  /** The session actually selected by a deferred structured reader, if resolved. */
  readonly session?: AgentSessionRef;
  /**
   * Return the latest output for this pane. Empty string when nothing is
   * available. Implementations MUST NOT throw; runtime read errors MUST
   * be swallowed and surfaced via the communicator's logger.
   */
  read(_maxLines: number): string;
  /** One parsed snapshot and all output since the earliest pending submitted prompt; null if absent. */
  readSincePrompts?(prompts: readonly string[], notBefore?: number): { snapshot: string; text: string } | null;
  /**
   * The question the agent is answering, or answered last. Only a source
   * that logs the user's side can offer it; a screen has its own extraction.
   */
  lastPrompt?(): string;
  /** The answer to that question alone, rather than the cumulative log. */
  lastAnswer?(): string;
  /** Optional proof of a complete appended turn. A supplied expected session
   *  must match the selected reader's actual source or capture returns null. */
  captureTurn?(expectedSession?: AgentSessionRef): (() => CompletedReaderTurn | null) | null;
  /**
   * The text is the model's own, byte for byte. A screen carries TUI chrome
   * and so, it turns out, does OpenCode's log; those go through the pane
   * filters before delivery. A transcript that records what the model wrote
   * must not — the filters would eat a path on its own line, or a `<tag>`
   * inside a code block.
   */
  readonly verbatim?: boolean;
}

/** Screen-scrape reader moved to `./readers/registry.ts` so all reader
 *  selection lives in one place. See `createAgentOutputReader`. */

// --- OpenCode SQLite reader ------------------------------------------------

/**
 * Minimal interface around the SQLite driver so tests can stub the
 * open/close/query lifecycle. Production uses `node:sqlite` (Node 22.5+).
 *
 * Why not the `sqlite3` CLI? Two reasons:
 *   - It required shell interpolation of the db path / session id
 *     (which is what we are explicitly trying to avoid).
 *   - Its positional-parameter binding doesn't match the documented
 *     `?` placeholder behaviour we want — we'd have to escape values
 *     ourselves. Using a real driver with prepared statements is
 *     strictly safer.
 */
export interface SqliteDriver {
  open(path: string): SqliteHandle;
}

export interface SqliteHandle {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): void;
}

/**
 * Default driver backed by `node:sqlite`. Built lazily — opening the
 * module requires Node 22.5+, so we probe at first use and surface a
 * meaningful validation reason if it isn't available.
 */
export const defaultSqliteDriver: SqliteDriver = (() => {
  return {
    open(path: string): SqliteHandle {
      const mod = tryLoadNodeSqlite();
      if (!mod) {
        throw new Error("node:sqlite module not available (need Node >=22.5)");
      }
      const db = new mod.DatabaseSync(path);
      return {
        prepare(sql: string): SqliteStatement {
          const stmt = db.prepare(sql);
          return {
            get(...params: unknown[]) {
              const r = stmt.get.apply(stmt, params);
              return (r as Record<string, unknown> | undefined) ?? undefined;
            },
            all(...params: unknown[]) {
              return stmt.all.apply(stmt, params) as Array<Record<string, unknown>>;
            },
            run(...params: unknown[]) {
              stmt.run.apply(stmt, params);
            },
          };
        },
        close() { db.close(); },
      };
    },
  };
})();

/**
 * Probe the OpenCode SQLite DB. Returns `null` on success, or a
 * human-readable reason on failure. Never shell-interpolates; prepared
 * statements bind the session id safely.
 */
export function validateOpenCodeDb(
  dbPath: string | null,
  sessionId: string,
  driver: SqliteDriver = defaultSqliteDriver,
): string | null {
  if (!dbPath) return "no opencode.db path configured";
  if (!existsSync(dbPath)) return `opencode.db not found at ${dbPath}`;
  let handle: SqliteHandle;
  try {
    handle = driver.open(dbPath);
  } catch (err) {
    return `failed to open opencode.db: ${err instanceof Error ? err.message : String(err)}`;
  }
  try {
    const tables = handle.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('message', 'part')",
    ).all();
    const names = new Set(tables.map((r) => String(r.name)));
    if (!names.has("message") || !names.has("part")) {
      return "opencode.db is missing the message/part tables";
    }
    const probe = handle.prepare(
      "SELECT id FROM message WHERE session_id = ? LIMIT 1",
    ).get(sessionId);
    if (!probe) {
      return `session ${sessionId} not present in opencode.db`;
    }
    return null; // OK
  } catch (err) {
    return `opencode.db probe failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}

/**
 * Read the most recent assistant message text from the DB. Returns ""
 * on any failure; never throws (errors surface via the reader wrapper).
 *
 * Strategy: pick the most recent assistant message id for the session,
 * then read its text parts in time-ASC order. Concatenate to a single
 * newline-joined string.
 *
 * Uses parameterized queries — NEVER string-interpolates user input.
 * Returns only most-recent assistant text — user prompts are skipped.
 */
export function readOpenCodeDb(
  dbPath: string,
  sessionId: string,
  driver: SqliteDriver = defaultSqliteDriver,
): string {
  const handle = driver.open(dbPath);
  try {
    // Real OpenCode schema: message.data JSON holds the role
    // (e.g. {"role":"assistant"}), while part.data holds type/text
    // (e.g. {"type":"text","text":"..."}) with NO role field.
    //
    // Strategy: pick the latest assistant message that has at least
    // one text part (OpenCode may write step-start / reasoning /
    // tool-only messages AFTER the textual answer).  Then collect
    // all text parts from that message in time order.
    const rows = handle.prepare(
      [
        "SELECT p.data AS data, p.time_created AS ts",
        "FROM message m JOIN part p ON p.message_id = m.id",
        "WHERE m.session_id = ?",
        "  AND json_extract(m.data, '$.role') = 'assistant'",
        "  AND json_extract(p.data, '$.type') = 'text'",
        "  AND m.id = (",
        "    SELECT m2.id FROM message m2",
        "    WHERE m2.session_id = ?",
        "      AND json_extract(m2.data, '$.role') = 'assistant'",
        "      AND EXISTS (",
        "        SELECT 1 FROM part p2",
        "        WHERE p2.message_id = m2.id",
        "          AND json_extract(p2.data, '$.type') = 'text'",
        "      )",
        "    ORDER BY m2.time_created DESC, m2.id DESC",
        "    LIMIT 1",
        "  )",
        "ORDER BY p.time_created ASC",
      ].join(" "),
    ).all(sessionId, sessionId);

    const parts: string[] = [];
    for (const row of rows) {
      const raw = (row as any).data;
      let data: any;
      try { data = JSON.parse(typeof raw === "string" ? raw : "null"); }
      catch { data = null; }
      const text = typeof data?.text === "string" ? data.text : "";
      if (text) parts.push(text);
    }
    return parts.join("\n").trim();
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}

/**
 * Read a *cumulative* OpenCode snapshot: the latest N assistant messages,
 * their parts concatenated in chronological order.  Default window is 50
 * messages — recent enough to capture the live turn, bounded enough that
 * SQLite doesn't scale with session length.
 *
 * Real OpenCode part payload shapes (inspected from a live DB):
 *   - {type:"text",     text:"<visible answer>"}
 *   - {type:"reasoning",text:"<chain-of-thought, may be empty when encrypted>"}
 *   - {type:"tool",     tool:"read"|"bash"|..., state:{input:..., output:...}}
 *   - {type:"patch",    hash:"...", files:[...]}
 *   - {type:"step-start"|"step-finish"|"compaction"|"file", ...}
 *
 * Defaults emit ONLY type="text" parts — the user-visible answer.
 * Opt-in flags under [agents.opencode] turn on tool/thought summaries:
 *   include_tools    → "🔧 <tool> <compact input preview>"
 *   include_thoughts → "💭 <reasoning>" (or "💭 (reasoning step)" when
 *                     encrypted with empty text)
 * Tool summaries deliberately omit the large `state.output` body and
 * truncate long inputs.
 *
 * SQL strategy:
 *   1. Resolve the latest N assistant message ids ordered by time_created DESC.
 *   2. Read all parts whose `message_id` is in that set, ordered by time ASC.
 *   3. Walk rows in order, projecting each part to a line (or skipping it)
 *      based on the type and the include options.
 *
 * Both the session id and the window bound are bound parameters — the
 * function never interpolates them into SQL.
 */
export interface OpenCodeReadOptions {
  /** Include tool parts as compact one-line summaries prefixed `🔧`. */
  includeTools?: boolean;
  /** Include reasoning/thinking parts as compact summaries prefixed `💭`. */
  includeThoughts?: boolean;
  /** Max assistant messages to read, latest first. Default 50. */
  messageWindow?: number;
}

const DEFAULT_MESSAGE_WINDOW = 50;

/** Compact summary of a tool part — never dumps the output body. */
function summarizeTool(data: any): string | null {
  const toolName =
    typeof data?.tool === "string" ? data.tool :
    typeof data?.name === "string" ? data.name :
    typeof data?.toolName === "string" ? data.toolName :
    "";
  if (!toolName) return null;
  const input = data?.state?.input ?? data?.input ?? {};
  // Per-tool compact preview: only the args the user would care to see.
  let preview = "";
  if (typeof input?.filePath === "string") {
    preview = input.filePath;
    if (typeof input?.offset === "number") {
      preview += `:${input.offset}`;
      if (typeof input?.limit === "number") preview += `+${input.limit}`;
    }
  } else if (typeof input?.command === "string") {
    preview = input.command.length > 80
      ? input.command.slice(0, 77) + "..."
      : input.command;
  } else if (typeof input?.patchText === "string") {
    const m = input.patchText.match(/^\*\*\*\s+(?:Begin Patch|Update File|Delete File|Add File):\s*(.*)$/m);
    preview = m ? m[1] : `patch (${input.patchText.length}b)`;
  } else if (typeof input?.file === "string") {
    preview = input.file;
  } else if (typeof input?.url === "string") {
    preview = input.url;
  }
  return preview ? `${toolName} ${preview}` : toolName;
}

/** Compact summary of a reasoning/thinking part. */
function summarizeReasoning(data: any): string {
  const text = typeof data?.text === "string" ? data.text : "";
  return text || "(reasoning step)";
}

export function readOpenCodeCumulative(
  dbPath: string,
  sessionId: string,
  driver: SqliteDriver = defaultSqliteDriver,
  options: OpenCodeReadOptions = {},
): string {
  const includeTools = options.includeTools ?? false;
  const includeThoughts = options.includeThoughts ?? false;
  // Clamp invalid / non-positive / non-finite window values to the default.
  // SQLite LIMIT -1 is unlimited and LIMIT 0 returns no rows — both would
  // produce surprising output, so we guard against them here.
  const raw = options.messageWindow;
  const windowSize = (raw != null && Number.isFinite(raw) && raw > 0)
    ? Math.floor(raw)
    : DEFAULT_MESSAGE_WINDOW;

  const handle = driver.open(dbPath);
  try {
    // 1. Find the latest N assistant message ids for this session.
    //    Bound ?1 = sessionId, ?2 = window size. Order by time DESC + id DESC
    //    so concurrent inserts at the same tick resolve deterministically.
    const messageRows = handle.prepare(
      [
        "SELECT id FROM message",
        "WHERE session_id = ?",
        "  AND json_extract(data, '$.role') = 'assistant'",
        "ORDER BY time_created DESC, id DESC",
        "LIMIT ?",
      ].join(" "),
    ).all(sessionId, windowSize);

    const ids: string[] = [];
    for (const row of messageRows) {
      const id = (row as any).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
    if (ids.length === 0) return "";

    // 2. Pull every part whose message_id is in the set, in time order.
    //    Only `?` placeholders — drivers (node:sqlite, sqlite3 CLI) do NOT
    //    support `?N` positional binding, and over-specifying would trip up
    //    any test driver. The IDs are bound — never concatenated into SQL.
    const placeholders = ids.map(() => "?").join(",");
    const partRows = handle.prepare(
      `SELECT data FROM part WHERE message_id IN (${placeholders}) ORDER BY time_created ASC, id ASC`,
    ).all(...ids);

    // 3. Walk rows in order; emit a line per included part.
    const lines: string[] = [];
    for (const row of partRows) {
      const raw = (row as any).data;
      let data: any;
      try { data = JSON.parse(typeof raw === "string" ? raw : "null"); }
      catch { data = null; }
      const type = typeof data?.type === "string" ? data.type : "";
      if (type === "text") {
        const text = typeof data?.text === "string" ? data.text : "";
        if (text) lines.push(text);
        continue;
      }
      if (includeThoughts && (type === "reasoning" || type === "thinking")) {
        lines.push("💭 " + summarizeReasoning(data));
        continue;
      }
      if (includeTools && (type === "tool" || type === "tool_use" || type === "tool_call")) {
        const summary = summarizeTool(data);
        if (summary) lines.push("🔧 " + summary);
        continue;
      }
      // All other part types (step-start, step-finish, patch, file,
      // compaction, …) are skipped — they aren't user-facing prose.
    }

    return lines.join("\n").trim();
  } finally {
    try { handle.close(); } catch { /* ignore */ }
  }
}

export class OpenCodeDbReader implements AgentOutputReader {
  readonly kind = "opencode-db";
  constructor(
    private readonly dbPath: string,
    private readonly sessionId: string,
    private readonly driver: SqliteDriver,
    private readonly logger: Logger,
    private readonly paneId: string,
    private readonly readOptions: OpenCodeReadOptions = {},
  ) {}
  read(_maxLines: number): string {
    try {
      // Use the cumulative reader so the caller sees a stable, replayable
      // snapshot of the latest N assistant messages. Default behavior
      // (text-only, 50-message window) matches what users want from /last.
      return readOpenCodeCumulative(
        this.dbPath, this.sessionId, this.driver, this.readOptions,
      );
    } catch (err) {
      this.logger.warn("opencode structured read failed", {
        paneId: this.paneId,
        sessionId: this.sessionId,
        dbPath: this.dbPath,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }
}

// --- Public factory --------------------------------------------------------

/** Subset of herdr-client AgentInfo that factory needs. */
export interface AgentCommunicatorDeps {
  paneId: string;
  getAgentInfo: (target: string) => { agent?: string; agent_status?: string; agent_session?: AgentSessionRef; cwd?: string } | null;
  readPane: (paneId: string, lines: number) => string;
  agentPaths?: Record<string, Record<string, string>>;
  logger?: Logger;
  /**
   * Optional test seam — replace the SQLite driver. Production uses the
   * built-in `node:sqlite` module via defaultSqliteDriver.
   */
  sqliteDriver?: SqliteDriver;
  /**
   * Per-agent reader options (e.g. include_tools / include_thoughts for
   * OpenCode). Wired in from cfg at the daemon entry point.
   */
  opencodeReadOptions?: OpenCodeReadOptions;
}

const fallbackLog: Logger = createLogger("agent-sessions");

/**
 * Selection-once factory. Delegates reader selection to
 * `./readers/registry.ts` — all agent-specific logic (pi/omp/codex/opencode
 * validation, scrape fallback, warn reasons) lives there. This function
 * only knows about the communicator class and the request shape.
 *
 * Caller-facing behaviour (unchanged):
 *   - If validation of the structured source fails, the registry logs a
 *     single warning (pane, agent, reason) and falls back to a scrape reader.
 *   - If validation succeeds, the registry picks the structured reader
 *     permanently.
 *   - Runtime empty reads do NOT trigger a fallback.
 *
 * Production code MUST go through this factory instead of `new AgentCommunicator`.
 * The class itself remains exported for tests + seam-based construction.
 */
export function createAgentCommunicator(depsIn: AgentCommunicatorDeps): AgentCommunicator {
  const deps: AgentCommunicatorDeps = { ...depsIn };
  const log: Logger = deps.logger ?? fallbackLog;

  const info = safeGetAgentInfo(deps);
  // Assigned below; the resolver closes over it so a Claude pane herdr
  // cannot name a session for can still be found by what the bridge sent.
  let communicator: AgentCommunicator | undefined;
  const reader = createAgentOutputReader({
    paneId: deps.paneId,
    agentName: info?.agent ?? "?",
    session: info?.agent_session,
    resolveSession: () => {
      const live = safeGetAgentInfo(deps);
      if (live?.agent_session) return live.agent_session;
      if (live?.agent !== "claude" || !communicator) return undefined;
      const guessed = findClaudeSessionByPrompt(live.cwd, communicator.sentPrompts());
      if (guessed) log.info("session found by the prompt the bridge sent", { paneId: deps.paneId, sessionId: guessed });
      return guessed ? { kind: "id", id: guessed } : undefined;
    },
    readPane: deps.readPane,
    agentPaths: deps.agentPaths,
    opencodeReadOptions: deps.opencodeReadOptions,
    sqliteDriver: deps.sqliteDriver,
    logger: log,
  });
  communicator = new AgentCommunicator(reader, log, deps.paneId);
  // A pane that is not working has answered its log's last question already.
  // So has a working one whose log shows an answer under that question: it
  // woke to continue — a monitor, a background shell — and the question is
  // an old one, whoever asked it.
  if (info?.agent_status !== "working" || communicator.lastPromptAnswered()) communicator.sealAnsweredPrompt();
  return communicator;
}

function safeGetAgentInfo(deps: AgentCommunicatorDeps): { agent?: string; agent_status?: string; agent_session?: AgentSessionRef; cwd?: string } | null {
  try {
    return deps.getAgentInfo(deps.paneId);
  } catch {
    return null;
  }
}

// --- AgentCommunicator class -----------------------------------------------

/**
 * Encapsulates communication with a single agent pane.
 *
 * Use `createAgentCommunicator(deps)` to build one. Direct construction
 * is allowed for tests that want to inject a custom reader.
 */
export class AgentCommunicator {
  /**
   * Short identifier of the active reader ("scrape" | "claude-jsonl" | …).
   * Read through to the reader: one chosen before its log existed may settle
   * for the screen later, and every scrape-or-structured decision here must
   * follow it when it does.
   */
  get readerKind(): string {
    return this.reader.kind;
  }
  /** Whether a source has resolved, independent of a submitted-prompt match. */
  get sourceReady(): boolean {
    return this.reader.ready !== false;
  }
  /** Whether output can be read without crossing an unresolved prompt fence. */
  get outputReady(): boolean {
    return this.sourceReady && this.deferredInputGroup?.ready !== false;
  }
  /** Whether the reader's text is the model's own, needing no pane filters. */
  get verbatim(): boolean {
    return this.reader.verbatim === true;
  }
  /**
   * Pane id this communicator is bound to. Required for `sendInput`.
   * Optional in the constructor purely so existing direct-construction
   * test sites (which don't exercise input) keep working unchanged —
   * the factory always supplies a value.
   */
  readonly paneId: string;

  constructor(
    reader: AgentOutputReader,
    private readonly logger: Logger = fallbackLog,
    paneId?: string,
  ) {
    this.reader = reader;
    this.paneId = paneId ?? "";
  }

  private readonly reader: AgentOutputReader;

  /**
   * Diff state. `sentTail` is the trailing SENT_TAIL_MAX chars of the last
   * snapshot we considered "consumed" by the consumer (a follow loop, a
   * /last-aware poll, etc.). `initialized` flips to `true` after the first
   * baseline seed; until then the next `getNewOutput()` call seeds instead
   * of emitting — historical content must never be replayed as "new".
   *
   * Why per-instance: each pane gets its own communicator, so each pane's
   * turn lifecycle owns its own baseline. Sharing across panes would let
   * one pane consume another pane's unread content.
   */
  private sentTail = "";
  private initialized = false;
  /** Most recent text handed to the pane, used to anchor a turn's response. */
  private lastInput = "";
  /** This turn's input group: structured anchors freeze; screens retain later inputs until the next fresh consumer. */
  private deferredInputGroup: { prompts: string[]; ready: boolean; startedAt: number; snapshotPrefix?: string } | null = null;
  /**
   * Whether the turn under way was started outside the bridge — somebody typed
   * in the pane itself. There is no submitted text to anchor on, so the answer
   * is read off the last prompt the screen shows instead.
   */
  private externalTurn = false;
  /**
   * The closing line ("✻ Worked for 2m 26s · done 1:15 PM") of the turn the
   * most recent `getTurnResponse` read, and of the last turn delivered. When
   * the two are the same line, the screen has not closed a new turn: the
   * answer just read is the one already sent.
   *
   * Turn identity, not answer text. The bridge-typed and adopted paths
   * extract the same turn differently and their strings disagreed on bytes
   * while agreeing on words — the guard comparing them never fired, and the
   * same answer went out twice.
   */
  private readMark = "";
  private deliveredMark = "";
  /**
   * Every question this communicator has typed into the pane, or found
   * already answered when it was built — the questions that are NOT
   * somebody's terminal typing, however the log presents them. A single
   * "last delivered" question was not enough: a message sent while the pane
   * was busy is absorbed into that turn and never logged as a prompt, so the
   * log's last prompt lagged one behind, and the one before was announced as
   * asked in the terminal. Bounded, oldest out.
   */
  private readonly knownPrompts = new Set<string>();
  private static readonly KNOWN_PROMPTS_MAX = 64;

  private remember(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    this.knownPrompts.delete(text);
    this.knownPrompts.add(text);
    if (this.knownPrompts.size > AgentCommunicator.KNOWN_PROMPTS_MAX) {
      const oldest = this.knownPrompts.values().next().value;
      if (oldest !== undefined) this.knownPrompts.delete(oldest);
    }
  }

  /** Whether a question is one the bridge itself asked, or one already answered. */
  private isKnown(prompt: string): boolean {
    return this.knownPrompts.has(prompt.trim());
  }

  /** What the bridge has typed into this pane, newest last. */
  sentPrompts(): string[] {
    return [...this.sentTexts];
  }
  private readonly sentTexts: string[] = [];

  /**
   * Read the current output from the agent.
   *
   * Returns the structured reader's text when one was selected, otherwise
   * the screen-scrape. Runtime read errors return "" (and surface via the
   * injected logger) — they MUST NOT trigger a fallback to readPane.
   *
   * This is a PURE read: it does not seed or update the diff state owned
   * by `getNewOutput`. Use it for one-shot reads (e.g. the watcher's
   * seed snapshot) where there's no notion of "what the user has already
   * seen".
   */
  getAgentOutput(maxLines: number): string {
    try {
      const text = this.reader.read(maxLines);
      return text ?? "";
    } catch (err) {
      this.logger.error("agent output reader threw unexpectedly", {
        readerKind: this.readerKind,
        message: err instanceof Error ? err.message : String(err),
      });
      return "";
    }
  }

  /** Capture an inactive turn's literal baseline before dispatch, never after it. */
  seedOutputBaseline(): void {
    this.sentTail = tailOf(this.getAgentOutput(4000), SENT_TAIL_MAX);
    this.initialized = true;
    this.deferredInputGroup = this.reader.ready === false ? { prompts: [], ready: false, startedAt: Date.now() } : null;
  }

  /** A new follow window must not inherit an ended submitted turn's unresolved boundary. */
  clearPendingInputBoundary(): void {
    this.deferredInputGroup = null;
  }

  /**
   * Stateful diff reader for polling consumers (follow loop, turn
   * controller, etc.).
   *
   *   - First call: seed `sentTail` from the current snapshot and return
   *     "". Historical content is never replayed — the user has been
   *     watching the pane live and would see duplicates.
   *   - Subsequent calls: return the portion of the current snapshot
   *     that has not yet been seen, and update `sentTail` only when the
   *     unseen suffix was non-empty. When nothing is new, the baseline
   *     is left untouched so a stable pane does not drift the anchor.
   *   - Errors are swallowed by `getAgentOutput` (return "") — the
   *     first error after a clean seed will look like "snapshot went
   *     empty", which `deriveUnseen` handles by returning "".
   *
   * Submitted turns seedOutputBaseline before sending, so even their first
   * poll can return a fast reply. Deferred sources first exclude prior prompts.
   * Multiple calls after the baseline seed each return only what has
   * appeared since the previous successful call, so a polling consumer
   * that calls this every tick will see each new chunk exactly once.
   */
  getNewOutput(): string {
    if (this.deferredInputGroup && !this.deferredInputGroup.ready) {
      const turn = this.reader.readSincePrompts?.(this.deferredInputGroup.prompts, this.deferredInputGroup.startedAt);
      if (turn && turn.snapshot.endsWith(turn.text)) {
        // Consume the same snapshot that supplied the entire pending input group.
        this.sentTail = tailOf(turn.snapshot, SENT_TAIL_MAX);
        this.initialized = true;
        // Freeze this occurrence, not its prompt text: a later identical input
        // must not move full-turn readback past an earlier current answer.
        this.deferredInputGroup.snapshotPrefix = turn.snapshot.slice(0, turn.snapshot.length - turn.text.length);
        this.deferredInputGroup.ready = true;
        return turn.text;
      }
      if (this.readerKind !== "scrape") return "";
    }
    // A new source needs its own literal baseline. Retain an already-complete
    // answer, but never treat the first screen's historical scrollback as new.
    if (this.deferredInputGroup && this.readerKind === "scrape" && (!this.deferredInputGroup.ready || !this.sentTail)) {
      const screen = this.getAgentOutput(4000);
      this.sentTail = tailOf(screen, SENT_TAIL_MAX);
      this.initialized = true;
      this.deferredInputGroup.ready = true;
      return this.deferredScreenAnswer(screen);
    }
    const snapshot = this.getAgentOutput(4000);
    if (!this.initialized) {
      this.sentTail = tailOf(snapshot, SENT_TAIL_MAX);
      this.initialized = true;
      return "";
    }
    // A baseline seeded on nothing — a session so new its log did not exist
    // yet — anchors nowhere, and `deriveUnseen` would answer "" for good.
    // Everything that appears after an empty baseline is new.
    const unseen = this.sentTail === "" ? snapshot : deriveUnseen(snapshot, this.sentTail);
    if (unseen.length > 0) {
      // Re-anchor on the LITERAL current snapshot (not on the unseen
      // suffix) — trailing-newline stripping on scrape snapshots can
      // offset by a single `\n`, and substring anchoring against the
      // snapshot itself always matches on the next poll.
      this.sentTail = tailOf(snapshot, SENT_TAIL_MAX);
    }
    return unseen;
  }

  /**
   * Read-only peek for `/last` and similar. Returns whatever the
   * underlying reader currently reports WITHOUT touching diff state —
   * a subsequent `getNewOutput()` still treats the first unseen
   * content as "new".
   *
   * Implemented as a thin wrapper over `getAgentOutput` so the
   * constraint is structurally guaranteed: there is no path through
   * this method that mutates `sentTail`/`initialized`.
   */
  getLatestOutput(): string {
    return this.getAgentOutput(4000);
  }

  /** Final readback must not bypass a deferred submitted-prompt fence. */
  getFinalFallbackOutput(): string {
    if (this.readerKind !== "scrape") {
      return this.deferredInputGroup ? this.getTurnResponse() : this.outputReady ? this.getLastAnswer() : "";
    }
    const snapshot = this.getLatestOutput();
    return this.deferredInputGroup && this.readerKind === "scrape" ? this.deferredScreenAnswer(snapshot) : snapshot;
  }

  private deferredScreenAnswer(screen: string): string {
    // Untimed screen echoes cannot disambiguate repeated/coalesced identical prompts.
    return extractSubmittedScreenResponses(screen, this.deferredInputGroup?.prompts ?? []);
  }

  /** Pure pre-dispatch capture: does not consume or seed ordinary diff output. */
  captureCompletedResponse(input: string, expectedSession?: AgentSessionRef): (() => string | null) | null {
    try {
      const read = this.reader.captureTurn?.(expectedSession);
      if (!read || !input.trim()) return null;
      return () => {
        try {
          const turn = read();
          return turn && matchesPrompt(turn.prompt, input) && turn.text.trim() ? turn.text : null;
        } catch {
          return null;
        }
      };
    } catch {
      return null;
    }
  }

  /**
   * Forward `text` to the pane as agent input (via herdr's
   * `pane run` bridge). Equivalent to the user typing in the TUI.
   * Synchronous — herdr returns once the input has been delivered to
   * the pane's stdin.
   *
   * Throws if the communicator was built without a `paneId` (only
   * possible via direct constructor — the factory always supplies one).
   * `PaneAgent` calls this from `handleMessage`.
   */
  sendInput(text: string): void {
    if (!this.paneId) {
      throw new Error(
        "AgentCommunicator.sendInput requires a paneId — use createAgentCommunicator()"
      );
    }
    this.lastInput = text;
    if (this.deferredInputGroup) {
      if (!this.deferredInputGroup.ready || this.readerKind === "scrape") this.deferredInputGroup.prompts.push(text);
    }
    this.externalTurn = false;
    this.remember(text);
    this.sentTexts.push(text);
    if (this.sentTexts.length > 8) this.sentTexts.shift();
    sendText(this.paneId, text);
  }

  /**
   * The agent's answer to the most recent submitted prompt, or "" when this
   * reader cannot anchor one.
   *
   * A screen-scrape reader sees a terminal SCREEN, not an append-only log: it
   * scrolls, redraws, and repeats content, so accumulating incremental diffs
   * over a turn reproduces the scrollback rather than the answer. Anchoring on
   * the submitted prompt inside the final snapshot is reliable exactly where
   * diffing is not.
   *
   * Structured readers (JSONL, SQLite) return cumulative ASSISTANT text with
   * no prompt to anchor on — and they diff reliably — so they return "" and
   * leave the caller on its diff-based path. The exception is a log that
   * records the prompts as well: there the answer to a NEW question is
   * everything logged after it, which no diff baseline can get wrong. A turn
   * under a question already answered — the agent woke on its own — has no
   * such boundary, and stays on the diffs so the old answer is not resent.
   */
  getTurnResponse(): string {
    if (this.readerKind !== "scrape") {
      // A delayed source can contain several inputs from this active turn.
      // Re-reading only its last answer would lose the earlier input's output.
      if (this.deferredInputGroup) {
        // Finalization (including abort/ceiling) must respect the same fence as
        // polling: a matching old lastPrompt is not proof of a current answer.
        if (!this.deferredInputGroup.ready) {
          // Abort can arrive after the reply was logged but before polling
          // matched it. Read one coherent, dispatch-floored match without
          // consuming diff output or opening the polling fence.
          const turn = this.reader.readSincePrompts?.(this.deferredInputGroup.prompts, this.deferredInputGroup.startedAt);
          return turn && turn.snapshot.endsWith(turn.text) ? turn.text : "";
        }
        const prefix = this.deferredInputGroup.snapshotPrefix;
        if (prefix === undefined) return "";
        const snapshot = this.getAgentOutput(4000);
        return snapshot.startsWith(prefix) ? snapshot.slice(prefix.length).trim() : "";
      }
      const asked = this.reader.lastPrompt?.().trim() ?? "";
      if (!asked || !this.reader.lastAnswer) return "";
      const isNew = this.lastInput.trim()
        ? asked === this.lastInput.trim()
        : !this.isKnown(asked);
      return isNew ? this.reader.lastAnswer() : "";
    }
    if (this.lastInput.trim()) {
      const screen = this.getAgentOutput(4000);
      // Only a mark below the prompt closes THIS turn. Read the moment the
      // agent settles, the screen may not show one yet; the mark above the
      // prompt belongs to the turn before, and is not this turn's.
      this.readMark = lastTurnMark(screen, { afterPrompt: this.lastInput });
      return this.deferredInputGroup ? this.deferredScreenAnswer(screen) : extractScreenResponse(screen, this.lastInput);
    }
    // Only a turn we were told is external falls back to the screen's own
    // prompt. A `/follow` window has no input either, and its loop is not
    // bounded by one turn, so guessing an anchor there would deliver whatever
    // question happened to be last on screen.
    if (!this.externalTurn) return "";
    const screen = this.getAgentOutput(4000);
    this.readMark = lastTurnMark(screen);
    return extractLatestScreenResponse(screen);
  }

  /**
   * Whether the turn `getTurnResponse` just read is the one already delivered.
   *
   * True means the agent has not closed a new turn since: the loop settled on
   * a quiet screen mid-turn and the extraction fell back to the previous one.
   * The right response is to keep watching, which is `PaneAgent`'s call.
   */
  turnAlreadyDelivered(): boolean {
    return this.readMark !== "" && this.readMark === this.deliveredMark;
  }

  /**
   * The turn last read has been sent. Remember which one, so the next read
   * can tell whether it is looking at the same turn, and what it answered, so
   * that question is not announced again.
   *
   * `prompt` is the question delivered with the turn; empty means the bridge
   * typed it and `lastInput` is the question.
   */
  markDelivered(prompt: string): void {
    if (this.readMark) this.deliveredMark = this.readMark;
    // A turn with no question of its own — the agent continued under the
    // last one — leaves the memory alone. Blanking it here is what let the
    // next such turn quote that question all over again.
    this.remember(prompt.trim() || this.lastInput);
  }

  /**
   * The question just submitted in the pane, read before there is any answer
   * to it. Used to announce a turn as it starts, so a long one is not fifteen
   * minutes of silence in the chat.
   *
   * Only a screen scrape can see it: a structured reader logs assistant text,
   * not the prompt.
   */
  getPendingPrompt(): string {
    if (this.readerKind !== "scrape") {
      // A log that carries the prompts has no mark to place them against;
      // the question's text is the only tell, as it is for a markless screen.
      const asked = this.reader.lastPrompt?.() ?? "";
      return this.isKnown(asked) ? "" : asked;
    }
    // The prompt is at the bottom of the screen; there is no need to pull the
    // whole scrollback for it.
    const asked = extractLatestScreenPrompt(this.getAgentOutput(400), { afterMark: this.deliveredMark });
    // Without a mark to place it against, the question's text is the only
    // tell. An agent that woke on its own — a background shell finishing —
    // has no new `❯`, and the latest one on screen is what the bridge typed.
    if (!this.deliveredMark && asked && this.isKnown(asked)) return "";
    return asked;
  }

  /**
   * The question this turn is answering, as far as it can be known.
   *
   * For a turn the bridge started that is the text it sent. For one started in
   * the pane there is only what the terminal echoed, so it is read back off
   * the screen — which is also the only way the chat can show a question that
   * was never typed there.
   *
   * Empty when the question found is the one already delivered: the agent
   * woke under it on its own — a background task, a hook — and the chat has
   * that question above already, quite possibly because it typed it.
   */
  getTurnPrompt(): string {
    if (this.lastInput.trim()) return this.lastInput;
    if (!this.externalTurn) return "";
    const asked = (this.readerKind !== "scrape"
      ? this.reader.lastPrompt?.() ?? ""
      : extractLatestScreenTurn(this.getAgentOutput(4000))?.prompt ?? "").trim();
    return this.isKnown(asked) ? "" : asked;
  }

  /**
   * The most recent answer visible in this pane, for a read-only `/last`.
   *
   * A scrape reader hands back a whole terminal screen, so the answer has to
   * be cut out of it — the same extraction an externally-started turn uses.
   * A structured reader already returns assistant text and nothing else, so
   * its snapshot IS the answer. When the screen shows no prompt to anchor on
   * (a pane that has only ever printed, a TUI this rule does not fit), the
   * raw snapshot is returned rather than nothing.
   */
  getLastAnswer(): string {
    if (this.readerKind !== "scrape") {
      // A log that knows where the last question fell can cut the answer
      // out; one that does not is assistant text end to end, so its
      // snapshot is the closest thing.
      const answer = this.reader.lastAnswer?.();
      return answer !== undefined ? answer : this.getAgentOutput(4000);
    }
    const snapshot = this.getAgentOutput(4000);
    return extractLatestScreenResponse(snapshot) || snapshot;
  }

  /**
   * The next turn was started in the pane, not through the bridge. Forget the
   * prompt anchor: the stale one belongs to an earlier turn, and
   * `extractResponseSince` would bound that turn's answer at the new prompt
   * and hand back an answer already delivered.
   *
   * Then seal the screen: whatever turn is closed at this moment is over, and
   * this adoption is for the one under way. A daemon that has just started
   * finds panes mid-turn with nothing delivered yet, and without the seal the
   * loop's first quiet read would hand back the last closed turn — from
   * before the daemon existed — as the answer. The seal is what lets the
   * watcher adopt a pane on first sight instead of skipping it, and it
   * costs nothing on an ordinary adoption: the last closed turn there is one
   * the bridge already sent.
   *
   * A question typed for the turn under way sits BELOW the sealed line, so
   * `getPendingPrompt` still announces it; only the one above, already
   * answered, is kept quiet.
   */
  /**
   * Take the log's latest question as already answered. For a source that
   * logs prompts there is no turn mark to seal the way a screen is sealed,
   * so this is done once, when the communicator is built for a pane that is
   * not working: the answer to that question is on the pane already, and an
   * agent that later wakes without a new question — a task notification, a
   * hook — must not have it announced as asked in the terminal.
   */
  sealAnsweredPrompt(): void {
    const asked = this.reader.lastPrompt?.();
    if (asked) this.remember(asked);
  }

  /**
   * Whether `getLastAnswer` returns one answer rather than the whole log. A
   * screen is cut at its last prompt; a structured reader needs `lastAnswer`
   * for that, and one without it hands back everything it has — which is
   * never what a late delivery should post.
   */
  canIsolateLastAnswer(): boolean {
    return this.readerKind === "scrape" || typeof this.reader.lastAnswer === "function";
  }

  /** Whether the log already shows an answer under its last question. */
  lastPromptAnswered(): boolean {
    return (this.reader.lastAnswer?.() ?? "").trim().length > 0;
  }

  beginExternalTurn(): void {
    this.lastInput = "";
    this.deferredInputGroup = null;
    this.externalTurn = true;
    this.readMark = "";
    if (this.readerKind !== "scrape") return;
    const closed = lastTurnMark(this.getAgentOutput(4000));
    if (closed) this.deliveredMark = closed;
  }
}

/** Back-compat alias used by old test code. */
export const buildAgentCommunicator = createAgentCommunicator;

// Re-export createLogger so callers can build a Logger without importing logger.ts.
export { createLogger } from "./logger.js";
