---
description: "Deduce and report the CALLER's Claude Code context length by reading its session transcript's API usage. Use when asked how full the context window is, how many tokens are in use, or how much room is left."
---

Claude cannot introspect its own context window mid-turn — the model has no
token count of itself. But the Claude Code session transcript records the exact
API `usage` block for every assistant turn, and that is the ground truth. This
command reads it back so the number lands in the context window as a tool
result.

## Method

The prompt token count the model saw on a turn is the sum of three `usage`
fields: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
That sum is the **entire** context — system prompt, tool schemas, skills,
memory, and the full conversation — metered by the API, not estimated. The most
recent assistant turn's sum is the context length as of that turn.

The reading is only meaningful for the **caller's own** session. The tool
therefore identifies the session **explicitly** — it never picks a transcript
by file mtime, because any other concurrently-running Claude session (a second
agent loop, an interactive session) would otherwise silently win that guess and
the tool would report a stranger's context.

How the session is resolved:
- **`SESSION_ID` passed explicitly** → reads `~/.claude/projects/*/<SESSION_ID>.jsonl`.
- **`SESSION_ID` omitted** → inferred from `$CLAUDE_CODE_SESSION_ID`, which
  Claude Code exports into every Bash-tool subprocess. A bare invocation
  therefore measures exactly the caller that ran it.
- If neither yields a session, the tool **errors** rather than guess.

Caveats the tool already accounts for:
- **One-turn lag.** The turn being generated now is not in the transcript yet;
  `estimated_next_prompt` adds the last output as a tight lower bound.
- **Compaction.** Each turn's usage is that turn's real prompt, so the latest
  reading is already post-compaction. `peak_prompt` is reported so a drop from
  peak makes a compaction visible.
- **Window size.** `claude-opus-4-7[1m]` is a 1M-token window; the transcript
  omits the `[1m]` tier suffix, so 1M is the default. Pass `--window 200000`
  for a 200k-tier session.

## Steps

1. Run the tool. With no argument it measures the caller's own session via
   `$CLAUDE_CODE_SESSION_ID`:

   ```bash
   python3 ../arch-common/scripts/context_length.py
   ```

   To measure a specific session, pass its id as the first argument:

   ```bash
   python3 ../arch-common/scripts/context_length.py <SESSION_ID>
   ```

   This is the canonical sibling-directory layout (see
   [common_tools.md](../common_tools.md)). If `arch-common` is not a sibling of
   the current repo, use the absolute path to `scripts/context_length.py`
   instead. Add `--json` for a machine-readable block, `--window N` to override
   the window (e.g. `--window 200000` for a 200k-tier session), `--project
   <dir>` to pin a specific `~/.claude/projects/` subdirectory, or
   `--transcript <path>` to read an explicit transcript file.

2. Report to the user: measured context tokens, percentage of the window used,
   and estimated tokens remaining. If the tool prints the compaction note,
   relay it.

3. If the tool errors (cannot determine the session, no transcript, no
   assistant turn yet), say so plainly — do not guess a number. A guessed
   context length is worse than "cannot determine."
