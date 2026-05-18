# TODO

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

## Deferred — multi-workspace

- [ ] OAuth install flow (`/slack/install`, `/slack/oauth_redirect`)
- [ ] Token store (SQLite or Postgres) keyed by `team_id` / `enterprise_id`
- [ ] Bolt `InstallProvider` + `installationStore` adapter
- [ ] Per-workspace bot token retrieval inside handlers
- [ ] Public HTTPS endpoint (drop Socket Mode, or keep Socket per-install)
- [ ] Token rotation / refresh handling
- [ ] Uninstall + revoke cleanup
- [ ] Required scopes documented per workspace admin

## Deferred — productionization

- [ ] Session persistence across restarts (SQLite for thread → state map)
- [ ] Workdir cleanup policy (TTL or LRU eviction)
- [ ] Cost/usage tracking per thread
- [ ] Audit log of tool calls (bash commands especially)
- [ ] Stronger sandboxing (Docker/Firecracker) — currently runs on host
- [ ] Rate limiting per user / per workspace
- [ ] Error reporting beyond console (Sentry or similar)
- [ ] Deploy target (Fly/Render) — requires moving off laptop
