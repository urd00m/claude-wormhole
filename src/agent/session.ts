import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import {
  computeChildDepth,
  isSpawnTool,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_ALLOWLIST,
} from "./subagentDepth.js";

export type SessionInput = {
  text: string;
  attachments?: string[];
};

export type SessionOutput = {
  finalText: string;
};

/**
 * Lifecycle events for sub-agent Tasks (especially background ones, whose
 * completion arrives out-of-band on the parent's message stream).
 *
 * The SDK emits these as `system` messages with subtype `task_started` /
 * `task_progress` / `task_notification`. Foreground Agent calls also emit
 * them, but their progress is already visible to the parent via the
 * synchronous tool_result. Background workers (`subagent_type:
 * "background-worker"`) return immediately to the parent, so without
 * surfacing these events the user would never see them complete.
 */
export type TaskEvent =
  | {
      kind: "started";
      taskId: string;
      toolUseId?: string;
      description: string;
      subagentType?: string;
    }
  | {
      kind: "progress";
      taskId: string;
      toolUseId?: string;
      description: string;
      summary?: string;
    }
  | {
      kind: "notification";
      taskId: string;
      toolUseId?: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
    };

export type StreamHooks = {
  onText?: (chunk: string) => void;
  /** `id` is the SDK's tool_use_id; pair with onToolEnd for matching. */
  onToolStart?: (id: string, name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (id: string, ok: boolean) => void;
  /** Called once with the canonical final text after the agent finishes. */
  onFinal?: (text: string) => void;
  /**
   * Called for sub-agent task lifecycle events. Only fires for tasks the
   * Session has classified as background (i.e. spawned with subagent_type
   * "background-worker") — foreground Agent calls already surface progress
   * through the normal tool strip.
   */
  onTaskEvent?: (event: TaskEvent) => void;
};

type SessionOpts = {
  threadKey: string;
  workdir: string;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
};

/**
 * Override the built-in `general-purpose` sub-agent so it gets the full tool
 * surface — Bash, file tools, web tools, AND the spawning tool (`Agent`),
 * which the SDK's default for unconfigured `general-purpose` omits as a
 * safety measure. Tools are listed explicitly here rather than via the
 * "omit to inherit" semantic, because in practice that inheritance does
 * NOT include Bash/Agent.
 *
 * Recursive sub-agent nesting is bounded by MAX_SUBAGENT_DEPTH, enforced
 * in the canUseTool wrapper below.
 */
const SUBAGENT_PROMPT = `You are a general-purpose sub-agent launched by a parent agent. You have the full Claude Code tool surface — Bash, Read/Write/Edit, Grep/Glob, WebFetch/WebSearch — AND the Agent tool, so you may spawn further sub-agents (Planner / Critic / Verifier / workers) for parallel or context-isolated work. Recursive sub-agent depth is capped at ${MAX_SUBAGENT_DEPTH}; deeper spawns will be denied with a clear error. Be concise: do the work and report a tight, self-contained result to the parent.`;

const BACKGROUND_WORKER_PROMPT = `You are a background sub-agent. Your invocation returned to the parent immediately — the parent is NOT waiting on your tool_result. Do the work, then write your final report to the file path provided by the SDK (or to a file in the working directory, mentioned in your final summary). The parent will see your completion via a task-notification event in its Slack thread. You have the full tool surface; nested-Agent depth is bounded at ${MAX_SUBAGENT_DEPTH}. Be self-contained — the parent has no way to ask you follow-ups, so commit any context you need into your summary.`;

export const BACKGROUND_WORKER_TYPE = "background-worker";

const RECURSIVE_AGENTS: Record<string, import("@anthropic-ai/claude-agent-sdk").AgentDefinition> = {
  "general-purpose": {
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Has the full Claude Code tool surface including Bash and the Agent tool, so it can spawn further sub-agents up to a depth cap.",
    prompt: SUBAGENT_PROMPT,
    tools: [...SUBAGENT_TOOL_ALLOWLIST],
  },
  [BACKGROUND_WORKER_TYPE]: {
    description:
      "Fire-and-forget background worker. Use for long-running tasks (benchmarks, large builds, slow verifiers) where the parent should not wait on the result. The Agent tool returns immediately; completion is reported back into the Slack thread via a task-notification event when the worker finishes. Has the same full tool surface as general-purpose.",
    prompt: BACKGROUND_WORKER_PROMPT,
    tools: [...SUBAGENT_TOOL_ALLOWLIST],
    background: true,
  },
};

export class Session {
  readonly threadKey: string;
  workdir: string;
  private canUseTool?: CanUseTool;
  private mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  private hasStarted = false;

  constructor(opts: SessionOpts) {
    this.threadKey = opts.threadKey;
    this.workdir = opts.workdir;
    this.canUseTool = opts.canUseTool;
    this.mcpServers = opts.mcpServers;
  }

  setMcpServers(servers: Record<string, McpSdkServerConfigWithInstance>): void {
    this.mcpServers = servers;
  }

  setCanUseTool(fn: CanUseTool): void {
    this.canUseTool = fn;
  }

  /**
   * Switch the working directory for subsequent agent runs. Resets the
   * session-continue flag so the SDK starts fresh in the new directory
   * (CLAUDE.md and other project context will be reloaded).
   */
  setWorkdir(newWorkdir: string): void {
    if (newWorkdir === this.workdir) return;
    this.workdir = newWorkdir;
    this.hasStarted = false;
  }

  async send(input: SessionInput, hooks: StreamHooks = {}): Promise<SessionOutput> {
    const prompt = buildPrompt(input);

    // Per-turn tool_use_id → spawned-child-depth map. Built incrementally as
    // assistant messages stream in. Consulted by the canUseTool wrapper to
    // deny Task calls past MAX_SUBAGENT_DEPTH.
    const childDepthByToolUseId = new Map<string, number>();
    const userCanUseTool = this.canUseTool;

    const wrappedCanUseTool: CanUseTool = async (toolName, toolInput, options) => {
      if (isSpawnTool(toolName)) {
        // childDepthByToolUseId is populated when we see the issuing assistant
        // message. If the entry is missing (race with our async iterator),
        // default to 1 so we never spuriously deny the first level.
        const childDepth = childDepthByToolUseId.get(options.toolUseID) ?? 1;
        if (childDepth > MAX_SUBAGENT_DEPTH) {
          return {
            behavior: "deny",
            message: `sub-agent depth ${childDepth} exceeds cap ${MAX_SUBAGENT_DEPTH}`,
          };
        }
      }
      if (userCanUseTool) return userCanUseTool(toolName, toolInput, options);
      return { behavior: "allow", updatedInput: toolInput };
    };

    const q = query({
      prompt,
      options: {
        cwd: this.workdir,
        model: env.ANTHROPIC_MODEL,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
        tools: { type: "preset", preset: "claude_code" },
        agents: RECURSIVE_AGENTS,
        // Continue the prior session for this thread once we've started one.
        continue: this.hasStarted,
        canUseTool: wrappedCanUseTool,
        mcpServers: this.mcpServers,
        // Surface token-level deltas so the Slack message updates as the agent writes.
        includePartialMessages: true,
        env: buildChildEnv(),
      },
    });

    let finalText = "";
    const seenToolStarts = new Set<string>();

    // Set of tool_use_ids that were Agent calls with subagent_type ===
    // BACKGROUND_WORKER_TYPE. Used to filter task lifecycle system messages
    // so we only surface bg events (foreground Agent calls report progress
    // via the normal tool strip already).
    const backgroundToolUseIds = new Set<string>();
    // task_id → tool_use_id mapping. task_started gives us both; later
    // task_progress / task_notification only carry tool_use_id, but we
    // cache task_id too so consumers can group by stable ID.
    const backgroundTaskIds = new Set<string>();

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      // Sub-agent messages carry a non-null parent_tool_use_id. Skip
      // user-visible side effects for them so the parent thread's stream,
      // final-text capture, and tool strip reflect only the main agent.
      // The parent's `Task` tool_use itself lives on a main-agent assistant
      // message (parent_tool_use_id: null) and still surfaces normally.
      const parentToolUseId =
        "parent_tool_use_id" in msg
          ? (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null
          : null;
      const isSubAgent = parentToolUseId != null;

      // Depth bookkeeping runs for ALL assistant messages (sub-agent or not)
      // so the cap fires on nested Task calls. This must happen before the
      // isSubAgent gate below. Also classify each Agent call as
      // background vs foreground based on the requested subagent_type, so
      // the system-message handler below knows whether to surface it.
      if (msg.type === "assistant") {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_use" && isSpawnTool(block.name)) {
            const depth = computeChildDepth(parentToolUseId, childDepthByToolUseId);
            childDepthByToolUseId.set(block.id, depth);
            const subagentType = (block.input as { subagent_type?: unknown } | undefined)?.subagent_type;
            if (typeof subagentType === "string" && subagentType === BACKGROUND_WORKER_TYPE) {
              backgroundToolUseIds.add(block.id);
            }
          }
        }
      }

      switch (msg.type) {
        case "stream_event": {
          if (isSubAgent) break;
          // Incremental token deltas — surface as text-only chunks.
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            hooks.onText?.(ev.delta.text);
          }
          break;
        }
        case "assistant": {
          if (isSubAgent) break;
          // Full assistant turn — capture final text and tool_use starts.
          const content = msg.message?.content ?? [];
          for (const block of content) {
            if (block.type === "text") {
              finalText = block.text;
            } else if (block.type === "tool_use") {
              if (!seenToolStarts.has(block.id)) {
                seenToolStarts.add(block.id);
                hooks.onToolStart?.(block.id, block.name, (block.input ?? {}) as Record<string, unknown>);
              }
            }
          }
          break;
        }
        case "user": {
          if (isSubAgent) break;
          // Tool results come back as user messages with tool_result blocks.
          const content = msg.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === "object" && block !== null && "type" in block && block.type === "tool_result") {
                const tr = block as { tool_use_id?: string; is_error?: boolean };
                if (tr.tool_use_id) {
                  hooks.onToolEnd?.(tr.tool_use_id, !tr.is_error);
                }
              }
            }
          }
          break;
        }
        case "result": {
          const r = msg as { subtype?: string; result?: string };
          if (r.subtype === "success" && typeof r.result === "string") {
            finalText = r.result;
          }
          break;
        }
        case "system": {
          // Task lifecycle events (task_started / task_progress /
          // task_notification) for background workers. The parent's
          // Agent tool_use already returned synchronously with a
          // "spawned" tool_result, so without these events the user
          // never learns when the worker actually finishes. Foreground
          // Agent calls also emit these but we suppress them — their
          // progress is already in the tool strip.
          const s = msg as {
            subtype?: string;
            task_id?: string;
            tool_use_id?: string;
            description?: string;
            subagent_type?: string;
            summary?: string;
            status?: "completed" | "failed" | "stopped";
            patch?: { status?: string; error?: string };
          };
          const tuid = s.tool_use_id;
          const isBackground =
            (tuid != null && backgroundToolUseIds.has(tuid)) ||
            (s.task_id != null && backgroundTaskIds.has(s.task_id));
          if (!isBackground) break;
          if (s.task_id) backgroundTaskIds.add(s.task_id);

          switch (s.subtype) {
            case "task_started":
              if (s.task_id) {
                hooks.onTaskEvent?.({
                  kind: "started",
                  taskId: s.task_id,
                  toolUseId: tuid,
                  description: s.description ?? "(no description)",
                  subagentType: s.subagent_type,
                });
              }
              break;
            case "task_progress":
              if (s.task_id) {
                hooks.onTaskEvent?.({
                  kind: "progress",
                  taskId: s.task_id,
                  toolUseId: tuid,
                  description: s.description ?? "",
                  summary: s.summary,
                });
              }
              break;
            case "task_notification":
              if (s.task_id && s.status) {
                hooks.onTaskEvent?.({
                  kind: "notification",
                  taskId: s.task_id,
                  toolUseId: tuid,
                  status: s.status,
                  summary: s.summary ?? "",
                });
              }
              break;
            default:
              break;
          }
          break;
        }
        default:
          break;
      }
    }

    this.hasStarted = true;
    const out = finalText || "_(no response)_";
    hooks.onFinal?.(out);
    return { finalText: out };
  }
}

/**
 * Build the env passed to the Claude Code subprocess. If ANTHROPIC_API_KEY is
 * set, use it. If not, omit the var entirely so the subprocess falls back to
 * OAuth credentials at ~/.claude/ (i.e., a Claude Pro/Max subscription).
 */
function buildChildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  if (env.ANTHROPIC_API_KEY) {
    out.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  } else {
    delete out.ANTHROPIC_API_KEY;
  }
  return out;
}

function buildPrompt(input: SessionInput): string {
  const parts: string[] = [];
  if (input.attachments && input.attachments.length > 0) {
    parts.push(`User uploaded files (in ./uploads/):`);
    for (const a of input.attachments) parts.push(`- ${a}`);
    parts.push("");
  }
  parts.push(input.text);
  return parts.join("\n");
}
