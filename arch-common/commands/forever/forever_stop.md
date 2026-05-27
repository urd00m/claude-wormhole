Stop the forever runner for LOOP_DIR given by `$ARGUMENTS`. SIGTERM, wait, report. If empty, ask.

Full design contract: `$ARCH_COMMON/forever/README.md`.

## Procedure

```bash
pid_file="$LOOP_DIR/.runner.pid"
[[ ! -f "$pid_file" ]] && { echo "no .runner.pid; nothing to stop"; exit 0; }
pid="$(cat "$pid_file")"
if ! kill -0 "$pid" 2>/dev/null; then
    echo "stale .runner.pid (pid=$pid not alive); nothing to stop"
    exit 0
fi
cmdline="$(ps -o command= -p "$pid" 2>/dev/null)"
if ! grep -q 'runner\.sh' <<< "$cmdline" || ! grep -qF "$LOOP_DIR" <<< "$cmdline"; then
    echo "REFUSE: pid=$pid does not match runner.sh for $LOOP_DIR — pid file is stale or compromised" >&2
    ps -o pid,command= -p "$pid" >&2
    exit 1
fi

kill -TERM "$pid"
deadline=$(( $(date +%s) + 60 ))
while kill -0 "$pid" 2>/dev/null; do
    (( $(date +%s) >= deadline )) && break
    sleep 1
done
```

The runner forwards TERM to its in-flight round's process group, gives 30s grace then SIGKILLs survivors, then releases its lock and exits.

**Never SIGKILL the runner from this command.** If the runner is still alive past 60s, surface for the user — likely a wedged round or a runner bug. Inspect `ps -o pid,ppid,command= -p $pid` and `pgrep -P $pid` before any `kill -9`.

End with one of:

`FOREVER_STOP: LOOP_DIR=<path> stopped=yes pid=<N>`

`FOREVER_STOP: LOOP_DIR=<path> stopped=no pid=<N> reason=<deadline|cmdline-mismatch|already-stopped>`
