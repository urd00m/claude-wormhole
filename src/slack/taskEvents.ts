import type { WebClient } from "@slack/web-api";
import type { TaskEvent } from "../agent/session.js";

/**
 * Post a background-task lifecycle event into a Slack thread. Each event is
 * its own message (rather than editing one rolling status line) so the user
 * has a durable record of when the worker started, when it reported
 * progress, and how it ended.
 *
 * Designed to be passed as the `onTaskEvent` hook to `Session.send`.
 */
export function buildTaskEventPoster(
  client: WebClient,
  channel: string,
  threadTs: string,
): (event: TaskEvent) => void {
  return (event) => {
    const text = formatTaskEvent(event);
    if (!text) return;
    // Fire-and-forget: don't block the agent loop on Slack latency. Failures
    // are logged rather than thrown, matching the heartbeat / streamer
    // pattern elsewhere.
    void client.chat
      .postMessage({ channel, thread_ts: threadTs, text })
      .catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[taskEvent] post failed: ${m}`);
      });
  };
}

function formatTaskEvent(event: TaskEvent): string {
  const idTag = `\`${event.taskId.slice(0, 12)}\``;
  switch (event.kind) {
    case "started": {
      const type = event.subagentType ? ` (${event.subagentType})` : "";
      return `🛰️ background task ${idTag}${type} started: ${truncate(event.description, 200)}`;
    }
    case "progress": {
      const tail = event.summary ? ` — ${truncate(event.summary, 240)}` : "";
      return `📡 background task ${idTag} progress: ${truncate(event.description, 200)}${tail}`;
    }
    case "notification": {
      const emoji =
        event.status === "completed" ? "✅" : event.status === "failed" ? "❌" : "⏹️";
      return `${emoji} background task ${idTag} ${event.status}: ${truncate(event.summary, 300)}`;
    }
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
