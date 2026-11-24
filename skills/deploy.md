# Deploy Wormhole changes together

Use for an authorized Wormhole rollout prepared outside the running checkout.
Preserve persistent sessions; install the complete change while the bot is stopped.

1. Record the live revision, dirty files, service, state directory, identity anchor,
   and session identities. Prepare an isolated temporary checkout matching the
   intended live baseline, including relevant uncommitted changes. Leave live files
   untouched while developing; keep unrelated work out of the patch and commit.
2. Run typecheck and relevant tests there. Package one complete patch, expected
   before/after file hashes, validation results, and rollback copies. Include new
   files. Save deployment instructions and logs outside disposable staging paths.
3. Preflight the live hashes and `git apply --check`; stop if the baseline changed.
   Read the current shutdown path and service configuration before scheduling stop.
4. From a Wormhole thread, launch an independent deployment job so graceful shutdown
   can wait for the initiating reply. Record its status path before ending the turn.
5. Gracefully stop the service and wait for accepted turns and workers to drain.
   Do not force-kill or impose a drain timeout. Confirm no in-flight bindings or
   running deliveries remain; recheck hashes and patch applicability after stopping.
6. Back up SQLite consistently, its identity anchor, and bindings to persistent
   storage. Apply the full patch once while stopped; verify installed file hashes.
   Never reset the state database, provider homes, native transcripts, or bindings.
7. Restart with the same state directory. Verify service and Slack startup, installed
   hashes, and every existing thread's runtime, native ID, workdir, provider home,
   and started flag. Save a deployment report with checks and backup/rollback paths.

Inspect `src/index.ts`, `src/agent/continuityStore.ts`, and `scripts/test.sh` for the
current drain, persistence, and isolated test setup. If installation fails, restore
only this patch's files before restarting. If startup verification fails, drain
before rollback; preserve current session state rather than restoring an older DB.
Report success only after verification; distinguish scheduled, draining, and complete.
