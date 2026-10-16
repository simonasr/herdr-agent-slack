/**
 * The Slack bridge: threads on one side, herdr panes on the other, and the
 * turn machinery — `PaneAgent`, the observe loop, the pane readers — between
 * them. The app cannot open a thread; a person does, or a message starts one
 * under itself, and the bridge binds it to a pane.
 *
 * A thread is addressed by `channel:thread_ts`. The address works the same
 * for a thread in the app's DM and for one in a channel: a mention of the app
 * in a channel opens the latter, and `!bind` there binds it like any other.
 * In a channel every message for the bridge names its bot — the rest is
 * people talking; in the DM everything is for the bot, and `# ` marks an
 * aside.
 *
 * One daemon can drive several bots (`[slack.shaka]`, `[slack.lilith]`), each
 * with its own Socket Mode connection and its own bindings. In a channel
 * thread they can share the conversation: a line of one bot's answer that
 * starts with `@lilith` is handed to Lilith's pane, so a planner can brief a
 * coder in the open, and `@lilith !spawn` has the bridge open the coder's
 * pane first. The bridge routes text; it never reads it.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig, type Config, type SlackBotConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { SlackClient, isDirectMessage, type SlackThread, type ThreadMessage } from "./slack-client.js";
import { formatForSlack } from "./slack-format.js";
import { cleanPaneDelta, cleanPaneOutput, stripStatusBar } from "./output-format.js";
import { createAgentCommunicator, findClaudeSessionByPrompt } from "./agent-sessions.js";
import { closeTab, createTab, getAgents, getAgentInfo, getAgentInfoAsync, readPane, renameAgent, renameTab, sendKeys, startAgent } from "./herdr-client.js";
import type { AgentSessionRef } from "./herdr-client.js";
import { PaneAgent } from "./pane-agent.js";
import { PaneWatcher } from "./turn/pane-watcher.js";
import { PendingTurnLog } from "./turn/pending-turns.js";
import type { OutputEvent } from "./turn/observe-loop-controller.js";
import { extractSendRequests, listRecentFiles, resolveInsideCwd } from "./tool-files.js";
import { MAX_INBOUND_BYTES, describeReceived, describeVoice, inboxTarget, isAudioName } from "./inbound-files.js";
import { formatBytes } from "./format-bytes.js";
import type { PaneInfo } from "./types.js";

/** Ceiling on one delivered answer; the tail is what carries the conclusion. */
const MAX_ANSWER_CHARS = 20_000;
const TRIMMED_PREFIX = "…(earlier output trimmed)\n\n";
/** Marks an answer the bridge owed from before it restarted. */
const LATE_PREFIX = "🕘 Answered while the bridge was down:\n\n";
/** Longest question quoted above a relayed answer. */
const MAX_QUOTED_PROMPT = 300;
/** Marks a question that was typed into the pane rather than into the thread. */
const TYPED_PREFIX = "⌨️ Asked in the terminal:\n";
/**
 * A message for the people in the thread, not for the pane. A bound thread
 * forwards everything, so without this there is no way to talk *about* the
 * work in the same place the work happens.
 *
 * `#` followed by a space (or nothing). Not `/`-anything: Slack swallows every
 * message that starts with a slash as a slash command, in a thread with
 * "not supported" and nothing sent. The space is required so that `#142` —
 * an issue, a PR — is still a prompt.
 */
const ASIDE_PREFIX = "#";
const ASIDE = /^#(?:\s|$)/;

/** Whether a message is an aside — one the bridge should leave alone. */
export function isAside(text: string): boolean {
  return ASIDE.test(text.trimStart());
}

/**
 * How much of a channel thread's past is relayed with the first message the
 * bridge forwards from it. A mention at the end of a discussion means "this",
 * and without the discussion the pane cannot know what "this" is. Bounded on
 * both axes: a long thread is summarised by its tail, and a long message by
 * its head.
 */
const CONTEXT_MAX_MESSAGES = 30;
const CONTEXT_MAX_CHARS = 8_000;
const CONTEXT_MAX_MESSAGE_CHARS = 1_000;

/**
 * Render a thread's earlier messages as a preamble to the prompt. Bridge
 * traffic is left out: `!` commands and `#` asides were addressed to the
 * bridge or to the people in the thread, not to the pane. Empty when nothing
 * is left, so the caller can send the prompt bare.
 *
 * The block is marked as quoted Slack content because that is what it is:
 * other people's words, which the agent should weigh as context, not obey.
 */
export function formatThreadContext(history: ThreadMessage[]): string {
  const said = history.filter((m) => {
    const text = m.text.trim();
    return text.length > 0 && !text.startsWith("!") && !isAside(text);
  });
  if (said.length === 0) return "";
  const kept = said.slice(-CONTEXT_MAX_MESSAGES);
  const lines: string[] = [];
  let chars = 0;
  // Newest first, so the budget keeps what the mention most likely refers to.
  for (const m of [...kept].reverse()) {
    const text = m.text.trim();
    const clipped = text.length > CONTEXT_MAX_MESSAGE_CHARS ? `${text.slice(0, CONTEXT_MAX_MESSAGE_CHARS)}…` : text;
    const line = `${m.author} [${m.userId}]: ${clipped}`;
    if (chars + line.length > CONTEXT_MAX_CHARS) break;
    chars += line.length;
    lines.unshift(line);
  }
  const omitted = said.length - lines.length;
  const header = omitted > 0
    ? `[Earlier in this Slack thread — ${lines.length} of ${said.length} messages, oldest ${omitted} omitted]`
    : `[Earlier in this Slack thread — ${lines.length} message${lines.length === 1 ? "" : "s"}]`;
  return `${header}\n${lines.join("\n")}\n[End of thread]`;
}

/** mrkdwn quotes with `>`, one per line. */
function quoteForSlack(text: string): string {
  const trimmed = text.length > MAX_QUOTED_PROMPT ? `${text.slice(0, MAX_QUOTED_PROMPT)}…` : text;
  return `> ${trimmed.replace(/\n/g, "\n> ")}`;
}

/** One bot's lines addressed to another, cut out of an answer. */
export interface Handoff {
  /** The addressed bot's config name, lower case. */
  bot: string;
  /** What followed the mention, line by line, mention removed. */
  lines: string[];
}

/**
 * Cut the lines that address another bot out of an answer. A line that
 * starts with `@name` — a bot the daemon drives — is a handoff to that bot;
 * the mention stays in the posted text (rendered as a real one), and the
 * words after it go to the other bot's pane. Consecutive lines to the same
 * bot form one handoff, so a brief can run several lines. Nothing else in
 * the answer is touched: the bridge routes, it does not read.
 *
 * `resolve` maps what the agent wrote (`lilith`, `Lilith`, the Slack
 * username) to a config name, or undefined for a name that is nobody's.
 */
export function extractHandoffs(
  text: string,
  resolve: (name: string) => string | undefined,
): Handoff[] {
  const handoffs: Handoff[] = [];
  let open: Handoff | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*@([A-Za-z0-9_.-]+)\b[ \t]*:?[ \t]*(.*)$/);
    const bot = match ? resolve(match[1]) : undefined;
    if (match && bot) {
      if (!open || open.bot !== bot) {
        open = { bot, lines: [] };
        handoffs.push(open);
      }
      open.lines.push(match[2].trim());
      continue;
    }
    // A line that does not address anyone ends the brief above it.
    open = null;
  }
  return handoffs;
}

/**
 * An agent that knows Slack may write the mention Slack's own way,
 * `<@U0BTFJZLSKV>` or `<@U0BTFJZLSKV|Lilith>`, at the start of a line. That
 * is the same handoff; give it the form the extractor reads. Anything that
 * is not one of the bridge's bots is left alone.
 */
export function normalizeBotMentions(
  text: string,
  nameForUserId: (userId: string) => string | undefined,
): string {
  return text.replace(/^(\s*)<@([A-Z0-9]+)(?:\|[^>]*)?>/gm, (whole, indent: string, userId: string) => {
    const name = nameForUserId(userId);
    return name ? `${indent}@${name}` : whole;
  });
}

/**
 * Turn `@lilith` at the start of a line into the mention Slack renders, so
 * the handoff reads in the thread the way it was routed. Applied after the
 * Markdown conversion, which would otherwise escape the angle brackets.
 */
export function renderBotMentions(
  text: string,
  mentionFor: (name: string) => string | undefined,
): string {
  return text.replace(/^(\s*)@([A-Za-z0-9_.-]+)\b/gm, (whole, indent: string, name: string) => {
    const rendered = mentionFor(name);
    return rendered ? `${indent}${rendered}` : whole;
  });
}

/**
 * What Claude Code's screen says is still running in the background after
 * a turn ends — "1 shell, 1 monitor still running" on the closing line, and
 * the same on the mode row. herdr calls such a pane idle, and so it is; but
 * a shell still running is work the person is waiting for, and the mark
 * must not say it is done.
 *
 * A monitor is not work: it is a watch, and it may stand for hours — a
 * planner keeping an eye on its coder's pane. An answer given while only
 * monitors run is the answer. Empty when nothing but monitors is running, or
 * the screen is another TUI's.
 */
export function backgroundWork(screen: string): string {
  const stillRunning = screen.match(/((?:\d+ (?:shell|monitor|task|agent)s?)(?:, \d+ (?:shell|monitor|task|agent)s?)*) still running/);
  const modeRow = screen.match(/⏵⏵[^\n]*?·\s*((?:\d+ (?:shell|monitor|task)s?)(?:, \d+ (?:shell|monitor|task)s?)*)\s*·/);
  const counts = stillRunning?.[1] ?? modeRow?.[1] ?? "";
  return counts
    .split(", ")
    .filter((count) => count && !/monitor/.test(count))
    .join(", ");
}

/**
 * The one-time menu an agent can open on startup, and the option to take.
 *
 * A pane sitting at one of these is not started: herdr waits, then reports
 * the agent blocked or the wait timed out, and the thread gets nothing. The
 * answer is never simply Enter — Claude Code preselects "No, exit" on its
 * trust prompt, Codex preselects "Update now", which would run an install —
 * so each entry says which line to land on, matched on the screen.
 *
 * Returns the line to select, or "" when the screen shows no menu this
 * knows: an unknown block stays a failure rather than a guessed keypress.
 */
const STARTUP_MENUS: Array<{ shows: RegExp; choose: RegExp; what: string }> = [
  // Claude Code, in a directory it has not seen before.
  { shows: /Is this a project you created or one you trust|trust the files|Do you trust/i,
    choose: /^\s*[›❯>]?\s*(?:\d+[.)]\s*)?Yes, I trust this folder/i,
    what: "trust this folder" },
  // Codex, when a newer version is out.
  { shows: /Update available!/i,
    choose: /^\s*[›❯>]?\s*(?:\d+[.)]\s*)?Skip(?! until)/i,
    what: "skip the update" },
];

/** A line the terminal draws as selected: `❯ Yes, …`, `› 2. Skip`. */
const SELECTED = /^\s*[›❯>]\s*\S/;

/**
 * How to answer a startup menu on this screen: how many times to press Down
 * before Enter, or null when there is no menu to answer. Zero means the
 * wanted line is already selected.
 */
export function startupMenuChoice(screen: string): { downs: number; what: string } | null {
  for (const menu of STARTUP_MENUS) {
    if (!menu.shows.test(screen)) continue;
    const lines = screen.split("\n");
    const wanted = lines.findIndex((line) => menu.choose.test(line));
    if (wanted === -1) continue;
    // The options are the run of lines around the wanted one that look like
    // menu entries; the selected one carries the marker.
    const selected = lines.findIndex((line) => SELECTED.test(line));
    if (selected === -1 || selected > wanted) continue;
    return { downs: wanted - selected, what: menu.what };
  }
  return null;
}

/** How far back `!files` looks by default. */
const DEFAULT_FILE_WINDOW_MINUTES = 120;
/**
 * Most files one turn may deliver. An agent that has read untrusted content can
 * be talked into emitting send markers, so the blast radius is bounded on two
 * axes: this count, and the working-directory confinement.
 */
const MAX_SENT_FILES = 5;
/** Slack's own ceiling is far higher, but a chat is no place for a 1 GB file. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** What `!<word>` accepts, shown whenever an unknown one arrives. */
const COMMANDS = [
  "!help — this list",
  "# <text> — an aside for the thread; not sent to the pane",
  "!panes — list the panes herdr reports",
  "!tracking — every thread the bridge is bound in, and to which pane",
  "!bind <label|pane id> — bind this thread to a pane (e.g. !bind w4:p7)",
  "!spawn [dir] [agent] [-- args] — open a pane for this bot here and bind it",
  "!close — unbind, and close the tab !spawn opened for it",
  "!name <name> — rename this thread's pane (!name alone shows the current name)",
  "!unbind — release this thread's pane",
  "!last — this pane's most recent answer",
  "!files [minutes] — files changed in this pane's directory (default 120)",
  "!file <path|n> — send a file from this pane",
].join("\n");

/** One thread's binding. Persisted so a restart keeps its lanes. */
interface ThreadBinding {
  /** The bot this binding belongs to: which connection posts the answers. */
  bot: string;
  pane_id: string;
  label: string;
  agent: string;
  channel: string;
  thread_ts: string;
  /**
   * Whether the thread's earlier messages have gone to the pane. Once, per
   * binding: after the first prompt the agent holds the context itself, and
   * a rebind is a new agent that has not seen it.
   */
  context_sent?: boolean;
  /**
   * The version of the bridge note the pane has been given. A binding from
   * before the note existed, or from before it last changed, gets the
   * current one with its next prompt — without the thread's history, which
   * it has been living.
   */
  note_version?: number;
  /**
   * The tab `!spawn` opened for this binding, when it did. Only such a tab
   * may be closed from the thread: a tab a person opened is theirs.
   */
  spawned_tab?: string;
  /** When this thread last sent its pane a message (ms since epoch). */
  last_active?: number;
}

interface SlackState {
  /** Keyed by `bot|channel:thread_ts`: a thread can hold one binding per bot. */
  threads: Record<string, ThreadBinding>;
  /** Per thread, the last person who spoke — whom a bot-initiated bind greets. */
  last_user: Record<string, string>;
  /**
   * Per pane, the binding that last sent it a message. A default pane is
   * bound from every fresh thread, and its answer belongs to the thread that
   * asked — not to whichever thread bound it first. Persisted, so an answer
   * owed across a restart goes to the right thread too.
   */
  asked_from: Record<string, string>;
  /**
   * Per pane, the message that carries the ⏳ for the turn under way — the
   * question, or for a turn the pane started itself, the pane's previous
   * answer — so the mark can become ✅ when the answer lands, even after a
   * restart.
   */
  marked: Record<string, { channel: string; ts: string; name?: string }>;
  /** Per pane, the ts of its last delivered answer: what a self-started turn marks. */
  last_answer: Record<string, { channel: string; ts: string }>;
  /**
   * Per pane, a hash of the last answer delivered. What a restart finds
   * owed is compared against it: the same text was not lost, it was sent.
   */
  delivered: Record<string, string>;
  /**
   * Per binding key, the session an idle sweep closed. The next mention in
   * that thread resumes it (`claude --resume`) instead of starting cold, so
   * the conversation carries on where it stopped.
   */
  closed: Record<string, ClosedSession>;
}

interface ClosedSession {
  label: string;
  agent: string;
  dir: string;
  /** The agent's own session id, when herdr reported one. */
  session_id?: string;
  closed_at: number;
}

/** The agent's own session id from herdr's reference: an id, or a Claude transcript path `<id>.jsonl`. */
function sessionIdOf(ref: AgentSessionRef | undefined): string | undefined {
  if (!ref) return undefined;
  if (ref.kind === "id") return ref.id;
  const match = /([0-9a-f-]{36})\.jsonl$/i.exec(ref.path);
  return match?.[1];
}

/**
 * herdr's rule for an agent name: 1-32 characters, starting with a lowercase
 * letter, then lowercase letters, digits, `-` or `_`. A name built from a
 * question's first words broke `!spawn` once it ran past 32 characters
 * (`invalid_agent_name`), so every name the bridge sends goes through here.
 */
export function agentName(raw: string, fallback = "thread"): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(0, 32).replace(/[-_]+$/, "") || fallback;
}

/** Bumped when the bridge note changes, so panes that have the old one are told again. */
const NOTE_VERSION = 3;

/** The marks a workspace is sure to have, for when a configured one is not. */
const FALLBACK_WORKING = "hourglass_flowing_sand";
const FALLBACK_DONE = "white_check_mark";

const threadKey = (thread: SlackThread): string => `${thread.channel}:${thread.threadTs}`;
const bindingKey = (bot: string, thread: SlackThread): string => `${bot}|${threadKey(thread)}`;

/** One bot the daemon drives: its config and its connection. */
interface Bot {
  name: string;
  cfg: SlackBotConfig;
  client: SlackClient;
}

export interface StartSlackDaemonOptions {
  configDir?: string;
  stateDir?: string;
}

export async function startSlackDaemon(
  opts: StartSlackDaemonOptions = {},
): Promise<{ stop: () => Promise<void> }> {
  const log = createLogger("slack");
  const cfg = loadConfig(opts.configDir);
  if (cfg.slackBots.length === 0 || cfg.slackBots.some((bot) => !bot.botToken || !bot.appToken)) {
    throw new Error(
      "Slack tokens missing. Add bot_token (xoxb-) and app_token (xapp-) under [slack] in config.toml",
    );
  }

  const statePath = opts.stateDir ?? defaultSlackStateDir();
  const state = loadSlackState(statePath, log, cfg.slackBots[0].name);
  const persist = (): void => saveSlackState(statePath, state);
  // Written back at once, so a state file from before bots were named is
  // upgraded on disk and not only in memory.
  persist();

  const bots = new Map<string, Bot>();
  /** The bot a name refers to: a config name or a Slack username, any case. */
  const botNamed = (name: string): Bot | undefined => {
    const wanted = name.trim().toLowerCase();
    for (const bot of bots.values()) {
      if (bot.name === wanted || bot.client.username?.toLowerCase() === wanted) return bot;
    }
    return undefined;
  };
  const botByUserId = (userId: string): Bot | undefined =>
    [...bots.values()].find((bot) => bot.client.botUserId === userId);

  // Only an explicit allowlist gates users. The assistant container is already
  // one-to-one with a person, so this is the second layer rather than the only
  // one — but a workspace admin can install the app for others, so it stays.
  const isAllowed = (bot: Bot, userId: string): boolean =>
    bot.cfg.allowedUserIds.length === 0 || bot.cfg.allowedUserIds.includes(userId);
  for (const bot of cfg.slackBots) {
    if (bot.allowedUserIds.length === 0) {
      log.warn(
        `No allowed_user_ids for Slack bot "${bot.name}" — anyone the app is installed for can drive the agents.`,
      );
    }
  }

  const agents = new Map<string, PaneAgent>();
  let stopping = false;
  /** A reservation exists before the first asynchronous setup step. */
  const inputDispatches = new Map<string, Promise<void>>();
  const turnOwners = new Map<string, object>();
  const startingTurns = new Map<string, number>();
  /** Questions definitely not dispatched; restored entries remain owed. */
  const setupOnlyTurns = new Set<string>();
  const closePendingTurn = (paneId: string): void => {
    setupOnlyTurns.delete(paneId);
    pendingTurns.close(paneId);
  };
  /** Questions asked in a thread that have not been answered yet. */
  const pendingTurns = new PendingTurnLog(join(statePath, "pending-turns.json"), log);
  /** The bot a binding posts through. Bindings only exist for configured bots. */
  const botOf = (binding: ThreadBinding): Bot => bots.get(binding.bot) as Bot;
  /** Every binding in a thread, one per bot at most. */
  const bindingsIn = (thread: SlackThread): ThreadBinding[] =>
    Object.values(state.threads).filter(
      (b) => b.channel === thread.channel && b.thread_ts === thread.threadTs,
    );
  /** Bot-to-bot handoffs since a person last spoke, per thread. */
  const handoffsSinceHuman = new Map<string, number>();
  /**
   * The handoff the brake stopped, per thread — the latest one, since the
   * brief a planner writes last supersedes the one before. Released when a
   * person speaks in the thread, so nothing is lost to the brake, only
   * delayed until somebody has looked.
   */
  const heldHandoffs = new Map<string, { from: Bot; handoff: Handoff; fromPane?: string }>();
  /** When each pane's current turn began, for the status line's clock. */
  const turnStartedAt = new Map<string, number>();
  /**
   * ⏳ on the message a turn answers: the question, or the pane's previous
   * answer when the pane woke on its own. One mark per pane at a time.
   */
  const markWorking = async (
    bot: Bot,
    paneId: string,
    channel: string,
    ts: string,
    opts: { replace: boolean } = { replace: true },
  ): Promise<void> => {
    if (!ts) return;
    const previous = state.marked[paneId];
    if (previous && (previous.ts !== ts || previous.channel !== channel)) {
      // A question still waiting keeps its mark through the pane's own
      // continuations; only a new question takes it over.
      if (!opts.replace) return;
      await bot.client.react(previous.channel, previous.ts, previous.name ?? FALLBACK_WORKING, false);
    }
    // The configured emoji, or the one every workspace has when it is not
    // there; which one stuck is remembered so it can be taken off again.
    let name = bot.cfg.markWorking;
    if (!(await bot.client.react(channel, ts, name, true)) && name !== FALLBACK_WORKING) {
      name = FALLBACK_WORKING;
      await bot.client.react(channel, ts, name, true);
    }
    state.marked[paneId] = { channel, ts, name };
    persist();
  };

  /** The last lines of a pane's screen, without chrome, for showing what it is asking. */
  const paneTail = (paneId: string): string => {
    try {
      const lines = stripStatusBar(readPane(paneId, 30)).split("\n").map((line) => line.trimEnd()).filter((line) => line.trim());
      return lines.slice(-12).join("\n").slice(-1500);
    } catch {
      return "";
    }
  };

  /** What a pane's screen says is still running, or "" — see `backgroundWork`. */
  const backgroundOn = (paneId: string): string => {
    try {
      return backgroundWork(readPane(paneId, 12));
    } catch {
      return "";
    }
  };

  /**
   * ⏳ becomes ✅: the turn's answer is up. Unless the pane still has work
   * running in the background — then the answer was an interim one, the mark
   * stays, and the status line says what is still going.
   */
  const markDone = async (bot: Bot, paneId: string, thread: SlackThread, isCurrent: () => Promise<boolean>): Promise<void> => {
    const mark = state.marked[paneId];
    if (!mark || !await isCurrent()) return;
    const running = backgroundOn(paneId);
    if (running) {
      if (!await isCurrent()) return;
      log.info("answer delivered, but work continues in the background", { paneId, running });
      await bot.client.setStatus(thread, `has ${running} still running in the background`);
      return;
    }
    if (!await isCurrent() || state.marked[paneId] !== mark) return;
    delete state.marked[paneId];
    persist();
    await bot.client.react(mark.channel, mark.ts, mark.name ?? FALLBACK_WORKING, false);
    if (!await isCurrent()) return;
    if (!(await bot.client.react(mark.channel, mark.ts, bot.cfg.markDone, true)) && bot.cfg.markDone !== FALLBACK_DONE) {
      if (!await isCurrent()) return;
      await bot.client.react(mark.channel, mark.ts, FALLBACK_DONE, true);
    }
  };

  /** "1m 30s" — the shape a status line has room for. */
  const elapsedSince = (startedAt: number | undefined): string => {
    if (!startedAt) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  // A later asker does not retire a dispatched answer's captured binding.
  const bindingLive = (binding: ThreadBinding, owner: PaneAgent): boolean =>
    !stopping && agents.get(binding.pane_id) === owner &&
    state.threads[bindingKey(binding.bot, { channel: binding.channel, threadTs: binding.thread_ts })] === binding;
  const localOwner = (binding: ThreadBinding, owner: PaneAgent): boolean =>
    bindingLive(binding, owner) && bindingForPane(binding.pane_id) === binding;
  /** Deliver a finished turn into the thread it belongs to. */
  const deliverFinal = async (
    binding: ThreadBinding,
    event: Extract<OutputEvent, { type: "final" }>,
    owner: PaneAgent,
    note = "",
    /** Whether somebody in the thread asked for this turn, and is waiting. */
    awaited = true,
    /**
     * An answer found owed after a restart. Posted, but not acted on: the
     * handoffs in it were routed when it was first written, or were never
     * meant for now.
     */
    replay = false,
    captured: { turn: object | undefined; duringSetup: boolean; binding: ThreadBinding; dispatched?: boolean } = {
      turn: turnOwners.get(binding.pane_id), duringSetup: startingTurns.has(binding.pane_id), binding,
    },
  ): Promise<void> => {
    const paneId = binding.pane_id;
    // Session ownership allows an already-started answer to finish; only
    // captured turn ownership permits settlement of the ledger and marks.
    const isCurrent = (): boolean => !captured.duringSetup && !startingTurns.has(paneId)
      && turnOwners.get(paneId) === captured.turn && localOwner(binding, owner);
    const closeOwned = (): void => {
      if (!isCurrent()) return;
      turnStartedAt.delete(paneId);
      closePendingTurn(paneId);
    };
    // Until dispatch, missing evidence must retain the entire answer. After
    // dispatch it is only a positive contradiction that stops later operations.
    const nextOperation = async (): Promise<boolean> =>
      captured.dispatched ? bindingLive(binding, owner) : localOwner(binding, owner);
    const beginOperation = (): void => {
      if (captured.dispatched) return;
      captured.dispatched = true;
      closeOwned();
    };
    const canSettle = async (): Promise<boolean> => {
      if (!isCurrent()) return false;
      return isCurrent();
    };
    if (!await nextOperation()) return;
    const thread: SlackThread = { channel: binding.channel, threadTs: binding.thread_ts };
    if (event.duplicate) {
      beginOperation();
      log.info("suppressed a repeat of the last answer", { paneId });
      if (isCurrent()) await botOf(binding).client.setStatus(thread, "");
      return;
    }
    // Accumulated turn output has already been through the snapshot filters;
    // a raw readback has not. The model's own text needs neither.
    const cleaned = owner.verbatim
      ? event.text.trim()
      : event.source === "snapshot"
        ? cleanPaneOutput(event.text)
        : cleanPaneDelta(event.text);
    // `@@send:` lines are instructions to the bridge, not prose; they never
    // reach the chat as text.
    const { paths: requestedFiles, text: answer } = extractSendRequests(cleaned);
    const bot = botOf(binding);
    const trimmed = answer.length > MAX_ANSWER_CHARS
      ? TRIMMED_PREFIX + answer.slice(-MAX_ANSWER_CHARS)
      : answer;
    const prose = normalizeBotMentions(trimmed, (userId) => botByUserId(userId)?.name);
    // Lines addressed to another bot: posted as part of the answer, with the
    // mention rendered, and routed to that bot's pane once the answer is up.
    const handoffs = replay ? [] : extractHandoffs(prose, (name) => botNamed(name)?.name);
    const mentionFor = (name: string): string | undefined => {
      const target = botNamed(name);
      return target && target.name !== bot.name ? target.client.mention() : undefined;
    };
    const messages = formatForSlack(prose).map((m) => ({ text: renderBotMentions(m.text, mentionFor) }));
    log.info("delivering answer", {
      bot: bot.name,
      paneId: binding.pane_id,
      reason: event.reason,
      source: event.source,
      rawChars: event.text.length,
      cleanedChars: cleaned.length,
      messages: messages.length,
      handoffs: handoffs.length,
    });
    if (messages.length === 0 && requestedFiles.length === 0) {
      if (event.reason === "aborted") {
        beginOperation();
        await bot.client.post(thread, `${note}🛑 Stopped.`);
        if (isCurrent()) await markDone(bot, paneId, thread, canSettle);
        return;
      }
      // Nothing said, but the pane is stuck on a question of its own — an
      // approval, a choice — which only the terminal can answer. That is
      // worth a message; show what it is asking.
      const stuck = getAgentInfo(paneId)?.agent_status === "blocked" ? paneTail(paneId) : "";
      if (stuck) {
        beginOperation();
        await bot.client.post(
          thread,
          `${note}⚠️ *${binding.label}* is waiting for an answer in the terminal:\n\`\`\`\n${stuck}\n\`\`\``,
        );
        return;
      }
      // A turn somebody asked for owes a reply, even an empty one. A turn
      // the pane started itself — a monitor firing, a false idle in a long
      // command — owes nothing, and "Done (no output)" only reads as an
      // answer to whatever was said last.
      beginOperation();
      if (!awaited) {
        log.info("a turn of the pane's own ended with nothing to say", { paneId });
        if (isCurrent()) await bot.client.setStatus(thread, "");
        return;
      }
      await bot.client.post(thread, `${note}✅ Done (no output).`);
      if (isCurrent()) await markDone(bot, paneId, thread, canSettle);
      return;
    }
    // The question, when it was asked in the terminal and this thread never
    // saw it. mrkdwn quotes with `>`, one per line.
    const asked = event.prompt?.trim() ?? "";
    // Not twice: a question announced when the turn started is already above.
    const alreadyShown = asked.length > 0 && announcedPrompt.get(binding.pane_id) === asked;
    if (alreadyShown && isCurrent()) announcedPrompt.delete(binding.pane_id);
    const quoted = asked && !alreadyShown ? `${quoteForSlack(asked)}\n\n` : "";
    const prefix = note + quoted + (event.reason === "aborted" ? "🛑 Stopped.\n\n" : "");
    let lastTs = "";
    for (const [index, message] of messages.entries()) {
      if (index > 0 && !await nextOperation()) return;
      beginOperation();
      lastTs = await bot.client.post(thread, (index === 0 ? prefix : "") + message.text) || lastTs;
    }
    if (messages.length > 0 && isCurrent()) {
      if (lastTs) state.last_answer[paneId] = { channel: thread.channel, ts: lastTs };
      state.delivered[paneId] = digest(event.text);
      persist();
      await markDone(bot, paneId, thread, canSettle);
    }
    if (!bindingLive(binding, owner)) return;
    log.info("answer delivered", { bot: bot.name, paneId: binding.pane_id, messages: messages.length });
    // These are dispatched operations: once started, finish their files or
    // command/spawn/brief sequence rather than strand a partial side effect.
    if (requestedFiles.length > 0) {
      if (!await nextOperation()) return;
      beginOperation();
      await deliverRequestedFiles(binding, thread, requestedFiles);
    }
    if (messages.length === 0 && isCurrent() && captured.dispatched) {
      state.delivered[paneId] = digest(event.text);
      persist();
      await markDone(bot, paneId, thread, canSettle);
    }
    for (const handoff of handoffs) {
      if (!await nextOperation()) return;
      beginOperation();
      await handOff(bot, thread, handoff, paneId).catch((err) =>
        log.error("handoff failed", { from: bot.name, to: handoff.bot, message: String(err) }),
      );
    }
  };

  /**
   * Carry out one bot's lines to another. Commands (`!spawn`, `!bind …`) run
   * first, as the target, with the sender's standing in the thread; whatever
   * else was said goes to the target's pane as a prompt, framed as coming
   * from the sender so the agent knows how to answer back. Capped per thread
   * until a person speaks, because two agents can hand work to each other
   * forever.
   */
  const handOff = async (from: Bot, thread: SlackThread, handoff: Handoff, handoffFromPane?: string): Promise<void> => {
    const to = bots.get(handoff.bot);
    if (!to) return;
    const key = threadKey(thread);
    if (to.name === from.name) {
      // Addressed to itself: `!bind`, `!spawn` — the pane moving its own
      // thread. Prose to itself would only come straight back.
      for (const line of handoff.lines) {
        if (!line.startsWith("!")) continue;
        log.info("self-command", { bot: from.name, thread: key, line });
        await handleCommand(from, thread, state.threads[bindingKey(from.name, thread)], line, state.last_user[key] ?? "", from);
      }
      return;
    }
    if (isDirectMessage(thread.channel)) {
      // Another bot cannot post into this one's DM: a handoff needs a
      // channel thread both are in.
      log.warn("handoff refused in a DM", { thread: key, from: from.name, to: to.name });
      await from.client.post(
        thread,
        `Handoffs to ${to.name} only work in a channel thread both bots are in — ${to.name} cannot post here.`,
      );
      return;
    }
    const count = (handoffsSinceHuman.get(key) ?? 0) + 1;
    handoffsSinceHuman.set(key, count);
    const limit = from.cfg.maxHandoffs;
    if (limit > 0 && count > limit) {
      log.warn("handoff limit reached; holding it", { thread: key, from: from.name, to: to.name, count });
      const first = !heldHandoffs.has(key);
      heldHandoffs.set(key, { from, handoff, fromPane: handoffFromPane });
      if (first) {
        await from.client.post(
          thread,
          `⚠️ ${limit} handoffs in a row with nobody else in the thread. Holding this one for ${to.client.mention()} — say anything here and it goes through.`,
        );
      }
      return;
    }
    log.info("handoff", { thread: key, from: from.name, to: to.name, lines: handoff.lines.length, count });
    const onBehalfOf = state.last_user[key] ?? "";
    const prompt: string[] = [];
    for (const line of handoff.lines) {
      if (line.startsWith("!")) {
        await handleCommand(to, thread, state.threads[bindingKey(to.name, thread)], line, onBehalfOf, from);
      } else if (line) {
        prompt.push(line);
      }
    }
    if (prompt.length === 0) return;
    const binding = state.threads[bindingKey(to.name, thread)] ?? await autoBind(to, thread, onBehalfOf);
    if (!binding) {
      await to.client.post(
        thread,
        `${from.client.mention()} I'm not working in a pane here yet. Use \`@${to.client.username ?? to.name} !spawn\` or \`!bind <label>\` first.`,
      );
      return;
    }
    const framed =
      `[Handoff from ${from.name} in this Slack thread. To answer ${from.name}, start a line with @${from.name}.]\n\n` +
      prompt.join("\n");
    // The sender's message is what this turn answers: it carries the mark.
    await startTurn(to, binding, thread, framed, state.last_answer[handoffFromPane ?? ""]?.ts ?? "");
  };

  /**
   * Honour the `@@send:` markers an answer carried.
   *
   * Every path is re-checked rather than trusted: the agent naming it may have
   * been steered by content it read. Outcomes are always reported into the
   * thread — a file skipped in silence reads like one that was sent.
   */
  const deliverRequestedFiles = async (
    binding: ThreadBinding,
    thread: SlackThread,
    requested: string[],
  ): Promise<void> => {
    const client = botOf(binding).client;
    const cwd = getAgentInfo(binding.pane_id)?.cwd;
    if (!cwd) {
      await client.post(thread, "Could not send files: this pane has no working directory.");
      return;
    }
    const notes: string[] = [];
    for (const candidate of requested.slice(0, MAX_SENT_FILES)) {
      const verdict = resolveInsideCwd(cwd, candidate);
      if (!verdict.ok) { notes.push(`⚠️ ${candidate} — ${verdict.reason}`); continue; }
      let size: number;
      try {
        const stat = statSync(verdict.absolute);
        if (stat.isDirectory()) { notes.push(`⚠️ ${candidate} — is a directory`); continue; }
        size = stat.size;
      } catch {
        notes.push(`⚠️ ${candidate} — not found`);
        continue;
      }
      if (size === 0) { notes.push(`⚠️ ${candidate} — empty`); continue; }
      if (size > MAX_UPLOAD_BYTES) { notes.push(`⚠️ ${candidate} — too large (${formatBytes(size)})`); continue; }
      try {
        await client.upload(thread, verdict.absolute, basename(candidate), candidate);
        log.info("file sent", { paneId: binding.pane_id, file: candidate, bytes: size });
      } catch (err) {
        notes.push(`⚠️ ${candidate} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (requested.length > MAX_SENT_FILES) {
      notes.push(`⚠️ ${requested.length - MAX_SENT_FILES} more not sent — ${MAX_SENT_FILES} per turn.`);
    }
    if (notes.length) await client.post(thread, notes.join("\n"));
  };

  /** Release a cancelled turn without posting anything from its retired reader. */
  const abandonTurn = (binding: ThreadBinding): void => {
    const paneId = binding.pane_id;
    closePendingTurn(paneId);
    turnStartedAt.delete(paneId);
    announcedPrompt.delete(paneId);
    const mark = state.marked[paneId];
    delete state.marked[paneId];
    persist();
    const client = botOf(binding).client;
    void client.setStatus({ channel: binding.channel, threadTs: binding.thread_ts }, "");
    if (mark) void client.react(mark.channel, mark.ts, mark.name ?? FALLBACK_WORKING, false);
  };

  /** Lazily build the PaneAgent that owns a pane, wired to this thread. */
  const paneAgentFor = (binding: ThreadBinding): PaneAgent => {
    const existing = agents.get(binding.pane_id);
    if (existing) return existing;
    const communicator = createAgentCommunicator({
      paneId: binding.pane_id,
      getAgentInfo,
      readPane,
      agentPaths: cfg.agentPaths,
      opencodeReadOptions: {
        includeTools: cfg.opencodeIncludeTools,
        includeThoughts: cfg.opencodeIncludeThoughts,
      },
      logger: log,
    });
    // A pane still working on a question asked through the chat, found on
    // restart: its current question is the chat's own, not one typed in the
    // terminal, and must not be announced as such when the turn is adopted.
    // The communicator seals an idle pane's last question itself; a working
    // one it cannot tell apart from a terminal turn — the ledger can.
    if (pendingTurns.isOpen(binding.pane_id)) communicator.sealAnsweredPrompt();
    const agent = new PaneAgent({
      paneId: binding.pane_id,
      communicator,
      config: cfg,
      getCompletionInfo: () => getAgentInfoAsync(binding.pane_id),
      emit: (event) => {
        const paneId = binding.pane_id;
        // Snapshot the destination and turn synchronously, not after Slack yields.
        const captured = { turn: turnOwners.get(paneId), duringSetup: startingTurns.has(paneId),
          binding: bindingForPane(paneId) ?? binding };
        const valid = (): boolean => !stopping && agents.get(paneId) === agent
          && bindingForPane(paneId) === captured.binding
          && state.threads[bindingKey(captured.binding.bot, {
            channel: captured.binding.channel, threadTs: captured.binding.thread_ts,
          })] === captured.binding;
        if (!valid()) return;
        const thread: SlackThread = { channel: captured.binding.channel, threadTs: captured.binding.thread_ts };
        if (event.type !== "final") {
          const elapsed = elapsedSince(turnStartedAt.get(paneId));
          void botOf(captured.binding).client.setStatus(thread, elapsed ? `is working… (${elapsed})` : "is working…");
          return;
        }
        void deliverFinal(captured.binding, event, agent, "", pendingTurns.isOpen(paneId), false, captured)
          .catch((err) => log.error("Slack event delivery failed", { paneId, message: String(err) }));
      },
    });
    agents.set(binding.pane_id, agent);
    return agent;
  };

  /**
   * The thread a pane's answers go to: the one that last sent it a message,
   * while that binding stands; else any thread bound to it. One thread, not
   * all of them — the agent behind the pane is one conversation, and the
   * same answer in every thread would read as it talking to itself.
   */
  const bindingForPane = (paneId: string): ThreadBinding | undefined => {
    const key = state.asked_from[paneId];
    const asked = key ? state.threads[key] : undefined;
    if (asked && asked.pane_id === paneId) return asked;
    return Object.values(state.threads).find((binding) => binding.pane_id === paneId);
  };

  /**
   * Turns that started in the pane itself. Every bound pane is watched, so a
   * question typed into the terminal is answered into its thread as well,
   * under the same "is working…" line a question from the thread gets.
   * `onBoundStatus` is left unwired: the line is the indicator, and posting a
   * message every few seconds is not an indicator, it is a flood.
   */
  /** The question last announced for a pane, so the answer does not repeat it. */
  const announcedPrompt = new Map<string, string>();

  const adoptExternalTurn = (paneId: string): boolean => {
    // Slack owns setup until handleMessage starts observation with its prompt.
    if (startingTurns.has(paneId)) return false;
    const binding = bindingForPane(paneId);
    if (!binding) return false;
    const agent = paneAgentFor(binding);
    if (!agent.noteExternalTurn()) return false;
    const owner = {};
    turnOwners.set(paneId, owner);
    // Adopted means the thread is following it; losing it to a restart is
    // the same silence as losing a question asked in the thread.
    pendingTurns.open(paneId);
    setupOnlyTurns.delete(paneId);
    const thread: SlackThread = { channel: binding.channel, threadTs: binding.thread_ts };
    // Say what was asked now, rather than when the answer lands: a turn can
    // run for a quarter of an hour.
    const asked = agent.getPendingPrompt().trim();
    let announced: Promise<unknown> = Promise.resolve();
    if (asked && announcedPrompt.get(paneId) !== asked) {
      announcedPrompt.set(paneId, asked);
      announced = botOf(binding).client.post(thread, TYPED_PREFIX + quoteForSlack(asked)).catch((err) =>
        log.warn("could not announce a terminal turn", { paneId, detail: String(err) }),
      );
    }
    // Posting clears the line, so it goes up after the announcement.
    turnStartedAt.set(paneId, Date.now());
    void announced.then(async () => {
      if (agents.get(paneId) !== agent) return;
      await botOf(binding).client.setStatus(thread, "is working…");
      if (agents.get(paneId) !== agent) return;
      // Nothing was asked here; the pane picked its own work back up. The
      // previous answer is what this turn continues, so it carries the mark.
      const previous = state.last_answer[paneId];
      if (previous && previous.channel === thread.channel) {
        await markWorking(botOf(binding), paneId, previous.channel, previous.ts, { replace: false });
      }
    });
    return true;
  };

  const paneWatcher = new PaneWatcher({
    listPanes: getAgents,
    isBound: (paneId) => bindingForPane(paneId) !== undefined,
    onExternalTurn: adoptExternalTurn,
    logger: log,
  });

  /** Resolve a pane by label or id, refusing an ambiguous label. */
  const lookupPane = (arg: string, panes: PaneInfo[]): { pane: PaneInfo } | { reply: string } => {
    const needle = arg.trim().toLowerCase();
    const byId = panes.find((pane) => pane.pane_id.toLowerCase() === needle);
    if (byId) return { pane: byId };
    const byLabel = panes.filter((pane) => pane.label.toLowerCase() === needle);
    if (byLabel.length === 1) return { pane: byLabel[0] };
    if (byLabel.length > 1) {
      return { reply: `"${arg}" matches ${byLabel.length} panes. Use the pane id:\n${describePanes(byLabel)}` };
    }
    return { reply: `Pane "${arg}" not found.\n\nAvailable:\n${describePanes(panes) || "  (none)"}` };
  };

  const bind = async (
    bot: Bot,
    thread: SlackThread,
    pane: PaneInfo,
    userId: string,
    opts: { spawnedTab?: string; quiet?: boolean } = {},
  ): Promise<void> => {
    const { spawnedTab, quiet = false } = opts;
    const binding: ThreadBinding = {
      bot: bot.name,
      pane_id: pane.pane_id,
      label: pane.label,
      agent: pane.agent,
      channel: thread.channel,
      thread_ts: thread.threadTs,
      context_sent: false,
      note_version: 0,
      // Without this an untouched binding reads as "active now" forever and
      // the idle sweep never reaches it.
      last_active: Date.now(),
      ...(spawnedTab ? { spawned_tab: spawnedTab } : {}),
    };
    const previous = state.threads[bindingKey(bot.name, thread)];
    state.threads[bindingKey(bot.name, thread)] = binding;
    persist();
    // A thread that moved lets go of the pane it left, unless another
    // thread still delivers for it.
    if (previous && previous.pane_id !== pane.pane_id && !bindingForPane(previous.pane_id)) {
      agents.get(previous.pane_id)?.dispose();
      agents.delete(previous.pane_id);
      if (setupOnlyTurns.has(previous.pane_id)) abandonTurn(previous);
    }
    const cwd = getAgentInfo(pane.pane_id)?.cwd;
    await bot.client.rename(thread, cwd ? `${pane.label} · ${cwd}` : pane.label);
    // Addressed to whoever bound it: in a channel that is what makes the reply
    // read as theirs rather than the room's. Not for a binding nobody asked
    // for — the default pane answering a fresh thread — where the answer is
    // the whole point and a preamble is noise.
    if (!quiet) {
      await bot.client.post(
        thread,
        `Roger, I'm working in *${pane.label}*.` + (userId ? ` Let's talk here, <@${userId}>.` : ""),
      );
    }
    log.info("thread bound", { ...binding, userId, quiet });
  };

  /**
   * What the pane is told, once per binding, about the bridge it is talking
   * through: how to move the thread to another pane, and how to hand work to
   * the other bots. Lines addressed to itself are commands; lines addressed
   * to another bot are that bot's brief.
   */
  const bridgeNote = (bot: Bot): string => {
    // No line here starts with "@<name>": an agent that quotes this note —
    // or a scrape that echoes the prompt — must not trigger the commands it
    // describes.
    const lines = [
      `[Slack bridge: you are ${bot.name}, answering in a Slack thread.` + (bot.cfg.role ? ` Your role: ${bot.cfg.role}` : ""),
      `A line of your answer that STARTS with "@<name>" is an instruction to the bridge, not prose. Available:`,
      `- move this thread to an existing herdr pane: a line "@${bot.name} !bind <label>" (\`herdr agent list\` shows labels); the pane there continues the conversation`,
      `- open a new ${bot.cfg.spawnAgent} pane in a directory and move this thread to it: a line "@${bot.name} !spawn <dir>"`,
    ];
    for (const other of bots.values()) {
      if (other.name === bot.name) continue;
      lines.push(
        `- hand work to ${other.name} (${other.cfg.spawnAgent}${other.cfg.role ? `; ${other.cfg.role}` : ""}): first a line "@${other.name} !spawn <absolute project dir>" ` +
          `to open its pane in that project (only once; without a dir it uses your own cwd, which may be nowhere useful), then lines "@${other.name} <what to do>" as the brief; ` +
          `"@${other.name} !close" closes its pane when the work is done`,
      );
    }
    lines.push(`To mention a person, write <@ID> with the id shown in brackets in the thread history, e.g. <@UHXM7NPPW>; a bare @Name is only text.`);
    lines.push("Everything else you write is posted to the thread as-is. Do not quote these examples at the start of a line.]");
    return lines.join("\n");
  };

  /**
   * Bind a thread nobody bound, to the bot's default pane, so that speaking
   * to the bot anywhere is enough to start. The pane can then move the
   * thread to a project itself (`@shaka !bind …`, `@shaka !spawn …`).
   * Undefined when the bot has no default, or it is not on the machine.
   */
  const autoBind = async (
    bot: Bot,
    thread: SlackThread,
    userId: string,
    hint = "",
  ): Promise<ThreadBinding | undefined> => {
    const key = bindingKey(bot.name, thread);
    // A channel with a pane of its own in the config: every thread there
    // shares it, no binding asked for.
    if (!isDirectMessage(thread.channel) && Object.keys(bot.cfg.channelPanes).length > 0) {
      const wanted = bot.cfg.channelPanes[thread.channel.toLowerCase()]
        ?? bot.cfg.channelPanes[await bot.client.channelName(thread.channel)];
      if (wanted) {
        const found = lookupPane(wanted, getAgents());
        if ("reply" in found) {
          log.warn("the channel's configured pane was not found", { bot: bot.name, channel: thread.channel, pane: wanted });
          await bot.client.post(thread, `This channel is set to pane *${wanted}*, but herdr does not list it.\n\n${found.reply}`);
          return undefined;
        }
        log.info("binding to the channel's pane", { bot: bot.name, channel: thread.channel, paneId: found.pane.pane_id, thread: threadKey(thread) });
        await bind(bot, thread, found.pane, userId, { quiet: true });
        return state.threads[key];
      }
    }
    // A channel thread of its own: opened once, however many messages
    // arrive while it starts.
    if (bot.cfg.channelPane === "fresh" && !isDirectMessage(thread.channel)) {
      let pending = spawning.get(key);
      if (!pending) {
        pending = (async () => {
          const previous = state.closed[key];
          if (previous && existsSync(previous.dir)) {
            log.info("resuming the session an idle sweep closed", { bot: bot.name, thread: threadKey(thread), ...previous });
            await spawn(bot, thread, undefined, [previous.dir, previous.agent], userId, undefined, {
              fresh: true, quiet: true, label: previous.label, resumeSession: previous.session_id,
            });
            if (state.threads[key]) {
              delete state.closed[key];
              persist();
              return state.threads[key];
            }
            log.warn("could not resume the closed session; starting fresh", { bot: bot.name, thread: threadKey(thread) });
            delete state.closed[key];
            persist();
          }
          const cwd = bot.cfg.spawnCwd || homedir();
          log.info("opening a pane for this thread", { bot: bot.name, thread: threadKey(thread), cwd });
          await spawn(bot, thread, undefined, [cwd], userId, undefined, { fresh: true, quiet: true, labelHint: hint });
          return state.threads[key];
        })().finally(() => spawning.delete(key));
        spawning.set(key, pending);
      }
      return pending;
    }
    if (!bot.cfg.defaultPane) return undefined;
    const found = lookupPane(bot.cfg.defaultPane, getAgents());
    if ("reply" in found) {
      log.warn("default pane not found", { bot: bot.name, defaultPane: bot.cfg.defaultPane });
      return undefined;
    }
    log.info("binding to the default pane", { bot: bot.name, paneId: found.pane.pane_id, thread: threadKey(thread) });
    await bind(bot, thread, found.pane, userId, { quiet: true });
    return state.threads[key];
  };
  /** Per binding key, a pane being opened for that thread right now. */
  const spawning = new Map<string, Promise<ThreadBinding | undefined>>();

  /**
   * The prompt to hand the pane, with the thread's past in front of it the
   * first time a channel thread speaks to this binding. A DM thread has no
   * past worth relaying: the user opened it for the pane. A failed fetch
   * sends the prompt bare rather than not at all.
   */
  const withThreadContext = async (
    binding: ThreadBinding,
    thread: SlackThread,
    text: string,
    messageTs: string,
  ): Promise<string> => {
    const bot = botOf(binding);
    const needsNote = (binding.note_version ?? 0) < NOTE_VERSION;
    const needsHistory = !binding.context_sent;
    if (!needsNote && !needsHistory) return text;
    binding.note_version = NOTE_VERSION;
    binding.context_sent = true;
    persist();
    // The pane has to be told what a line starting with @<name> does:
    // nothing else in its world says so.
    const parts: string[] = needsNote ? [bridgeNote(bot)] : [];
    if (needsHistory && !isDirectMessage(thread.channel) && messageTs) {
      try {
        const context = formatThreadContext(await bot.client.threadHistory(thread, messageTs));
        if (context) {
          parts.push(context);
          log.info("thread context relayed", { bot: bot.name, paneId: binding.pane_id, thread: threadKey(thread), chars: context.length });
        }
      } catch (err) {
        log.warn("could not read the thread's history", { thread: threadKey(thread), message: String(err) });
      }
    }
    return parts.length ? `${parts.join("\n\n")}\n\n${text}` : text;
  };

  /** Hand a prompt to a bound pane and start watching for its answer. */
  const startTurn = async (
    bot: Bot,
    binding: ThreadBinding,
    thread: SlackThread,
    text: string,
    messageTs: string,
  ): Promise<void> => {
    const paneId = binding.pane_id;
    const owner = {};
    turnOwners.set(paneId, owner);
    // Reserve arrival order before any asynchronous Slack setup. Even a setup
    // failure must not let later inputs overtake an earlier pending dispatch.
    const previousDispatch = inputDispatches.get(paneId) ?? Promise.resolve();
    let releaseDispatch!: () => void;
    const finished = new Promise<void>(resolve => { releaseDispatch = resolve; });
    const dispatch = previousDispatch.then(() => finished);
    inputDispatches.set(paneId, dispatch);
    void dispatch.then(() => {
      if (inputDispatches.get(paneId) === dispatch) inputDispatches.delete(paneId);
    });
    startingTurns.set(paneId, (startingTurns.get(paneId) ?? 0) + 1);
    try {
      // This thread asked; the answer comes back here.
      state.asked_from[paneId] = bindingKey(bot.name, thread);
      binding.last_active = Date.now();
      persist();
      paneAgentFor(binding);
      turnStartedAt.set(paneId, Date.now());
      await bot.client.setStatus(thread, "is working…");
      await markWorking(bot, paneId, thread.channel, messageTs);
      log.info("turn started", { bot: bot.name, paneId, label: binding.label, thread: threadKey(thread) });
      if (!pendingTurns.isOpen(paneId)) setupOnlyTurns.add(paneId);
      pendingTurns.open(paneId);
      await dismissBlockingDialog(paneId);
      const framed = await withThreadContext(binding, thread, text, messageTs);
      await previousDispatch;
      let sent = false;
      if (!stopping && state.threads[bindingKey(bot.name, thread)] === binding) {
        const agent = paneAgentFor(binding);
        if (await agent.handleMessage(framed) !== false) {
          sent = true;
          setupOnlyTurns.delete(paneId);
        }
      }
      // A canceled last setup owns no future answer. Never release a later
      // question's state, or a prior dispatched/recovered debt during shutdown.
      if (!sent && (!stopping || setupOnlyTurns.has(paneId))
        && turnOwners.get(paneId) === owner && startingTurns.get(paneId) === 1) {
        abandonTurn(bindingForPane(paneId) ?? binding);
      }
    } finally {
      const remaining = (startingTurns.get(paneId) ?? 1) - 1;
      if (remaining > 0) startingTurns.set(paneId, remaining);
      else startingTurns.delete(paneId);
      releaseDispatch();
    }
  };

  /**
   * `!spawn [dir] [agent] [-- agent args]`: open a pane for this bot and bind
   * it here. Without a directory, the pane of another bot in this thread
   * says where — a planner handing to a coder means "same project". An idle
   * pane of the right kind in that directory, bound nowhere, is reused rather
   * than duplicated; otherwise a tab is opened, unfocused, in the same
   * workspace as the pane it is for, and the agent started in it.
   *
   * A bot may ask this on a person's behalf only from a thread it is bound
   * in — what an agent can start unattended (`--yolo`) is decided by whoever
   * wrote the config, not by whoever can type in a channel.
   */
  const spawn = async (
    bot: Bot,
    thread: SlackThread,
    binding: ThreadBinding | undefined,
    args: string[],
    userId: string,
    onBehalfOf?: Bot,
    opts: {
      /** Always a new pane — never pick up an idle one. */
      fresh?: boolean;
      /** Nobody asked for this pane: no "Opening…" post, no "Roger". */
      quiet?: boolean;
      /** Something recognisable for the tab label, e.g. the question's first words. */
      labelHint?: string;
      /** The exact label to use (a resumed session keeps its old name). */
      label?: string;
      /** A Claude session id to continue with `--resume` instead of starting cold. */
      resumeSession?: string;
    } = {},
  ): Promise<void> => {
    const client = bot.client;
    if (onBehalfOf && !state.threads[bindingKey(onBehalfOf.name, thread)]) {
      log.warn("spawn refused: asking bot is not bound here", { bot: bot.name, from: onBehalfOf.name });
      return;
    }
    const dashDash = args.indexOf("--");
    const positional = dashDash === -1 ? args : args.slice(0, dashDash);
    const baseArgs = dashDash === -1 ? bot.cfg.spawnArgs : args.slice(dashDash + 1);
    const kind = positional[1] ?? bot.cfg.spawnAgent;
    const agentArgs = opts.resumeSession && kind === "claude"
      ? [...baseArgs, "--resume", opts.resumeSession]
      : baseArgs;
    // Where: given, or wherever the other bot here is working.
    let dir = positional[0] ?? "";
    if (!dir) {
      const sibling = bindingsIn(thread).find((b) => b.bot !== bot.name) ?? binding;
      dir = (sibling && getAgentInfo(sibling.pane_id)?.cwd) ?? "";
    }
    if (!dir) {
      await client.post(thread, "Usage: !spawn <dir> [agent] [-- args]. Without a directory, another bot must be bound here first.");
      return;
    }
    dir = dir.replace(/^~(?=$|\/)/, homedir());
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      await client.post(thread, `Not a directory: ${dir}`);
      return;
    }
    if (binding) {
      const live = getAgentInfo(binding.pane_id);
      if (live && live.cwd === dir) {
        await client.post(thread, `Already working in *${binding.label}* here.`);
        return;
      }
    }
    // Reuse before creating: a pane of this kind, in this directory, that
    // no thread is using and nothing is running in. Not for a pane meant to
    // be this thread's own.
    const bound = new Set(Object.values(state.threads).map((b) => b.pane_id));
    const idle = opts.fresh ? undefined : getAgents().find(
      (pane) => pane.agent === kind && !bound.has(pane.pane_id) && pane.status !== "working" &&
        getAgentInfo(pane.pane_id)?.cwd === dir,
    );
    if (idle) {
      log.info("spawn: reusing an idle pane", { bot: bot.name, paneId: idle.pane_id, dir });
      await bind(bot, thread, idle, userId, { quiet: opts.quiet });
      return;
    }
    const sibling = bindingsIn(thread).find((b) => b.bot !== bot.name);
    const workspaceId = sibling ? getAgentInfo(sibling.pane_id)?.workspace_id : undefined;
    let label = agentName(opts.label ?? `${bot.name}-${opts.labelHint ? slug(opts.labelHint) : basename(dir)}`, bot.name);
    // Starting an agent takes a while; the status line says so, and the
    // bind reply that follows names the pane. A message for the wait on top
    // of both was one line too many.
    await client.setStatus(thread, "is starting a session…");
    log.info("spawn: starting", { bot: bot.name, label, kind, agentArgs, dir });
    let tab;
    try {
      tab = await createTab({ cwd: dir, label, workspaceId });
      log.info("spawn: tab created", { bot: bot.name, ...tab, dir });
      try {
        try {
          await startAgent({ paneId: tab.pane_id, kind, name: label, agentArgs });
        } catch (err) {
          // Another pane (often a finished one) already has this name: the
          // same first words asked twice. Keep the words, make the name unique.
          if (!/agent_name_taken/.test(String(err))) throw err;
          label = agentName(`${label.slice(0, 27)}-${Date.now().toString(36).slice(-4)}`, bot.name);
          log.info("spawn: name taken, retrying", { bot: bot.name, label });
          await startAgent({ paneId: tab.pane_id, kind, name: label, agentArgs });
        }
      } catch (err) {
        // An agent can open a one-time menu before its prompt — Claude Code
        // asking whether this directory is trusted, Codex offering to
        // update. herdr reports the agent blocked, or simply times out
        // waiting; either way the pane is sitting at a question the bridge
        // can answer. An unknown screen is still a failure.
        if (!/blocked during startup|timed out waiting for agent startup/.test(String(err))
          || !(await answerStartupMenu(tab.pane_id))) throw err;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("spawn failed", { bot: bot.name, dir, kind, message });
      if (tab) { try { closeTab(tab.tab_id); } catch { /* it may already be gone */ } }
      await client.post(thread, `Could not start ${kind} in ${dir}: ${message}`);
      return;
    }
    // herdr reports the pane as an agent once it has detected one; `agent
    // start` returns on readiness, so this is a short wait at most.
    let pane: PaneInfo | undefined;
    for (let attempt = 0; attempt < 10 && !pane; attempt++) {
      pane = getAgents().find((candidate) => candidate.pane_id === tab.pane_id);
      if (!pane) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!pane) {
      await client.post(thread, `${kind} started in ${dir} (pane ${tab.pane_id}) but herdr does not list it as an agent yet. Try !bind ${label} in a moment.`);
      return;
    }
    // "Ready" is herdr's word for having recognised the agent; the TUI may
    // still be drawing its banner, and text typed into it then is lost — the
    // first brief to a Codex pane went that way. Wait until the pane settles
    // at a prompt, then a little longer.
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = getAgentInfo(pane.pane_id)?.agent_status;
      if (status === "idle" || status === "done") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // Claude Code can open on a one-time dialog ("Teach auto mode about your
    // environment?"). Everything typed at it is lost and the bridge then
    // repeats the pane's last answer, so dismiss it before the first prompt.
    await dismissBlockingDialog(pane.pane_id);
    await bind(bot, thread, pane, userId, { spawnedTab: tab.tab_id, quiet: opts.quiet });
    // A resumed session already holds the thread up to where it stopped;
    // relaying the whole history again would only repeat it.
    const resumed = opts.resumeSession ? state.threads[bindingKey(bot.name, thread)] : undefined;
    if (resumed && resumed.pane_id === pane.pane_id) {
      resumed.context_sent = true;
      persist();
    }
  };

  /**
   * A pane stuck on Claude Code's trust prompt: press Enter — "Yes, proceed"
   * is selected — and wait for the agent to come up. False when the pane
   * shows something else, which is then a real failure.
   */
  const answerStartupMenu = async (paneId: string): Promise<boolean> => {
    let screen = "";
    try { screen = readPane(paneId, 40); } catch { return false; }
    const choice = startupMenuChoice(screen);
    if (!choice) return false;
    log.info("spawn: answering a startup menu", { paneId, ...choice });
    for (let i = 0; i < choice.downs; i++) {
      sendKeys(paneId, "Down");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    sendKeys(paneId, "Enter");
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const status = getAgentInfo(paneId)?.agent_status;
      if (status === "idle" || status === "done") return true;
      // One menu can follow another — trust, then a version notice.
      try {
        if (startupMenuChoice(readPane(paneId, 40))) return answerStartupMenu(paneId);
      } catch { /* the pane may be gone */ }
    }
    return false;
  };

  /**
   * Claude Code sometimes opens a one-time dialog over its prompt ("Teach
   * auto mode about your environment?") — at startup or between turns.
   * Text typed at it is lost and the bridge would repeat the pane's last
   * answer, so close it (Esc cancels it) before sending anything.
   */
  const dismissBlockingDialog = async (paneId: string): Promise<void> => {
    let screen = "";
    try { screen = readPane(paneId, 25); } catch { return; }
    // A menu the bridge knows the answer to — a version notice can appear
    // between turns too — is answered rather than cancelled.
    if (startupMenuChoice(screen)) { await answerStartupMenu(paneId); return; }
    if (!/Teach auto mode/i.test(screen)) return;
    log.info("dismissing a Claude Code dialog before sending", { paneId });
    sendKeys(paneId, "Escape");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  };

  /** A short fingerprint of an answer, for "was this already sent". */
  const digest = (text: string): string => createHash("sha1").update(text.trim()).digest("hex");

  /** A tab label from the first words of a question: `shaka-tambahin-rate-limit`. */
  const slug = (hint: string): string =>
    hint.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 4).join("-") || "thread";

  /**
   * `!close`: the opposite of `!spawn`. Unbind, and close the tab the bridge
   * opened — only that one; a tab a person opened stays theirs, and `!unbind`
   * is what to use. A pane still working is not closed either: whatever it
   * is doing would be lost, and "done" was somebody's guess.
   */
  const close = async (bot: Bot, thread: SlackThread, binding: ThreadBinding): Promise<void> => {
    const client = bot.client;
    if (!binding.spawned_tab) {
      await client.post(thread, `*${binding.label}* was not opened by me, so I will not close its tab. Use !unbind to release it.`);
      return;
    }
    if (getAgentInfo(binding.pane_id)?.agent_status === "working") {
      await client.post(thread, `*${binding.label}* is still working. Wait for it, or !stop it, then !close again.`);
      return;
    }
    const tab = binding.spawned_tab;
    await unbind(bot, thread, binding);
    // Another thread may still be talking to this pane; then it is theirs.
    const others = bindingForPane(binding.pane_id);
    if (others) {
      await client.post(thread, `Roger, I'm done here. *${binding.label}* stays open — another thread is still working in it.`);
      return;
    }
    try {
      closeTab(tab);
      log.info("tab closed", { bot: bot.name, tab, paneId: binding.pane_id });
      await client.post(thread, `Roger, *${binding.label}* is closed. !spawn opens a fresh one whenever you need it.`);
    } catch (err) {
      await client.post(thread, `Roger, I'm done in *${binding.label}* — but its tab would not close: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /** Release a binding, and the pane's agent when no other thread delivers for it. */
  const unbind = async (bot: Bot, thread: SlackThread, binding: ThreadBinding): Promise<void> => {
    delete state.threads[bindingKey(bot.name, thread)];
    persist();
    // The PaneAgent is per pane, not per thread: keep it while any other
    // thread still delivers for that pane.
    if (!bindingForPane(binding.pane_id)) {
      agents.get(binding.pane_id)?.dispose();
      agents.delete(binding.pane_id);
      if (setupOnlyTurns.has(binding.pane_id)) abandonTurn(binding);
    }
    listings.delete(bindingKey(bot.name, thread));
    log.info("thread unbound", { bot: bot.name, paneId: binding.pane_id, thread: threadKey(thread) });
  };

  /**
   * Commands use `!` — Slack's own `/` cannot be invoked inside a thread.
   * `bot` is the one addressed, which answers and is bound; `onBehalfOf` is
   * another bot when the command came out of an answer rather than from a
   * person, in which case `userId` is whoever last spoke in the thread.
   */
  const handleCommand = async (
    bot: Bot,
    thread: SlackThread,
    binding: ThreadBinding | undefined,
    text: string,
    userId: string,
    onBehalfOf?: Bot,
  ): Promise<boolean> => {
    const client = bot.client;
    const [word, ...rest] = text.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ");
    const panes = getAgents();

    if (word === "panes") {
      await client.post(thread, `Panes:\n${describePanes(panes) || "  (none)"}`);
      return true;
    }
    if (word === "tracking") {
      // Global, not per thread: the point is to find the bridge from wherever
      // the question is asked.
      const bindings = Object.values(state.threads);
      if (bindings.length === 0) {
        await client.post(thread, "Not tracking any thread yet. Use !bind <label> in one.");
        return true;
      }
      const lines: string[] = [];
      for (const b of bindings) {
        const at: SlackThread = { channel: b.channel, threadTs: b.thread_ts };
        const owner = botOf(b);
        const link = await owner.client.permalink(at);
        const where = isDirectMessage(b.channel) ? "DM" : `<#${b.channel}>`;
        const who = bots.size > 1 ? `${owner.name}: ` : "";
        const here = threadKey(at) === threadKey(thread) ? " ← this thread" : "";
        lines.push(`  • ${who}*${b.label}* (${b.agent}) — ${where}${link ? ` <${link}|thread>` : ""}${here}`);
      }
      await client.post(thread, `Tracking ${bindings.length} thread${bindings.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
      return true;
    }
    if (word === "help") {
      // Slack has no composer menu to fill: `/` commands cannot be invoked in
      // a thread at all, so the list has to be askable.
      await client.post(thread, `Commands:\n${COMMANDS}\n\nPlain text goes to this thread's pane. Answers come back here — including turns you start in the terminal.`);
      return true;
    }
    if (word === "bind") {
      if (!arg) { await client.post(thread, `Usage: !bind <label or pane id>\n\n${describePanes(panes)}`); return true; }
      const found = lookupPane(arg, panes);
      if ("reply" in found) { await client.post(thread, found.reply); return true; }
      await bind(bot, thread, found.pane, userId);
      return true;
    }
    if (word === "spawn") {
      await spawn(bot, thread, binding, rest, userId, onBehalfOf);
      return true;
    }
    if (!binding) {
      await client.post(thread, "This thread is not bound to a pane yet. Use !bind <label>.");
      return true;
    }
    const cwd = getAgentInfo(binding.pane_id)?.cwd;
    if (word === "files") {
      if (!cwd) { await client.post(thread, "Cannot determine this pane's working directory."); return true; }
      const minutes = Number(arg) > 0 ? Math.min(Number(arg), 7 * 24 * 60) : DEFAULT_FILE_WINDOW_MINUTES;
      const recent = listRecentFiles(cwd, minutes * 60_000);
      if (recent.length === 0) {
        await client.post(thread, `No files changed under ${cwd} in the last ${minutes} minutes.`);
        return true;
      }
      listings.set(bindingKey(bot.name, thread), recent.map((file) => file.relative));
      const lines = recent.map((file, i) => `  ${i + 1}. ${file.relative}  (${formatBytes(file.size)})`);
      await client.post(thread, `Changed in the last ${minutes} minutes:\n${lines.join("\n")}\n\nSend with !file <n> or !file <path>.`);
      return true;
    }
    if (word === "file") {
      if (!cwd) { await client.post(thread, "Cannot determine this pane's working directory."); return true; }
      const listed = /^\d+$/.test(arg) ? listings.get(bindingKey(bot.name, thread))?.[Number(arg) - 1] : arg;
      if (!listed) { await client.post(thread, "Usage: !file <path>, or !file <n> after !files."); return true; }
      const verdict = resolveInsideCwd(cwd, listed);
      if (!verdict.ok) { await client.post(thread, `Refused ${listed}: ${verdict.reason}.`); return true; }
      try {
        await client.upload(thread, verdict.absolute, basename(listed), listed);
      } catch (err) {
        await client.post(thread, `Could not send ${listed}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    if (word === "unbind") {
      await unbind(bot, thread, binding);
      await client.post(
        thread,
        `Roger, I'm done in *${binding.label}*. Mention me with !bind <label or pane id> whenever you need me here again.`,
      );
      return true;
    }
    if (word === "close") {
      await close(bot, thread, binding);
      return true;
    }
    if (word === "name" || word === "rename") {
      if (!arg) {
        await client.post(thread, `This thread's pane is *${binding.label}* (${binding.pane_id}). Rename it with !name <name>.`);
        return true;
      }
      const name = agentName(arg, "");
      if (!name) { await client.post(thread, "Usage: !name <name> — start with a letter; letters, digits, - and _; up to 32 characters."); return true; }
      if (name === binding.label) { await client.post(thread, `Already named *${name}*.`); return true; }
      if (panes.some((pane) => pane.label === name && pane.pane_id !== binding.pane_id)) {
        await client.post(thread, `*${name}* is already another pane's name. Pick another.`);
        return true;
      }
      try {
        renameAgent(binding.pane_id, name);
        const tabId = binding.spawned_tab ?? getAgentInfo(binding.pane_id)?.tab_id;
        if (tabId) { try { renameTab(tabId, name); } catch { /* the pane's name is what counts */ } }
      } catch (err) {
        await client.post(thread, `Could not rename *${binding.label}*: ${err instanceof Error ? err.message : String(err)}`);
        return true;
      }
      const old = binding.label;
      binding.label = name;
      persist();
      await client.rename(thread, cwd ? `${name} · ${cwd}` : name);
      log.info("pane renamed", { bot: bot.name, paneId: binding.pane_id, from: old, to: name });
      await client.post(thread, `Renamed *${old}* → *${name}*. Use !bind ${name} to come back to it from another thread.`);
      return true;
    }
    if (word === "last") {
      // Rendered like any other answer: `!last` exists to show the answer
      // again, so it should not look different from the one that was missed.
      const agent = paneAgentFor(binding);
      const raw = agent.verbatim
        ? agent.getLastAnswer().trim()
        : cleanPaneOutput(stripStatusBar(agent.getLastAnswer()));
      const body = raw.length > MAX_ANSWER_CHARS ? TRIMMED_PREFIX + raw.slice(-MAX_ANSWER_CHARS) : raw;
      const messages = formatForSlack(body);
      if (messages.length === 0) {
        await client.post(thread, "Nothing on this pane yet.");
        return true;
      }
      for (const message of messages) await client.post(thread, message.text);
      return true;
    }
    await client.post(thread, `Unknown command: !${word}\n\n${COMMANDS}`);
    return true;
  };

  /** Numbered `!files` listings, per binding, so `!file 2` means something. */
  const listings = new Map<string, string[]>();

  /**
   * A person spoke in a thread, to this bot. Remembered for a bot-initiated
   * bind to greet, and it resets the handoff count: a person is back in the
   * loop.
   */
  const noteHuman = (_bot: Bot, thread: SlackThread, userId: string): void => {
    const key = threadKey(thread);
    state.last_user[key] = userId;
    handoffsSinceHuman.delete(key);
    // Somebody has looked: what the brake held can go through now.
    const held = heldHandoffs.get(key);
    if (held) {
      heldHandoffs.delete(key);
      log.info("releasing a held handoff", { thread: key, from: held.from.name, to: held.handoff.bot });
      void handOff(held.from, thread, held.handoff, held.fromPane).catch((err) =>
        log.error("held handoff failed", { from: held.from.name, to: held.handoff.bot, message: String(err) }),
      );
    }
  };

  /** One connection per bot; the handlers close over which one it is. */
  const connect = (botCfg: SlackBotConfig): Bot => {
    const bot: Bot = {
      name: botCfg.name,
      cfg: botCfg,
      client: null as unknown as SlackClient,
    };
    const client = new SlackClient({
      name: botCfg.name,
      botToken: botCfg.botToken,
      appToken: botCfg.appToken,
      logger: log,
      isOwnBot: (userId) => botByUserId(userId) !== undefined,
      onThreadStarted: async (_thread, userId) => {
        // Nothing is posted into a new thread. Slack caps a picker at four
        // prompts — fewer panes than this machine runs — and the first message
        // to an unbound thread already answers with the full list, so the picker
        // only ever showed a truncated version of what typing gives you.
        if (!isAllowed(bot, userId)) { log.warn("thread from unauthorized user", { bot: bot.name, userId }); return; }
        log.info("assistant thread opened", { bot: bot.name, userId });
      },
      /**
       * Files shared into a thread. Each is written to the pane's `.inbox/` and
       * the agent is told the path, so reading it becomes an ordinary tool call.
       */
      onUserFiles: async (thread, userId, caption, files, messageTs) => {
        log.info("slack files", { bot: bot.name, userId, thread: threadKey(thread), count: files.length });
        if (!isAllowed(bot, userId)) { log.warn("files from unauthorized user", { bot: bot.name, userId }); return; }
        if (isAside(caption)) { log.info("aside ignored", { thread: threadKey(thread), files: files.length }); return; }
        noteHuman(bot, thread, userId);
        const binding = state.threads[bindingKey(bot.name, thread)] ?? await autoBind(bot, thread, userId);
        if (!binding) {
          await client.post(thread, "This thread is not bound to a pane yet. Use !bind <label>.");
          return;
        }
        const cwd = getAgentInfo(binding.pane_id)?.cwd;
        if (!cwd) {
          await client.post(thread, "Cannot receive files: this pane has no working directory.");
          return;
        }
        const saved: string[] = [];
        const notes: string[] = [];
        for (const file of files) {
          if (file.size > MAX_INBOUND_BYTES) {
            notes.push(`⚠️ ${file.name} — larger than the 20 MB receive limit`);
            continue;
          }
          try {
            const bytes = await client.downloadFile(file.urlPrivateDownload);
            const target = inboxTarget(cwd, file.name);
            mkdirSync(dirname(target.absolute), { recursive: true });
            writeFileSync(target.absolute, bytes);
            saved.push(target.relative);
            log.info("file received", { paneId: binding.pane_id, file: target.relative, bytes: bytes.length });
          } catch (err) {
            notes.push(`⚠️ ${file.name} — ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (notes.length) await client.post(thread, notes.join("\n"));
        if (saved.length === 0) return;
        // A lone audio clip is a voice message however Slack labels it, and it
        // carries the same instruction not to act on it unheard.
        const described = saved.length === 1 && isAudioName(saved[0])
          ? describeVoice(saved[0], undefined)
          : describeReceived(saved, caption);
        await startTurn(bot, binding, thread, described, messageTs);
      },
      onUserMessage: async (thread, userId, text, messageTs) => {
        log.info("slack message", { bot: bot.name, userId, thread: threadKey(thread), text: text.slice(0, 80) });
        if (!isAllowed(bot, userId)) { log.warn("message from unauthorized user", { bot: bot.name, userId }); return; }
        if (isAside(text)) { log.info("aside ignored", { thread: threadKey(thread) }); return; }
        noteHuman(bot, thread, userId);
        let binding: ThreadBinding | undefined = state.threads[bindingKey(bot.name, thread)];
        if (text.trim().startsWith("!")) {
          await handleCommand(bot, thread, binding, text.trim(), userId);
          return;
        }
        binding ??= await autoBind(bot, thread, userId, text);
        if (!binding) {
          // An unbound thread cannot route a question anywhere; say so rather
          // than guessing a pane.
          const panes = getAgents();
          await client.post(
            thread,
            `This thread is not bound to a pane yet.\n\n${describePanes(panes)}\n\nUse !bind <label>.`,
          );
          return;
        }
        await startTurn(bot, binding, thread, text, messageTs);
      },
    });
    bot.client = client;
    return bot;
  };
  for (const botCfg of cfg.slackBots) bots.set(botCfg.name, connect(botCfg));

  /**
   * Pay back what the previous process owed. A daemon that dies mid-turn loses
   * the answer twice: its observe loop goes with it, and this one refuses to
   * adopt a pane that is already working. These panes are the exception —
   * somebody asked in a thread and is still waiting.
   */
  const resumePendingTurns = async (): Promise<void> => {
    const owed = pendingTurns.resumable(cfg.maxTotalWaitS * 1000);
    if (owed.length === 0) return;
    let panes: PaneInfo[];
    try {
      panes = getAgents();
    } catch (err) {
      log.warn("could not list panes to resume pending turns", { message: String(err) });
      return;
    }
    const byId = new Map(panes.map((pane) => [pane.pane_id, pane]));
    for (const paneId of owed) {
      const binding = bindingForPane(paneId);
      const pane = byId.get(paneId);
      if (startingTurns.has(paneId)) continue;
      if (!binding || !pane) { closePendingTurn(paneId); continue; }
      setupOnlyTurns.delete(paneId);
      if (pane.status === "working") {
        paneAgentFor(binding).noteExternalTurn();
        log.info("resumed a turn a restart interrupted", { paneId });
        continue;
      }
      const agent = paneAgentFor(binding);
      // Only an answer, never the log: a reader that cannot cut one out
      // would hand over everything it has, and every handoff in it.
      if (!agent.canIsolateLastAnswer()) {
        log.warn("an answer is owed but the reader cannot isolate it; not replaying the log", { paneId });
        pendingTurns.close(paneId);
        continue;
      }
      const owed = agent.getLastAnswer();
      // Already sent before the restart: the ledger was simply not closed in time.
      if (!owed.trim() || state.delivered[paneId] === digest(owed)) {
        log.info("the answer owed was delivered before the restart", { paneId });
        pendingTurns.close(paneId);
        continue;
      }
      try {
        await deliverFinal(
          binding,
          { type: "final", text: owed, reason: "idle", source: "snapshot" },
          agent,
          LATE_PREFIX,
          true,
          true,
        );
        log.info("delivered an answer owed from before the restart", { paneId });
      } catch (err) {
        log.warn("could not deliver a late answer", { paneId, message: String(err) });
      }
      // A suspended replay owns its own settlement; never close a newer turn.
    }
  };

  for (const bot of bots.values()) await bot.client.start();
  if (cfg.relayTerminalTurns) paneWatcher.start();
  void resumePendingTurns().catch((err) =>
    log.error("resuming pending turns failed", { message: String(err) }),
  );
  log.info("Slack daemon started", {
    bots: [...bots.keys()],
    threads: Object.keys(state.threads).length,
    relayTerminalTurns: cfg.relayTerminalTurns,
  });

  // The socket is the only thing holding the event loop open. If it drops and
  // Bolt does not re-establish it, Node runs out of work and exits cleanly —
  // no crash, no stack, nothing in the log. That is exactly how the first run
  // of this daemon disappeared. The heartbeat keeps the loop referenced and
  // leaves a trail that distinguishes "still alive" from "gone quietly".
  const heartbeat = setInterval(
    () => log.info("alive", { threads: Object.keys(state.threads).length }),
    5 * 60_000,
  );

  /**
   * Close panes the bridge opened that nobody has spoken to for a while. A
   * thread's own pane is cheap to open again — and it comes back with the
   * thread's history — so idle ones need not be kept. Never one still
   * working, and never a tab a person opened.
   */
  const sweepIdle = async (): Promise<void> => {
    const now = Date.now();
    // A pane closed from the terminal or by hand leaves its thread bound to
    // something that no longer exists, and silent: say so there, the way an
    // idle close does, and let the binding go. Only when herdr is answering —
    // an empty list means herdr is down, not that every pane vanished.
    const live = getAgents();
    if (live.length > 0) {
      const alive = new Set(live.map((pane) => pane.pane_id));
      for (const [key, binding] of Object.entries(state.threads)) {
        if (alive.has(binding.pane_id)) continue;
        const bot = bots.get(binding.bot);
        if (!bot) continue;
        const thread: SlackThread = { channel: binding.channel, threadTs: binding.thread_ts };
        log.info("a bound pane is gone; releasing the thread", { bot: bot.name, key, paneId: binding.pane_id });
        const info = getAgentInfo(binding.pane_id);
        const dir = info?.cwd || state.closed[key]?.dir || bot.cfg.spawnCwd || "";
        state.closed[key] = {
          label: binding.label,
          agent: binding.agent,
          dir,
          session_id: sessionIdOf(info?.agent_session)
            ?? (binding.agent === "claude"
              ? findClaudeSessionByPrompt(dir, agents.get(binding.pane_id)?.sentPrompts() ?? []) ?? undefined
              : undefined)
            ?? state.closed[key]?.session_id,
          closed_at: now,
        };
        persist();
        await unbind(bot, thread, binding);
        await bot.client.post(
          thread,
          `Closed *${binding.label}*. Mention me again to pick it up where it stopped.`,
        ).catch(() => {});
      }
    }
    for (const [key, binding] of Object.entries(state.threads)) {
      const bot = bots.get(binding.bot);
      if (!bot || !bot.cfg.idleCloseMinutes) continue;
      const idleMs = now - (binding.last_active ?? now);
      if (idleMs < bot.cfg.idleCloseMinutes * 60_000) continue;
      if (getAgentInfo(binding.pane_id)?.agent_status === "working") continue;
      if (backgroundOn(binding.pane_id)) continue;
      const thread: SlackThread = { channel: binding.channel, threadTs: binding.thread_ts };
      // A pane the bridge did not open belongs to whoever did: let the thread
      // go, so the pane is free again, but never close their tab.
      if (!binding.spawned_tab) {
        log.info("releasing an idle pane the bridge did not open", { bot: bot.name, key, paneId: binding.pane_id });
        await unbind(bot, thread, binding);
        // Where a mention alone binds this thread again (a DM with a default
        // pane, a channel with one of its own, or a channel that opens a pane
        // per thread), saying "!bind" would be busywork.
        const rebinds = isDirectMessage(binding.channel)
          ? Boolean(bot.cfg.defaultPane)
          : Boolean(bot.cfg.channelPanes[binding.channel.toLowerCase()]) || bot.cfg.channelPane === "fresh";
        // The default pane is always there and a mention alone comes back to
        // it, so letting a quiet thread go is bookkeeping, not news.
        const isDefault = bot.cfg.defaultPane
          && (binding.label === bot.cfg.defaultPane || binding.pane_id === bot.cfg.defaultPane);
        if (isDefault) continue;
        await bot.client.post(
          thread,
          `Let go of *${binding.label}* after ${bot.cfg.idleCloseMinutes} minutes without a message. Its tab is untouched; `
          + (rebinds ? "just mention me again here." : `!bind ${binding.label} to come back to it.`),
        ).catch(() => {});
        continue;
      }
      log.info("closing an idle pane", { bot: bot.name, key, paneId: binding.pane_id, idleMinutes: Math.round(idleMs / 60_000) });
      const info = getAgentInfo(binding.pane_id);
      if (info?.cwd) {
        state.closed[key] = {
          label: binding.label,
          agent: binding.agent,
          dir: info.cwd,
          session_id: sessionIdOf(info.agent_session)
            ?? (info.agent === "claude"
              ? findClaudeSessionByPrompt(info.cwd, agents.get(binding.pane_id)?.sentPrompts() ?? []) ?? undefined
              : undefined),
          closed_at: now,
        };
        persist();
      }
      await unbind(bot, thread, binding);
      try {
        closeTab(binding.spawned_tab);
      } catch (err) {
        log.warn("could not close an idle tab", { tab: binding.spawned_tab, message: String(err) });
      }
      await bot.client.post(
        thread,
        `Closed *${binding.label}* after ${bot.cfg.idleCloseMinutes} minutes without a message. Mention me again to pick it up where it stopped.`,
      ).catch(() => {});
    }
  };
  const idleSweep = setInterval(() => { void sweepIdle().catch((err) => log.error("idle sweep failed", { message: String(err) })); }, 5 * 60_000);

  return {
    stop: async () => {
      stopping = true;
      for (const paneId of setupOnlyTurns) {
        const binding = bindingForPane(paneId);
        if (binding) abandonTurn(binding);
      }
      clearInterval(heartbeat);
      clearInterval(idleSweep);
      paneWatcher.stop();
      for (const agent of agents.values()) agent.dispose();
      agents.clear();
      for (const bot of bots.values()) await bot.client.stop();
    },
  };
}

function describePanes(panes: PaneInfo[]): string {
  return panes.map((pane) => `  • ${pane.label} (${pane.agent}, ${pane.pane_id})`).join("\n");
}

/** Separate from the Telegram daemon's, so both can run on one machine. */
export function defaultSlackStateDir(): string {
  return join(
    process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "state"),
    "herdr-slack",
  );
}

/**
 * Read the persisted bindings. `firstBot` names the bot a binding saved
 * before there were several belongs to — the only one there was.
 */
export function loadSlackState(stateDir: string, log: Logger, firstBot: string): SlackState {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as Partial<SlackState>;
    const threads: Record<string, ThreadBinding> = {};
    for (const [key, binding] of Object.entries(parsed.threads ?? {})) {
      // A binding saved before the thread's past was relayed has been talking
      // to its pane already; sending the history now would only repeat it.
      binding.context_sent ??= true;
      binding.bot ??= firstBot;
      binding.last_active ??= Date.now();
      // Re-key a binding from before bots were named.
      threads[key.includes("|") ? key : `${binding.bot}|${key}`] = binding;
    }
    return {
      threads,
      last_user: parsed.last_user ?? {},
      asked_from: parsed.asked_from ?? {},
      marked: parsed.marked ?? {},
      last_answer: parsed.last_answer ?? {},
      delivered: parsed.delivered ?? {},
      closed: parsed.closed ?? {},
    };
  } catch {
    log.info("no existing Slack state; starting fresh", { stateDir });
    return { threads: {}, last_user: {}, asked_from: {}, marked: {}, last_answer: {}, delivered: {}, closed: {} };
  }
}

function saveSlackState(stateDir: string, state: SlackState): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
}
