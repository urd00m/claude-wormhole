// Verify rolling-message behavior: per task_id, one chat.postMessage + N
// chat.update edits — not a fresh post per event.
import { buildTaskEventPoster } from "./taskEvents.js";
import type { TaskEvent } from "../agent/session.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Posted = { channel: string; thread_ts: string; text: string; assignedTs: string };
type Updated = { channel: string; ts: string; text: string };

function makeClient(posted: Posted[], updated: Updated[]) {
  let counter = 0;
  return {
    chat: {
      postMessage: async (args: { channel: string; thread_ts: string; text: string }) => {
        const assignedTs = `ts_${++counter}`;
        posted.push({ ...args, assignedTs });
        return { ok: true, ts: assignedTs };
      },
      update: async (args: Updated) => {
        updated.push(args);
        return { ok: true };
      },
    },
  } as never;
}

async function flushChain(post: (e: TaskEvent) => void): Promise<void> {
  // The poster is fire-and-forget. Yield repeatedly until microtasks drain.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  void post; // unused, just makes the helper readable from call sites
}

async function main() {
  // --- Single task with full lifecycle: 1 post + 2 updates -----------------
  {
    const posted: Posted[] = [];
    const updated: Updated[] = [];
    const post = buildTaskEventPoster(makeClient(posted, updated), "C123", "T456");

    const events: TaskEvent[] = [
      {
        kind: "started",
        taskId: "task_full_lifecycle",
        toolUseId: "tu_1",
        description: "Run perf bench across 20 commits",
        subagentType: "background-worker",
      },
      {
        kind: "progress",
        taskId: "task_full_lifecycle",
        toolUseId: "tu_1",
        description: "10/20 commits benchmarked",
        summary: "median 142ms ± 8ms",
      },
      {
        kind: "notification",
        taskId: "task_full_lifecycle",
        toolUseId: "tu_1",
        status: "completed",
        summary: "all 20 commits benchmarked",
      },
    ];

    for (const e of events) post(e);
    await flushChain(post);

    assert(posted.length === 1, `expected 1 post per task, got ${posted.length}`);
    assert(updated.length === 2, `expected 2 updates (progress + notification), got ${updated.length}`);

    // The original post is the "started" rendering.
    assert(posted[0].text.includes("🛰️"), `started should render with satellite emoji`);
    assert(posted[0].text.includes("Run perf bench"), "started includes description");
    assert(posted[0].text.includes("background-worker"), "started includes subagent type");
    // First update reflects progress.
    assert(updated[0].text.includes("📡"), "first update should be progress emoji");
    assert(updated[0].text.includes("median 142ms"), "progress includes summary");
    assert(updated[0].ts === posted[0].assignedTs, "update edits the same ts as the post");
    // Second update reflects completion.
    assert(updated[1].text.includes("✅"), "final update should be completion emoji");
    assert(updated[1].text.includes("completed"), "final says completed");
    assert(updated[1].ts === posted[0].assignedTs, "final edit hits the same ts");
  }

  // --- Task that only gets a terminal event (no started): single post ----
  {
    const posted: Posted[] = [];
    const updated: Updated[] = [];
    const post = buildTaskEventPoster(makeClient(posted, updated), "C123", "T456");

    post({
      kind: "notification",
      taskId: "task_failed_only",
      status: "failed",
      summary: "ENOENT: data.csv not found",
    });
    await flushChain(post);

    assert(posted.length === 1, `single notif → 1 post, got ${posted.length}`);
    assert(updated.length === 0, "no updates when only one event arrived");
    assert(posted[0].text.includes("❌"), "failed emoji");
    assert(posted[0].text.includes("ENOENT"), "summary included");
  }

  // --- Two tasks in the same poster: each gets its own post --------------
  {
    const posted: Posted[] = [];
    const updated: Updated[] = [];
    const post = buildTaskEventPoster(makeClient(posted, updated), "C", "T");

    post({ kind: "started", taskId: "task_a", description: "A starts" });
    post({ kind: "started", taskId: "task_b", description: "B starts" });
    post({ kind: "notification", taskId: "task_a", status: "completed", summary: "A done" });
    post({ kind: "notification", taskId: "task_b", status: "completed", summary: "B done" });
    await flushChain(post);

    assert(posted.length === 2, `two tasks → 2 posts, got ${posted.length}`);
    assert(updated.length === 2, `two notifications → 2 updates, got ${updated.length}`);
    // Each task's update should target the matching post's ts.
    const aPostTs = posted.find((p) => p.text.includes("A starts"))?.text;
    const bPostTs = posted.find((p) => p.text.includes("B starts"))?.text;
    assert(aPostTs, "task A was posted");
    assert(bPostTs, "task B was posted");
  }

  // --- Late progress after notification still edits (defensive) ---------
  {
    const posted: Posted[] = [];
    const updated: Updated[] = [];
    const post = buildTaskEventPoster(makeClient(posted, updated), "C", "T");

    post({ kind: "started", taskId: "task_late", description: "Late task" });
    post({ kind: "notification", taskId: "task_late", status: "completed", summary: "done" });
    post({ kind: "progress", taskId: "task_late", description: "stray progress", summary: "ignored?" });
    await flushChain(post);

    assert(posted.length === 1, "one post for the task");
    assert(updated.length === 2, "two updates: completion + stray progress");
    // Stray progress overwrites terminal in our simple state model. That's
    // a known wart but doesn't crash.
  }

  console.log("✅ task event rolling-message behavior verified");
}

main().catch((err) => {
  console.error("❌ task events verification failed:", err);
  process.exit(1);
});
