# Usage

How to actually use `slack-claude-agent` once it's running. See [README.md](./README.md) for setup.

---

## Mental model

> **One Slack thread = one Claude agent.**

- The **first message** in a channel or DM starts a fresh agent session.
- **Every reply in that thread** continues the same session — the agent remembers everything earlier in the thread.
- A **new top-level message** (not a reply) starts a brand-new session with empty context.
- DMs without explicit threads still work: each top-level message in a DM is its own session.

Each session gets:

- Its own working directory at `sessions/<channel_id>:<thread_ts>/`
- Its own conversation history (kept in memory while the bot is running)
- The full Claude Code tool surface: `Read`, `Write`, `Edit`, `Bash`, `WebFetch`, `WebSearch`, `Task` (sub-agents), `Grep`, `Glob`, and the custom `slack_post_message` / `slack_post_file` tools

The bot replies to **every** DM and every message in a channel it's been invited to — no `@mention` required.

---

## What you see while the bot works

1. **You send a message.**
2. **`:eyes:` reaction appears** within ~1 second — confirms the bot received your message.
3. **A "_thinking…_" reply** posts in the thread, then edits live as the agent types.
4. **Tool calls show inline** in the reply: `_🔧 Bash…_` while running, then `_✅ Bash_` or `_❌ Bash_`.
5. **Every 30 seconds while still working**, a new emoji is added to your original message (`:hourglass_flowing_sand:` → `:thinking_face:` → `:gear:` → …). This is your "still alive" signal.
6. **When the task finishes**, every heartbeat emoji is removed and replaced with **`:+1:`** (success) or **`:x:`** (error).

If you don't see `:eyes:` within a few seconds, the bot isn't running or isn't connected — check the terminal where `npm run dev` is running.

---

## Multi-turn conversations

Just keep replying in the thread.

```
You:   write me a fibonacci function in python
Bot:   <streams a function in a thread reply>

You:   [reply in thread] add memoization
Bot:   <edits the same conversation context — knows what "it" refers to>

You:   [reply in thread] save it to fib.py and run it with n=20
Bot:   <writes the file, executes via Bash, streams the output>
```

To start a totally new conversation, send a new **top-level** message (not a reply). That spins up a fresh session in a new working directory.

---

## Attaching files

Drop any file into Slack the way you normally would (drag-and-drop, paste, or the paperclip).

The bot will:

1. Download it into `sessions/<threadKey>/uploads/<filename>`.
2. Tell the agent in its prompt: *"User uploaded: ./uploads/report.pdf"*.
3. Use the standard `Read` tool when it needs the contents.

Supported natively by Claude:

- **PDFs** — read in full, including images on each page.
- **Images** — PNG, JPG, GIF, WebP.
- **Plain text / code / markdown / JSON / CSV** — any text format.

Other binary formats work too as long as a Bash tool (`unzip`, `pdftotext`, etc.) can extract them — the agent will figure it out.

### Example

```
You:   [attach quarterly-report.pdf]  summarize page 3 in 5 bullets
Bot:   _🔧 Read…_
       _✅ Read_
       Page 3 covers Q3 revenue. Key points:
       • ...
```

---

## Asking for diagrams

The agent has `mermaid-cli` available via `npx`. Just ask for a diagram.

```
You:   draw a sequence diagram of the OAuth 2.0 authorization-code flow with PKCE
Bot:   _🔧 Write…_   (writes diagram.mmd)
       _🔧 Bash…_    (runs `npx -y @mermaid-js/mermaid-cli -i diagram.mmd -o diagram.png`)
       _🔧 slack_post_file…_   (uploads diagram.png back to the thread)
       Here's the sequence diagram for OAuth 2.0 + PKCE…
```

The PNG appears as an attachment in the thread. Ask follow-up questions — the agent can edit the `.mmd` source and re-render.

Other formats: ask for a flowchart, ER diagram, state diagram, Gantt chart, etc. — Mermaid supports them all.

---

## Sub-agents (the `Task` tool)

The agent can spawn sub-agents for work it wants to delegate. You don't have to do anything special — just ask for things that benefit from parallelism or isolated context.

```
You:   audit each TypeScript file in src/ for any TODO comments and summarize the categories
Bot:   _🔧 Task…_   (spawns a sub-agent per file)
       _🔧 Task…_
       _🔧 Task…_
       _✅ Task_ × 3
       Found 12 TODOs across 3 files. Categories:
       • Type narrowing (5)
       • Error handling (4)
       • Performance (3)
```

Sub-agents inherit the **same consent gate** — if they want to run a destructive command, you'll be prompted just like for the main agent.

---

## Scheduled runs (cron)

The agent can register recurring jobs. Just ask in plain English — the agent translates your phrasing into a cron expression and calls the `cron_add` tool.

```
You:   every weekday at 9am, summarize yesterday's commits in this channel
Bot:   _🔧 cron_add…_
       _✅ cron_add_
       Scheduled `cron_l3m9_k2p1` — `0 9 * * 1-5`
       Channel: <#C123>
       Next run: 2026-05-19T16:00:00Z
```

### What happens when a cron fires

1. The bot posts a fresh top-level message in the target channel: `🕒 scheduled run: <description>` — this becomes the new thread root.
2. A new session is created for that thread with the stored prompt as its first input.
3. The agent runs, streaming output into the thread, with the usual heartbeat reactions on the placeholder message.
4. You (or anyone) can reply in that thread and continue the conversation like any other thread.

The fired prompt has no memory of the conversation that scheduled it — write self-contained prompts.

### Inspecting and removing schedules

```
You:   what crons do I have?
Bot:   _🔧 cron_list…_
       • `cron_l3m9_k2p1` — `0 9 * * 1-5`
         channel: <#C123> · next: 2026-05-19T16:00:00Z
         prompt: summarize yesterday's commits in this channel

You:   cancel that one
Bot:   _🔧 cron_remove…_
       Removed `cron_l3m9_k2p1`.
```

### Cron expression cheatsheet

5 fields: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|---|---|
| `*/15 * * * *` | Every 15 minutes |
| `0 9 * * *` | Daily at 9:00 AM |
| `0 9 * * 1-5` | Weekdays at 9:00 AM |
| `0 9 * * 1` | Mondays at 9:00 AM |
| `0 0 1 * *` | First of each month at midnight |
| `0 17 * * 5` | Fridays at 5:00 PM |

Add a sixth field at the front for seconds (`* * * * * *` = every second), but you'll rarely want that.

You can also specify a timezone: "every Monday at 9am Pacific" → the agent passes `timezone: 'America/Los_Angeles'`.

### Persistence

Schedules are stored in `data/crons.json` and survive bot restarts. When the bot boots, you'll see `⏰ Scheduler active: N crons loaded` if any are registered.

To wipe all crons: stop the bot, delete `data/crons.json`, restart.

---

## Consent prompts (destructive commands)

If the agent wants to run a command that could destroy data, it pauses and posts a message like:

```
:no_entry: Agent wants to run Bash
Reason: removes files (rm)
```rm -rf node_modules```

Reply *yes* / *no* in this thread, or click below.

[Approve]  [Deny]
```

Three ways to respond:

1. **Click `Approve` or `Deny`** — fastest.
2. **Reply in the thread** with `yes` / `y` / `approve` / `ok` (allow) or `no` / `n` / `deny` / `cancel` / `stop` (block).
3. **Do nothing** — after 5 minutes the prompt auto-denies and the agent reports the user declined.

### What triggers a consent prompt

- `rm`, `rmdir`, `unlink`, `shred`
- `find … -delete`
- `mv -f` (force overwrite)
- `git reset --hard` / `--merge`, `git clean -f`, `git push --force` / `-f`, `git branch -D`, `git checkout --`, `git restore .`
- `dd`, `mkfs`, `parted`, `fdisk`, `wipefs`
- `kill -9`
- File truncation via `> filename` (note: append `>>` is allowed)
- Anything prefixed with `sudo`

Read-only commands (`ls`, `cat`, `grep`, `find` without `-delete`, `git status`, `git log`, `npm install`, etc.) never prompt.

### What it doesn't catch

The classifier is conservative — it prefers false positives over false negatives — but it isn't a sandbox. Heredocs, unusual quoting, and clever shell tricks could in principle slip past. Don't invite this bot to channels where untrusted parties can chat with it.

---

## Working directories

By default, each thread gets a sandbox at `sessions/<channel_id>:<thread_ts>/`:

```
sessions/<channel_id>:<thread_ts>/
├── uploads/        # files you attached in Slack
├── ...             # anything the agent writes
```

You can `cd` in there yourself to see what the agent has been doing — generated diagrams, scratch files, etc.

The `sessions/` directory is gitignored. Delete a subdirectory to "reset" a thread (the agent's in-memory session is independent; if the bot is running, you may also want to start a new top-level message).

### Pointing a thread at a real project (CLAUDE.md, etc.)

To make the agent work inside an actual project on disk — picking up its `CLAUDE.md`, repo structure, dependencies, etc. — just ask:

```
You:   work inside /Users/me/code/myproject
Bot:   _🔧 set_workdir…_
       _✅ set_workdir_
       Workdir set to `/Users/me/code/myproject` for this thread. Your next
       message will run there (CLAUDE.md will be reloaded if present).
```

A few notes:

- **The change takes effect on the next message.** The turn that called `set_workdir` continues in the old directory; subsequent messages in this thread use the new one.
- **Per thread.** Each thread has its own workdir override. Switching directories in one thread doesn't affect others.
- **Persistent.** Overrides are stored in `data/workdirs.json` and survive bot restarts.
- **CLAUDE.md is auto-loaded.** Anything the Claude Code CLI normally picks up — `CLAUDE.md`, `.claude/settings.json`, project skills — works when the workdir is a real project root.
- **Switching back.** "Reset workdir" or "go back to the sandbox" → agent calls `reset_workdir`. Or pick a different absolute path.
- **Validation.** The path must be absolute (with `~` expansion) and an existing directory. Relative paths and non-existent paths are rejected.

---

## The custom `slack_post_*` tools

The agent has two custom tools beyond the standard Claude Code surface:

- **`slack_post_message`** — post an extra message into the current thread. Useful for status updates or splitting long outputs.
- **`slack_post_file`** — upload a file from the working directory into the thread. This is how diagrams, generated PDFs, screenshots, etc. get back to you.

You don't call these directly — the agent decides when to use them. If you want the agent to post something, just ask.

---

## Tips

- **Be specific about what you want.** "Write me a PR description for the changes in src/" works better than "review my code."
- **Multi-step tasks are fine.** "Read this PDF, write a summary to summary.md, then post that summary back" is one message. The agent will sequence the tools.
- **Ask for diagrams when explaining systems.** Mermaid output is usually a big win over a wall of text.
- **Use sub-agents for parallel work.** If you have ten files to analyze, ask the agent to spawn sub-agents — it's much faster than serial reads.
- **Restart the bot to wipe state.** Sessions live in memory while `npm run dev` is running. Stopping and restarting clears every session. (Working directories on disk persist until you delete them.)

---

## Billing — API key vs subscription

How usage gets billed depends on which auth path you picked at setup:

- **Subscription** (you ran `npm run login`): turns count against your Claude Pro or Claude Max subscription's quota. No per-token charges. Hitting the daily/weekly cap will surface as a `rate_limit` error in the thread until the quota resets.
- **API key** (`ANTHROPIC_API_KEY` in `.env`): every turn is billed at standard API token rates against the key's organization. Long threads or sub-agent fan-out can add up quickly — keep an eye on the console at <https://console.anthropic.com/>.

To switch between them: edit `.env` (or run `npm run logout` / `npm run login`), then restart `npm run dev`. The startup banner shows which mode is active.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `:eyes:` reaction | Bot isn't running, or isn't invited to that channel. Check the terminal. |
| `:eyes:` but no reply | Anthropic API error — check the terminal logs. Bot will post `:warning: agent error: …` if it can. |
| `❌ No Claude auth configured` at startup | Run `npm run login` (subscription) or set `ANTHROPIC_API_KEY` in `.env` (API key). |
| `authentication_failed` / `oauth_org_not_allowed` | OAuth creds expired or wrong account — `npm run logout` then `npm run login` again. |
| `not_in_channel` errors | Bot needs `/invite @YourBotName` in that channel. |
| `missing_scope` errors | Re-create the app from `slack-manifest.yaml` or add the missing scope by hand, then reinstall. |
| Heartbeat keeps adding emoji forever | Agent is hung; restart `npm run dev`. The session for that thread will reset. |
| Bot replies to its own messages | It shouldn't — the handler filters `bot_id`. If you see this, file a bug. |

For deeper issues, run `./scripts/doctor.sh` to confirm env + auth + typecheck + tests all pass.
