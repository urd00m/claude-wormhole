---
description: "Single source of truth for shelling out to a codex sub-agent. Use when dispatching work to codex — the canonical invocation template, load-bearing flags, prompt discipline, and reaping rules."
---

This skill is the **single source of truth** for invoking a codex sub-agent. Any other skill, command, or template that dispatches to codex must defer here rather than restating the mechanics.

A codex sub-agent is a fresh `codex` CLI invocation, run in a separate process and backgrounded with `&`. It shares the working tree but sees none of the dispatching agent's conversation.

---

## Invocation template (verbatim)

Substitute only the prompt text and the `/tmp/` log path:

```bash
codex exec --skip-git-repo-check -m gpt-5.5 -s danger-full-access \
    -c 'model_reasoning_effort="xhigh"' \
    "<self-contained prompt>" </dev/null > /tmp/codex_<id>.log 2>&1 &
```

- **`</dev/null`, `-s danger-full-access`, and `--skip-git-repo-check` are load-bearing.** Without `</dev/null` codex hangs on stdin; without `-s danger-full-access` it prompts for permissions; without `--skip-git-repo-check` it refuses to start when the cwd is not a codex-"trusted" directory (`Not inside a trusted directory and --skip-git-repo-check was not specified.`) — a fast 0-edit failure, since a backgrounded sub-agent's cwd is not guaranteed trusted. Never drop them.
- **Model and effort are tunable.** `-m` and `model_reasoning_effort` may be retuned for cost / latency trade-offs. The load-bearing flags above must not change.
- **`exec` is required** for programmatic dispatch — it is the non-interactive subcommand. (Bare `codex` is interactive; see `templates/shell_alias.md` for the human-facing `om` alias.)
- **One `/tmp/` log per call.** Give every concurrent codex call a non-overlapping `/tmp/codex_<id>.log` so parallel calls don't clobber each other.

---

## Prompt discipline

Codex sees none of the dispatching agent's conversation. The prompt must be **fully self-contained**.

- **Don't forward claude prompts verbatim** — they imply `Task` / write affordances codex doesn't have.
- **State read-only vs. write mode explicitly.**
- **Bake in critical/load-bearing file paths.** 
- **Prescribe the answer shape.** A schema like "answer V1..VN with CONFIRMED / DISPUTED / INCONCLUSIVE plus 1-2 lines each" is sturdier than a free-form question.

---

## Reaping and non-blocking discipline

Codex calls are **non-blocking — never serialize on them.**

- Launch with `&`; keep working in the dispatching context while codex runs.
- **Detect completion with `wait "$PID"`** once the output is needed for the next decision. **Never** poll by grepping the log for a marker line — content-grep predicates wedge.
- `wait` only when the result actually feeds the next step. Serial "issue codex; sit idle; then resume" wastes the wall-clock budget the parallel call was supposed to be free against.
- After `wait`, read the `/tmp/` log for the result. If the log is empty or truncated, treat the call as failed — re-dispatch or proceed without it; do not block.
