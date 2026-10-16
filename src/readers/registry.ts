import type { AgentOutputReader, AgentReaderRequest } from "./types.js";
import { stripStatusBar } from "../output-format.js";
import {
  OpenCodeDbReader,
  defaultSqliteDriver,
  findClaudeSessionPath,
  findCodexSessionPath,
  getAgentDataPath,
  validateOpenCodeDb,
} from "../agent-sessions.js";
import { ClaudeJsonlReader, CodexJsonlReader, DeferredReader, PiJsonlReader, validatePathSession } from "./jsonl.js";

class ScrapeReader implements AgentOutputReader {
  readonly kind = "scrape";
  constructor(
    private readonly paneId: string,
    private readonly readPane: (paneId: string, lines: number) => string,
  ) {}

  read(maxLines: number): string {
    try {
      return stripStatusBar(this.readPane(this.paneId, maxLines));
    } catch {
      return "";
    }
  }
}

export function createAgentOutputReader(req: AgentReaderRequest): AgentOutputReader {
  if (req.session?.kind === "path" && (req.agentName === "pi" || req.agentName === "omp")) {
    const reason = validatePathSession(req.session.path);
    if (reason) {
      req.logger.warn("structured source unavailable; falling back to scrape", {
        paneId: req.paneId,
        agent: req.agentName,
        reason,
      });
    } else {
      return new PiJsonlReader(req.session.path, req.logger, req.paneId, req.agentName);
    }
  }

  if (req.session?.kind === "path" && req.agentName === "codex") {
    const reason = validatePathSession(req.session.path);
    if (!reason) {
      return new CodexJsonlReader(req.session.path, req.logger, req.paneId);
    }
    req.logger.warn("structured source unavailable; falling back to scrape", {
      paneId: req.paneId,
      agent: req.agentName,
      reason,
    });
  }

  if (req.session?.kind === "id" && req.agentName === "codex") {
    const session = req.session;
    const path = findCodexSessionPath(session.id);
    if (path) return new CodexJsonlReader(path, req.logger, req.paneId);
    // Metadata may precede the rollout for initial and replacement sessions.
    // Unlike the sessionless resolver, this reader must wait for this exact id.
    return new DeferredReader("codex-jsonl", false, () => {
      const found = findCodexSessionPath(session.id);
      return found ? Object.assign(new CodexJsonlReader(found, req.logger, req.paneId), { session }) : null;
    }, req.logger, req.paneId, new ScrapeReader(req.paneId, req.readPane));
  }

  // A Codex pane with no session yet has just started: the rollout is
  // written with the first prompt, and herdr reports the id then. Wait for
  // it rather than settle for the screen.
  if (!req.session && req.agentName === "codex" && req.resolveSession) {
    const resolve = req.resolveSession;
    return new DeferredReader("codex-jsonl", false, () => {
      const session = resolve();
      if (session?.kind !== "id") return null;
      const path = findCodexSessionPath(session.id);
      return path ? Object.assign(new CodexJsonlReader(path, req.logger, req.paneId), { session }) : null;
    }, req.logger, req.paneId, new ScrapeReader(req.paneId, req.readPane));
  }

  // Likewise a Claude pane herdr has not put a session id to yet.
  if (!req.session && req.agentName === "claude" && req.resolveSession) {
    const resolve = req.resolveSession;
    return new DeferredReader("claude-jsonl", true, () => {
      const session = resolve();
      if (session?.kind !== "id") return null;
      const sessionId = session.id;
      // The transcript itself may still be missing; the reader looks again on
      // every read, so hand it over only once the file is there.
      return findClaudeSessionPath(sessionId)
        ? Object.assign(new ClaudeJsonlReader(() => findClaudeSessionPath(sessionId), req.logger, req.paneId), { session })
        : null;
    }, req.logger, req.paneId, new ScrapeReader(req.paneId, req.readPane));
  }

  if (req.session?.kind === "id" && req.agentName === "claude") {
    // A Claude Code session writes its transcript with its first prompt, so
    // a pane bound before that has simply not been asked anything: the
    // reader keeps looking until the file appears — and reads the screen if
    // it never does.
    const sessionId = req.session.id;
    if (findClaudeSessionPath(sessionId)) {
      return new ClaudeJsonlReader(() => findClaudeSessionPath(sessionId), req.logger, req.paneId);
    }
    return new DeferredReader("claude-jsonl", true, () => (
      findClaudeSessionPath(sessionId)
        ? new ClaudeJsonlReader(() => findClaudeSessionPath(sessionId), req.logger, req.paneId)
        : null
    ), req.logger, req.paneId, new ScrapeReader(req.paneId, req.readPane));
  }

  if (req.session?.kind === "id" && req.agentName === "opencode") {
    const dbPath = getAgentDataPath("opencode", "db", req.agentPaths);
    const driver = req.sqliteDriver ?? defaultSqliteDriver;
    const reason = validateOpenCodeDb(dbPath, req.session.id, driver);
    if (!reason) {
      return new OpenCodeDbReader(
        dbPath!,
        req.session.id,
        driver,
        req.logger,
        req.paneId,
        req.opencodeReadOptions,
      );
    }
    req.logger.warn("structured source unavailable; falling back to scrape", {
      paneId: req.paneId,
      agent: req.agentName,
      reason,
    });
  }

  return new ScrapeReader(req.paneId, req.readPane);
}
