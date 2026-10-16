import type { AgentSessionRef, SqliteDriver, OpenCodeReadOptions } from "../agent-sessions.js";
import type { Logger } from "../logger.js";

export interface CompletedReaderTurn {
  prompt: string;
  text: string;
}

export interface AgentOutputReader {
  readonly kind: string;
  /** False while a deferred source is unresolved, not merely empty. Omitted means ready. */
  readonly ready?: boolean;
  /** The session actually selected by a deferred structured reader, if resolved. */
  readonly session?: AgentSessionRef;
  read(maxLines: number): string;
  /** One parsed snapshot and all output since the earliest pending submitted prompt; null if absent. */
  readSincePrompts?(prompts: readonly string[]): { snapshot: string; text: string } | null;
  /**
   * The question the agent is answering, or answered last. Only a source
   * that logs the user's side can offer it; a screen has its own extraction.
   */
  lastPrompt?(): string;
  /** The answer to that question alone, rather than the cumulative log. */
  lastAnswer?(): string;
  /** Capture an append-only boundary; when supplied, the expected session must
   *  match this reader's actual source or capture returns null. */
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

export interface AgentReaderRequest {
  paneId: string;
  agentName: string;
  session: AgentSessionRef;
  /**
   * Ask herdr for the session again. A pane just started has no session
   * yet — Codex gets one with its first prompt — and a reader chosen then
   * would be the screen for good. Given this, the choice can wait.
   */
  resolveSession?: () => AgentSessionRef;
  readPane: (paneId: string, lines: number) => string;
  agentPaths?: Record<string, Record<string, string>>;
  opencodeReadOptions?: OpenCodeReadOptions;
  sqliteDriver?: SqliteDriver;
  logger: Logger;
}
