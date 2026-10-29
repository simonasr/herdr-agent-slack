import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * How much of an agent turn reaches the chat. The Slack bridge delivers one
 * answer per turn ("final"); the field is kept because the turn machinery
 * reads it.
 */
export type OutputMode = "final" | "stream";

/**
 * One Slack app the bridge drives. A `[slack]` section is one bot; a
 * `[slack.<name>]` section is one of several, and the name is how the others
 * hand work to it (`@lilith …` in an answer).
 */
export interface SlackBotConfig {
  /** The section name: `default` for a bare `[slack]`, else what follows the dot. */
  name: string;
  /** Slack bot token (`xoxb-`). */
  botToken: string;
  /** Slack app-level token (`xapp-`) that opens the Socket Mode connection. */
  appToken: string;
  /**
   * Slack user ids (`U…`) allowed to drive this bot. Slack ids are strings,
   * Slack ids are strings.
   */
  allowedUserIds: string[];
  /** The agent `!spawn` starts for this bot. Default "codex". */
  spawnAgent: string;
  /** Arguments handed to that agent, e.g. `["--yolo"]`. */
  spawnArgs: string[];
  /**
   * The pane (label or id) a thread with no binding for this bot is bound
   * to when someone speaks to it there. Empty means such a thread is asked
   * to `!bind` first.
   */
  defaultPane: string;
  /** Existing, unbound pane for explicit !concierge requests. Empty disables it. */
  conciergePane: string;
  /** Opt-in, bounded recent task-text matching; never searches other thread bindings. */
  conciergeRecentContext: boolean;
  /**
   * What a channel thread with no binding gets: the shared `default_pane`
   * ("shared"), or a pane of its own, opened for it ("fresh") so threads do
   * not share one context. The DM always uses the default pane.
   */
  channelPane: "shared" | "fresh";
  /** Where a fresh per-thread pane starts. Default: the home directory. */
  spawnCwd: string;
  /**
   * Minutes a pane the bridge opened may sit without a message before it
   * is closed. 0 keeps them until `!close`. Default 120.
   */
  idleCloseMinutes: number;
  /**
   * What this bot is for, in a sentence or two, told to its pane with the
   * first prompt of every thread. The bridge note says what a bot CAN do;
   * this says what it SHOULD — "you plan and review; coding goes to lilith".
   */
  role: string;
  /** The reaction while the pane works. Default the ⏳; a custom emoji name works. */
  markWorking: string;
  /** The reaction once the answer is up. Default the ✅. */
  markDone: string;
  /**
   * How many times this bot may hand work to another in one thread with no
   * person speaking in between, before the bridge holds the next one.
   * Default 20. 0 = no limit.
   */
  maxHandoffs: number;
  /**
   * Per channel, the pane a thread there is bound to without asking — the
   * `[slack.<name>.channels]` table. Keys are channel ids (`C…`) or names
   * (with or without `#`); values are pane labels or ids. Looked up before
   * `channelPane` decides between the default pane and a fresh one.
   */
  channelPanes: Record<string, string>;
}

export interface Config {
  /** Slack bot token (`xoxb-`) of the first bot. */
  slackBotToken: string;
  /** Slack app-level token (`xapp-`) of the first bot. */
  slackAppToken: string;
  /** The first bot's allowlist. See `SlackBotConfig.allowedUserIds`. */
  allowedSlackUserIds: string[];
  /** Every Slack bot configured, in file order. */
  slackBots: SlackBotConfig[];
  throttleMs: number;
  waitTimeoutS: number;
  maxTotalWaitS: number;
  /** Max Working progress updates before giving up (-1 = unlimited). Default 60. */
  maxProgressUpdates: number;
  /** How often the coordinator asks a wrapper for status. */
  progressIntervalMs: number;
  /** Min ms the pane must remain unchanged before a screen-scrape turn is
   *  declared final. Larger values tolerate herdr's idle-flicker during long
   *  tool calls. Default 30000. */
  stabilityWindowMs: number;
  /** Default minutes a /follow subscription stays alive after the last user
   *  message before expiring. 0 = no timeout, manual /unsubscribe required.
   *  Default 30. */
  followTimeoutMinutes: number;
  /** Per-agent paths to data stores. Each key is an agent name (e.g. "opencode",
   *  "codex"); value is a map from data key to path. Default paths are inferred
   *  from $HOME (e.g. ~/.local/share/opencode/opencode.db). Override per-agent
   *  paths via [agents] section in config.toml. */
  agentPaths: Record<string, Record<string, string>>;
  /** [agents.opencode] include_tools = true — surface compact tool summaries
   *  prefixed `🔧` in the cumulative snapshot. Default false. */
  opencodeIncludeTools: boolean;
  /** [agents.opencode] include_thoughts = true — surface reasoning/thinking
   *  parts prefixed `💭` in the cumulative snapshot. Default false. */
  opencodeIncludeThoughts: boolean;
  /** How much of a turn is forwarded. Default "final". */
  outputMode: OutputMode;
  /**
   * Deliver the answer to a turn that started in the pane itself, not through
   * the chat. On by default: the point of the bridge is to follow one agent
   * from either side, and without this a question typed into the terminal
   * leaves the chat with a gap it cannot even see.
   */
  relayTerminalTurns: boolean;
}

/** Parse a TOML string array (`["U1", "U2"]`) or a bare comma-separated list. */
function parseStringList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter((entry) => entry.length > 0);
}

/** Accept `true`/`false` (and the usual `1`/`0`, `yes`/`no`); else `fallback`. */
function parseBool(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return fallback;
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** Accept only the two known modes; anything else falls back to `fallback`. */
function parseOutputMode(value: string | undefined, fallback: OutputMode): OutputMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "final" || normalized === "stream" ? normalized : fallback;
}

function parseTomlLine(line: string): [string, string] | null {
  const i = line.indexOf("=");
  if (i === -1) return null;
  const key = line.slice(0, i).trim();
  let val = line.slice(i + 1).trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  return [key, val];
}

/** An environment override, `HERDR_SLACK_<NAME>`. */
function bridgeEnv(name: string): string | undefined {
  return process.env[`HERDR_SLACK_${name}`];
}

/** Where config.toml lives: `~/.config/herdr-slack`, unless told otherwise. */
export function resolveConfigDir(explicit?: string): string {
  return explicit ?? bridgeEnv("CONFIG_DIR") ?? path.join(os.homedir(), ".config", "herdr-slack");
}

export function loadConfig(configDir?: string): Config {
  const dir = resolveConfigDir(configDir);
  const filePath = path.join(dir, "config.toml");

  let fileThrottleMs = 60_000;
  let fileWaitTimeoutS = 300;
  let fileMaxTotalWaitS = 1800;
  let fileMaxProgressUpdates = 60;
  let fileProgressIntervalMs = 15_000;
  let fileStabilityWindowMs = 30_000;
  let fileFollowTimeoutMinutes = 30;
  let fileAgentPaths: Record<string, Record<string, string>> = {};
  let fileOpencodeIncludeTools = false;
  let fileOpencodeIncludeThoughts = false;
  let fileOutputMode: OutputMode = "final";
  let fileRelayTerminalTurns = true;
  const fileSlackBots: SlackBotConfig[] = [];
  // Assigned from a closure, which flow analysis cannot see; the cast keeps
  // the declared type from narrowing to `null` at every use.
  let currentSlackBot = null as SlackBotConfig | null;
  const openSlackBot = (name: string): void => {
    currentSlackBot = { name, botToken: "", appToken: "", allowedUserIds: [], spawnAgent: "codex", spawnArgs: [], defaultPane: "", conciergePane: "", conciergeRecentContext: false, channelPane: "shared", spawnCwd: "", idleCloseMinutes: 120, role: "", markWorking: "hourglass_flowing_sand", markDone: "white_check_mark", maxHandoffs: 20, channelPanes: {} };
    fileSlackBots.push(currentSlackBot);
  };

  if (fs.existsSync(filePath)) {
    const lines = fs.readFileSync(filePath, "utf8").split("\n");
    let inSlack = false;
    let inChannels = false;
    let inAgents = false;
    let currentAgent: string | null = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      if (line === "[slack]") { inSlack = true; inChannels = false; inAgents = false; openSlackBot("default"); continue; }
      // [slack.channels] or [slack.<name>.channels]: that bot's channel → pane table.
      if (/^\[slack(?:\.[^.\]]+)?\.channels\]$/.test(line)) {
        const owner = line.slice(7, -10).replace(/^\./, "").trim().toLowerCase() || "default";
        const bot = fileSlackBots.find((b) => b.name === owner);
        if (bot) currentSlackBot = bot; else openSlackBot(owner);
        inSlack = false; inChannels = true; inAgents = false;
        continue;
      }
      // e.g. [slack.lilith] — one of several bots, named for the others to address.
      if (line.startsWith("[slack.") && line.endsWith("]")) {
        inSlack = true; inChannels = false; inAgents = false;
        openSlackBot(line.slice(7, -1).trim().toLowerCase());
        continue;
      }
      if (line.startsWith("[agents.") && line.endsWith("]")) {
        // e.g. [agents.opencode]
        inSlack = false; inChannels = false;
        inAgents = true;
        currentAgent = line.slice(8, -1);
        if (!fileAgentPaths[currentAgent]) fileAgentPaths[currentAgent] = {};
        continue;
      }
      if (line === "[agents]") {
        inSlack = false; inChannels = false;
        inAgents = true;
        currentAgent = null;
        continue;
      }
      // Any other section is not this plugin's.
      if (line.startsWith("[")) { inSlack = false; inChannels = false; inAgents = false; currentAgent = null; continue; }
      const kv = parseTomlLine(line);
      if (!kv) continue;
      if (inChannels && currentSlackBot) {
        // `#legal-bot-test = "develop-legal-bot"`, or by channel id.
        const channel = kv[0].trim().replace(/^["']|["']$/g, "").replace(/^#/, "").toLowerCase();
        if (channel && kv[1].trim()) currentSlackBot.channelPanes[channel] = kv[1].trim();
        continue;
      }
      if (inSlack && currentSlackBot) {
        if (kv[0] === "bot_token") currentSlackBot.botToken = kv[1];
        else if (kv[0] === "app_token") currentSlackBot.appToken = kv[1];
        else if (kv[0] === "allowed_user_ids") currentSlackBot.allowedUserIds = parseStringList(kv[1]);
        else if (kv[0] === "spawn_agent") currentSlackBot.spawnAgent = kv[1].trim() || "codex";
        else if (kv[0] === "spawn_args") currentSlackBot.spawnArgs = parseStringList(kv[1]);
        else if (kv[0] === "default_pane") currentSlackBot.defaultPane = kv[1].trim();
        else if (kv[0] === "concierge_pane") currentSlackBot.conciergePane = kv[1].trim();
        else if (kv[0] === "concierge_recent_context") currentSlackBot.conciergeRecentContext = parseBool(kv[1], false);
        else if (kv[0] === "channel_pane") currentSlackBot.channelPane = kv[1].trim() === "fresh" ? "fresh" : "shared";
        else if (kv[0] === "spawn_cwd") currentSlackBot.spawnCwd = kv[1].trim();
        else if (kv[0] === "idle_close_minutes") currentSlackBot.idleCloseMinutes = Math.max(0, parseInt(kv[1], 10) || 0);
        else if (kv[0] === "role") currentSlackBot.role = kv[1].trim();
        else if (kv[0] === "mark_working") currentSlackBot.markWorking = kv[1].trim().replace(/^:|:$/g, "") || "hourglass_flowing_sand";
        else if (kv[0] === "mark_done") currentSlackBot.markDone = kv[1].trim().replace(/^:|:$/g, "") || "white_check_mark";
        else if (kv[0] === "max_handoffs") currentSlackBot.maxHandoffs = Math.max(0, parseInt(kv[1], 10) || 0);
        // The turn settings.
        else if (kv[0] === "progress_interval_ms") fileProgressIntervalMs = parseInt(kv[1], 10);
        else if (kv[0] === "stability_window_ms") fileStabilityWindowMs = parseInt(kv[1], 10);
        else if (kv[0] === "max_total_wait_s") fileMaxTotalWaitS = parseInt(kv[1], 10);
        else if (kv[0] === "wait_timeout_s") fileWaitTimeoutS = parseInt(kv[1], 10);
        else if (kv[0] === "max_progress_updates") fileMaxProgressUpdates = parseInt(kv[1], 10);
        else if (kv[0] === "throttle_ms") fileThrottleMs = parseInt(kv[1], 10);
        else if (kv[0] === "follow_timeout_minutes") fileFollowTimeoutMinutes = parseInt(kv[1], 10);
        else if (kv[0] === "output_mode") fileOutputMode = parseOutputMode(kv[1], fileOutputMode);
        else if (kv[0] === "relay_terminal_turns") fileRelayTerminalTurns = parseBool(kv[1], fileRelayTerminalTurns);
      } else if (inAgents && currentAgent) {
        // Per-agent data paths, e.g. db = "/path/to/db"
        if (currentAgent === "opencode") {
          if (kv[0] === "include_tools") fileOpencodeIncludeTools = kv[1] === "true";
          else if (kv[0] === "include_thoughts") fileOpencodeIncludeThoughts = kv[1] === "true";
          else fileAgentPaths[currentAgent][kv[0]] = kv[1];
        } else {
          fileAgentPaths[currentAgent][kv[0]] = kv[1];
        }
      }
    }
  }

  // Environment overrides address the first bot: a single-bot install has
  // exactly one, and that is what the variables were for. A bot given only
  // through the environment is created for them.
  if (
    fileSlackBots.length === 0 &&
    (process.env.HERDR_SLACK_BOT_TOKEN || process.env.HERDR_SLACK_APP_TOKEN)
  ) {
    openSlackBot("default");
  }
  const first = fileSlackBots[0];
  if (first) {
    if (process.env.HERDR_SLACK_BOT_TOKEN) first.botToken = process.env.HERDR_SLACK_BOT_TOKEN;
    if (process.env.HERDR_SLACK_APP_TOKEN) first.appToken = process.env.HERDR_SLACK_APP_TOKEN;
    if (process.env.HERDR_SLACK_ALLOWED_USER_IDS) {
      first.allowedUserIds = parseStringList(process.env.HERDR_SLACK_ALLOWED_USER_IDS);
    }
  }

  return {
    slackBotToken: first?.botToken ?? "",
    slackAppToken: first?.appToken ?? "",
    allowedSlackUserIds: first?.allowedUserIds ?? [],
    slackBots: fileSlackBots,
    throttleMs: fileThrottleMs,
    waitTimeoutS: fileWaitTimeoutS,
    maxTotalWaitS: fileMaxTotalWaitS,
    maxProgressUpdates: fileMaxProgressUpdates,
    progressIntervalMs: fileProgressIntervalMs,
    stabilityWindowMs: fileStabilityWindowMs,
    followTimeoutMinutes: fileFollowTimeoutMinutes,
    agentPaths: fileAgentPaths,
    opencodeIncludeTools: fileOpencodeIncludeTools,
    opencodeIncludeThoughts: fileOpencodeIncludeThoughts,
    outputMode: parseOutputMode(bridgeEnv("OUTPUT_MODE"), fileOutputMode),
    relayTerminalTurns: parseBool(bridgeEnv("RELAY_TERMINAL_TURNS"), fileRelayTerminalTurns),
  };
}
