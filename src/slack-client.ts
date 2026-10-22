/**
 * Slack transport.
 *
 * Two things shape this file:
 *
 *   - **Socket Mode.** The daemon opens an outbound WebSocket instead of
 *     exposing an endpoint, so it runs on a laptop or a box behind NAT with no
 *     tunnel. That needs an app-level token (`xapp-`) as well as the bot token.
 *   - **The assistant container.** Threads are opened by the user, never by
 *     the app, so this client has no "create a place to talk" call.
 *
 * Two kinds of thread reach the bridge, and both are addressed the same way
 * (`channel` + `thread_ts`):
 *
 *   - a thread in the app's DM (the assistant container), delivered by Bolt's
 *     `Assistant` middleware — or a message typed into the DM itself, which
 *     starts a thread under itself;
 *   - a thread in a channel the app is a member of. A message that names the
 *     app is for it — outside a thread it starts one under itself, inside a
 *     thread it joins that thread — and the mention is the address, not part
 *     of the prompt. A message that names nobody is people talking: the app
 *     sees every message in every channel it belongs to, and answering what
 *     was not said to it would be noise.
 */
import bolt, { type BlockButtonAction, type types } from "@slack/bolt";
import { createReadStream } from "node:fs";
import type { Logger } from "./logger.js";

const { App, Assistant, LogLevel } = bolt;

export const BIND_PANE_ACTION = "herdr_bind_pane";
export type SlackBlock = types.KnownBlock;

/** A thread's address: Slack needs both halves to act on one. */
export interface SlackThread {
  channel: string;
  threadTs: string;
}

export interface SlackClientDeps {
  /** The bot's config name: `[slack.lilith]` → "lilith". */
  name: string;
  botToken: string;
  appToken: string;
  logger: Logger;
  /** A user opened a new assistant thread. */
  onThreadStarted: (thread: SlackThread, userId: string) => Promise<void>;
  /** A user sent a message in a thread. `messageTs` is the message's own id. */
  onUserMessage: (thread: SlackThread, userId: string, text: string, messageTs: string) => Promise<void>;
  /** A person clicked Bind in a pane listing. Value identifies the listed session. */
  onBindPane: (thread: SlackThread, userId: string, value: string) => Promise<void>;
  /** A user shared one or more files in a thread. */
  onUserFiles: (
    thread: SlackThread,
    userId: string,
    caption: string,
    files: SlackFile[],
    messageTs: string,
  ) => Promise<void>;
  /**
   * Whether a Slack user id is one of the bridge's own bots. What they post
   * is handled inside the daemon, never read back off Slack — and a message
   * that names one of them is that bot's to answer, not this one's.
   */
  isOwnBot: (userId: string) => boolean;
}

/** The shape shared by `message` and `app_mention` payloads, as far as the bridge reads them. */
interface InboundMessage {
  text?: string;
  user?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  files?: Array<{ name?: string; title?: string; size?: number; url_private_download?: string }>;
}

/** Slack channel ids say what they are: `D` is a DM, `C` public, `G` private. */
export function isDirectMessage(channel: string): boolean {
  return channel.startsWith("D");
}

/** One earlier message of a thread, as the bridge relays it. */
export interface ThreadMessage {
  /** Who wrote it: a display name when Slack will say, else the user id. */
  author: string;
  /** Their id, for a pane that wants to mention them back. */
  userId: string;
  text: string;
  ts: string;
}

/** A file attached to a Slack message. */
export interface SlackFile {
  name: string;
  size: number;
  /** Authenticated download URL — needs the bot token as a bearer header. */
  urlPrivateDownload: string;
}

/**
 * One connection to Slack, plus the handful of calls the bridge makes.
 *
 * Every method is best effort: a deleted thread or a revoked scope must
 * surface as a logged failure, never as a crashed daemon.
 */
export class SlackClient {
  private readonly app: InstanceType<typeof App>;
  private readonly logger: Logger;
  private started = false;
  /** The config name, for logs and for the others to address. */
  readonly name: string;

  constructor(private readonly deps: SlackClientDeps) {
    this.logger = deps.logger;
    this.name = deps.name;
    this.app = new App({
      token: deps.botToken,
      appToken: deps.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    const assistant = new Assistant({
      threadStarted: async ({ event }) => {
        const thread: SlackThread = {
          channel: event.assistant_thread.channel_id,
          threadTs: event.assistant_thread.thread_ts,
        };
        await this.deps.onThreadStarted(thread, event.assistant_thread.user_id);
      },
      userMessage: async ({ message }) => {
        await this.forward(message as InboundMessage);
      },
    });
    this.app.assistant(assistant);

    this.app.action<BlockButtonAction>(BIND_PANE_ACTION, async ({ ack, body, action }) => {
      // Acknowledge before any Herdr or Slack work: actions have a short deadline.
      await ack();
      if (!body.channel?.id || !body.message?.ts || !body.user.id || !action.value) return;
      if (this.deps.isOwnBot(body.user.id)) return;
      const thread = {
        channel: body.channel.id,
        // Never trust a thread address embedded in the button value.
        threadTs: body.message.thread_ts ?? body.message.ts,
      };
      await this.deps.onBindPane(thread, body.user.id, action.value);
    });

    // Messages typed into the DM itself, and channel messages that name this
    // app. Everything else in a channel is ignored — this listener sees every
    // message in every channel the app belongs to. One listener rather than
    // `app_mention` plus this: a mention arrives as both events, and a file
    // shared with a mention only as this one.
    this.app.message(async ({ message, context }) => {
      const inbound = message as InboundMessage;
      if (!inbound.channel) return;
      // Our own bots' posts are routed inside the daemon when they are made.
      if (inbound.user && this.deps.isOwnBot(inbound.user)) return;
      if (isDirectMessage(inbound.channel)) {
        // A thread in the DM is the assistant's, handled above. A message in
        // the DM's own timeline starts a thread under itself: it is
        // addressed to the app by where it was typed, no mention needed.
        if (inbound.thread_ts) return;
        await this.forward({ ...inbound, thread_ts: inbound.ts });
        return;
      }
      // A channel: the mention is the address. Outside a thread the message
      // starts one under itself, so the answer lands as a reply rather than
      // in the channel's timeline.
      const self = context.botUserId ?? this.botUserId;
      if (!self || !mentionsAny(inbound.text ?? "", (id) => id === self)) return;
      const text = stripMention(inbound.text ?? "", self);
      const hasFiles = (inbound.files ?? []).some((f) => f.url_private_download);
      await this.forward({
        ...inbound,
        thread_ts: inbound.thread_ts ?? inbound.ts,
        // A bare mention asks what the bridge can do; an empty message would
        // otherwise be sent to the pane as a turn. A bare mention on a file
        // is the file.
        text: text || (hasFiles ? "" : "!help"),
      });
    });
  }

  /**
   * Route one inbound message to the bridge. Only plain user messages carry
   * text worth forwarding; joins, edits and file-shares arrive on the same
   * event.
   */
  private async forward(message: InboundMessage): Promise<void> {
    if (!message.user) return;
    const thread: SlackThread = {
      channel: message.channel ?? "",
      threadTs: message.thread_ts ?? "",
    };
    // A share arrives with subtype "file_share" and the caption in `text`;
    // rejecting every subtype, as this used to, dropped both.
    const files = (message.files ?? [])
      .filter((f) => f.url_private_download)
      .map((f) => ({
        name: f.name ?? f.title ?? "file",
        size: f.size ?? 0,
        urlPrivateDownload: f.url_private_download as string,
      }));
    if (files.length === 0 && (message.subtype || !message.text)) return;

    const ts = message.ts ?? "";
    if (files.length > 0) {
      await this.deps.onUserFiles(thread, message.user, message.text ?? "", files, ts);
    } else {
      await this.deps.onUserMessage(thread, message.user, message.text as string, ts);
    }
  }

  /**
   * Show "<App> <status>" under the thread. Slack clears it when the app
   * posts there; pass "" to clear it when nothing will be posted. Called
   * through the Web API with the thread's address rather than through the
   * utility Bolt hands a message handler, so it works for a turn started in
   * the terminal or handed over by another bot as well as for a reply — and
   * in a channel thread, which Slack accepts for an app with assistant:write.
   */
  async setStatus(thread: SlackThread, status: string): Promise<void> {
    try {
      await this.app.client.assistant.threads.setStatus({
        channel_id: thread.channel,
        thread_ts: thread.threadTs,
        status,
      });
    } catch (err) {
      this.logger.warn("setStatus failed", { thread: `${thread.channel}:${thread.threadTs}`, message: describe(err) });
    }
  }

  /** Post one message into a thread. Returns the message's ts, or "" if Slack gave none. */
  async post(thread: SlackThread, text: string, blocks?: SlackBlock[]): Promise<string> {
    const message = { channel: thread.channel, thread_ts: thread.threadTs, text, mrkdwn: true };
    try {
      const result = await this.app.client.chat.postMessage({ ...message, ...(blocks ? { blocks } : {}) });
      return result.ts ?? "";
    } catch (err) {
      // Retry only an explicit rejection: a network timeout may have posted
      // successfully, and retrying that would duplicate the listing.
      const code = (err as { data?: { error?: string } } | null)?.data?.error;
      if (!blocks || !["invalid_blocks", "invalid_blocks_format", "invalid_arguments"].includes(code ?? "")) throw err;
      this.logger.warn("pane listing blocks failed; retrying as text", { message: describe(err) });
      const result = await this.app.client.chat.postMessage(message);
      return result.ts ?? "";
    }
  }

  /**
   * Put an emoji on a message, or take it off. Best effort, and quiet
   * about a scope the app was not given — once, so the log says why
   * nothing marks the messages.
   */
  async react(channel: string, ts: string, name: string, on: boolean): Promise<boolean> {
    if (!ts) return false;
    try {
      if (on) await this.app.client.reactions.add({ channel, timestamp: ts, name });
      else await this.app.client.reactions.remove({ channel, timestamp: ts, name });
      return true;
    } catch (err) {
      const message = describe(err);
      // Already there / already gone: nothing to do.
      if (/already_reacted|no_reaction/.test(message)) return true;
      // Not an emoji this workspace has.
      if (/invalid_name/.test(message)) return false;
      if (/missing_scope/.test(message)) {
        if (!this.warnedReactions) {
          this.warnedReactions = true;
          this.logger.warn("reactions need the reactions:write scope — re-paste slack-app-manifest.json and reinstall", { bot: this.name });
        }
        return false;
      }
      this.logger.warn("reaction failed", { bot: this.name, ts, name, on, message });
      return false;
    }
  }
  private warnedReactions = false;

  /**
   * Name the thread, so the container's timeline reads as a pane list. A
   * channel thread has no title to set; the call would only fail.
   */
  async rename(thread: SlackThread, title: string): Promise<void> {
    if (!isDirectMessage(thread.channel)) return;
    try {
      await this.app.client.assistant.threads.setTitle({
        channel_id: thread.channel,
        thread_ts: thread.threadTs,
        title,
      });
    } catch (err) {
      this.logger.warn("setTitle failed", { message: describe(err) });
    }
  }

  /**
   * Upload a local file into a thread.
   *
   * `files.upload` is retired; the supported path is to ask Slack for a
   * one-shot URL, PUT the bytes there, then complete the upload. The Node SDK
   * wraps all three in `filesUploadV2`.
   */
  async upload(thread: SlackThread, absolutePath: string, filename: string, comment?: string): Promise<void> {
    await this.app.client.filesUploadV2({
      channel_id: thread.channel,
      thread_ts: thread.threadTs,
      file: createReadStream(absolutePath),
      filename,
      initial_comment: comment,
    });
  }

  /**
   * What was said in a thread before `beforeTs`, oldest first. The app's
   * own posts are left out — they are answers the agent already gave — and so
   * is anything without text. Authors are named where `users:read` allows;
   * otherwise the id stands in.
   *
   * One page of replies: Slack hands back up to a thousand, and a thread
   * longer than that is not one anybody wants relayed.
   */
  async threadHistory(thread: SlackThread, beforeTs: string): Promise<ThreadMessage[]> {
    const result = await this.app.client.conversations.replies({
      channel: thread.channel,
      ts: thread.threadTs,
      limit: 1000,
    });
    const messages = (result.messages ?? []) as Array<{
      ts?: string;
      user?: string;
      bot_id?: string;
      subtype?: string;
      text?: string;
    }>;
    const own = this.botUserId;
    const history: ThreadMessage[] = [];
    for (const message of messages) {
      if (!message.ts || !message.user || !message.text) continue;
      if (Number(message.ts) >= Number(beforeTs)) continue;
      if (message.bot_id || (own && message.user === own)) continue;
      if (message.subtype && message.subtype !== "file_share" && message.subtype !== "thread_broadcast") continue;
      history.push({ author: await this.userName(message.user), userId: message.user, text: message.text, ts: message.ts });
    }
    return history;
  }

  /** A link to a thread, or "" when Slack will not give one. */
  async permalink(thread: SlackThread): Promise<string> {
    try {
      const result = await this.app.client.chat.getPermalink({
        channel: thread.channel,
        message_ts: thread.threadTs,
      });
      return (result.permalink as string | undefined) ?? "";
    } catch (err) {
      this.logger.warn("getPermalink failed", { thread: `${thread.channel}:${thread.threadTs}`, message: describe(err) });
      return "";
    }
  }

  /**
   * A channel's name, for matching the config's `[slack.<name>.channels]`
   * keys. Fetched once per channel; "" when Slack will not say (a missing
   * channels:read / groups:read scope), in which case only ids match.
   */
  private readonly channelNames = new Map<string, string>();

  async channelName(channelId: string): Promise<string> {
    const known = this.channelNames.get(channelId);
    if (known !== undefined) return known;
    let name = "";
    try {
      const result = await this.app.client.conversations.info({ channel: channelId });
      name = ((result.channel as { name?: string } | undefined)?.name ?? "").toLowerCase();
    } catch (err) {
      this.logger.warn("conversations.info failed; channels are matched by id only", { channelId, message: describe(err) });
    }
    this.channelNames.set(channelId, name);
    return name;
  }

  /** Display names, fetched once each. Falls back to the id when Slack will not say. */
  private readonly names = new Map<string, string>();

  async userName(userId: string): Promise<string> {
    const known = this.names.get(userId);
    if (known) return known;
    let name = userId;
    try {
      const result = await this.app.client.users.info({ user: userId });
      const user = result.user as { real_name?: string; name?: string; profile?: { display_name?: string } } | undefined;
      name = user?.profile?.display_name || user?.real_name || user?.name || userId;
    } catch (err) {
      this.logger.warn("users.info failed", { userId, message: describe(err) });
    }
    this.names.set(userId, name);
    return name;
  }

  /** The app's own user id, learned when the socket opens. */
  botUserId: string | undefined;
  /** The app's Slack username (`lilith`), learned with it. */
  username: string | undefined;

  /** How to name this bot in a message so Slack renders a real mention. */
  mention(): string {
    return this.botUserId ? `<@${this.botUserId}>` : `@${this.username ?? this.name}`;
  }

  /** Fetch a shared file. Slack's private URLs need the bot token. */
  async downloadFile(url: string): Promise<Buffer> {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.deps.botToken}` },
    });
    if (!response.ok) {
      throw new Error(`file download failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  /** Open the socket. Invalid credentials fail here, before anything else. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.app.start();
    this.started = true;
    try {
      const auth = await this.app.client.auth.test();
      this.botUserId = auth.user_id as string | undefined;
      this.username = auth.user as string | undefined;
    } catch (err) {
      this.logger.warn("auth.test failed; own posts will not be filtered from thread history", { message: describe(err) });
    }
    this.logger.info("Slack socket mode connected", { bot: this.name, userId: this.botUserId, username: this.username });
    await this.checkScopes();
  }

  /**
   * Say at startup what an app installed from an older manifest cannot do,
   * rather than let it fail in silence: a bot without channels:history sees
   * no channel message at all, and looks merely ignored. Slack lists the
   * granted scopes in a response header, which the SDK does not surface, so
   * this asks once by hand.
   */
  private async checkScopes(): Promise<void> {
    let granted: Set<string>;
    try {
      const response = await fetch("https://slack.com/api/auth.test", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.deps.botToken}` },
      });
      granted = new Set((response.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    } catch (err) {
      this.logger.warn("could not read the app's scopes", { bot: this.name, message: describe(err) });
      return;
    }
    const needed: Array<[string, string]> = [
      ["chat:write", "cannot post at all"],
      ["im:history", "will not see messages in its DM"],
      ["channels:history", "will not see messages in public channels — not even mentions"],
      ["groups:history", "will not see messages in private channels"],
      ["assistant:write", "no status line, no thread titles"],
      ["files:read", "cannot receive files"],
      ["files:write", "cannot send files"],
      ["users:read", "thread history will name people by id"],
      ["reactions:write", "no ⏳/✅ on the messages it answers"],
      ["channels:read", "[slack.<name>.channels] keys must be channel ids, not names"],
    ];
    const missing = needed.filter(([scope]) => !granted.has(scope));
    if (missing.length === 0) return;
    this.logger.warn("app is missing scopes — re-paste slack-app-manifest.json and reinstall", {
      bot: this.name,
      missing: Object.fromEntries(missing),
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.app.stop();
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether the text carries a `<@U…>` mention of a user the predicate accepts. */
export function mentionsAny(text: string, isUser: (userId: string) => boolean): boolean {
  for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (isUser(match[1])) return true;
  }
  return false;
}

/**
 * Drop the app's own mention from a message, wherever it sits. Slack renders
 * it as `<@U123>` or `<@U123|name>`; the id is all that identifies it. Line
 * breaks survive — a prompt is often more than one line — only the gap the
 * mention leaves behind is closed.
 */
export function stripMention(text: string, botUserId: string | undefined): string {
  if (!botUserId) return text.trim();
  return text
    .replace(new RegExp(`[ \\t]*<@${botUserId}(\\|[^>]*)?>[ \\t]*`, "g"), " ")
    .replace(/^ | $/gm, "")
    .trim();
}
