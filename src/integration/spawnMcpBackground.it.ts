// Live integration test: mcp__spawn__spawn with background: true must
// return IMMEDIATELY (not block on the worker) and surface completion via
// onTaskEvent later.
//
// Worker prompt: `Bash` a sleep 4 + echo. If we were blocking, the
// dispatch ack wouldn't come back for ~4-5 seconds. With background mode,
// the ack returns within a second; the notification arrives ~4-5s later.
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { buildSpawnMcp, activeBackgroundWorkerCount } from "../agent/tools/spawn.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskEvent } from "../agent/session.js";

const stubSlackMcp = createSdkMcpServer({
  name: "slack",
  version: "0.1.0",
  tools: [
    tool("slack_post_message", "stub", { text: z.string() }, async () => ({
      content: [{ type: "text", text: "(stubbed)" }],
    })),
  ],
});

const ROOT_PROMPT = `Call mcp__spawn__spawn EXACTLY ONCE with the following arguments, then in your final response include the tool result verbatim:
  background: true
  description: "sleep-then-echo bg worker"
  prompt: |
    Run this Bash command: bash -lc 'sleep 4 && echo READY_FROM_BG_WORKER'
    After the command completes, in your reply, write exactly:
      WORKER_DONE
    Stop.`;

async function main(): Promise<number> {
  console.log("▸ Live test: background spawn dispatches immediately");

  const events: { event: TaskEvent; at: number }[] = [];
  const start = Date.now();
  const onTaskEvent = (event: TaskEvent) => {
    events.push({ event, at: Date.now() - start });
    console.log(`  [+${Date.now() - start}ms] ${event.kind} ${"status" in event ? `(${event.status})` : ""}`);
  };

  const spawnMcp = buildSpawnMcp({
    workdir: process.cwd(),
    depth: 0,
    buildSlackMcp: () => stubSlackMcp,
    buildCanUseTool: () => async () => ({ behavior: "allow", updatedInput: {} }),
    onTaskEvent,
  });

  let toolCallStartedAt = -1;
  let toolResultReceivedAt = -1;

  const q = query({
    prompt: ROOT_PROMPT,
    options: {
      model: env.ANTHROPIC_MODEL,
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: { slack: stubSlackMcp, spawn: spawnMcp },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      additionalDirectories: ["/"],
    },
  });

  let parentDoneAt = -1;
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      const m = msg as { message?: { content?: unknown }; parent_tool_use_id?: string | null };
      if (m.parent_tool_use_id) continue;
      const content = (m.message?.content ?? []) as Array<{ type?: string; name?: string }>;
      for (const block of content) {
        if (block.type === "tool_use" && (block.name === "mcp__spawn__spawn" || /spawn/.test(block.name ?? ""))) {
          toolCallStartedAt = Date.now() - start;
          console.log(`  [+${toolCallStartedAt}ms] parent emitted mcp__spawn__spawn tool_use`);
        }
      }
    }
    if (msg.type === "user") {
      const m = msg as { message?: { content?: unknown } };
      const content = (m.message?.content ?? []) as Array<{ type?: string; tool_use_id?: string }>;
      for (const block of content) {
        if (block.type === "tool_result" && toolResultReceivedAt < 0 && toolCallStartedAt > 0) {
          toolResultReceivedAt = Date.now() - start;
          console.log(`  [+${toolResultReceivedAt}ms] tool_result received`);
        }
      }
    }
    if (msg.type === "result") {
      parentDoneAt = Date.now() - start;
      console.log(`  [+${parentDoneAt}ms] parent turn finished`);
    }
  }

  // The worker is still running in the background. Wait up to 15s for the
  // notification event.
  const waitUntil = Date.now() + 15_000;
  while (Date.now() < waitUntil && !events.some((e) => e.event.kind === "notification")) {
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`\n  active background workers still in flight: ${activeBackgroundWorkerCount()}`);

  // --- Assertions ---
  let ok = true;

  const tToolResult = toolResultReceivedAt - toolCallStartedAt;
  console.log(`\n  spawn tool_use → tool_result latency: ${tToolResult}ms`);
  if (tToolResult > 2500) {
    console.log(`  ❌ FAIL: background spawn returned too slowly (${tToolResult}ms > 2500ms threshold). Looks like it blocked on the worker.`);
    ok = false;
  } else {
    console.log(`  ✅ spawn returned quickly — not blocked on worker`);
  }

  const started = events.find((e) => e.event.kind === "started");
  const notif = events.find((e) => e.event.kind === "notification");
  if (!started) {
    console.log("  ❌ FAIL: no 'started' lifecycle event fired");
    ok = false;
  } else {
    console.log(`  ✅ 'started' event fired at +${started.at}ms`);
  }
  if (!notif) {
    console.log(`  ❌ FAIL: no 'notification' event within 15s (worker output: never received)`);
    ok = false;
  } else {
    console.log(`  ✅ 'notification' fired at +${notif.at}ms (status: ${"status" in notif.event ? notif.event.status : "?"})`);
    if ("summary" in notif.event && !notif.event.summary?.includes("READY_FROM_BG_WORKER") && !notif.event.summary?.includes("WORKER_DONE")) {
      console.log(`  ⚠️  notification summary doesn't contain expected sentinel: ${JSON.stringify(notif.event.summary).slice(0, 200)}`);
    }
  }

  if (started && notif) {
    const elapsed = notif.at - started.at;
    if (elapsed < 3000) {
      console.log(`  ⚠️  worker reported done suspiciously fast (${elapsed}ms — expected ~4-5s for sleep 4). May not have actually run.`);
    } else {
      console.log(`  ✅ worker ran for ${elapsed}ms (expected ~4-5s)`);
    }
  }

  return ok ? 0 : 1;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error("crashed:", err);
    process.exit(1);
  });
