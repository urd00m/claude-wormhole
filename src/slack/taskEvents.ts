import type { WebClient } from "@slack/web-api";
import type { TaskEvent } from "../agent/session.js";

/**
 * Post one Slack message per background task and EDIT it as further events
 * arrive — rather than posting a fresh message per event. Reduces thread
 * noise from ~3-N messages per worker (started + N progress + terminal) to
 * a single message that updates in place.
 *
 * State is kept per task_id in a Map. Each task gets:
 *   - One chat.postMessage on its first event (started OR notification OR
 *     progress, whichever arrives first).
 *   - chat.update for each subsequent event, applied serially per task via
 *     a promise chain so updates can't reorder under network latency.
 *
 * Map lifetime: the poster is rebuilt per Session.send() invocation, so the
 * Map covers exactly one parent turn — tasks completing across turns are
 * unusual (background workers normally finish within the turn that spawned
 * them or shortly after) but if they do, the new turn gets a fresh poster
 * and the late notification creates its own message.
 */
export function buildTaskEventPoster(
  client: WebClient,
  channel: string,
  threadTs: string,
): (event: TaskEvent) => void {
  const states = new Map<string, TaskState>();

  return (event) => {
    let state = states.get(event.taskId);

    if (!state) {
      // First event for this task: post a fresh message capturing whatever
      // state we have so far.
      state = newState(event.taskId);
      applyEvent(state, event);
      const text = render(state);
      state.pendingTs = client.chat
        .postMessage({ channel, thread_ts: threadTs, text })
        .then((res) => res.ts ?? null)
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          console.warn(`[taskEvent] postMessage failed: ${m}`);
          return null;
        });
      states.set(event.taskId, state);
      return;
    }

    // Subsequent event: merge into state, queue an edit behind any in-flight
    // post/update for this task.
    applyEvent(state, event);
    const text = render(state);
    const prevUpdate = state.lastUpdate;
    state.lastUpdate = (async () => {
      await prevUpdate;
      const ts = await state!.pendingTs;
      if (!ts) return;
      try {
        await client.chat.update({ channel, ts, text });
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        console.warn(`[taskEvent] update failed: ${m}`);
      }
    })();
  };
}

type TaskState = {
  taskId: string;
  pendingTs: Promise<string | null>;
  lastUpdate: Promise<void>;
  description?: string;
  subagentType?: string;
  latestProgress?: { description: string; summary?: string };
  terminal?: { status: "completed" | "failed" | "stopped"; summary: string };
};

function newState(taskId: string): TaskState {
  return {
    taskId,
    pendingTs: Promise.resolve(null),
    lastUpdate: Promise.resolve(),
  };
}

function applyEvent(state: TaskState, event: TaskEvent): void {
  switch (event.kind) {
    case "started":
      state.description = event.description;
      if (event.subagentType) state.subagentType = event.subagentType;
      break;
    case "progress":
      if (!state.description) state.description = event.description;
      state.latestProgress = { description: event.description, summary: event.summary };
      break;
    case "notification":
      if (!state.description) state.description = `(${event.status})`;
      state.terminal = { status: event.status, summary: event.summary };
      break;
  }
}

function render(state: TaskState): string {
  const idTag = `\`${state.taskId.slice(0, 12)}\``;
  const typeTag = state.subagentType ? ` (${state.subagentType})` : "";
  const desc = truncate(state.description ?? "(unknown)", 160);

  if (state.terminal) {
    const emoji =
      state.terminal.status === "completed"
        ? "✅"
        : state.terminal.status === "failed"
          ? "❌"
          : "⏹️";
    return `${emoji} task ${idTag}${typeTag} — ${desc}\n${state.terminal.status}: ${truncate(state.terminal.summary, 280)}`;
  }
  if (state.latestProgress) {
    const tail = state.latestProgress.summary
      ? ` — ${truncate(state.latestProgress.summary, 200)}`
      : "";
    return `📡 task ${idTag}${typeTag} — ${desc}\nprogress: ${truncate(state.latestProgress.description, 160)}${tail}`;
  }
  return `🛰️ task ${idTag}${typeTag} — ${desc} · running`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
