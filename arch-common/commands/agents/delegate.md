---
description: "Switch the main agent into aggressive-delegation mode: orchestrate, don't execute. Use when asked to delegate, parallelize, or keep the main context lean for the remainder of a task."
---

For the remainder of the current task, operate as an **orchestrator**. You dispatch work; you do not perform it.

## Arguments

`$ARGUMENTS` = `[<sub-agent list>]`

- **sub-agent list** (optional) — comma-separated sub-agent kinds to employ (e.g. `claude`, `codex`). When omitted, default to `claude`.

Print the resolved sub-agent list before starting.

**The sub-agent list is binding — you MUST obey it.** Dispatch *only* to the listed kinds. If the list is `codex`, dispatch every sub-task to codex and spawn no `claude` `Task` sub-agents. If the list is `claude`, use `Task` exclusively and shell out to no codex sub-agents. Never substitute one kind for another because it seems more convenient, faster, or better-suited — the directive overrides your own judgment about which kind to use. If a sub-task genuinely cannot be done by any listed kind, stop and tell the user rather than silently reaching for an unlisted kind.

---

## Mandate

1. **Delegate all work.** Every self-contained sub-task — reading, searching, writing, building, testing, probing — goes to a sub-agent. The main agent only decomposes, dispatches, integrates results, and commits.
2. **Minimize main-agent context.** Never read whole files, run broad searches, or ingest large outputs in the main context. Sub-agents return compact structured reports; funnel large output through `/tmp/<run>_<id>.log` scratch files and have the sub-agent summarize.
3. **Exploit parallelism.** Dispatch independent sub-tasks concurrently to cut wall-clock time. Serialize only on a genuine data dependency — the output of one sub-task being the input of the next.
4. **Self-contained prompts.** Each sub-agent sees none of the main conversation. Bake every file path, line number, command, output location, and decision point into the prompt. State read-only vs. write mode explicitly.

A sub-task is delegable when its inputs and outputs are fully specifiable upfront. If it is not yet self-contained, the main agent's job is to *make* it so — by decomposing — not to do it directly.

---

## Sub-agent mechanisms

- **`claude`** — spawn with the `Task` tool. Inherits the main agent's tool affordances (read, write, shell). Foreground when the result blocks the next step; background otherwise.
- **`codex`** — shell out to a codex sub-agent, backgrounded. Runs in a separate process with no access to the conversation. Follow `/arch-common:agents:codex` for the invocation template, prompt discipline, and reaping rules — it is the single source of truth. Codex calls are non-blocking; keep orchestrating while they run.

---

## Working-tree safety

The main agent and all sub-agents share one working tree.

- **Read-only sub-agents** are parallel-safe and never touch the tree.
- **Parallel writers must partition by file** — never two sub-agents editing the same file concurrently. Coupled changes go to one writer with the coupled set.
- **Writers don't commit.** They return a structured report (files changed, lines touched, suggested message). The main agent validates with `git status` / `git diff` against the reports, then commits.
- **Probes that write artifacts** (waveform dumps, bisect logs) are not automatically parallel-safe — assign each a non-overlapping `/tmp/<run>_<id>.log` or test partition.

---

## Completion

Before reporting done, confirm every dispatched sub-agent has returned, every writer's diff is integrated, and validation criteria are met — then summarize outcomes compactly.
