Initialize a forever loop directory at the path given by `$ARGUMENTS`. By the time this command finishes, every ALL CAPS file is fully populated with substantive user content; the loop is ready for `forever_start`.

If `$ARGUMENTS` is empty or unclear, ask the user where LOOP_DIR should live. LOOP_DIR must be inside a git repository (the agent commits to it on every round). If the chosen path is not inside a git repo, stop and ask the user to either pick a different path or `git init` the parent first.

This command produces the file scaffolding the runner needs. It does **not** start the runner. After this command finishes, the user starts the loop with `forever_start`.

Full design contract: `$ARCH_COMMON/forever/README.md`.

---

## Hard rules

1. **Ask the user about every substantive field** — OBJECTIVE statement, success threshold, leaderboard table shape and contents, leaderboard update rules, sub-agent concurrency and types. Use `AskUserQuestion`. Refuse silent defaults; keep asking until the user gives a real answer. If the user can't answer a substantive field, abort the init — better to come back when the user is ready than ship a half-scaffolded loop.
2. **Ready-to-run contract.** When this command finishes, OBJECTIVE.md / SETTINGS.md / SAGENTS.md / LEADERBOARD.md must contain the user's substantive content (no *template-placeholder* angle-bracket text remaining — distinct from *recipe metavariables* that the lead is meant to substitute at dispatch time, such as `<HOST>` / `<USER>` / `<REMOTE_SCRATCH>` in the ssh execution-environment template, or `<remote cmd>` / `<src>` / `<dst>` / `<long_cmd>` / `<id>` / `<marker>` in the ssh recipe block — those are preserved verbatim so the lead has working templates to fill in per dispatch), and STATE/MEMORY.md / STATE/TASKS.md / STATE/SCRATCH.md / STATE/ISSUES.md must contain their canonical empty bodies. The next step is `forever_start`, with no human edits required in between.
3. **Do not start the runner from this command.** Print the start command for the user.
4. **Single source of truth.** The runner and leader prompt (`leader.md`) live in `$ARCH_COMMON/forever/` and are referenced by absolute path. Do not copy them into LOOP_DIR.

## Inputs

- `$ARGUMENTS` — path to LOOP_DIR. Relative or absolute. If empty, ask.

## Pre-flight checks

1. `$ARCH_COMMON/forever/runner.sh` exists. Abort otherwise — `arch-common` is not installed as a sibling of the project dir.
2. LOOP_DIR's parent is inside a git repository (`git -C <parent> rev-parse --show-toplevel`). Abort otherwise.
3. LOOP_DIR does NOT already contain `OBJECTIVE.md`. If present, abort — do not overwrite.

## Interactive elicitation

Ask each via `AskUserQuestion`. Group related questions when natural; do not bundle them all into one mega-question.

### 1. Objective

> "What is the top-level objective for this loop? State it in 1–2 sentences, the way you'd want the agent to read it on every round."

If vague, ask a follow-up: what would success *look* like (a passing test, a metric reaching a threshold, a property holding)? Iterate until substantive.

### 2. Success threshold

> "What's the criterion that, when met, makes the loop done? It must be unambiguously decidable from the LEADERBOARD state — that's how the agent decides when to write OBJECTIVE_MET.md."

Examples: "every LEADERBOARD row has functional_pass=true", "cycle count ≤ 12000 on benchmark X", "coverage ≥ 95%".

### 3. Leaderboard shape and contents

> "How would you like to break the objective into sub-objectives? Sketch the leaderboard table — what are the rows, what are the columns, and what does each cell measure? Provide initial values for any cells you already know; use `?` for unmeasured cells."

The user owns the shape. Don't prescribe rows or columns.

Then ask about column polarity for any non-standard column (what direction is "better"). Standard conventions don't need declaration; only call out non-obvious columns.

### 4. How to update the leaderboard

> "How does the agent populate the leaderboard? For each column (or per row, if rules vary), tell me: what command produces the cell value, how to parse the output, and when a cell should be reset to `?` (e.g. after a code change that invalidates a measurement). Cell-coupling rules are welcome — e.g. 'if a merge touches paths matching X, reset cells matching Y'."

This is substantive — refuse silent defaults. Without these rules, the agent has no binding contract for cell writes; the loop is unable to make measurable progress. Drill in until the user gives concrete commands and parse rules. If the user can't answer, abort the init per Hard rule 1.

### 5. Sub-agents

The lead is primarily a dispatcher. The numeric concurrency caps live in `SETTINGS.md § Sub-agent concurrency` (elicited here as 5a — recorded into SETTINGS.md, NOT SAGENTS.md). The per-loop dispatch protocol's loop-specific content — what *types* of sub-agents the lead dispatches and what each handles — lives in `SAGENTS.md`'s `## Sub-agent tactics` section (elicited here as 5b — recorded into SAGENTS.md). The rest of SAGENTS.md (mechanisms, codex dispatch, writer protocol, working-tree safety) is loop-agnostic boilerplate.

**5a. Concurrency caps.** Ask three numbers:

> "Sub-agent concurrency caps. (1) How many sub-agents total should the lead aim to keep in flight at once (claude Tasks + codex shell-outs combined)? Typical range 2–16; 4 is a sound default. (2) Sub-cap on concurrent claude `Task` agents (typically scarcer)? (3) Sub-cap on concurrent codex `exec` shell-outs (cheaper to fan out)? All three are targets, not hard quotas — the lead fills spare slots with parallelizable work but never manufactures low-confidence work."

Record three integers; written to `SETTINGS.md` as `num_max_sub_agents:`, `max_claude_tasks:`, `max_codex_shellouts:`. Constraint to verify with the user if it doesn't hold: `max_claude_tasks + max_codex_shellouts >= num_max_sub_agents` (each mechanism's cap alone should be able to absorb the total cap, so the lead can flexibly partition work across mechanisms when one type dominates).

**5b. Sub-agent types.** Ask, offering the four standard dispatch modes as defaults:

> "What types of sub-agents should the lead dispatch? The four standard modes are: (1) **read-only audit** — claude `Task` for synthesis-heavy reads, codex `exec` for methodical enumeration / coverage walks; (2) **second opinion** — codex `exec` for an independent counter-hypothesis on high-stakes decide / falsify points; (3) **mechanical writer** — codex `exec` for bounded refactors / regex sweeps / mechanical fixes / test loops; (4) **semantic writer** — claude `Task` for code writes requiring judgment. Keep all four, drop any that don't fit this loop, or add loop-specific types. For each type, confirm its mechanism (claude `Task` or codex `exec`) and the work it handles."

Most loops keep all four. Capture the final list — each type needs a name, a mechanism, and a one-line scope. Written to `SAGENTS.md § Sub-agent tactics`.

### 6. Execution environment (ssh / remote)

> "Does this loop do its work on a remote machine over ssh? If yes, the agent (and every sub-agent it dispatches) needs to be told that explicitly, and a canonical ssh / rsync recipe will be baked into SAGENTS.md so it doesn't have to be rediscovered each round."

Offer three options:

- `(a)` All work runs locally — skip the ssh recipe.
- `(b)` All work runs on a remote machine over ssh — inject the ssh execution-environment section into SAGENTS.md.
- `(c)` Mixed — most work runs on a remote machine, some runs locally (e.g. codex is local). Inject the ssh section with a "mixed" note.

If `(b)` or `(c)` is chosen, ask a follow-up for **remote host details**:
- hostname (FQDN, e.g. `a26.millennium.berkeley.edu`)
- username (e.g. `cwfletcher`)
- optional remote scratch directory root (e.g. `/scratch/<user>/<project>` — used in the rsync recipe template; leave blank to keep the placeholder `<REMOTE_SCRATCH>` in the injected text)

Record the captured choice and host details — they are used by the SAGENTS.md write step below to optionally inject an `## Execution environment` section at the top of the generated SAGENTS.md.

### 7. Launcher

Propose-and-confirm the default:

```
claude --plugin-dir ../arch-common --dangerously-skip-permissions --print --effort xhigh --model claude-opus-4-7'[1m]'
```

Don't modify the launcher unless the user asks.

## What to write

Create `LOOP_DIR/` and these files, in this order. Substitute user content where the template has a placeholder; remove every angle-bracket placeholder line before writing.

### `LOOP_DIR/OBJECTIVE.md`

The "Asynchronous work — the canonical recipe" section is baked-in boilerplate — write it verbatim, no elicitation needed. It applies to every forever loop because every loop eventually backgrounds some job (validation runs, builds, codex shell-outs, probes) and needs a reaping discipline. Production loops have wedged for hours on content-grep polling predicates and on un-drained harness Bash tasks; this section points the lead at the consolidated PERMANENT MEMORY entry that prevents that class.

```markdown
# Objective

<the user's 1–2 sentence statement, verbatim>

## Success threshold

<the user's success criterion>

## How to update the leaderboard

<the user's update rules from elicitation question 4, verbatim. Cover: command per column/row, output parse rule, reset-to-`?` triggers, any cell-coupling rules.>

## Asynchronous work — the canonical recipe

Every non-trivial shell-out (codex exec, builds, simulations, probes, validation
sweeps, rsync, remote ssh jobs) follows the recipe documented in
`STATE/MEMORY.md`'s PERMANENT entry on async shell-outs:
`cmd > log 2>&1 & PID=$!; <next move>; wait $PID; parse log; KillShell`.

That entry is mandatory PERMANENT memory and carries the full DO/DON'T
breakdown (anti-patterns: foreground launch, idle-wait, poll-output-for-marker,
skip-KillShell). Read it at round start; follow it verbatim every round.

## Notes

This file is **human-only**. The agent does not write to it. Edits take effect on the next round (live-reload).
```

### `LOOP_DIR/SETTINGS.md`

Copy `$ARCH_COMMON/forever/templates/SETTINGS.md` verbatim, then make two substitutions from the elicitation answers:

1. Replace the `launcher:` line with the user's confirmed launcher (from question 7).
2. Replace the three `## Sub-agent concurrency` values with the integers captured in question 5a:
   - `num_max_sub_agents:` (total cap)
   - `max_claude_tasks:` (claude Task sub-cap)
   - `max_codex_shellouts:` (codex shell-out sub-cap)

Verify the invariant `max_claude_tasks + max_codex_shellouts >= num_max_sub_agents` and ask the user to reconcile if it doesn't hold (otherwise the lead can never reach the total cap regardless of work mix).

Other SETTINGS keys (`memory_prune_after_rounds`) keep their template defaults unless the user explicitly asked to tune them.

### `LOOP_DIR/SAGENTS.md`

Copy `$ARCH_COMMON/forever/templates/SAGENTS.md`, keeping every static section verbatim. The only fill-in is the `### Types` subsection under `## Sub-agent tactics` — replace its angle-bracket placeholder with the content below, built from elicitation question 5b. The sibling `### Concurrency` subsection is already populated in the template (it just points at `SETTINGS.md § Sub-agent concurrency`) and is loop-agnostic; do NOT rewrite it. Numeric caps come from 5a and are written to SETTINGS.md per § `LOOP_DIR/SETTINGS.md` below.

```markdown
### Types

<one numbered entry per type from 5b, each as `**<name>** — <mechanism> for <one-line scope>.`, where `<mechanism>` is claude `Task` or codex `exec`>

<if the second-opinion type is kept, add this line after the list — otherwise omit it:>
**Always use codex for a second opinion. It is a free available resource for improving result quality.**
```

This is the per-loop sub-agent dispatch protocol — the agent treats it as gospel for `leader.md § Execute`. Humans tune dispatch by editing this file between rounds; the agent never writes here.

If the user picked `(b)` or `(c)` in elicitation question 6, **prepend** an `## Execution environment` section to the generated SAGENTS.md, placed **before** the existing `## Sub-agent tactics` section (i.e. immediately after the file's intro paragraph and before any other `##` heading). Substitute the user's captured `<HOST>`, `<USER>`, and `<REMOTE_SCRATCH>` (leave `<REMOTE_SCRATCH>` literal if the user didn't provide one). For option `(c)`, keep the trailing "Some sub-agent mechanisms (e.g. codex) may run locally — note this explicitly in their dispatch prompts." sentence; for option `(b)`, omit it.

````markdown
## Execution environment

**All work runs on `<HOST>` over ssh.** This applies to the lead and to *every* sub-agent — both claude `Task` and codex `exec` shell-outs. Builds, simulation, validation, audits, probes — all of it executes on `<HOST>`, not the local host.

- Follow the `/arch-common:misc:ssh` skill verbatim for every remote invocation — non-interactive invocation, fresh-shell discipline, long-job detachment, file movement (rsync/scp). It is the single source of truth; do not improvise ssh usage.
- Every sub-agent dispatched (claude `Task` or codex) must be told in its prompt to do its work on `<HOST>` over ssh per the `/arch-common:misc:ssh` skill. The lead must not assume a sub-agent will infer this — state it explicitly in each dispatch.
- Local-host work is limited to orchestration: reading/writing this loop's state files, composing commits, dispatching sub-agents. <if MIXED: append: "Some sub-agent mechanisms (e.g. codex) may run locally — note this explicitly in their dispatch prompts.">

### ssh recipe

```bash
# Non-interactive ssh invocation (write the command literally, do NOT put the ssh string in a shell var — word-splitting fails):
ssh -o BatchMode=yes -o LogLevel=QUIET <USER>@<HOST> '<remote cmd>'

# rsync local → remote (per-file or per-dir; never use --delete):
rsync -az -e 'ssh -o BatchMode=yes -o LogLevel=QUIET' <src> <USER>@<HOST>:<REMOTE_SCRATCH>/<dst>

# Detached long jobs on remote (so the round can end without orphaning the job):
ssh -o BatchMode=yes -o LogLevel=QUIET <USER>@<HOST> 'nohup <long_cmd> > /tmp/<id>.log 2>&1 & disown; echo PID=$!'
```

Common pitfalls:
- DPI / IPC markers on the remote do NOT appear on the local filesystem — poll them via `ssh ... 'test -f /tmp/<marker>'` or use the PERMANENT-MEMORY `wait $PID` recipe with `wait` blocking on the local ssh process.
- Capturing remote stdout to a local file via `ssh ... > /tmp/local.log`: stderr stays on the remote unless you also redirect 2>&1 on the remote side or pull it back explicitly.
- Long-running remote builds: use the `nohup ... & disown` pattern above so the ssh process can exit; reap the marker / artifact via a follow-up ssh call.
````

### `LOOP_DIR/LEADERBOARD.md`

Copy the template (intro + `## Cell format` section verbatim from `$ARCH_COMMON/forever/templates/LEADERBOARD.md`), then fill in the `## Polarity` and `## Table` sections with the user's content:

```markdown
# Leaderboard

(... intro paragraph + `## Cell format` section, verbatim from the template ...)

## Polarity

<bullets per non-standard column the user declared, or `(none)` if every column maps to a standard convention>

## Table

<the user's table, verbatim shape, with the user's known initial values and `?` in any cell the user did not provide one for>
```

### `LOOP_DIR/STATE/`

Create the `STATE/` subdir, then copy these six files from `$ARCH_COMMON/forever/templates/STATE/` verbatim — the agent's durable + ephemeral state lives under here.

- `LOOP_DIR/STATE/MEMORY.md` — durable cross-round insights.
- `LOOP_DIR/STATE/TASKS.md` — current scoped task graph with loop-nest + parallelism annotations (read in full at round start, rewritten at round end, completed items pruned).
- `LOOP_DIR/STATE/SCRATCH.md` — ephemeral notes for next round.
- `LOOP_DIR/STATE/ISSUES.md` — open-only bug tracker (humans may also append entries). Resolved entries are removed.
- `LOOP_DIR/STATE/LOG.md` — append-only forensic record. The agent appends one round-end entry per round (with required `### Sub-agent report` and `### Context and time` blocks) and never reads it.
- `LOOP_DIR/STATE/ROUNDS.md` — runner-managed round counter, initialized to `0`. The runner increments it at the start of each round; the agent reads it for MEMORY voting/pruning.

### `LOOP_DIR/.gitignore`

Copy `$ARCH_COMMON/forever/templates/LD.gitignore` to `$LOOP_DIR/.gitignore` verbatim. Excludes `.logs/`, `.runner.lock/`, `.runner.pid`.

### `LOOP_DIR/.logs/`

Create the directory. Runner writes to it on first round. Gitignored.

## Post-write summary to the user

Print a concise summary:

1. Path to LOOP_DIR.
2. Files written.
3. **Ready to run.** Start command: `/arch-common:forever:forever_start <LOOP_DIR>`. Stop command: `/arch-common:forever:forever_stop <LOOP_DIR>`.
4. Hand-editable during a run:
   - `OBJECTIVE.md` — goal, success threshold, leaderboard update rules.
   - `SETTINGS.md` — launcher, prune horizon, sub-agent concurrency caps.
   - `SAGENTS.md` — sub-agent dispatch protocol (types + mechanisms + writer protocol + working-tree safety; gospel for `leader.md § Execute`). Numeric concurrency caps live in SETTINGS.md, not here.
   - `LEADERBOARD.md` — table shape and polarity (cells are agent-owned).
   - `STATE/ISSUES.md` — file-it-yourself bugs/improvements.

   `STATE/MEMORY.md` and `STATE/SCRATCH.md` are agent-owned; humans can read but should avoid editing. `STATE/LOG.md` is append-only and `STATE/ROUNDS.md` is runner-managed — neither should be hand-edited.

   The agent's round-end update protocol for every ALL CAPS state file lives in `$ARCH_COMMON/forever/update_rules.md` (shared across all loops; not copied into LOOP_DIR). Edits there take effect on the next round for every running loop.

## What this command does NOT do

- Does not start the runner — `forever_start` does.
- Does not commit anything — whether LOOP_DIR is committed to the parent repo is the user's decision; suggest it but don't act on it. (`forever_start` doesn't require it; untracked LOOP_DIR contents don't trigger its dirty-tree check.)
