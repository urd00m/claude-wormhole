import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

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

    const q = query({
      prompt,
      options: {
        cwd: this.workdir,
        model: env.ANTHROPIC_MODEL,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
        tools: { type: "preset", preset: "claude_code" },
        // Continue the prior session for this thread once we've started one.
        continue: this.hasStarted,
        canUseTool: this.canUseTool,
        mcpServers: this.mcpServers,
        // Surface token-level deltas so the Slack message updates as the agent writes.
        includePartialMessages: true,
        env: buildChildEnv(),
      },
    });

    let finalText = "";
    const seenToolStarts = new Set<string>();

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      switch (msg.type) {
        case "stream_event": {
          // Incremental token deltas — surface as text-only chunks.
          const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            hooks.onText?.(ev.delta.text);
          }
          break;
        }
        case "assistant": {
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
