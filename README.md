# slack-claude-agent

A Slack bot that **is** a coding agent. Every Slack thread becomes its own per-thread agent session — pick **Claude** or **Codex** as the runtime per thread — with file system access, Bash, web search, PDF reading, diagram rendering, and (Claude only, for now) sub-agents, all driven by chatting in Slack.

Think of it as Claude Code or Codex CLI in your DMs.

> Everything you need is in this README — setup, [authentication](#authentication), and the full [feature](#features) list (runtimes, aliases, macros, sub-agents/resident workers, the context+usage footer).

---

## What this repo gives you

- A Node/TypeScript app that runs on your laptop and connects to Slack over **Socket Mode** (no public URL required).
- **Per-thread agent sessions** — open a new thread to start a new conversation; reply in an existing thread to continue it.
- **Two interchangeable runtimes per thread** — say "switch to codex" or "use claude" in any thread to flip its backend. Default is Claude; persisted in `data/runtimes.json`.
- **Reaction heartbeat** — `:eyes:` the instant the bot reads your message, a new emoji every 30 seconds while it works, all replaced with `:+1:` (or `:x:`) when done.
- **Live streaming replies** — the bot's response edits into Slack as it writes, with inline `_🔧 Bash…_` / `_✅ Bash_` indicators for each tool call (Claude only; Codex streams text).
- **Consent gate** — destructive commands (`rm`, `git reset --hard`, force-push, `dd`, file truncation, etc.) pause and ask for an Approve/Deny button click before running. Claude threads + sub-agents go through this gate; Codex threads use a coarser sandbox (see USAGE).
- **File ingest** — drop a PDF, image, or any file into the Slack thread; the bot reads it.
- **File output** (Claude only) — agent can post images/PDFs/diagrams back into the thread via MCP.
- **Sub-agents** — the agent can spawn sub-agents (via the `mcp__spawn__spawn` tool) for parallel or context-isolated work. Claude can also launch **resident workers** that stay warm across calls, and **Codex workers can now spawn too** (codex→codex and codex→claude). See [Features](#features).
- **Launch aliases** — define named agent configs in `data/aliases.json` (runtime, model, effort, extra CLI args) and start a thread with `custom_claude ~/code/myrepo <prompt>`.
- **Text macros** — define shorthand in `data/macros.json`; any whole-token match in a message expands before the agent runs.
- **Shell passthrough** — a message starting with `!` is run verbatim through `bash -lc` in the thread's workdir (bypasses the agent). `!ls`, `!git status`, etc. 60s timeout, 32 KB output cap.
- **Caveman compression** — global toggle (`caveman on/off/lite/full/ultra/wenyan`) from any Slack thread. Vendored from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman); ~65% fewer tokens by replying in terse fragments. Off by default. Applies to all Claude + Codex agents (main + spawn + resident). Wormhole-scoped — your global `~/.claude` / `~/.codex` untouched.
- **Context + usage footer** (Claude) — each reply ends with a compact `🧠 [▰▰▱▱▱] 38% · 380k/1M · 📊 5h 42% · wk 18% · $~0.42` showing context-window fullness (from the SDK's `getContextUsage`), subscription quota (from `/api/oauth/usage` via `scripts/fetch-usage.sh` — needs `jq`), and notional API-equivalent cost.
- **Scheduled runs (cron)** (Claude only) — ask in plain English ("every Monday at 9am, summarize PRs in #engineering"); the agent registers a cron and the prompt fires on schedule. Schedules persist across restarts.
- **Point a thread at a real project** — say "work in /Users/me/code/myrepo" and the agent switches its working directory for that thread, picking up `CLAUDE.md` / `AGENTS.md` and project context. Per-thread, persistent across restarts. Workdir is shared across runtimes.
- **Interrupt a running turn** — send `ctrl+c` (or `^c`, `interrupt`) in a thread to stop whatever the agent is currently doing, like ctrl+c in a terminal. Partial output stays; the session and its conversation survive — the next message continues where things stood. Works in both runtimes (Claude via the SDK's interrupt control request, Codex by terminating its subprocess).
- **End a session on demand** — say `end session` (or `close session`) in a thread to close its agent session immediately. The next message in that thread starts fresh.

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

# 4. (Optional) Authenticate to Codex — only needed for Codex-backed threads
#    Install the CLI: brew install codex   (or your package manager equivalent)
codex login                  # OAuth into your ChatGPT/Codex subscription, OR
# …set OPENAI_API_KEY in .env to use an API key

# 5. Sanity check
./scripts/doctor.sh          # validates .env + auth (Claude + Codex if reachable), re-runs the test suite

# 6. Run
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

## Authentication

**Claude** — pick one:
- **Subscription:** `npm run login` — runs the Claude Code OAuth flow (works on a GUI box via browser, or headless via its device-code flow) and stores the credentials itself; the SDK reuses them. Headless boxes: if no browser opens, it prints a URL to approve on another device.
- **API key:** set `ANTHROPIC_API_KEY` in `.env` for pay-as-you-go billing.

**Codex** (only for Codex-backed threads) — install the CLI (`brew install codex`), then `codex login` (ChatGPT/Codex subscription) or set `OPENAI_API_KEY` in `.env`.

---

## Features

### Per-thread runtime (Claude or Codex)

Each thread runs under one runtime. Switch with a plain phrase — `switch to codex`, `use claude`, `back to claude`. Default is `DEFAULT_RUNTIME` in `.env`; per-thread choice persists in `data/runtimes.json`. Conversation context does **not** carry across a switch.

### Launch aliases

Named agent configs you start a thread with. Define them in `data/aliases.json`:

```json
{
  "custom_claude": { "runtime": "claude", "model": "claude-opus-4-7", "effort": "high",
                     "claudeArgs": { "fallback-model": "claude-sonnet-4-6" } },
  "custom_codex":  { "runtime": "codex", "model": "gpt-5", "effort": "medium",
                     "codexArgs": ["-c", "sandbox_mode=workspace-write"] }
}
```

Invoke as the **first token** of a message: `<alias> [workdir] [prompt]`. The workdir is optional (a literal path or a macro that resolves to one); the prompt is optional and macro-expanded.

```
custom_claude ~/code/M5CacheRE review the current diff
```
launches the `custom_claude` agent in that directory and runs the prompt. Bare `custom_claude` just pins the alias; your next message runs under it. Fields: `runtime`, `model`, `effort` (`low|medium|high|xhigh|max`), `codexArgs` (Codex argv), `claudeArgs` (Claude SDK `extraArgs`). Active alias persists per thread in `data/thread-aliases.json`.

### Text macros

Pure text expansion. Define in `data/macros.json`:

```json
{ "swd": "set working dir to /Users/me/code/M5CacheRE and use its CLAUDE.md" }
```

Every whole-token, case-sensitive occurrence in a message is replaced before the agent runs (`swd to foo` → `set working dir to … to foo`). Hand-edit the file; changes apply without a restart.

### Shell passthrough (`!cmd`)

A Slack message that starts with `!` (after any bot mention) is run **verbatim** through `bash -lc` in the thread's workdir, **bypassing the agent**. The output is posted back as a code block.

```
!ls -la
!git status
!pwd && find . -name '*.ts' | head
```

Working directory: the thread's pinned workdir (set via `swd`-style phrases, the `set_workdir` MCP tool, or a launch alias). Falls back to `$HOME` if the thread hasn't pinned one.

Guards: 60s wall-clock timeout (kills the whole process group), 32 KB stdout/stderr cap with a `truncated` marker. No interactivity (stdin is closed) — a command that prompts for input will time out. No agent, no MCP, no consent gate — the trusted Slack user is the only authorization. Use with the same care as a local shell.

### Caveman compression (global Slack toggle)

A vendored copy of [caveman](https://github.com/JuliusBrussee/caveman) — a token-compression skill that makes agent responses terse fragments (~65% fewer tokens). **Off by default**, toggled bot-wide from any Slack thread.

```
caveman              → on at level full
caveman on           → same
caveman lite         → on at level lite
caveman ultra        → on at level ultra
caveman wenyan       → on at classical-Chinese level
caveman off          → back to normal English
caveman status       → reply with current level
```

The global level is persisted in `data/cavemanState.json` (gitignored) so it survives restarts. Trust: anyone who can DM the bot can toggle (same as `!cmd`).

**Applies to all Claude agents:**
- Main thread (`ClaudeRuntime`)
- One-shot Claude workers via `mcp__spawn__spawn`
- New resident workers (existing ones keep their startup level — kill + re-spawn to update)
- Recursive sub-spawning at any depth

**Applies to Codex agents** via a prompt preamble — Codex has no SessionStart hook concept, so the caveman ruleset is prepended to each turn's prompt at `CodexRuntime.send()` time.

**Scoped to the wormhole only.** Caveman's hooks are vendored under `arch-common/caveman/` and pointed to via a wormhole-owned settings file passed to the bundled CLI through the SDK's `extraArgs.settings`. Your global `~/.claude/` and `~/.codex/` are never touched — interactive `claude` / `codex` on your machine behave exactly as before.

### Sub-agents & resident workers

- **One-shot spawn:** the agent calls `mcp__spawn__spawn` to run a worker (sync or `background: true`) that reports back. `runtime: "codex"` dispatches the worker to Codex instead of Claude.
- **Per-call `model` + `effort`:** the spawn tool takes optional `model` and `effort` (`low|medium|high|xhigh|max`) overrides — Claude applies them as SDK options, Codex maps them to `-m` / `-c model_reasoning_effort`. Not inherited by child spawns; for resident workers they apply at creation only (the warm process's options are fixed).
- **Resident workers (Claude):** `mcp__spawn__spawn` with `name` + `resident: true` launches a long-lived process that stays warm across calls, keeping its context in memory (no resume). Same name → same worker. `worker_list` and `worker_kill` manage them; `end session` kills a thread's workers.
- **Codex can spawn too:** a Codex worker gets its own `spawn` tool (via a stdio MCP server), so it's no longer one-shot — `codex→codex` recurses (depth-capped) and `codex→claude` delegates to a Claude leaf.

#### Long-task timers

The bundled Claude CLI's async-agent stall watchdog (`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, default 10 min) has documented history of falsely killing spawned workers that are waiting on real work (e.g. a `run_in_background: true` Bash + `ScheduleWakeup` long bench — the bash tool returns in ms, so the SDK sees an idle agent). We bump it for both worker types:

| Worker | `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` |
|---|---|
| One-shot spawn | **2 h** |
| Resident | **24 h** (residents sit idle between calls by design) |
| Main bot | unset — uses the CLI default |

The CLI also has `MCP_TOOL_TIMEOUT` / `MCP_TIMEOUT` env vars governing per-MCP-call wall clocks. **We don't touch these** — we don't have evidence they were firing for us, and the bundled CLI's actual default behavior when they're unset isn't documented. Override yourself if you ever observe a 60-second-ish abort on an MCP tool call:

```bash
export CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS=14400000   # 4 h, overrides our 2 h
export MCP_TOOL_TIMEOUT=14400000                       # ours doesn't set it; this would
npm run dev
```

### Context + usage footer (Claude)

Each Claude reply ends with `🧠 [▰▰▱▱▱] 38% · 380k/1M · 📊 5h 42% · wk 18% · $~0.42`:
- **Context** — `totalTokens / maxTokens` reported by `Query.getContextUsage()` (the same SDK surface that powers the interactive CLI's `/context`), falling back to `result.usage.iterations[last]` when unavailable. Window is the model's real `maxTokens`; `CONTEXT_WINDOW_TOKENS` is just the fallback.
- **5h / weekly %** — subscription quota utilization. Two sources, in order:
  1. `scripts/fetch-usage.sh` (if `jq` is installed) calls the same `/api/oauth/usage` endpoint the CLI uses for `/usage-credits`; the wormhole reads the cached JSON (`data/usage.json`) with lazy refresh every 5 min.
  2. The SDK's `rate_limit_event` (server only emits when utilization crosses a threshold — often blank otherwise).
  - Falls back to `n/a` when both are absent.
- **$~X.XX** — the SDK's `total_cost_usd` summed across turns. The `~` flags this as *notional*: it's the equivalent API-rate price, not real money on a subscription plan.

**Optional dependency: `jq`** — only needed for the 5h/weekly % readout to populate reliably. Install with `brew install jq` (or your package manager). Without it, those percentages will show `n/a` whenever the SDK isn't emitting `rate_limit_event`. The script never leaks the OAuth token (passes it via stdin headers, unsets it immediately, never echoes it); the wormhole reads only the script's non-secret output JSON.

Toggle the whole footer with `CONTEXT_INDICATOR=on|off`. `CONTEXT_WINDOW_TOKENS` only kicks in as a fallback when the SDK doesn't report a window.

### arch-common

`arch-common/` is a vendored folder holding `commands/` (shared
hardware/architecture-research skill references) and `scripts/` (helper
tools, including `context_length.py` used by the context indicator). It's
plain tracked files — no submodule, nothing to init after cloning.

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

For Codex: install the `codex` CLI directly (`brew install codex` or equivalent) and run `codex login` / `codex logout`. The wormhole spawns it as a subprocess; it isn't an npm dep of this repo.

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
│   ├── manager.ts          # Map<threadKey, Session> + per-thread queue + runtime selection
│   ├── session.ts          # Runtime-agnostic wrapper; holds one Runtime instance
│   ├── systemPrompt.ts     # agent persona / instructions
│   ├── guards.ts           # destructive-command classifier
│   ├── canUseTool.ts       # Claude permission hook → consent flow
│   ├── workdirStore.ts     # per-thread workdir overrides (data/workdirs.json)
│   ├── runtimeStore.ts     # per-thread runtime overrides (data/runtimes.json)
│   ├── runtime/
│   │   ├── types.ts        # Runtime port + StreamHooks + TaskEvent
│   │   ├── claude.ts       # ClaudeRuntime — Anthropic Agent SDK
│   │   ├── codex.ts        # CodexRuntime — `codex exec` subprocess
│   │   └── codexProcess.ts # spawn seam for Codex subprocess (test-injectable)
│   └── tools/
│       ├── types.ts        # runtime-neutral ToolDef shape
│       ├── claudeMcp.ts    # Claude SDK MCP wrapper helper
│       ├── slackPostDef.ts # tool defs (runtime-neutral)
│       ├── slackPost.ts    # Claude MCP wrapper for slack_post_*
│       ├── workdirDef.ts   # tool defs (runtime-neutral)
│       ├── workdir.ts      # Claude MCP wrapper for set_workdir/get_workdir/reset_workdir
│       ├── cronDef.ts      # tool defs (runtime-neutral)
│       └── cron.ts         # Claude MCP wrapper for cron_*
├── slack/
│   ├── runtimeMatcher.ts   # "switch to codex" / "use claude" control-phrase detector
│   └── ...                 # (handlers, heartbeat, stream, consent, etc — unchanged)
└── scheduler/
    ├── store.ts            # JSON-backed CronStore (data/crons.json)
    ├── scheduler.ts        # node-cron wrapper: add/remove/start/stop
    └── runner.ts           # fire handler: synthesize a thread + run the agent
```

`scripts/`, `slack-manifest.yaml`, `.env.example`, and `TODO.md` (deferred features) live at the repo root.

---

## What's *not* in v1

See `TODO.md` for the deferred list. The big ones:

- **Multi-workspace install** — single-workspace only for now (one set of tokens, no OAuth flow).
- **Session persistence across restarts** — sessions are in-memory; restart loses the per-thread agent state (Slack messages stay, but the agent loses its context). Codex resumes by rollout UUID on disk, so Codex threads can survive bot restarts if the UUID is still pinned in `data/runtimes.json` — Claude threads lose context on restart.
- **Stronger sandboxing** — the agent runs Bash on your laptop, scoped to `sessions/<threadKey>/`. The consent gate catches the common destructive patterns but is not a sandbox. Docker-per-session is sketched in TODO.
- **Codex parity with Claude** — Codex *workers* can now spawn (a stdio `spawn` MCP), but a Codex *thread* still doesn't get the other wormhole MCP tools (`slack_post_file`, `set_workdir`, `cron_add`), and its destructive-command consent gate is coarser (`--sandbox workspace-write`, not per-call). The context/usage footer is Claude-only.

---

## Security notes

- Treat this like running an SSH session that anyone in your Slack workspace can drive. The consent gate gives you a circuit breaker for the most destructive patterns, but it isn't a substitute for isolation.
- Only invite the bot to channels where you're comfortable with that trust level. For most users, DM-only is the right setup.
- Tokens in `.env` are gitignored. Don't commit them.

---

## See also

- **[TODO.md](./TODO.md)** — deferred features and known limitations.
- **[USAGE.md](./USAGE.md)** — older walkthrough (the README above is the current, authoritative reference).
