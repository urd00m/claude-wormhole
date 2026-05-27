---
description: "Single source of truth for running commands and moving files on a remote machine over ssh — non-interactive invocation, fresh-shell discipline, long-job detachment, and cross-OS hazards. Use when any task involves ssh, rsync/scp, or a remote/cluster machine."
---

This skill is the **single source of truth** for driving a remote machine over ssh. Any
skill, command, or sub-agent prompt that reaches a remote host must follow the mechanics
below rather than restating them.

Throughout, `<user>@<host>` is a placeholder for the target machine — this skill is
machine-agnostic. Substitute the real values; never hard-code one host's assumptions.

---

## Non-interactive invocation

```bash
ssh -o BatchMode=yes <user>@<host> '<cmd>'
```

- **`-o BatchMode=yes` is load-bearing.** It makes ssh fail fast instead of hanging
  forever on a password/passphrase prompt when key auth is not set up. Never omit it in
  scripted or sub-agent use — a hung ssh wedges the whole task.
- This assumes **key-based auth** is configured for the host. If a `BatchMode` connection
  fails, fix the auth (`ssh-copy-id`, ssh-agent, `~/.ssh/config`) — surface that as the
  blocker; do not paper over it with blind retries.

---

## Each ssh call is a fresh shell

A separate `ssh` invocation starts a brand-new shell. **Nothing persists between calls** —
not `export`ed env vars (`PATH`, `LD_LIBRARY_PATH`, …), not `cd`, not shell variables.

- Chain everything that depends on shared state into **one** invocation:
  ```bash
  ssh -o BatchMode=yes <user>@<host> 'export PATH=/opt/tool/bin:$PATH && cd /work && make'
  ```
- For anything non-trivial, **write a script and run it** rather than building a giant
  one-liner: `scp job.sh <user>@<host>:/tmp/ && ssh ... 'bash /tmp/job.sh'`, or stream it
  with `ssh ... 'bash -s' < job.sh`.

---

## Quoting

- In `ssh <host> '<cmd>'` the outer single quotes are consumed by the **local** shell;
  `<cmd>` runs verbatim on the remote. A `$VAR` inside single quotes expands **remotely**.
- To expand a variable on the local side you must break or switch quoting — this gets
  fragile fast. **When nesting quotes starts to hurt, stop: put the command in a file and
  ship it.** Nested-quote debugging is never worth the time.

---

## Long-running remote commands

An interactive ssh session can drop (network blip, idle timeout) and take its foreground
command down with it. For anything slow — builds, batch jobs, captures — **detach it on
the remote**:

```bash
ssh -o BatchMode=yes <user>@<host> 'cd /work && nohup ./long_job.sh > /work/job.log 2>&1 &'
```

Then **poll** by reconnecting:

- Detect completion via **process liveness** (`kill -0 <pid>`, `pgrep`) or a **sentinel
  status file** the job writes on exit — **never** by grepping the log for a marker line.
  A content-grep predicate wedges if the job stalls before emitting the marker.
- Have the job **write progress and results to a file as it goes**, so a dropped
  connection never loses state.

---

## File transfer

- **`rsync -a <src>/ <user>@<host>:<dst>/`** — preferred for directory trees. `-a`
  preserves timestamps; this matters because `make`'s up-to-date logic depends on mtimes.
  Add `--info=progress2` for progress. Mind the trailing-slash semantics on `<src>`.
- **`--exclude '<pat>'`** to skip artifacts (see cross-OS hazards below). `--delete`
  mirrors the destination — powerful and destructive; be certain before using it.
- **`scp <file> <user>@<host>:<dst>`** for a single file.
- After any transfer, **verify on the remote**: `du -sh`, file counts, `df -h`.

---

## Cross-OS hazards (when local and remote OSes differ)

The biggest source of silent failure. A file that synced fine may be useless on the
other OS.

- **Compiled binaries do not cross OS or architecture.** macOS Mach-O ≠ Linux ELF; an
  executable, `.dylib`/`.so`, `.a`, or `.o` built on one platform will not run or link on
  another. Rebuild it natively on the remote, or fetch the correct platform's release.
- **Sync sources, not build outputs.** Exclude `obj_dir/`, `*.o`, `*.a`, `*.so`,
  `*.dylib`, and prior executables. Stale *foreign* build artifacts are doubly harmful:
  with newer mtimes they poison `make`, which skips the rebuild and then links
  incompatible objects. Keep sources, generated code/filelists, and JVM `.jar`s (those
  are bytecode — portable).
- **Env var names differ:** macOS `DYLD_LIBRARY_PATH` vs Linux `LD_LIBRARY_PATH`.
- **Tool flags differ (BSD vs GNU):** `stat -f` (macOS) vs `stat -c` (Linux);
  `sed -i ''` vs `sed -i`. Write portable commands or branch on `uname`.
- **Embedded absolute paths:** generated files and makefiles may hard-code build-host
  paths. After syncing to a host with a different layout, scrub or parameterize them.

---

## Remote scratch / disk discipline

Cluster machines often expose a large **machine-local scratch volume** — fast, but
typically **purgeable and not backed up**.

- Do heavy work (builds, large intermediate data) on scratch; never on a small networked
  home volume that can fill.
- **Anything you must keep — results, commits, fixes — must be copied off scratch**
  before the run ends: push to a remote, or `git bundle` it back. Treat scratch as
  volatile.
- Monitor `df -h <volume>` during anything that writes a lot; reclaim space as you go.

---

## Git over ssh

- A repo cloned from a **local bundle file** has its `origin` set to that bundle — you
  **cannot push** to it. To preserve commits made on a remote machine: either add the
  real upstream remote and push, or `git bundle create` and copy the bundle back to a
  durable host.
- **Bundling back is not the finish line.** When commits are bundled back to the local
  machine, the task is not complete until that bundle is extracted there (`git fetch
  <bundle>`) and the changes are committed/pushed on the local machine, following the
  commit/push protocol established for the session (branch policy, message conventions,
  confirm-before-push). A bundle sitting on disk is not committed work.
- Advancing a non-checked-out branch with `git branch -f <branch> <ref>` updates the ref
  without a checkout — it touches no working-tree files, so it is safe even when the
  working tree has unrelated uncommitted changes.
