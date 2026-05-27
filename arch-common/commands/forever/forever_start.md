Start the forever runner for LOOP_DIR given by `$ARGUMENTS`. If empty, ask.

Full design contract: `$ARCH_COMMON/forever/README.md`.

## Pre-flight

Abort on any failure. Apply only the safe fixes named.

1. **LOOP_DIR exists and is in a git repo** — `[ -d "$LOOP_DIR" ]` AND `git -C "$LOOP_DIR" rev-parse --show-toplevel`.
2. **No `OBJECTIVE_MET.md`** — if present, abort: "objective met previously; `rm $LOOP_DIR/OBJECTIVE_MET.md` (and likely edit OBJECTIVE.md) before relaunching."
3. **Parent repo is clean** — `git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet`. Untracked files don't trigger; only modified-tracked + staged. Abort with `git -C $REPO_ROOT status` hint — the agent commits each round and dirty state would entangle with its commits.
4. **No live runner** — if `.runner.pid` is alive AND its cmdline matches both `runner.sh` AND `$LOOP_DIR`, abort: "runner already running (pid=N); use `forever_stop` first." If the pid is dead or mismatched, delete the stale pid file. If `.runner.lock/` exists AND `pgrep -f "runner\.sh.*$LOOP_DIR"` returns empty, `rmdir` it. If `pgrep` finds a live orphan runner with no matching pid file, abort: "orphan runner pid=N; stop manually before relaunching."

The runner enforces its own contract beyond this — it'll fail loud if SETTINGS.md is missing a `launcher:` line, if `leader.md` is missing, etc. `forever_start` is just the front door.

## Launch

```bash
mkdir -p "$LOOP_DIR/.logs"
nohup bash "$ARCH_COMMON/forever/runner.sh" "$LOOP_DIR" \
    > "$LOOP_DIR/.logs/runner.log" 2>&1 &
pid=$!
disown
```

The runner writes `$LOOP_DIR/.runner.pid` itself once it has the lock — don't write it from here.

Print: pid, monitor command (`tail -f $LOOP_DIR/.logs/runner.log`), stop command (`/arch-common:forever:forever_stop $LOOP_DIR`).

Also tell the user: **say `status` any time to get a loop status report** (runner liveness, current round, lead-agent context usage, recent errors).

End with `FOREVER_START: pid=<N> LOOP_DIR=<path>` on success, `FOREVER_START: ABORT — <reason>` on abort.

## Establish context

Once the runner is launched, read enough of `$LOOP_DIR` to hold a complete mental model of the project — so later `status` reports and hot-fixes are informed, not blind. Read at minimum:

- `OBJECTIVE.md` — what the loop is trying to achieve and the done condition.
- `LEADERBOARD.md` — the sub-objective table and current cell values.
- `SETTINGS.md` — launcher, memory-prune policy, sub-agent concurrency caps.
- `STATE/TASKS.md` — current scoped task graph with loop-nest + parallelism annotations.
- `STATE/MEMORY.md`, `STATE/SCRATCH.md`, `STATE/ISSUES.md` — durable lessons, in-flight next-round notes, open issues.
- `STATE/ROUNDS.md`, `STATE/LOG.md` — current round/session and recent round history.
- Any other top-level docs in `$LOOP_DIR` (plans, READMEs) the above reference.

Do this read once at startup; don't re-read every round. The point is a baseline so you can answer "what work got done", "what's blocked", and "is this error expected" without re-deriving the project from scratch each time.

## Monitor

Once the flow starts, monitor it for bugs/errors. Hot fix the issues, notify the user and resume the flow.

**Whenever the user asks for status, include the lead agent's current context usage.** Read the `session:` id from `$LOOP_DIR/STATE/ROUNDS.md`, then run `python3 $ARCH_COMMON/scripts/context_length.py <session-id>` and report the measured tokens and percent of window used alongside the rest of the status (runner liveness, current round, recent errors). If the round just rolled over and the transcript for that session does not exist yet, say so rather than guessing.
