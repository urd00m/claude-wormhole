# Prepare a reviewed handoff

Use to carry reviewed context to another assistant, including after a provider
error. This prepares a handoff artifact; switching a live session is a separate
operation covered by `skills/session-handoff.md`.

1. Identify the source thread, native session, working directory, model,
   permissions, and public failure diagnostic. Keep existing restriction records.
2. Save a SQLite online backup, identity anchor, original binding, session
   identities, and an opaque transcript copy with hashes in a private recovery
   directory. Never edit the original transcript or native session ID.
3. Summarize visible user messages and public assistant responses: the destination
   task, verified facts with dates, relevant paths, permissions, budgets, and
   unresolved errors. Label historical reports that need a fresh check.
   Exclude private reasoning, credentials, and automatic replay of tool calls.
4. Review the destination task. A separate allowed task,
   such as a read-only status report, must retain that boundary explicitly.
   Stop if the destination task is rejected; do not retry through new identities.
5. Save the handoff and a report of scope, source identity, backups, hashes,
   verification, and whether any switch occurred. Verify preparation left the
   original binding, transcript, and all session identities unchanged.

For an authorized session move, follow
`skills/session-handoff.md` to validate the replacement and switch the live
manager and durable binding together. A prepared handoff alone is not a completed
session move or provider approval to resume rejected work.
