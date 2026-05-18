# slack-claude-agent

A Slack bot that **is** a Claude agent. Every Slack thread becomes its own Claude Code session — with file system access, Bash, web search, PDF reading, diagram rendering, and the ability to launch sub-agents — all driven by chatting in Slack.

Think of it as Claude Code in your DMs.

> For day-to-day usage (how threads map to sessions, what commands need consent, attaching files, asking for diagrams, etc.) see **[USAGE.md](./USAGE.md)**.

---

## What this repo gives you

- A Node/TypeScript app that runs on your laptop and connects to Slack over **Socket Mode** (no public URL required).
- **Per-thread Claude agent sessions** — open a new thread to start a new conversation; reply in an existing thread to continue it.
- **Reaction heartbeat** — `:eyes:` the instant the bot reads your message, a new emoji every 30 seconds while it works, all replaced with `:+1:` (or `:x:`) when done.
- **Live streaming replies** — the bot's response edits into Slack as it writes, with inline `_🔧 Bash…_` / `_✅ Bash_` indicators for each tool call.
- **Consent gate** — destructive commands (`rm`, `git reset --hard`, force-push, `dd`, file truncation, etc.) pause and ask for an Approve/Deny button click before running. Sub-agents go through the same gate.
- **File ingest** — drop a PDF, image, or any file into the Slack thread; the bot reads it.
- **File output** — agent can post images/PDFs/diagrams back into the thread.
- **Sub-agents** — the agent can spawn sub-agents (via the SDK's `Task` tool) for parallel or context-isolated work.
- **Scheduled runs (cron)** — ask in plain English ("every Monday at 9am, summarize PRs in #engineering"); the agent registers a cron and the prompt fires on schedule. Schedules persist across restarts.
- **Point a thread at a real project** — say "work in /Users/me/code/myrepo" and the agent switches its working directory for that thread, picking up `CLAUDE.md` and project context. Per-thread, persistent across restarts.

---

## Quick start

```bash
# 1. Clone & set up
git clone <this-repo> slack-claude-agent
cd slack-claude-agent
./scripts/setup.sh           # checks Node 20+, installs deps, copies .env, runs tests

# 2. Create the Slack app  (see "Slack app setup" below)
#    Fill the three Slack tokens into .env

# 3. Authenticate to Claude  (pick one)
npm run login                # OAuth into your Claude Pro/Max subscription, OR
# …set ANTHROPIC_API_KEY in .env to use a pay-as-you-go API key instead

# 4. Sanity check
./scripts/doctor.sh          # validates .env + auth and re-runs the test suite

# 5. Run
npm run dev
```

You should see `⚡️ Bolt app running`. DM the bot or invite it to a channel and start chatting.

---

## Setup scripts

| Script | What it does |
|---|---|
| `./scripts/setup.sh` | Verifies Node 20+, runs `npm install`, copies `.env.example → .env` (if missing), runs `tsc --noEmit`, runs the verification suite. Use this once after cloning. |
| `./scripts/doctor.sh` | Checks all four env vars are filled with correctly-prefixed tokens, re-runs typecheck and tests. Use this after editing `.env` or whenever something feels off. |

If you'd rather do it manually: `npm install && cp .env.example .env && npm run typecheck && npm run test`.

---

## Slack app setup

The fast path uses the **Slack app manifest** included in this repo (`slack-manifest.yaml`). It pre-configures every scope, event subscription, Socket Mode toggle, and interactivity setting in one paste.

### 1. Create the app from the manifest

1. Go to <https://api.slack.com/apps> → **Create New App** → **From a manifest**.
2. Pick the workspace you want to install into.
3. Open `slack-manifest.yaml` in this repo, paste it into the YAML tab, click **Next** → **Create**.

### 2. Generate the Slack tokens

You need three Slack values in `.env`. (Claude auth is separate — see the "Claude authentication" section above.)

| Env var | Where to find it |
|---|---|
| `SLACK_APP_TOKEN` (`xapp-…`) | **Basic Information → App-Level Tokens → Generate Token and Scopes** → add `connections:write` scope → copy the token |
| `SLACK_SIGNING_SECRET` | **Basic Information → App Credentials → Signing Secret** |
| `SLACK_BOT_TOKEN` (`xoxb-…`) | **OAuth & Permissions → Install to Workspace → Allow** → copy the Bot User OAuth Token shown after install |

### 3. Invite the bot

- **DM:** open Slack → search for the app name → message it directly. (DMs work as soon as install is done.)
- **Channels:** `/invite @YourBotName` in any channel you want it to listen in.

### 4. Run it

```bash
npm run dev
```

The bot will start receiving messages as soon as Socket Mode connects. Heading over to Slack and sending it a message should produce a `:eyes:` reaction within a second.

### Manual app setup (without the manifest)

If you'd rather configure by hand, the manifest is the authoritative list — every value you'd toggle in the app config UI is in `slack-manifest.yaml`. The non-obvious ones:

- **Socket Mode** → On
- **Interactivity** → On (no Request URL needed — Socket Mode delivers the payloads)
- **App-Level Token scope:** `connections:write`
- **Bot scopes:** `app_mentions:read`, `channels:history`, `chat:write`, `files:read`, `files:write`, `groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`, `reactions:read`, `reactions:write`
- **Subscribed bot events:** `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`

---

## Commands

```bash
npm run dev         # start with watch reload
npm run start       # start without watch
npm run login       # OAuth into your Claude subscription
npm run logout      # clear Claude credentials
npm run typecheck   # strict TS check
npm run test        # run verification suite (no live tokens needed)
npm run build       # compile to dist/
```

---

## Project layout

```
src/
├── index.ts              # boot
├── config.ts             # zod-validated env
├── slack/
│   ├── app.ts            # Bolt app (Socket Mode)
│   ├── handlers.ts       # message + app_mention → SessionManager
│   ├── heartbeat.ts      # rotating reactions every 30s
│   ├── stream.ts         # throttled chat.update streaming
│   ├── formatter.ts      # markdown → Slack mrkdwn
│   ├── download.ts       # ingest Slack file attachments
│   ├── upload.ts         # files.uploadV2 wrapper
│   ├── consent.ts        # destructive-command approval flow
│   └── interactions.ts   # block_actions handler for buttons
├── agent/
│   ├── manager.ts        # Map<threadKey, Session> + per-thread queue
│   ├── session.ts        # Agent SDK query() wrapper
│   ├── systemPrompt.ts   # agent persona / instructions
│   ├── guards.ts         # destructive-command classifier
│   ├── canUseTool.ts     # permission hook → consent flow
│   ├── workdirStore.ts   # per-thread workdir overrides (data/workdirs.json)
│   └── tools/
│       ├── slackPost.ts  # MCP tools: slack_post_message, slack_post_file
│       ├── cron.ts       # MCP tools: cron_add, cron_list, cron_remove
│       └── workdir.ts    # MCP tools: set_workdir, get_workdir, reset_workdir
└── scheduler/
    ├── store.ts          # JSON-backed CronStore (data/crons.json)
    ├── scheduler.ts      # node-cron wrapper: add/remove/start/stop
    └── runner.ts         # fire handler: synthesize a thread + run the agent
```

`scripts/`, `slack-manifest.yaml`, `.env.example`, and `TODO.md` (deferred features) live at the repo root.

---

## What's *not* in v1

See `TODO.md` for the deferred list. The big ones:

- **Multi-workspace install** — single-workspace only for now (one set of tokens, no OAuth flow).
- **Session persistence across restarts** — sessions are in-memory; restart loses the per-thread agent state (Slack messages stay, but the agent loses its context).
- **Stronger sandboxing** — the agent runs Bash on your laptop, scoped to `sessions/<threadKey>/`. The consent gate catches the common destructive patterns but is not a sandbox. Docker-per-session is sketched in TODO.

---

## Security notes

- Treat this like running an SSH session that anyone in your Slack workspace can drive. The consent gate gives you a circuit breaker for the most destructive patterns, but it isn't a substitute for isolation.
- Only invite the bot to channels where you're comfortable with that trust level. For most users, DM-only is the right setup.
- Tokens in `.env` are gitignored. Don't commit them.

---

## See also

- **[USAGE.md](./USAGE.md)** — how to actually use it once it's running.
- **[TODO.md](./TODO.md)** — deferred features and known limitations.
