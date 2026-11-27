# Session handoff

Use for a user-authorized move to a replacement assistant in the same Slack thread.
Carry reviewed context forward; preserve the original session and restriction records.
Use `skills/reviewed-handoff.md` to prepare that context. A session move must not
bypass a safety stop or automatically retry rejected work.

1. Identify the thread key, native session ID, workdir, provider home, launch config,
   and current failure. Confirm the target has no active turn, creation, queued
   delivery, or resident worker, and Wormhole is not draining.
2. Make a SQLite online backup and save the original binding, all session identities,
   and an opaque transcript backup with hashes in a persistent recovery directory.
3. Write a concise handover from visible history: current task, verified facts with
   observation dates, relevant paths, budgets, permissions, and outstanding errors.
   Exclude private reasoning and automatic replay of tool calls or rejected work.
4. Review the destination task. Stop on rejection.
5. Initialize a provider-minted replacement using the same workdir, provider home,
   model, and permissions. Load the reviewed handover; perform a read-only recall
   check, then resume that same ID once without resupplying context to verify recall.
6. Recheck the original binding and idle conditions immediately before switching.
   Use the live manager/store APIs together, not a database-only edit: archive and
   unload the original, install the replacement binding, then reload the session.
   Keep the Slack thread key, launch config, and cyber-rejection timestamp intact.
7. Verify durable binding and live cache agree, native identity is valid, other
   sessions are unchanged, and the original transcript still matches its hash.
   Save a recovery report with old/new IDs, checks, timestamps, and backup paths.

Inspect `src/agent/manager.ts`, `continuityStore.ts`, and `nativeSession.ts` before
using their APIs. Failed preparation leaves the original attached; failed switching
requires restoring and verifying its saved binding/cache. Never edit native IDs or
transcripts, delete history, or retry replacement creation in a rejection loop.
