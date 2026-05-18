import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { computeChildDepth, MAX_SUBAGENT_DEPTH } from "./subagentDepth.js";

export type SessionInput = {
  text: string;
  attachments?: string[];
};

export type SessionOutput = {
  finalText: string;
};

export type StreamHooks = {
  onText?: (chunk: string) => void;
  /** `id` is the SDK's tool_use_id; pair with onToolEnd for matching. */
  onToolStart?: (id: string, name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (id: string, ok: boolean) => void;
  /** Called once with the canonical final text after the agent finishes. */
  onFinal?: (text: string) => void;
};

type SessionOpts = {
  threadKey: string;
  workdir: string;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
};

/**
 * Override the built-in `general-purpose` sub-agent. The SDK doc for
 * AgentDefinition.tools says: "If omitted, inherits all tools from parent."
 * Omitting `tools` here means sub-agents inherit the parent's full surface,
 * including `Task` — so they can spawn further sub-agents. Recursion is
 * bounded by MAX_SUBAGENT_DEPTH, enforced in the canUseTool wrapper below.
 */
const SUBAGENT_PROMPT = `You are a general-purpose sub-agent launched by a parent agent. You have inherited the full tool surface — including the Task tool, so you may spawn further sub-agents for parallel or context-isolated work. Recursive sub-agent depth is capped at ${MAX_SUBAGENT_DEPTH}; deeper spawns will be denied. Be concise: do the work and report a tight result to the parent.`;

const RECURSIVE_AGENTS = {
  "general-purpose": {
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Inherits the parent's full tool surface (including Task) so it can spawn further sub-agents up to a depth cap.",
    prompt: SUBAGENT_PROMPT,
    // tools omitted on purpose → inherit everything from parent
  },
} as const;

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
      if (toolName === "Task") {
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
      // isSubAgent gate below.
      if (msg.type === "assistant") {
        const content = msg.message?.content ?? [];
        for (const block of content) {
          if (block.type === "tool_use" && block.name === "Task") {
            const depth = computeChildDepth(parentToolUseId, childDepthByToolUseId);
            childDepthByToolUseId.set(block.id, depth);
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
