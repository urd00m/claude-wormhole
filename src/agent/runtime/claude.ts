import { randomUUID } from "node:crypto";
import {
  query,
  type CanUseTool,
  type SDKMessage,
  type McpSdkServerConfigWithInstance,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { env } from "../../config.js";
import { SYSTEM_PROMPT } from "../systemPrompt.js";
import {
  BACKGROUND_WORKER_TYPE,
  computeChildDepth,
  isSpawnTool,
  MAX_SUBAGENT_DEPTH,
  rewriteSpawnInput,
  SUBAGENT_DISALLOWED_TOOLS,
  SUBAGENT_TOOLS,
} from "../subagentDepth.js";
import type { AgentLaunchConfig, Runtime, SessionInput, SessionOutput, SessionUsage, StreamHooks } from "./types.js";

/**
 * Shape of the SDK's `query` export, minus the parts we don't use. Carved
 * out so tests can inject a fake — the real `query` opens a CLI subprocess
 * which is not viable in unit tests.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<unknown>;
  options?: Record<string, unknown>;
}) => AsyncIterable<SDKMessage> | Query;

export type ClaudeRuntimeOpts = {
  threadKey: string;
  workdir: string;
  /** Per-session launch overrides (from an alias). Claude applies model +
   * effort; `args` (raw CLI flags) are NOT applicable to the SDK path. */
  launch?: AgentLaunchConfig;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  /** Test seam — defaults to the real SDK `query`. */
  queryFn?: QueryFn;
};

/**
 * @deprecated Native Agent/Task is denied at the canUseTool gate
 * (see `REDIRECTED_SPAWN_TOOLS` in canUseTool.ts); these AgentDefinitions
 * are never invoked in normal operation. Retained so the SDK options
 * shape and historical behavior stay buildable for reference / rollback.
 *
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

/**
 * @deprecated See note above. Spawn-MCP is the only active sub-agent
 * dispatch path; RECURSIVE_AGENTS is still passed to `query` for shape
 * compatibility but is never reached because Agent/Task is denied.
 */
export const RECURSIVE_AGENTS: Record<string, import("@anthropic-ai/claude-agent-sdk").AgentDefinition> = {
  "general-purpose": {
    description:
      "General-purpose agent with the full Claude Code tool surface (Bash, Read/Write/Edit, Grep/Glob, web tools, AND the Agent/Task spawning tool) so it can run repo Python/Bash tooling, read project files, and recursively spawn further sub-agents (Planner / Plan-critic / Executor / Analyzer / Verifier / Verdict-critic workers) up to a depth cap.",
    prompt: SUBAGENT_PROMPT,
    tools: [...SUBAGENT_TOOLS],
    disallowedTools: [...SUBAGENT_DISALLOWED_TOOLS],
    permissionMode: "bypassPermissions",
  },
  [BACKGROUND_WORKER_TYPE]: {
    description:
      "Fire-and-forget background worker. Use for long-running tasks (benchmarks, large builds, slow verifiers) where the parent should not wait on the result. The Agent tool returns immediately; completion is reported back into the Slack thread via a task-notification event when the worker finishes. Has the same full tool surface as general-purpose.",
    prompt: BACKGROUND_WORKER_PROMPT,
    tools: [...SUBAGENT_TOOLS],
    disallowedTools: [...SUBAGENT_DISALLOWED_TOOLS],
    background: true,
    permissionMode: "bypassPermissions",
  },
};

/**
 * Claude implementation of the Runtime port. Wraps the Claude Agent SDK's
 * `query()` and consumes its message stream, translating SDK-specific events
 * into runtime-neutral `StreamHooks`.
 *
 * Owns its own conversation-resume state: a UUID pinned per-thread, sent as
 * `sessionId` on the first turn and `resume` on subsequent turns, so two
 * threads sharing a workdir don't bleed conversation history into each
 * other (the bug the cwd-based `continue: true` flag exhibited).
 */
export class ClaudeRuntime implements Runtime {
  readonly name = "claude" as const;
  readonly threadKey: string;
  workdir: string;
  private canUseTool?: CanUseTool;
  private mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  private hasStarted = false;
  /**
   * Stable SDK conversation identifier for THIS thread. Generated once at
   * construction (rotated on setWorkdir / resetConversation). See the
   * `sessionIsolation.test.ts` regression suite for the cross-thread-bleed
   * scenario this guards against.
   */
  private sessionId: string;
  private readonly launch?: AgentLaunchConfig;
  private readonly queryFn: QueryFn;
  /** Cumulative session usage, accumulated from each turn's result message. */
  private usage: { costUsd: number; inputTokens: number; outputTokens: number; turns: number } = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
  };
  /** Latest known rate-limit utilization (0–100), from rate_limit_event. */
  private rateLimits: { fiveHourPct?: number; weeklyPct?: number } = {};
  /**
   * Latest turn's prompt size (input + cache_read + cache_creation) = the
   * context the model saw this turn, and the peak across the session. This
   * is the SAME number the context_length skill extracts from the
   * transcript, but read straight from the SDK result message — so it's
   * available every turn with no transcript-flush race.
   */
  private contextTokens = 0;
  private peakContextTokens = 0;

  constructor(opts: ClaudeRuntimeOpts) {
    this.threadKey = opts.threadKey;
    this.workdir = opts.workdir;
    this.launch = opts.launch;
    this.canUseTool = opts.canUseTool;
    this.mcpServers = opts.mcpServers;
    this.queryFn = opts.queryFn ?? (query as unknown as QueryFn);
    this.sessionId = randomUUID();
  }

  setMcpServers(servers: Record<string, McpSdkServerConfigWithInstance>): void {
    this.mcpServers = servers;
  }

  setCanUseTool(fn: CanUseTool): void {
    this.canUseTool = fn;
  }

  setWorkdir(newWorkdir: string): void {
    if (newWorkdir === this.workdir) return;
    this.workdir = newWorkdir;
    this.hasStarted = false;
    this.sessionId = randomUUID();
  }

  resetConversation(): void {
    this.hasStarted = false;
    this.sessionId = randomUUID();
  }

  /**
   * The pinned SDK session UUID once at least one turn has run — i.e. once
   * the Claude CLI has written a transcript at
   * ~/.claude/projects/*<uuid>.jsonl that the context_length skill can
   * read. Null before the first turn (no transcript yet) or right after a
   * workdir/reset rotation (the new UUID hasn't started a conversation).
   */
  get contextSessionId(): string | null {
    return this.hasStarted ? this.sessionId : null;
  }

  async send(input: SessionInput, hooks: StreamHooks = {}): Promise<SessionOutput> {
    const prompt = buildPrompt(input);

    // Per-turn tool_use_id → spawned-child-depth map. Built incrementally as
    // assistant messages stream in. Consulted by the canUseTool wrapper to
    // deny Task calls past MAX_SUBAGENT_DEPTH.
    const childDepthByToolUseId = new Map<string, number>();
    const userCanUseTool = this.canUseTool;

    // Set of tool_use_ids that were Agent calls with subagent_type ===
    // BACKGROUND_WORKER_TYPE. Used both by the canUseTool wrapper (to
    // mark mid-flight bg dispatches) and by the message-stream loop (to
    // surface only bg task lifecycle events).
    const backgroundToolUseIds = new Set<string>();
    const backgroundTaskIds = new Set<string>();

    const wrappedCanUseTool: CanUseTool = async (toolName, toolInput, options) => {
      let effectiveInput = toolInput;
      // DEPRECATED: this branch handles depth-capping and run_in_background
      // rewriting for native Agent/Task calls. Native Agent/Task is now
      // denied earlier by `buildCanUseTool` (REDIRECTED_SPAWN_TOOLS), so
      // the branch is unreachable in normal operation. Kept (a) so the
      // historical wiring stays buildable and reviewable, (b) as a
      // belt-and-suspenders depth cap if someone ever re-enables Agent
      // without re-thinking the gate.
      if (isSpawnTool(toolName)) {
        const childDepth = childDepthByToolUseId.get(options.toolUseID) ?? 1;
        if (childDepth > MAX_SUBAGENT_DEPTH) {
          return {
            behavior: "deny",
            message: `sub-agent depth ${childDepth} exceeds cap ${MAX_SUBAGENT_DEPTH}`,
          };
        }
        const { input: rewritten, isBackground } = rewriteSpawnInput(toolInput);
        effectiveInput = rewritten;
        if (isBackground) backgroundToolUseIds.add(options.toolUseID);
      }
      if (userCanUseTool) {
        const result = await userCanUseTool(toolName, effectiveInput, options);
        if (result.behavior === "allow" && isSpawnTool(toolName)) {
          return { behavior: "allow", updatedInput: effectiveInput };
        }
        return result;
      }
      return { behavior: "allow", updatedInput: effectiveInput };
    };

    // Pin THIS thread's conversation to its own SDK session_id. On the
    // first send we set `sessionId` (start fresh with our chosen UUID);
    // on subsequent sends we set `resume: sessionId` (continue our own
    // session by ID, NOT by cwd-most-recent). This eliminates cross-thread
    // bleed when multiple Slack threads happen to share a workdir.
    //
    // Capture BOTH the id and the "is-first-send" flag here, because a
    // mid-turn `set_workdir` (via the workdir MCP tool) can mutate
    // `this.sessionId` and reset `this.hasStarted` to false while THIS
    // send is still streaming. The SDK call we hand to the CLI uses the
    // id we capture *now*, not whatever it gets rotated to later.
    const sessionIdAtStart = this.sessionId;
    const wasFirstSend = !this.hasStarted;
    const sessionIdField = wasFirstSend
      ? { sessionId: sessionIdAtStart }
      : { resume: sessionIdAtStart };

    const q = this.queryFn({
      prompt,
      options: {
        cwd: this.workdir,
        model: this.launch?.model ?? env.ANTHROPIC_MODEL,
        // Alias-supplied reasoning effort (SDK option).
        ...(this.launch?.effort ? { effort: this.launch.effort } : {}),
        // Alias-supplied raw CLI flags, forwarded to the `claude` process
        // via the SDK's extraArgs (keys without `--`, null = boolean flag).
        ...(this.launch?.claudeArgs ? { extraArgs: this.launch.claudeArgs } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
        tools: { type: "preset", preset: "claude_code" },
        // AskUserQuestion ships a picker UI in interactive Claude Code, but
        // the wormhole has no Slack surface for it: under bypassPermissions
        // the CLI returns an empty answer and the model loops asking again
        // ("Empty answer again"). Drop it from the model's tool surface;
        // the system prompt tells the model to ask in plain text instead.
        disallowedTools: ["AskUserQuestion"],
        agents: RECURSIVE_AGENTS,
        ...sessionIdField,
        canUseTool: wrappedCanUseTool,
        mcpServers: this.mcpServers,
        includePartialMessages: true,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        additionalDirectories: ["/"],
        env: buildChildEnv(),
      },
    });

    let finalText = "";
    const seenToolStarts = new Set<string>();
    // Per-turn usage, captured from the terminal result message and folded
    // into the cumulative session totals after the stream drains.
    let turnCostUsd = 0;
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let sawResult = false;

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      // Sub-agent messages carry a non-null parent_tool_use_id. Skip
      // user-visible side effects for them so the parent thread's stream,
      // final-text capture, and tool strip reflect only the main agent.
      const parentToolUseId =
        "parent_tool_use_id" in msg
          ? (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null
          : null;
      const isSubAgent = parentToolUseId != null;

      // Depth bookkeeping runs for ALL assistant messages (sub-agent or not)
      // so the cap fires on nested Task calls. Also classify each Agent
      // call as background vs foreground based on the requested
      // subagent_type, so the system-message handler below knows whether
      // to surface it.
      if (msg.type === "assistant") {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_use" && isSpawnTool(block.name)) {
            const depth = computeChildDepth(parentToolUseId, childDepthByToolUseId);
            childDepthByToolUseId.set(block.id, depth);
            const { isBackground } = rewriteSpawnInput(
              (block.input ?? {}) as Record<string, unknown>,
            );
            if (isBackground) backgroundToolUseIds.add(block.id);
          }
        }
      }

      switch (msg.type) {
        case "stream_event": {
          if (isSubAgent) break;
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            hooks.onText?.(ev.delta.text);
          }
          break;
        }
        case "assistant": {
          if (isSubAgent) break;
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
          const r = msg as {
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
          if (r.subtype === "success" && typeof r.result === "string") {
            finalText = r.result;
          }
          // Capture this turn's usage/cost (one terminal result per send).
          // total_cost_usd is this query's cost, so summing across the
          // session's sends gives cumulative session spend.
          if (typeof r.total_cost_usd === "number") turnCostUsd = r.total_cost_usd;
          if (r.usage) {
            turnInputTokens =
              (r.usage.input_tokens ?? 0) +
              (r.usage.cache_read_input_tokens ?? 0) +
              (r.usage.cache_creation_input_tokens ?? 0);
            turnOutputTokens = r.usage.output_tokens ?? 0;
          }
          sawResult = true;
          break;
        }
        case "system": {
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
        case "rate_limit_event": {
          // Subscription rate-limit utilization. Only present for claude.ai
          // subscription users, and `utilization` is omitted at low usage —
          // so we keep the latest known value per window and tolerate gaps.
          const info = (msg as { rate_limit_info?: { rateLimitType?: string; utilization?: number } }).rate_limit_info;
          if (info && typeof info.utilization === "number") {
            // Normalize: the field is a fraction (0–1) on some versions, a
            // percentage on others. Treat <=1 as a fraction.
            const pct = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
            if (info.rateLimitType === "five_hour") {
              this.rateLimits.fiveHourPct = pct;
            } else if (typeof info.rateLimitType === "string" && info.rateLimitType.startsWith("seven_day")) {
              this.rateLimits.weeklyPct = pct;
            }
          }
          break;
        }
        default:
          break;
      }
    }

    // Only mark "started" against the sessionId we actually handed to the
    // SDK above. If `setWorkdir` ran mid-turn it rotated `this.sessionId`
    // to a fresh UUID that was NEVER used to open a conversation — leaving
    // `hasStarted=false` (as setWorkdir already did) lets the next send
    // start that UUID cleanly with `{ sessionId }`. See
    // sessionIsolation.test.ts for the regression scenario.
    if (this.sessionId === sessionIdAtStart) {
      this.hasStarted = true;
    }
    // Fold this turn's usage into the cumulative session totals (once).
    if (sawResult) {
      this.usage.costUsd += turnCostUsd;
      this.usage.inputTokens += turnInputTokens;
      this.usage.outputTokens += turnOutputTokens;
      this.usage.turns += 1;
      // This turn's prompt size IS the current context size; track latest + peak.
      this.contextTokens = turnInputTokens;
      this.peakContextTokens = Math.max(this.peakContextTokens, turnInputTokens);
    }
    const out = finalText || "_(no response)_";
    hooks.onFinal?.(out);
    return { finalText: out };
  }

  /** Cumulative session usage, or null before any turn has completed. */
  usageSnapshot(): SessionUsage | null {
    if (this.usage.turns === 0) return null;
    return {
      ...this.usage,
      fiveHourPct: this.rateLimits.fiveHourPct,
      weeklyPct: this.rateLimits.weeklyPct,
      contextTokens: this.contextTokens,
      peakContextTokens: this.peakContextTokens,
    };
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
