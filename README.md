# herdr-slack

Talk to your [herdr](https://herdr.dev) agents from Slack — and let them talk
to each other.

A Slack thread is bound to a herdr pane. What you say in the thread goes to
the pane; what the agent answers comes back as one message per turn, with its
Markdown intact. Several bots can live in one daemon, each on its own Slack
app, and a line of one bot's answer that starts with `@lilith` goes to
Lilith's pane. A planner briefs a coder in the open, the coder reports back,
the planner reviews — in a thread you can read. The bridge routes text; it
never reads it. No LLM in the path.

```
you:     @Shaka tambahin rate limit di endpoint login
Shaka:   Rencana: middleware di auth/, 5 req/menit per IP, test di tests/auth.
         @lilith !spawn /home/me/Code/api
         @lilith kerjakan sesuai rencana di atas, jangan sentuh session handling.
Lilith:  Roger, I'm working in lilith-api. Let's talk here, @you.
Lilith:  Selesai. 3 file diubah, 4 test baru, semua hijau. @shaka tolong review.
Shaka:   Review: oke, satu catatan — TTL-nya hardcoded. @lilith pindahkan ke config.
Lilith:  Sudah. @shaka
Shaka:   Beres, siap di-merge. @lilith !close
```

## What it does

- **One thread, one pane.** DM the app and type; or `@Shaka …` in a channel.
  The thread is bound to a pane — a default one, a fresh one opened for the
  thread, or whichever you `!bind` — and stays bound.
- **Answers as the model wrote them.** For Claude Code and Codex the bridge
  reads the session transcript, not the terminal: bold, code blocks and tables
  survive, and Markdown tables become Slack lists. Other agents are read off
  the screen.
- **Several bots.** `[slack.shaka]`, `[slack.lilith]` — each its own Slack
  app, tokens, allowlist and role. In a channel a message is for the bot it
  names; a message that names nobody is people talking.
- **Handoffs.** `@lilith <brief>` in Shaka's answer reaches Lilith's pane;
  `@lilith !spawn <dir>` opens her a pane in that project first; `@lilith
  !close` closes it when the work is done. Eight-way ping-pong is stopped by
  a brake that holds the next handoff until a person speaks.
- **A pane that moves its own thread.** `@shaka !bind develop-legal-bot` in
  Shaka's answer sends the thread to that pane; `@shaka !spawn <dir>` opens
  a new one there.
- **Signals.** `Shaka is working… (1m 30s)` under the thread while a turn
  runs; ⏳ on the message being answered, ✅ when its answer is up — held
  while a background shell is still running; ⚠️ with the screen when a pane
  is stuck on a question only the terminal can answer.
- **Files both ways.** Share a file into a thread and the pane gets it under
  `.inbox/`; `!files`, `!file <n>` or an `@@send: path` line in an answer
  sends one back.

## Install

```bash
herdr plugin install rajapulau/herdr-agent-slack --yes
```

From a checkout:

```bash
git clone https://github.com/rajapulau/herdr-agent-slack
cd herdr-agent-slack && npm install && npm run build
herdr plugin link .
```

## The Slack app

One app per bot. **Create New App → From a manifest** with
[`slack-app-manifest.json`](slack-app-manifest.json), install it to the
workspace, and take two tokens: the **Bot User OAuth Token** (`xoxb-…`) and
an **App-Level Token** with `connections:write` (`xapp-…`). It runs on Socket
Mode, so nothing is exposed; the daemon dials out. Invite the app to every
channel it should answer in.

For an existing app, enable **Interactivity & Shortcuts → Interactivity** (or
apply the updated manifest) to receive Bind button clicks over Socket Mode.
No request URL or additional OAuth scopes are needed.

An app installed from an older manifest is told at startup which scopes it is
missing and what each one costs. Changing an app's scopes or events needs a
daemon restart.

## Configure

`~/.config/herdr-slack/config.toml`:

```toml
[slack.shaka]
bot_token = "xoxb-…"
app_token = "xapp-…"
allowed_user_ids = ["U…"]          # who may drive this bot
default_pane = "server-local"       # where a new DM thread lands
channel_pane = "fresh"              # a channel thread gets a pane of its own
spawn_agent = "claude"
role = "You answer questions, plan and review. Coding goes to lilith."

[slack.lilith]
bot_token = "xoxb-…"
app_token = "xapp-…"
allowed_user_ids = ["U…"]
spawn_agent = "codex"
spawn_args = ["--yolo"]
role = "You implement what shaka briefs, and report back to shaka."
```

One bot is enough to begin with: a single `[slack]` section holding the two
tokens. Everything else — `spawn_cwd`, `idle_close_minutes`, the ⏳/✅
emoji, `max_handoffs`, `relay_terminal_turns`, the turn timings — is in
[docs/guide/configuration.md](docs/guide/configuration.md).

## Run

```bash
node dist/index.js --daemon      # every bot in the config, one process
node dist/index.js --status
```

herdr can start it for you (`herdr plugin action herdr-slack-plugin
bootstrap`), and the plugin restarts it on a pane status change if it has
died. State lives in `~/.local/state/herdr-slack/`.

## Commands

Inside a thread, addressed to the bot (`@Shaka !panes` in a channel, plain in
the DM):

| | |
|---|---|
| `!panes` | the panes herdr reports, with inline Bind buttons |
| `!bind <label\|pane id>` | bind this thread to a pane |
| `!spawn [dir] [agent] [-- args]` | open a pane for this bot here and bind it |
| `!close` | unbind, and close the tab `!spawn` opened |
| `!unbind` | release the pane |
| `!tracking` | every thread the bridge is bound in, and where |
| `!last` | this pane's most recent answer |
| `!files [minutes]`, `!file <path\|n>` | files the pane changed; send one |
| `# <text>` | in the DM: an aside, not sent to the pane |
| `!help` | this list |

The full guide, with the handoff rules and what the pane is told about the
bridge: [docs/guide/commands.md](docs/guide/commands.md).

## How answers are read

| Agent | Source |
|---|---|
| Claude Code | its transcript under `~/.claude/projects` |
| Codex | its rollout under `~/.codex/sessions` |
| OpenCode | its SQLite session database |
| Pi / OMP | the JSONL session herdr reports |
| anything else | the pane's screen |

A transcript is the model's own text, delivered as it is; a screen is
cleaned of the terminal's chrome first. Details in
[docs/guide/agent-support.md](docs/guide/agent-support.md).

## Development

```bash
npm run typecheck
npm test            # build + vitest; the OpenCode tests need the sqlite3 CLI
```

MIT — see [LICENSE](LICENSE).
