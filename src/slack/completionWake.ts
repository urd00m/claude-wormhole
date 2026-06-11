import type { Session, TaskEvent } from "../agent/session.js";

/**
 * Close the background-completion wake gap.
 *
 * THE BUG (verified 2026-06-11): the agent's run loop (`session.send()`) is
 * invoked by exactly two things — a human Slack message (handlers.ts) and a
 * cron fire (scheduler/runner.ts). A background task completion (a
 * `mcp__spawn__spawn` `background:true` worker OR a `run_in_background` Bash)
 * is delivered ONLY to `buildTaskEventPoster`, which posts/edits a Slack
 * message and never calls `session.send()`. So a background task that
 * finishes AFTER its spawning turn ended posts a Slack message and the agent
 * never resumes — it sits idle until the next human message or cron fire.
 * (Real incident: an orchestrator returned LONG_BENCH_PENDING and the agent
 * stayed asleep for 8.5 h until the human pinged.)
 *
 * THE FIX: wrap the task-event poster. On a TERMINAL `notification` event that
 * arrives while the session is IDLE, in addition to the Slack post, re-invoke
 * the agent by running a fresh turn (`runTurn`) whose prompt carries the
 * completion. `runTurn` must do the same per-turn setup a human message does
 * (streamer + MCP servers + `session.send()`); it is supplied by the caller
 * (handlers.ts) so this module stays free of Slack/MCP wiring.
 *
 * Guards:
 *  - Active-turn guard (`session.isActive`): if a turn is already in flight,
 *    do nothing extra — the SDK delivers the completion into that live turn.
 *    Waking concurrently would start a second overlapping send().
 *  - Dedup (`woken` set): never fire more than one wake per taskId, so a
 *    duplicate/late event can't double-invoke the agent.
 */
export function withCompletionWake(
  poster: (event: TaskEvent) => void,
  session: Session,
  runTurn: (prompt: string) => Promise<void>,
): (event: TaskEvent) => void {
  const woken = new Set<string>();

  return (event) => {
    // Always keep the existing Slack-message behavior.
    poster(event);

    // Only terminal completions wake; "started"/"progress" do not.
    if (event.kind !== "notification") return;
    // A live turn already receives this completion via the SDK.
    if (session.isActive) return;
    // One wake per task, ever.
    if (woken.has(event.taskId)) return;
    woken.add(event.taskId);

    const prompt =
      `[task-notification] Background task \`${event.taskId}\` finished ` +
      `(${event.status}). Summary: ${event.summary}\n\n` +
      `You are being auto-woken because this completion arrived while you were ` +
      `idle. It may unblock pending work — e.g. a hoisted long bench whose ` +
      `result now needs collecting, or a LONG_BENCH_PENDING handoff to continue ` +
      `the orchestrator's next phase. Check current state on disk and continue ` +
      `the in-flight task.`;

    // Fire and forget: runTurn owns its own streamer + error handling. If a
    // turn is somehow already active by the time this resolves, runTurn's
    // session.send() would overlap — callers must ensure runTurn re-checks or
    // serializes; the isActive guard above covers the common case.
    void runTurn(prompt).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[completionWake] wake turn for ${event.taskId} failed: ${m}`);
    });
  };
}
