# slack-claude-agent

A Slack bot that **is** a Claude agent. Every message becomes a turn in a per-thread Claude Agent SDK session with full tool access (Bash, file ops, web fetch, web search, sub-agent spawning via `Task`).

## Features

- **Per-thread sessions** — each Slack thread is an isolated agent session with its own working directory under `sessions/<channel>:<thread_ts>/`.
- **Reaction heartbeat** — `:eyes:` immediately on receipt, a new rotating emoji every 30 seconds while processing. On completion: all heartbeat reactions are removed and replaced with `:+1:` (success) or `:x:` (error).
- **Streaming replies** — agent output streams into a single Slack message, throttled to ≤1 edit/sec. Tool calls show inline as `_🔧 Bash…_` → `_✅ Bash_`.
- **Consent gate** — destructive Bash commands (`rm`, `git reset --hard`, force-push, `dd`, truncation via `>`, etc.) are paused and require user approval via interactive buttons (or a `yes`/`no` reply in the thread). 5-minute auto-deny timeout. Sub-agent calls hit the same gate.
- **File ingest** — PDFs, images, and other uploads are downloaded into the session workdir and made available to the agent via the standard `Read` tool.
- **Diagram rendering** — agent can generate Mermaid source and render with `mmdc` via Bash, then upload the PNG back through the custom `slack_post_file` MCP tool.
- **Sub-agents** — the SDK's `Task` tool is enabled; the agent can launch sub-agents for parallel or context-isolated work.

## Setup

### 1. Create a Slack app

Go to https://api.slack.com/apps → "Create New App" → "From scratch". Then:

**Socket Mode** → On → generate an app-level token with `connections:write` (this is your `SLACK_APP_TOKEN`, starts with `xapp-`).

**OAuth & Permissions → Bot Token Scopes:**

- `app_mentions:read`
- `channels:history` (for public channels)
- `chat:write`
- `groups:history` (for private channels)
- `im:history`
- `im:read`
- `im:write`
- `mpim:history`
- `reactions:read`
- `reactions:write`
- `files:read`
- `files:write`

**Event Subscriptions** → On. Subscribe to bot events:

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

**Interactivity & Shortcuts** → On. (Socket Mode delivers payloads — no Request URL needed.)

**Install to Workspace** → grab the **Bot User OAuth Token** (`xoxb-…`) and the **Signing Secret** from "Basic Information".

### 2. Configure

```bash
cp .env.example .env
# fill in SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY
```

### 3. Install & run

```bash
npm install
npm run dev
```

You should see `⚡️ Bolt app running`. DM the bot or invite it to a channel and start chatting.

## Commands

- `npm run dev` — start with watch reload
- `npm run start` — start without watch
- `npm run typecheck` — strict TS check
- `npm run test` — run all verification scripts (no real Slack/API needed)
- `npm run build` — compile to `dist/`

## Architecture

```
src/
├── index.ts              # boot
├── config.ts             # zod env validation
├── slack/
│   ├── app.ts            # Bolt app construction (Socket Mode)
│   ├── handlers.ts       # message + app_mention → SessionManager
│   ├── heartbeat.ts      # rotating reactions every 30s
│   ├── stream.ts         # throttled chat.update streaming
│   ├── formatter.ts      # markdown → Slack mrkdwn
│   ├── download.ts       # ingest Slack file attachments
│   ├── upload.ts         # files.uploadV2 wrapper
│   ├── consent.ts        # destructive-command approval flow
│   └── interactions.ts   # block_actions handler for approval buttons
└── agent/
    ├── manager.ts        # Map<threadKey, Session> + per-thread queue
    ├── session.ts        # Agent SDK query() wrapper
    ├── systemPrompt.ts   # agent persona / instructions
    ├── guards.ts         # destructive-command classifier
    ├── canUseTool.ts     # permission hook → consent flow
    └── tools/
        └── slackPost.ts  # MCP server: slack_post_message, slack_post_file
```

See `TODO.md` for deferred features (multi-workspace, persistence, productionization).

## Verification

The `test` script exercises six independent scenarios with stubbed Slack/Anthropic clients:

| Verification | What it checks |
|---|---|
| `guards.test.ts` | 17 destructive command patterns flagged; 10 safe patterns pass |
| `heartbeat.test.ts` | `:eyes:` first, rotation, cleanup, final `:+1:` / `:x:` |
| `manager.test.ts` | Same thread → same session; cross-thread runs in parallel; same-thread serializes |
| `stream.test.ts` | One placeholder post, ≤1 edit/sec throttling, tool indicators render |
| `download.test.ts` | Slack file download writes to workdir; path-traversal names sanitized |
| `consent.test.ts` | Button approve, reply `no`, non-trigger replies don't consume pending prompts |

End-to-end smoke tests against a live Slack workspace (Q&A, multi-turn, tool use, sub-agent, PDF upload, diagram, destructive consent) are listed in `TODO.md` under v1.

## Security notes

- The bot runs **on your laptop** and executes arbitrary commands the LLM decides on, scoped to `sessions/<threadKey>/`. The consent gate catches the common destructive patterns but is not a sandbox.
- For a hardened setup, see the "stronger sandboxing" TODO — running each session inside Docker is straightforward but not yet wired.
