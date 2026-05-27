---
disable-model-invocation: true
---

The user's Claw isn't responding (browser, slack, or both). Diagnose and fix interactively. **A restart may or may not be needed** — most user-visible failures are caused by config or session state, not by a sick gateway. Investigate before restarting; if you restart unconditionally you will mask the real problem.

The user's framing ("not responding") usually means one of:
- Browser/webchat shows `[assistant turn failed before producing content]` — almost always a model/auth/config error in the agent run, **not** a gateway crash. Check the trajectory before doing anything else.
- Slack DMs to the bot get no reply — could be the same underlying agent-run failure, or a stuck slack socket.
- Gateway is genuinely down (`launchctl list` shows no entry, or PID was killed) — rare; restart fixes it.

## Diagnostic order (do this first, before any restart)

Run these in parallel. They are read-only.

```bash
launchctl list | grep openclaw
ps -p $(launchctl list | awk '/openclaw/{print $1}') -o pid,%cpu,etime,command 2>/dev/null
lsof -nP -p $(launchctl list | awk '/openclaw/{print $1}') 2>/dev/null | grep -E "TCP.*:443|LISTEN" | head
grep -E '"id"|"primary"|"contextWindow"' ~/.openclaw/openclaw.json
```

You want: PID present, modest CPU, listening on `:18789`, one ESTABLISHED `:443` (slack edge), and the model `primary` looks sane (see "Bedrock model IDs" below).

### Read the right logs

| File | What it tells you |
|---|---|
| `~/.openclaw/logs/gateway.log` | Plain-text gateway lifecycle (start/stop/connect events) |
| `~/.openclaw/logs/gateway.err.log` | Plain-text warns/errors (slack pong, agent fail summaries) |
| `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | **Full structured JSON log — the truth.** Includes streaming/tool events, fallback decisions, etc. |
| `~/.openclaw/agents/main/sessions/<id>.trajectory.jsonl` | **The single most useful file when an agent run looks broken.** Contains `model.completed`, `trace.artifacts`, `assistantTexts`, final status, exact error. |
| `~/.openclaw/agents/main/sessions/<id>.jsonl` | The persisted session — what the UI actually shows. Old failure placeholders live here forever. |
| `~/.openclaw/agents/main/sessions/sessions.json` | Session metadata: most-recent session id per agent, channel/origin |

**Date-confusion gotcha (real bug encountered):** `awk '/T12:/'` matches `T12:` as an hour-of-day across **every date** in the log, not just today. Always anchor on the full date: `awk '/^2026-04-28/'` or `grep '^2026-04-28T12:'`. I once "found" `getaddrinfo ENOTFOUND slack.com` errors that turned out to be from seven days earlier and chased a phantom DNS bug.

### Inspect the most recent run before assuming anything

```bash
# Find the active session
recent_session=$(jq -r '.[].sessionId' ~/.openclaw/agents/main/sessions/sessions.json | head -1)
# Or just take the most-recently-modified jsonl
recent=$(ls -t ~/.openclaw/agents/main/sessions/*.trajectory.jsonl | head -1)
# Look at the last 4-8 events
tail -8 "$recent" | python3 -c "import sys,json; [print(json.dumps({k:o.get(k) for k in ('seq','type','ts','data')}, indent=2)[:1500],'---') for o in (json.loads(l) for l in sys.stdin)]"
```

What you want to find:
- `model.completed` with `aborted: false`, an `assistantTexts` array, and `trace.artifacts` showing `finalStatus: "success"` → **the agent worked**. The user's "not responding" is a UI-render or stale-state issue (see "False alarms" below).
- `embedded run agent end ... isError=true ... error=...` in `gateway.err.log` → real failure. **Read the actual error string.** The most common ones:

| Error string | Real cause |
|---|---|
| `Validation error: Your account is not authorized to invoke this API operation` | **Invalid Bedrock model ID, NOT an auth problem.** Bedrock's wording is misleading. Check the model `id` in `~/.openclaw/openclaw.json` against the canonical list below. |
| `Validation error: The text field in the ContentBlock object at messages.N.content.0 is blank` | Bedrock rejected an empty assistant turn from a prior context. Usually self-heals via session repair; if it loops, `/new` the session. |
| `getaddrinfo ENOTFOUND slack.com` | Genuine DNS hiccup (rare). Verify with `dig slack.com`; `dig` working but Node failing implies a VPN/MagicDNS interceptor. |
| `Live session model switch requested ... reason=overloaded` | Model-fallback fired because the primary failed. The primary is broken — fix it before restarting. |

## Bedrock model IDs (canonical)

The user (or earlier you) may have written something like `us.anthropic.claude-opus-4-7[1m]` in `~/.openclaw/openclaw.json`. **The bracket suffix is Anthropic-API syntax, not Bedrock.** Bedrock will reject every call with the misleading "not authorized" error.

Authoritative list lives in `/opt/homebrew/lib/node_modules/openclaw/dist/extensions/amazon-bedrock/discovery.js`. Real IDs (as of 2026.4.25 build):

| Model | Bedrock ID | Context |
|---|---|---|
| Opus 4.7 | `us.anthropic.claude-opus-4-7` | 1M (native, no `[1m]` suffix needed) |
| Opus 4.6 | `us.anthropic.claude-opus-4-6-v1` | 1M |

The `1M` context for Opus 4.7 is **native to the Bedrock model** — do not add `params.context1m: true` and do not append `[1m]`. The `[1m]` form is correct for the Anthropic API path (claude-opus-4-7[1m]) but wrong here.

The model lives in two places, both should match:
- Gateway: `~/.openclaw/openclaw.json` → `models.providers.amazon-bedrock.models[].id` and `agents.defaults.model.primary`
- Per-agent: `~/.openclaw/agents/main/agent/models.json` (hot-reloaded from gateway config)

## Slack pong-timeout storms are usually downstream

If `gateway.err.log` shows a tight cycle of:

```
[WARN]  socket-mode:SlackWebSocket:N A pong wasn't received from the server before the timeout of 5000ms!
[slack] socket disconnected (disconnect). retry 1/12 in 2s
```

**check the agent first, not the network.** Each failed agent run does a synchronous `[agent/embedded] session file repaired: rewrote 1 assistant message(s)` write, which stalls the Node event loop. The slack `@slack/socket-mode` ping/pong runs on `setInterval` (1.67s ping, 5s pong-timeout). A stalled loop misses the pong window and trips the warning. The warning triggers a `health-monitor: stale-socket` reconnect, which restarts the cycle.

Signature: pong-timeouts firing more than once per minute, **correlated in time** with `embedded run agent end ... isError=true`. Fix the agent (model ID, creds, etc.) and the slack symptoms vanish.

Healthy baseline: roughly **one** `health-monitor: stale-socket` restart per day. Multiple per minute = symptom of upstream failure.

The slack tokens themselves rarely fail. To verify quickly:
```bash
# bot token (form-encoded — Slack quirk)
curl -s -d "token=$BOT_TOKEN" https://slack.com/api/auth.test
# app token (must use Authorization header, NOT form param)
curl -s -X POST -H "Authorization: Bearer $APP_TOKEN" -H "Content-Type: application/x-www-form-urlencoded" -d "" https://slack.com/api/apps.connections.open
```
Tokens come from `~/.openclaw/openclaw.json` → `channels.slack.{botToken,appToken}`.

## False alarms ("not responding" but the backend is fine)

Before restarting, rule these out:

1. **Stale UI state.** The browser/webchat shows `[assistant turn failed before producing content]` placeholders persisted from earlier failed runs in the session jsonl. They stay in scrollback forever. If the **most recent** message in `<session>.jsonl` is a real assistant reply, the backend is fine — the user just needs to scroll/refresh, or `/new` for a clean slate.
   ```bash
   tail -1 "$recent_session_jsonl" | python3 -m json.tool | head -20
   ```
2. **Streaming dropout.** A long gateway operation (model call >5s + slow `node.list` >3s) can briefly stall the WS stream. The reply is persisted but the browser tab missed the streaming events. Hard-refresh (Cmd+Shift+R) re-pulls the session and shows it.
3. **Bedrock 4.6 multi-turn hang.** Documented separately: Opus 4.6 1M on Bedrock hangs on multi-turn `claude -p` with tool use. Switching to 4.7 or using Agent subagents avoids it.

## Talking to the agent directly to verify

Two distinct paths — they exercise different code:

**Embedded (CLI, fast smoke test — bypasses gateway WS entirely):**
```bash
openclaw agent --local --session-id "verify-$(date +%s)" \
  --message "Reply with exactly the four words: gateway test ok now" \
  --json --timeout 90 2>&1 | tail -60
```
Look for `winnerProvider`, `winnerModel`, `result: success`, `finalAssistantVisibleText`. If `--local` works but webchat fails, the gateway run path or auth profile is the issue, not the model.

**Via gateway WS (what slack/webchat actually use):**
```bash
openclaw agent --session-id "..." --message "..." --json
```
**Common gotcha:** the default operator token has `operator.read` only. `openclaw agent` (non-local) requests `operator.write/admin/...` and gets `code=1008 reason=connect failed`. This is a CLI-pairing issue, not a gateway issue — re-pair the device with broader scopes if you need this path. **Slack and webchat are unaffected** because they use different auth.

## Two-layer model config

| Layer | File | Purpose |
|---|---|---|
| Gateway | `~/.openclaw/openclaw.json` | Sets `agents.defaults.model.primary` and the provider model catalog |
| Per-agent | `~/.openclaw/agents/main/agent/models.json` | Hot-reloaded copy. Edits to the gateway file propagate within seconds via `[reload] config hot reload applied` log line |

If you edit the gateway file, you do **not** need to restart — watch for `[reload] config hot reload applied (...)` in `gateway.log`. Restart only if hot-reload doesn't fire (rare).

## Restart, only when actually needed

Restart **only if** one of these is true:
- `launchctl list | grep openclaw` shows no entry, OR `ps -p` shows the process is gone
- The exit code in `launchctl list` is non-zero (e.g. `99040 -9 ai.openclaw.gateway` = killed by SIGKILL)
- You changed an env var in the plist (creds rotation; this requires the user to edit the file by hand — see below)
- Hot-reload demonstrably failed (you see no `[reload] config hot reload applied` after editing config)

```bash
launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null
sleep 1
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

If `load` errors with `5: Input/output error` but exits 0 anyway (this happens), don't worry — verify with `launchctl list | grep openclaw` and `tail -10 ~/.openclaw/logs/gateway.log`. Look for `[gateway] ready` and `[gateway] agent model: ...` showing the right model.

If `bootstrap` is needed (rare):
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

After restart, the very first slack reconnect attempt may pong-timeout once or twice before stabilizing. Three or more in 60s is a problem; one or two is normal cold-start.

## Daily 04:00 scheduled kickstart (preventive)

A separate launchd agent force-restarts the gateway every morning at 04:00 to clear long-running socket / event-loop drift before the user starts their day. This is a **prophylactic** restart, not a fix for an active failure — but it is the single biggest reason "morning openclaw is broken" reports stopped happening.

| Item | Value |
|---|---|
| Plist | `~/Library/LaunchAgents/ai.openclaw.gateway-restart.plist` |
| Label | `ai.openclaw.gateway-restart` |
| Command | `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway` |
| Schedule | `StartCalendarInterval` → `Hour 4, Minute 0`; `RunAtLoad=false` |
| Log | `~/.openclaw/logs/gateway-restart.log` (entries tagged `source=launchd-handoff mode=kickstart`) |

The `-k` flag SIGKILLs the running gateway; the gateway's own plist (`KeepAlive`) respawns it within seconds. If a user reports morning issues that started recently, first verify this agent is still loaded:

```bash
launchctl list | grep ai.openclaw.gateway-restart   # should show "-  0  ai.openclaw.gateway-restart"
tail -5 ~/.openclaw/logs/gateway-restart.log         # should show a "restart done" line dated today (after 04:00)
```

If the entry is missing, reload it: `launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway-restart.plist`.

## Refreshing AWS credentials

Only when the user explicitly says creds are stale, OR you see Bedrock errors like `expired token`, `signature does not match`, or `not entitled` (after confirming the model ID is correct). Tell the user to:

1. `code ~/Library/LaunchAgents/ai.openclaw.gateway.plist`
2. Update `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally `AWS_REGION`
3. Save, then restart per above

Do **not** read or inject credentials programmatically.

## Closing out

When the agent is genuinely working again:
- Confirm with one `--local` agent test that returns a known-string response
- Confirm the most recent session jsonl ends with a real assistant message
- Confirm `gateway.err.log` has gone quiet (no pong-storm in last few minutes)
- Tell the user to hard-refresh the browser or `/new` for a clean session if they were staring at stale `[assistant turn failed]` placeholders
