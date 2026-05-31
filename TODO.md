# TODO

## Priority

- [ ] **Bug: long messages cut off in Slack** — long agent replies still get truncated mid-stream, even though `splitForSlack(text, MAX_PART_CHARS)` is supposed to span them across multiple thread messages. Investigation surface: `src/slack/stream.ts` (streaming flush pipeline — `setText`/`appendText` buffering, the `pendingTimer` debounce path at line 178, `finalize()` drain ordering already covered by `streamOverflow.test.ts` regressions), `src/slack/contextIndicator.ts` (the footer is `appendText`'d after `onFinal` — could be pushing the message past the limit at the worst moment), and `splitForSlack` itself (lines 259+ — code-fence preservation across boundaries, hard 40k char Slack limit). Step 1: capture a real cut-off message + the corresponding `~/.claude/projects/*/jsonl` so we know exactly what the SDK emitted vs what landed in Slack. Step 2: if the SDK's final text is intact, the bug is on our flush side; if the SDK text was already short, it's an upstream SDK or stream-event ordering issue.
- [ ] **Bug: task notifications about stuff finishing aren't being sent** — root cause located in `src/slack/taskEvents.ts`: `buildTaskEventPoster` is built per-`Session.send()` and only stays alive for the duration of that one streaming turn. The `onTaskEvent` hook stops firing the moment the parent agent's `result` message lands and the for-await loop in `claude.ts` exits. Background workers that finish AFTER the parent turn returns have nowhere to deliver their `task_notification` — the poster is gone. Fix shape: lift the poster to **session-scoped** (or thread-scoped) lifetime instead of turn-scoped — keep the `Map<taskId, TaskState>` alive across `send()` calls so a late `task_notification` from a background worker still lands on its existing message via `chat.update`. Alternative: forward background task events through an out-of-band channel (a dedicated long-lived listener on `SDKTaskNotificationMessage` not tied to the per-turn stream). Touches: `taskEvents.ts` (lifetime + new entry point that doesn't take a per-turn `client+channel+threadTs`), `handlers.ts` (move construction up from per-`handleIncoming` to per-session creation), `manager.ts`/`session.ts` (hold the poster on the session).

- [ ] **Wormhole reset from Slack** — Slack control phrase (`reset wormhole` / `wormhole reset`), matched whole-message like `end session`. **Hard reset**: (a) close every in-memory session (`sessions.closeAll()`), (b) kill every resident worker across all threads (`registry.killAll()`), (c) clear all `:satellite_antenna:` active-marker reactions in Slack, (d) invalidate the mtime-cached stores (macros, aliases, runtimes, workdirs) so the next message re-reads them from disk. **No data deletion** — `data/*.json` stays. Trust: anyone who can DM the bot can trigger it (same model as `!cmd`). New `src/slack/resetMatcher.ts` mirroring `endSessionMatcher.ts`; new methods on `Sessions` and `ResidentWorkerRegistry`. Posts a summary back to Slack: `Reset: closed N sessions, killed M workers, cleared K reactions.`
- [ ] **Slack-triggered self-update** — control phrase `update wormhole` (optional `to <ref>` suffix; default `origin/main`). Flow: (1) `git fetch origin`; (2) build a temp worktree at `/private/tmp/wormhole-update-<ts>`; (3) in temp: `npm install`, `npm run typecheck`, `npm run test`, streaming a short summary to Slack; (4) on any failure → abort, post failure detail, leave temp dir for inspection, **keep current bot running unchanged**; (5) on success → one-shot swap: `git fetch && git reset --hard <ref>` in the live repo + `npm install` in live, then `kill $(cat data/wormhole.pid)` so the supervisor relaunches. Requires the bash-supervisor wrapper (below). Preserves `data/` (gitignored — not touched by reset --hard). Runs `npm install` automatically both in temp (for tests) and in live (post-swap). Trust: anyone can trigger (same as `!cmd`).
  - **Sub-task: bash supervisor** — new `scripts/run-wormhole.sh` (`while true; do tsx src/index.ts; PID written to data/wormhole.pid; done`). Launch the bot with this script instead of `npm run dev`. README updated to point at it as the supervised launch path. Required by the self-update task above (`kill $PID` only restarts the bot when the supervisor relaunches it).

- [ ] **Caveman skill** — add to the harness: <https://github.com/JuliusBrussee/caveman>
- [x] **Codex support — v1 (text-only)**: per-thread runtime selection via control phrases ("switch to codex", "use claude"). Persisted in `data/runtimes.json`. New CodexRuntime wraps `codex exec` / `codex exec resume`; provider-abstracted Runtime port shared with ClaudeRuntime. Streaming, heartbeat, end-session, workdir-overrides all work cross-runtime. Subscription auth (`codex login`) + API key (`OPENAI_API_KEY`) both supported. See README + USAGE.
- [ ] **Codex parity — MCP shim** — stand up a stdio MCP server that exposes the wormhole's runtime-neutral ToolDefs (slack/workdir/cron/runtime/spawn) to Codex via `codex exec -c mcp_servers.wormhole.command=...`. Without this, Codex threads can't call `slack_post_file`, `set_workdir`, `cron_add`, or spawn sub-agents.
- [ ] **Codex parity — spawn / sub-agents** — partial: a Claude parent can now dispatch a Codex worker via `runtime: "codex"` on the spawn MCP tool (handler in `spawn.ts:runCodexWorker`). Still missing: (1) Codex parents fanning out to *any* workers — depends on the Codex MCP shim landing so `mcp__spawn__spawn` is visible from a Codex thread; (2) Codex workers recursively spawning further workers (same dependency); (3) bg-task lifecycle (`task_started` / `task_progress` / `task_notification`) for Codex workers — currently they only emit the `started` event and final result, no progress chunks.
- [ ] **Codex parity — fine-grained consent gate** — Codex has no per-call IPC equivalent to Claude's `canUseTool`. Either (a) wire Codex's approval-policy hook if one ships in future versions, or (b) ship a `wormhole_shell` MCP tool and steer the model toward it via system prompt so destructive bash is gated like Claude's. Today Codex threads rely on `--sandbox workspace-write` alone.

## v1 — Single-workspace prototype (scope of initial build)

- [ ] Bolt app boots in Socket Mode with `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`
- [ ] Respond to **every** DM and channel message the bot can see (no mention required)
- [ ] Per-thread Claude Agent SDK session with file/bash/web tools enabled
- [ ] Streaming responses via throttled `chat.update` (≤1/sec)
- [ ] Tool-call status indicators inline in the streamed message
- [ ] **Reaction heartbeat**: `:eyes:` on receipt, new emoji every 30s
  - [ ] On success: remove all heartbeat reactions, add `:+1:`
  - [ ] On error: remove all heartbeat reactions, add `:x:`
- [ ] **Consent gate** for destructive Bash (`rm`, `rmdir`, `mv → trash`, `git reset --hard`, force-push, truncation, `dd`, `mkfs`, `kill -9`)
  - [ ] Slack interactive buttons (Approve / Deny) via `block_actions`
  - [ ] Thread reply fallback (`yes`/`no`)
  - [ ] 5-min auto-deny timeout
  - [ ] Hook applies to sub-agents too (same `canUseTool` callback)
- [ ] Slack file ingest: download attachments into per-thread workdir
- [ ] PDF reading (via SDK `Read` tool — native Claude document support)
- [ ] Diagram rendering: `mermaid-cli` via Bash → PNG → `files.uploadV2`
- [ ] Custom `slack_post` MCP tool so agent (and sub-agents) can post back
- [ ] Sub-agent launching via SDK `Task` tool (no extra code, just allowlist)
- [ ] Per-thread working dir under `sessions/<threadKey>/`
- [ ] Per-thread queue so concurrent messages don't interleave tool calls
- [x] **Scheduled runs (cron)** — agent uses `cron_add` / `cron_list` / `cron_remove` MCP tools; jobs persisted to `data/crons.json`; fired jobs open a fresh thread in the target channel

## Deferred — cron hardening

- [ ] Per-user ACLs (who can add/remove crons in a given channel)
- [ ] Bounded cron count and prompt length to avoid abuse
- [ ] Backfill / catch-up runs after long downtime
- [ ] Cron history (last N firings, success/failure) viewable via tool

## Deferred — multi-workspace

- [ ] OAuth install flow (`/slack/install`, `/slack/oauth_redirect`)
- [ ] Token store (SQLite or Postgres) keyed by `team_id` / `enterprise_id`
- [ ] Bolt `InstallProvider` + `installationStore` adapter
- [ ] Per-workspace bot token retrieval inside handlers
- [ ] Public HTTPS endpoint (drop Socket Mode, or keep Socket per-install)
- [ ] Token rotation / refresh handling
- [ ] Uninstall + revoke cleanup
- [ ] Required scopes documented per workspace admin

## Deferred — UX & alt-runtimes

- [ ] **Active-session reactions** — visual marker on Slack messages indicating which threads currently have an in-memory agent session (vs threads where the user would be starting fresh). Right now the user has to mentally track which threads are "alive." Sketch: when a thread's session is hot, the root message gets a persistent `:satellite:` (or similar) reaction; when the session is GC'd or the bot restarts, the reaction is removed. Should survive across the existing heartbeat lifecycle without interfering with it.
- [ ] **Runtime indicator reaction** — when a thread is pinned to Codex (vs the default Claude), reflect that visually so the user knows at a glance which backend is about to respond. E.g. `:robot_face:` for Codex / `:sparkles:` for Claude on the thread root. Should react to runtime-switch control phrases.

## Deferred — productionization

- [ ] Session persistence across restarts (SQLite for thread → state map)
- [ ] Workdir cleanup policy (TTL or LRU eviction)
- [ ] Cost/usage tracking per thread
- [ ] Audit log of tool calls (bash commands especially)
- [ ] Stronger sandboxing (Docker/Firecracker) — currently runs on host
- [ ] Rate limiting per user / per workspace
- [ ] Error reporting beyond console (Sentry or similar)
- [ ] Deploy target (Fly/Render) — requires moving off laptop
