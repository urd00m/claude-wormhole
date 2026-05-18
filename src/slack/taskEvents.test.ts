// Verify background task-event formatting and that the poster forwards a
// well-formed Slack chat.postMessage call.
import { buildTaskEventPoster } from "./taskEvents.js";
import type { TaskEvent } from "../agent/session.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Posted = { channel: string; thread_ts: string; text: string };

function makeClient(posted: Posted[]) {
  return {
    chat: {
      postMessage: async (args: Posted) => {
        posted.push(args);
        return { ok: true };
      },
    },
  } as never;
}

async function main() {
  const posted: Posted[] = [];
  const post = buildTaskEventPoster(makeClient(posted), "C123", "T456");

  const events: TaskEvent[] = [
    {
      kind: "started",
      taskId: "task_abc123def456",
      toolUseId: "tu_1",
      description: "Run perf bench across 20 commits",
      subagentType: "background-worker",
    },
    {
      kind: "progress",
      taskId: "task_abc123def456",
      toolUseId: "tu_1",
      description: "10/20 commits benchmarked",
      summary: "median 142ms ± 8ms",
    },
    {
      kind: "notification",
      taskId: "task_abc123def456",
      toolUseId: "tu_1",
      status: "completed",
      summary: "all 20 commits benchmarked, results in bench-results.json",
    },
    {
      kind: "notification",
      taskId: "task_fail9",
      status: "failed",
      summary: "ENOENT: data.csv not found",
    },
  ];

  for (const e of events) post(e);

  // postMessage is fire-and-forget. Give the microtask queue a tick.
  await new Promise((r) => setTimeout(r, 10));

  assert(posted.length === 4, `expected 4 posts, got ${posted.length}`);
  for (const p of posted) {
    assert(p.channel === "C123", "channel correct");
    assert(p.thread_ts === "T456", "thread_ts correct");
  }
  assert(posted[0].text.includes("🛰️"), "started uses satellite emoji");
  assert(posted[0].text.includes("background-worker"), "started includes subagent type");
  assert(posted[0].text.includes("Run perf bench"), "started includes description");
  // task IDs are truncated to 12 chars.
  assert(posted[0].text.includes("task_abc123d"), "started truncates id to 12 chars");

  assert(posted[1].text.includes("📡"), "progress uses radar emoji");
  assert(posted[1].text.includes("median 142ms"), "progress includes summary");

  assert(posted[2].text.includes("✅") && posted[2].text.includes("completed"), "completed event");
  assert(posted[3].text.includes("❌") && posted[3].text.includes("failed"), "failed event");

  console.log("✅ task event formatting verified");
}

main().catch((err) => {
  console.error("❌ task events verification failed:", err);
  process.exit(1);
});
