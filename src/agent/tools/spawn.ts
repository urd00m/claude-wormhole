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
 * Build the `spawn` MCP server for a given level. The returned server
 * exposes one tool — `spawn` — whose handler boots a fresh `query()` and
 * waits for the worker's final text.
 *
 * Workers receive:
 *   - Slack MCP (so they can post status / files back to the thread).
 *   - A nested spawn MCP at depth + 1 (so workers can recurse, bounded
 *     by MAX_SUBAGENT_DEPTH).
 *   - The parent's canUseTool gate (destructive-bash consent still applies).
 *   - cwd, model, permissionMode, etc. matching the parent.
 *
 * Workers do NOT receive workdir/cron mutator MCPs — that isolation
 * invariant is preserved by simply omitting them from the worker's
 * mcpServers map.
 */
export function buildSpawnMcp(ctx: SpawnCtx): McpSdkServerConfigWithInstance {
  const myDepth = ctx.depth;

  const spawnTool = tool(
    "spawn",
    `Spawn a worker sub-agent for parallel or context-isolated work. This is the wormhole's workaround for the CLI's hardcoded Agent/Task strip on sub-agents — unlike Agent, calling this tool from a sub-agent works. The worker has the full Claude Code tool surface AND this spawn tool itself, so deep orchestration patterns (Planner / Plan-critic / Executor / Verifier / Verdict-critic) work to depth ${MAX_SUBAGENT_DEPTH}. Multiple spawn calls in one assistant turn run in parallel. Current spawn-MCP depth: ${myDepth}.`,
    {
      prompt: z
        .string()
        .describe("Self-contained worker prompt. The worker has no channel back to you for follow-ups — commit any context it needs into this prompt."),
      description: z
        .string()
        .optional()
        .describe("Short human-readable label for this worker, shown in Slack lifecycle events."),
    },
    async ({ prompt, description }) => {
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

      const taskId = `spawn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const label = description ?? prompt.slice(0, 80).replace(/\s+/g, " ");

      ctx.onTaskEvent?.({
        kind: "started",
        taskId,
        description: label,
        subagentType: `wormhole-spawn-d${workerDepth}`,
      });

      // Build the worker's MCP map: slack (post back to thread) + a
      // recursive spawn MCP at the next depth. Workdir / cron mutators
      // intentionally omitted — workers can't change parent state.
      const workerSpawnMcp = buildSpawnMcp({ ...ctx, depth: workerDepth });
      const workerMcpServers: Record<string, McpSdkServerConfigWithInstance> = {
        slack: ctx.buildSlackMcp(),
        spawn: workerSpawnMcp,
      };

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
            // Only capture top-level text from THIS worker's main thread —
            // not from any further Agent calls it makes internally.
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
    },
  );

  return createSdkMcpServer({
    name: "spawn",
    version: "0.1.0",
    tools: [spawnTool],
    alwaysLoad: true,
  });
}
