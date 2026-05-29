import { randomUUID } from "node:crypto";
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
import { CodexRuntime } from "../runtime/codex.js";
import type { CodexProcessFactory } from "../runtime/codexProcess.js";
import { getResidentWorkerRegistry, type ResidentWorkerRegistry } from "../residentWorkerRegistry.js";

/** Result shape shared by the resident-worker tool handlers. */
export type SpawnToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

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
  /**
   * Owner thread key for resident workers (namespaces the registry so two
   * Slack threads can each have a "researcher" without collision). Omitted
   * for nested/recursive spawn levels that don't manage resident workers.
   */
  threadKey?: string;
  /**
   * Test seam — overrides the codex subprocess factory used for Codex
   * workers. Production omits this and CodexRuntime uses the real
   * spawnCodexProcess. Lets the test suite exercise the Codex worker path
   * without invoking the real `codex` CLI.
   */
  codexProcessFactory?: CodexProcessFactory;
  /**
   * Test seam — overrides the resident-worker registry. Production omits
   * this and the global singleton is used (so resident workers persist
   * across messages). Tests inject a registry wired with a fake worker
   * factory to exercise the resident tool handlers without real Claude.
   */
  residentRegistry?: ResidentWorkerRegistry;
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
export type WorkerOutcome = { finalText: string; outcome: "completed" | "failed" };

/**
 * Claude worker dispatch — wraps the existing `query()` loop. Extracted
 * to module scope so the tool handler can branch on the requested runtime
 * without ballooning into a single 200-line closure. Returns the worker's
 * canonical final text + outcome.
 */
export async function runClaudeWorker(
  ctx: SpawnCtx,
  prompt: string,
  workerMcpServers: Record<string, McpSdkServerConfigWithInstance>,
): Promise<WorkerOutcome> {
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
        disallowedTools: ["AskUserQuestion"],
        canUseTool: ctx.buildCanUseTool(),
        mcpServers: workerMcpServers,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        additionalDirectories: ["/"],
        includePartialMessages: false,
        env: buildWorkerEnv(),
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
}

/**
 * Codex worker dispatch — instantiates a fresh `CodexRuntime` for the
 * worker, sends the prompt as a single turn, returns its final text. The
 * worker:
 *   - Sees NO wormhole MCP tools (Codex's MCP integration is a separate,
 *     deferred slice — see TODO "Codex parity — MCP shim"). So this is
 *     "ask Codex a question, get its answer back" rather than a fully-
 *     featured agent. Useful for second opinions, model-specific tasks.
 *   - Cannot recursively spawn — same reason.
 *   - Runs in the parent's workdir (`ctx.workdir`).
 *   - Honors the harness's coarse Codex sandbox (--sandbox workspace-write
 *     + --dangerously-bypass-approvals-and-sandbox) configured inside
 *     CodexRuntime; the wormhole's consent classifier doesn't gate
 *     Codex's native shell. See README + USAGE.
 *
 * The `ctx.codexProcessFactory` test seam lets unit tests inject a fake
 * CodexProcess yielding synthesized JSONL — production omits this and
 * CodexRuntime uses spawnCodexProcess.
 */
export async function runCodexWorker(
  ctx: SpawnCtx,
  prompt: string,
): Promise<WorkerOutcome> {
  try {
    const rt = new CodexRuntime({
      threadKey: `spawn-${randomUUID()}`,
      workdir: ctx.workdir,
      // Give the codex worker the spawn MCP so it can launch further agents
      // instead of being one-shot. It runs at this spawn level's depth;
      // its children spawn at depth+1, bounded by the cap in the server.
      enableSpawnMcp: true,
      spawnDepth: ctx.depth + 1,
      processFactory: ctx.codexProcessFactory,
    });
    const out = await rt.send({ text: prompt });
    return { finalText: out.finalText, outcome: "completed" };
  } catch (err) {
    return {
      finalText: err instanceof Error ? err.message : String(err),
      outcome: "failed",
    };
  }
}

export function buildSpawnMcp(ctx: SpawnCtx): McpSdkServerConfigWithInstance {
  const myDepth = ctx.depth;

  const spawnTool = tool(
    "spawn",
    `Spawn a worker sub-agent for parallel or context-isolated work. This is the ONLY sub-agent dispatch path in this harness — native Agent/Task tool calls are denied at the canUseTool gate and redirected here. The worker has the full Claude Code tool surface AND this spawn tool itself, so deep orchestration patterns (Planner / Plan-critic / Executor / Verifier / Verdict-critic) work to depth ${MAX_SUBAGENT_DEPTH}. Multiple spawn calls in one assistant turn run in parallel. Set background: true (or run_in_background: true) for fire-and-forget — the call returns immediately with a dispatch ack and the worker's completion is posted to the Slack thread later via a task-notification event. Set runtime: "codex" to dispatch the worker to the OpenAI Codex CLI instead of Claude — useful for second opinions or Codex-specific behavior; Codex workers see no MCP tools and cannot recursively spawn. Current spawn-MCP depth: ${myDepth}.`,
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
      runtime: z
        .enum(["claude", "codex"])
        .optional()
        .describe("Which runtime to launch the worker under. 'claude' (default) gets the full Claude Code tool surface and can recursively spawn. 'codex' dispatches to the codex CLI subprocess and returns its final text — Codex workers see no MCP tools and can't spawn further workers, so reach for it when you want a second opinion or Codex-specific capability, not when you need recursive orchestration."),
      name: z
        .string()
        .optional()
        .describe("Name a RESIDENT worker. The first spawn with a given name launches a long-lived Claude process that stays warm; subsequent spawns with the SAME name send the new prompt to that SAME live process, which retains full in-memory context from earlier turns (no re-spawn, no resume). Use this for an assistant you want to keep coming back to. Kill it with worker_kill; it also dies on bot restart. Requires resident: true."),
      resident: z
        .boolean()
        .optional()
        .describe("Set true (with `name`) to make the worker resident — a process kept alive across invocations, holding its own conversation context in memory. Default false = the normal one-shot worker (runs once, exits). Resident workers are Claude-only for now and ignore the background/runtime flags."),
    },
    async ({ prompt, description, background, run_in_background, runtime, name, resident }) => {
      // --- Resident worker path -------------------------------------------
      // A named, long-lived process that retains in-memory context across
      // invocations. Routed entirely through the registry; the one-shot
      // background/runtime machinery below does not apply.
      if (resident === true) {
        return handleResidentSpawn(ctx, { prompt, name }, ctx.residentRegistry ?? getResidentWorkerRegistry());
      }

      const workerRuntime: "claude" | "codex" = runtime ?? "claude";
      const workerDepth = myDepth + 1;
      // Depth cap applies only to the Claude path — Codex workers don't
      // see the spawn MCP at all, so recursion isn't possible regardless
      // of depth. Bypassing the cap for Codex keeps the door open for
      // future "Claude → Codex → Claude" orchestration patterns once the
      // Codex MCP shim ships.
      if (workerRuntime === "claude" && workerDepth > MAX_SUBAGENT_DEPTH) {
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
        subagentType:
          workerRuntime === "codex"
            ? `wormhole-spawn-codex${isBackground ? "-bg" : ""}`
            : isBackground
            ? `wormhole-spawn-bg-d${workerDepth}`
            : `wormhole-spawn-d${workerDepth}`,
      });

      // Build the worker's MCP map (Claude only). Codex workers see no
      // MCP, so this is skipped for that runtime.
      const buildClaudeWorkerMcp = (): Record<string, McpSdkServerConfigWithInstance> => {
        const workerSpawnMcp = buildSpawnMcp({ ...ctx, depth: workerDepth });
        return {
          slack: ctx.buildSlackMcp(),
          spawn: workerSpawnMcp,
        };
      };

      const runWorker = async (): Promise<WorkerOutcome> =>
        workerRuntime === "codex"
          ? runCodexWorker(ctx, prompt)
          : runClaudeWorker(ctx, prompt, buildClaudeWorkerMcp());

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

  // --- Resident-worker management tools --------------------------------
  // Only meaningful at the top spawn level (where ctx.threadKey is set).
  // Nested spawn MCPs don't own resident workers, so we omit these tools
  // for them to keep the sub-agent surface clean.
  const residentRegistry = ctx.residentRegistry ?? getResidentWorkerRegistry();
  const managementTools = ctx.threadKey
    ? [buildWorkerListTool(residentRegistry, ctx.threadKey), buildWorkerKillTool(residentRegistry, ctx.threadKey)]
    : [];

  return createSdkMcpServer({
    name: "spawn",
    version: "0.1.0",
    tools: [spawnTool, ...managementTools],
    alwaysLoad: true,
  });
}

/**
 * Resident-spawn handler. Creates the named worker on first use (capturing
 * this thread's Slack MCP + consent gate so it can post back and stays
 * gated), or routes the prompt to the already-warm worker. Returns the
 * worker's reply synchronously — the worker stays alive afterward.
 *
 * Exported + registry-injected so the resident tool path can be unit-tested
 * with a fake registry (no real Claude process).
 */
export async function handleResidentSpawn(
  ctx: SpawnCtx,
  args: { prompt: string; name?: string },
  registry: ResidentWorkerRegistry,
): Promise<SpawnToolResult> {
  if (!args.name || args.name.trim().length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "resident spawn requires a non-empty `name` so the worker can be addressed and killed later.",
        },
      ],
      isError: true,
    };
  }
  if (!ctx.threadKey) {
    return {
      content: [
        {
          type: "text",
          text: "resident workers can only be created at the top spawn level (no threadKey in this context).",
        },
      ],
      isError: true,
    };
  }

  const worker = registry.getOrCreate({
    name: args.name,
    ownerThread: ctx.threadKey,
    workdir: ctx.workdir,
    canUseTool: ctx.buildCanUseTool(),
    mcpServers: { slack: ctx.buildSlackMcp() },
  });

  try {
    const reply = await worker.send(args.prompt);
    return { content: [{ type: "text", text: reply }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `resident worker '${args.name}' failed: ${msg}` }],
      isError: true,
    };
  }
}

/** Pure formatter for worker_list output. Exported for tests. */
export function formatWorkerList(registry: ResidentWorkerRegistry, threadKey: string): SpawnToolResult {
  const infos = registry.list(threadKey);
  if (infos.length === 0) {
    return { content: [{ type: "text", text: "No resident workers in this thread." }] };
  }
  const lines = infos.map((w) => {
    const bits = [`• \`${w.name}\` — ${w.status}`, `  created: ${w.createdAt}`];
    if (w.lastRunAt) bits.push(`  last run: ${w.lastRunAt}`);
    if (w.lastError) bits.push(`  last error: ${w.lastError}`);
    return bits.join("\n");
  });
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

/** Pure handler for worker_kill. Exported for tests. */
export function killResidentWorker(
  registry: ResidentWorkerRegistry,
  threadKey: string,
  name: string,
): SpawnToolResult {
  const killed = registry.kill(threadKey, name);
  return {
    content: [
      {
        type: "text",
        text: killed
          ? `Killed resident worker \`${name}\`.`
          : `No live resident worker named \`${name}\` in this thread.`,
      },
    ],
    isError: !killed,
  };
}

function buildWorkerListTool(registry: ResidentWorkerRegistry, threadKey: string) {
  return tool(
    "worker_list",
    "List the resident sub-agent workers owned by this Slack thread, with their status (idle / running / dead), creation time, and last-run time. Resident workers are created via spawn with resident: true + a name.",
    {},
    async () => formatWorkerList(registry, threadKey),
  );
}

function buildWorkerKillTool(registry: ResidentWorkerRegistry, threadKey: string) {
  return tool(
    "worker_kill",
    "Kill a resident sub-agent worker by name. Terminates its held-open process and frees the name for reuse. Use worker_list to see names.",
    { name: z.string().describe("Name of the resident worker to kill.") },
    async ({ name }) => killResidentWorker(registry, threadKey, name),
  );
}

/**
/**
 * 2 hours in ms. Applied to every CLI timer that would otherwise kill a
 * legitimately long-running spawn worker: the MCP tool-call wall clock
 * (default 60s — kills `mcp__spawn__spawn` after 60s no matter what), the
 * sibling MCP request timeout, and the async-agent stall watchdog
 * (default 10 min — kills idle workers waiting on background bash).
 * Each is only set if the user hasn't already exported their own value.
 */
const LONG_TASK_TIMEOUT_MS = "7200000";

/**
 * Env for spawned worker CLI subprocesses. Inherits the wormhole node's
 * process.env, then bumps the CLI's three "task killer" timers to 2 h
 * unless the user has already set them.
 *
 * Why each one matters:
 *   - MCP_TOOL_TIMEOUT — the CLI's hard wall-clock cap on a single MCP
 *     tool call (default 60s, "progress notifications do not extend it").
 *     A bench launched via mcp__spawn__spawn that takes 5 min hits this
 *     and the call aborts mid-flight; the worker process keeps running
 *     but its IPC channel back to the parent is gone.
 *   - MCP_TIMEOUT — sibling default for non-tool MCP requests.
 *   - CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS — the SDK's built-in idle
 *     watchdog (default 10 min). Triggers when there's no tool_use in
 *     flight from the SDK's view, which is exactly what happens during
 *     long benches launched via `run_in_background: true` Bash +
 *     ScheduleWakeup — the worker is genuinely waiting on real work, but
 *     the background-bash tool_result returned in ms, so the SDK sees an
 *     idle agent. Once it fires, every subsequent `mcp__spawn__spawn`
 *     from that worker fails synchronously with "Stream closed" until
 *     the worker exits.
 *
 * Two hours covers every long task this repo actually runs (15–30 min
 * benches, multi-step Codex chains, long verifier loops). If you need
 * more, export the env var with your own value before starting the bot.
 */
export function buildWorkerEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  if (!out.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS) out.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS = LONG_TASK_TIMEOUT_MS;
  if (!out.MCP_TOOL_TIMEOUT) out.MCP_TOOL_TIMEOUT = LONG_TASK_TIMEOUT_MS;
  if (!out.MCP_TIMEOUT) out.MCP_TIMEOUT = LONG_TASK_TIMEOUT_MS;
  return out;
}
