# Configuration

`~/.config/herdr-slack/config.toml` (or the directory `HERDR_SLACK_CONFIG_DIR`
names).

## Minimal config

```toml
[slack]
bot_token = "xoxb-…"
app_token = "xapp-…"
allowed_user_ids = ["U…"]
```

## Full reference

```toml
[slack]                       # one bot; or several, each as [slack.<name>]
bot_token = "xoxb-..."        # Bot User OAuth Token
app_token = "xapp-..."        # App-Level Token with connections:write
allowed_user_ids = ["U…"]     # Slack user ids allowed to drive this bot
spawn_agent = "codex"         # what !spawn starts for this bot (default codex)
spawn_args = ["--yolo"]       # handed to that agent (default none)
default_pane = "server-local" # pane (label or id) a thread with no binding for
                              # this bot is bound to when spoken to
# concierge_pane = "w9:p2"    # optional existing, idle, unbound classifier pane
concierge_recent_context = false # separate opt-in for bounded task-text matching
channel_pane = "fresh"        # "shared" (default): channel threads use default_pane
                              # "fresh": each channel thread gets a pane of its own
spawn_cwd = "~"               # where such a pane starts (default: home)
idle_close_minutes = 120      # close a pane the bridge opened after this long
                              # without a message (0 = never)
role = "…"                    # what this bot is FOR, told to its pane with the
                              # first prompt of every thread
mark_working = "loading"      # reaction while the pane works (default ⏳);
mark_done = "white_check_mark"  # and once the answer is up (default ✅).
                              # A custom emoji name works; one the workspace
                              # does not have falls back to the default.
max_handoffs = 20             # bot-to-bot handoffs allowed in a thread with
                              # nobody else speaking, before one is held (0 = no limit)
relay_terminal_turns = true   # deliver turns started in the pane itself

# --- Turn machinery (in any [slack…] section) ---
progress_interval_ms = 15000  # how often the pane is polled during a turn
stability_window_ms = 30000   # fallback: min ms output must stay unchanged
                              # before a turn is declared final
max_total_wait_s = 1800       # ceiling on one observe loop

[slack.channels]              # per channel, the pane its threads use — see below
"#legal-bot-test" = "develop-legal-bot"
C07UN4GG3PE = "planner-harness"

[agents.opencode]             # per-agent data paths, when not at the default
# db = "/path/to/opencode.db"
```

## Options in detail

### [slack.<name>] — several bots

One daemon can run several Slack apps: give each its own section, named.

```toml
[slack.shaka]
bot_token = "xoxb-…"
app_token = "xapp-…"
allowed_user_ids = ["UHXM7NPPW"]
default_pane = "server-local"
channel_pane = "fresh"
spawn_agent = "claude"
role = "You answer questions, plan and review. You do not write code yourself: coding goes to lilith, with a clear brief, and you review the result."

[slack.lilith]
bot_token = "xoxb-…"
app_token = "xapp-…"
allowed_user_ids = ["UHXM7NPPW"]
spawn_agent = "codex"
spawn_args = ["--yolo"]
role = "You implement what shaka briefs, in the project you were opened in, and report back to shaka when done."
```

Each bot keeps its own bindings, and a channel thread can hold one binding
per bot; a message there is for whichever bot it names. The name is also how
the bots address each other — a line of Shaka's
answer that starts with `@lilith` goes to Lilith's pane — and the name of a
bare `[slack]` is `default`. See [the commands guide](./commands.md#two-bots-in-one-thread)
for how a handoff works and what `!spawn` does with `spawn_agent` and
`spawn_args`.

Bindings saved by a single-bot install belong to the first section on
upgrade.

### default_pane

The pane a bot binds a thread to on its own, when spoken to in a thread it
has no binding for — a new DM thread, a mention in a channel. That binding
is silent: only the answer appears. Without a default such a thread is told
to `!bind` first. The pane can then move the thread
itself: see [moving a thread](./commands.md#a-pane-that-moves-its-own-thread).

### concierge_pane — read-only prototype

Disabled by default. Set this per bot to an **existing** live pane ID (preferred),
agent name or unique tab label. The pane must be idle/done, unbound to all work
threads, and have a known Pi/OMP, Codex or Claude JSONL session. Missing or
unsupported readers do not fall back to terminal scrollback. An explicit,
nonempty `allowed_user_ids` list is required for concierge requests.

The bridge sends only the explicitly addressed question, asking the pane for
one read-only `list`, `find` or `inspect` proposal. It validates that proposal
and queries live metadata itself; it does not forward thread history, model
prose, file requests or bot handoffs. Requester, bot and reply thread come from
Slack callbacks, not model fields. Ordinary work still uses its existing binding.

#### concierge_recent_context

Off by default, independently per bot. Set `concierge_recent_context = true`
only if the bot's allowed users may discover task keywords in local **unbound**
agent sessions and sessions bound exclusively to this bot and requesting thread.
Panes bound to any other thread or bot are never read, even if their metadata is
visible. A pane configured as another bot's default/channel target still counts
as unbound until an actual thread binding exists. All configured classifier
panes are excluded.

For `find` requests without a complete metadata match, the host checks at most
eight eligible candidates, preferring partial metadata matches. With no metadata
matches it checks up to eight eligible live panes; this is not exhaustive search.
It reads at most the last 64 KiB of each current Pi/OMP, Codex or Claude JSONL
session, keeping six recent user/assistant text messages, at most 2k characters
per message. Tool payloads, reasoning, system records, archived sessions,
terminal scrollback and Slack history are excluded. Missing/unsupported or
changed sessions supply no evidence. A five-second deadline is checked between
lookup operations; no additional context reads start after it. Filesystem reads
and session-ID path lookup are synchronous and cannot be interrupted, so an
operation already in progress can exceed that deadline.

Task text stays in the host's request memory: it is not sent to the classifier,
posted to Slack, logged or persisted. Only the **query keywords** that matched
are shown, labelled as task-text evidence. This can reveal that an allowed local
session mentions a keyword; it is not a confirmed summary of its current work.
Old topics outside the bounded window may not be found. Disabling this option
retains metadata-only discovery. Restart the daemon after changing configuration.

Only one management request may use a pane at once, even across bots. Busy
requests are rejected, not queued. The classification wait is capped at 90
seconds. Its observer polls at most two seconds apart and settles for at most
five seconds, independently of slower work-message settings; a working agent
still prevents settling. Timeouts/shutdown stop observation, not the external agent. Outstanding
concierge requests are not recovered across daemon restarts: retry explicitly.
The bridge never launches a missing concierge or changes a binding for discovery.
Configured concierge panes are excluded from automatic idle-pane reuse and from
concierge discovery results, including those configured for other bots. `!panes`
still shows the full inventory; explicit manual binding is unchanged.

**This is not a sandbox.** The existing CLI agent retains its own tools,
credentials, extensions and conversation history. “Do not use tools” is a prompt,
not an enforced restriction. Use only a trusted operator-controlled pane for UX
experiments; this is not a production security boundary or an untrusted-user
service. Keep it separate from ongoing work, and do not type into it during a
request. A future restricted runtime needs a separately enforced tool policy.

See [concierge addressing](./commands.md#read-only-concierge-prototype) for examples.

### role

A sentence or two on what the bot is for, carried to its pane with the first
prompt of every thread, next to the bridge note. The note says what a bot
*can* do — hand work to another, move a thread; the role says what it
*should*. Without it a capable agent does the work itself, which is what
agents do; with "coding goes to lilith" the planner hands over. Each bot's
role is also shown to the others, so a planner knows what the coder is for.

### [slack.<name>.channels] — a pane per channel

A channel that is about one project can go straight to that project's pane,
no `!bind`, whatever `channel_pane` says for the rest:

```toml
[slack.shaka.channels]
"#legal-bot-test" = "develop-legal-bot"   # by name (quoted: TOML keys with # need it)
C07UN4GG3PE = "planner-harness"           # or by id, from the channel's URL
```

Every thread in that channel shares the pane, the way DM threads share
`default_pane`; the answer goes to the thread that asked. The lookup happens
before `channel_pane` decides between the default pane and a fresh one, so a
channel not in the table behaves as before. Matching by name needs the
`channels:read` scope (`groups:read` for private channels); without it, ids
still work and the log says so. A pane the table names that herdr does not
list is reported in the thread.

### channel_pane

One pane shared by every thread is one context shared by every thread: two
threads asking at once land in one turn, and each thread's agent remembers
the other's conversation. `channel_pane = "fresh"` gives every channel
thread a pane of its own instead — opened when the thread first speaks to
the bot (the bot's `spawn_agent`, in `spawn_cwd`), bound silently, labelled
after the question. The DM keeps using `default_pane`: one person, one
conversation at a time.

Such panes are closed after `idle_close_minutes` without a message (never
while working). Mentioning the bot in that thread again opens a fresh one,
and it starts with the thread's history, so nothing said there is lost —
only the agent's scratch memory, which is the point.

### relay_terminal_turns

Whether a turn that started **in the pane itself** is delivered to the
thread. Default: `true`.

With this on, every bound pane is polled for herdr's `agent_status`. A pane
that goes from anything else to `working` has started a turn, and the bridge
attaches its ordinary observe loop — without sending any input, because the
prompt has already been submitted. The question is quoted ("⌨️ Asked in the
terminal: …"), then the same one formatted answer per turn as always.

Set it to `false` to keep the terminal private: only questions asked from
Slack — and handoffs between bots — are answered there. It is one setting for
the whole daemon, not per bot. `HERDR_SLACK_RELAY_TERMINAL_TURNS=false`
overrides the file.

### max_total_wait_s

Ceiling on a single observe loop, in seconds. Default: `1800` (30 minutes).

It exists because the idle gate cannot close while herdr reports the pane
working, so without a ceiling a loop has no guaranteed end. It is **not** a
limit on how long an agent may take: when the ceiling expires and herdr still
says the pane is working, the turn continues under a fresh loop and nothing is
reported. The `typing…` indicator runs off herdr's status, so it stays on
across that seam.

The trade-off is deliberate. A pane whose status is stuck at `working` will be
watched indefinitely rather than given up on — visibly, because the indicator
keeps running, and `/stop` ends it.

### progress_interval_ms

Controls how often the shared turn coordinator asks the selected agent wrapper for its status. Default: `15000` (15 seconds). Under `output_mode = "stream"` each poll with no new output also sends one neutral `⏳ Working` message; under the default `"final"` the poll is silent.

This applies equally to Codex JSONL, Pi/OMP JSONL, and screen-scraped agents. Lower values give more frequent updates but can clutter the chat.

### stability_window_ms

The minimum time in milliseconds selected output must remain unchanged before ordinary polling considers the response final. Default: `30000` (30 seconds). This applies to session-log readers as well as screen scraping; a reported busy agent still prevents idle completion.

In `"final"` mode, an eligible new chat request can bypass this window on the next poll when fresh Herdr completion metadata agrees with a complete answer anchored to that request and session. Pi/OMP JSONL readers currently provide this readiness proof. Unsupported metadata/readers, coalesced inputs, recovered or externally adopted turns, and uncertain evidence retain ordinary settling. Follow deadlines and stop/ceiling behavior are unchanged; there are no event-driven wakeups yet.

Independent from `progress_interval_ms`, so polling cadence and stability can be tuned separately. Increase this window if fallback responses are truncated; decrease it for snappier fallback handoffs.

## Environment variables

| Variable | Overrides config.toml |
|---|---|
| `HERDR_SLACK_BOT_TOKEN` | `[slack] bot_token` |
| `HERDR_SLACK_APP_TOKEN` | `[slack] app_token` |
| `HERDR_SLACK_ALLOWED_USER_IDS` | `[slack] allowed_user_ids` |
| `HERDR_SLACK_OUTPUT_MODE` | `output_mode` |
| `HERDR_SLACK_RELAY_TERMINAL_TURNS` | `relay_terminal_turns` |
| `HERDR_SLACK_CONFIG_DIR` | directory holding config.toml |
| `HERDR_SLACK_STATE_DIR` | directory holding state.json |

The token variables address the first bot in the file.
