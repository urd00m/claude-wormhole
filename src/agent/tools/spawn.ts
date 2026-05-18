import { z } from "zod";
import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { env } from "../../config.js";
import { SYSTEM_PROMPT } from "../systemPrompt.js";
import { MAX_SUBAGENT_DEPTH } from "../subagentDepth.js";
import type { TaskEvent } from "../session.js";

/**
 * Context for one level of the spawn-MCP hierarchy. `depth` is THIS MCP's
 * level (the parent thread is depth 0; the main thread's spawn MCP is
 * built at depth 0; when its tool fires, it spawns a worker at depth 1
 * whose own spawn MCP is built at depth 1, etc.).
 *
 * The `build*` factories are closures: each spawned worker gets its OWN
 * Slack MCP / canUseTool instance, so worker state (posted messages,
 * consent prompts) is scoped correctly.
 */
export type SpawnCtx = {
  workdir: string;
  depth: number;
  /** Build a Slack-post MCP scoped to the parent thread (workers post back into the original thread). */
  buildSlackMcp: () => McpSdkServerConfigWithInstance;
  /** Build a canUseTool gate (destructive-bash consent, etc.) for one worker. */
  buildCanUseTool: () => CanUseTool;
  /** Lifecycle hook — fired when a worker starts and when it completes. */
  onTaskEvent?: (event: TaskEvent) => void;
};

/**
 * Module-level tracker of in-flight background workers. Keeps a strong
 * reference to the worker promise so it doesn't get GC'd before the SDK
 * pipeline finishes, and lets a future introspection tool (or shutdown
 * handler) see what's running. Entries self-delete on completion.
 */
const inflightBackgroundWorkers = new Map<string, Promise<void>>();

/** Snapshot — exposed for tests / introspection. */
export function activeBackgroundWorkerCount(): number {
  return inflightBackgroundWorkers.size;
}

/**
 * Build the `spawn` MCP server for a given level. Exposes one tool —
 * `spawn` — with synchronous (default) and background (fire-and-forget)
 * modes.
 *
 * Synchronous: handler awaits the worker's entire query() and returns
 * its final text as the tool result.
 *
 * Background (background: true OR run_in_background: true): handler
 * returns IMMEDIATELY with a dispatch ack; the worker runs in an async
 * IIFE; completion is surfaced via onTaskEvent (NOT the tool result).
 *
 * Workers receive:
 *   - Slack MCP (post status / files back to the thread).
 *   - A nested spawn MCP at depth + 1 (so workers can recurse, bounded
 *     by MAX_SUBAGENT_DEPTH).
 *   - The parent's canUseTool gate (destructive-bash consent still applies).
 *
 * Workers do NOT receive workdir/cron mutator MCPs.
 */
export function buildSpawnMcp(ctx: SpawnCtx): McpSdkServerConfigWithInstance {
  const myDepth = ctx.depth;

  const spawnTool = tool(
    "spawn",
    `Spawn a worker sub-agent for parallel or context-isolated work. This is the wormhole's workaround for the CLI's hardcoded Agent/Task strip on sub-agents — unlike Agent, calling this tool from a sub-agent works. The worker has the full Claude Code tool surface AND this spawn tool itself, so deep orchestration patterns (Planner / Plan-critic / Executor / Verifier / Verdict-critic) work to depth ${MAX_SUBAGENT_DEPTH}. Multiple spawn calls in one assistant turn run in parallel. Set background: true (or run_in_background: true) for fire-and-forget — the call returns immediately with a dispatch ack and the worker's completion is posted to the Slack thread later via a task-notification event. Current spawn-MCP depth: ${myDepth}.`,
    {
      prompt: z
        .string()
        .describe("Self-contained worker prompt. The worker has no channel back to you for follow-ups — commit any context it needs into this prompt."),
      description: z
        .string()
        .optional()
        .describe("Short human-readable label for this worker, shown in Slack lifecycle events."),
      background: z
        .boolean()
        .optional()
        .describe("If true, return immediately and let the worker run in the background. Default false (block until worker finishes, return its final text)."),
      run_in_background: z
        .boolean()
        .optional()
        .describe("Alias for `background` — accepted for compatibility with Claude Code CLI style. If either flag is true, the call runs in background mode."),
    },
    async ({ prompt, description, background, run_in_background }) => {
      const workerDepth = myDepth + 1;
      if (workerDepth > MAX_SUBAGENT_DEPTH) {
        return {
          content: [
            {
              type: "text",
              text: `spawn denied: worker would run at depth ${workerDepth}, cap is ${MAX_SUBAGENT_DEPTH}`,
            },
          ],
          isError: true,
        };
      }

      const isBackground = background === true || run_in_background === true;
      const taskId = `spawn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const label = description ?? prompt.slice(0, 80).replace(/\s+/g, " ");

      ctx.onTaskEvent?.({
        kind: "started",
        taskId,
        description: label,
        subagentType: isBackground ? `wormhole-spawn-bg-d${workerDepth}` : `wormhole-spawn-d${workerDepth}`,
      });

      // Build the worker's MCP map: slack (post back to thread) + a
      // recursive spawn MCP at the next depth. Workdir / cron mutators
      // intentionally omitted — workers can't change parent state.
      const workerSpawnMcp = buildSpawnMcp({ ...ctx, depth: workerDepth });
      const workerMcpServers: Record<string, McpSdkServerConfigWithInstance> = {
        slack: ctx.buildSlackMcp(),
        spawn: workerSpawnMcp,
      };

      // Inner runner: shared by sync and background paths. Returns the
      // worker's final text + outcome.
      const runWorker = async (): Promise<{ finalText: string; outcome: "completed" | "failed" }> => {
        let finalText = "";
        let outcome: "completed" | "failed" = "completed";
        try {
          const workerQ = query({
            prompt,
            options: {
              cwd: ctx.workdir,
              model: env.ANTHROPIC_MODEL,
              systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
              tools: { type: "preset", preset: "claude_code" },
              canUseTool: ctx.buildCanUseTool(),
              mcpServers: workerMcpServers,
              permissionMode: "bypassPermissions",
              allowDangerouslySkipPermissions: true,
              additionalDirectories: ["/"],
              includePartialMessages: false,
            },
          });

          for await (const msg of workerQ as AsyncIterable<SDKMessage>) {
            if (msg.type === "result") {
              const r = msg as { subtype?: string; result?: string };
              if (r.subtype === "success" && typeof r.result === "string") {
                finalText = r.result;
              }
            } else if (msg.type === "assistant") {
              const m = msg as {
                parent_tool_use_id?: string | null;
                message?: { content?: unknown };
              };
              if (m.parent_tool_use_id) continue;
              const content = (m.message?.content ?? []) as Array<{ type?: string; text?: string }>;
              for (const block of content) {
                if (block.type === "text" && typeof block.text === "string") {
                  finalText = block.text;
                }
              }
            }
          }
        } catch (err) {
          outcome = "failed";
          finalText = err instanceof Error ? err.message : String(err);
        }
        return { finalText, outcome };
      };

      if (!isBackground) {
        // Synchronous path: block on the worker.
        const { finalText, outcome } = await runWorker();
        ctx.onTaskEvent?.({
          kind: "notification",
          taskId,
          status: outcome,
          summary: finalText.slice(0, 400),
        });
        return {
          content: [{ type: "text", text: finalText || "(worker produced no text)" }],
          isError: outcome === "failed",
        };
      }

      // Background path: kick off the worker, return immediately.
      const bgPromise = (async () => {
        try {
          const { finalText, outcome } = await runWorker();
          ctx.onTaskEvent?.({
            kind: "notification",
            taskId,
            status: outcome,
            summary: finalText.slice(0, 400),
          });
        } catch (err) {
          // Defense in depth — runWorker should catch everything, but a
          // bug there must not crash the bot via UnhandledPromiseRejection.
          const m = err instanceof Error ? err.message : String(err);
          ctx.onTaskEvent?.({
            kind: "notification",
            taskId,
            status: "failed",
            summary: `internal: ${m}`,
          });
        } finally {
          inflightBackgroundWorkers.delete(taskId);
        }
      })();
      inflightBackgroundWorkers.set(taskId, bgPromise);

      return {
        content: [
          {
            type: "text",
            text: `worker ${taskId} dispatched (background). Completion will be posted as a task notification in this Slack thread when the worker finishes.`,
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "spawn",
    version: "0.1.0",
    tools: [spawnTool],
    alwaysLoad: true,
  });
}
