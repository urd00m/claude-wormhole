import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { classifyToolCall } from "./guards.js";
import { askConsent } from "../slack/consent.js";

type Ctx = {
  client: WebClient;
  channel: string;
  threadTs: string;
};

/**
 * MCP tools that mutate parent-thread state. Sub-agents (identified by a
 * non-empty options.agentID from the SDK) must not be able to call these — a
 * sub-agent shouldn't be able to hijack the parent thread's workdir or
 * register persistent cron jobs without an explicit user ask.
 */
const SUBAGENT_BLOCKED_TOOLS = new Set([
  "mcp__workdir__set_workdir",
  "mcp__workdir__reset_workdir",
  "mcp__cron__cron_add",
  "mcp__cron__cron_remove",
]);

/**
 * Native sub-agent-spawning tool names. The harness routes ALL sub-agent
 * creation through `mcp__spawn__spawn` instead. We deny these names at the
 * canUseTool gate with a redirect message — the model sees the deny in the
 * tool_result and retries against spawn. Lives here (not in subagentDepth.ts)
 * because (a) this is the enforcement point and (b) subagentDepth.ts's
 * isSpawnTool is now deprecated; we don't want the policy decision to depend
 * on a deprecated symbol.
 */
const REDIRECTED_SPAWN_TOOLS = new Set(["Agent", "Task"]);

const SPAWN_REDIRECT_MESSAGE =
  "Agent/Task is disabled in this harness. Use `mcp__spawn__spawn` instead — same purpose, accepts `{ prompt: string, description?: string, background?: boolean }`. Multiple spawn calls in one assistant turn run in parallel; set `background: true` for fire-and-forget.";

// AskUserQuestion has no Slack surface (the CLI's picker UI is interactive-
// only) and under bypassPermissions the CLI returns an empty answer when the
// tool fires — which the model interprets as "ask again," producing an
// infinite loop where the agent is stuck waiting for input that the harness
// cannot deliver. session.ts and tools/spawn.ts already remove the tool from
// the model's surface via `disallowedTools`; this is a belt-and-suspenders
// gate so any future preset change or agent variant that still surfaces the
// tool can't death-loop. The deny message redirects the model to ask in
// plain text instead — the user replies in the next Slack message.
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const ASK_USER_QUESTION_REDIRECT =
  "AskUserQuestion is disabled in this harness (no Slack picker UI). Ask your question as plain text in your reply; the user will answer in their next Slack message.";

export type Gate = (
  toolName: string,
  input: Record<string, unknown>,
  agentID: string | undefined,
) =>
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

/** Pure decision function — exposed for unit tests. */
export function classifyCall(
  toolName: string,
  input: Record<string, unknown>,
  agentID: string | undefined,
): ReturnType<Gate> {
  // Harness enforcement: native sub-agent spawn tools are redirected to
  // the spawn MCP. Applies at every layer (main thread and sub-agents)
  // because the same buildCanUseTool is wired for both.
  if (REDIRECTED_SPAWN_TOOLS.has(toolName)) {
    return { kind: "deny", reason: SPAWN_REDIRECT_MESSAGE };
  }
  if (toolName === ASK_USER_QUESTION_TOOL) {
    return { kind: "deny", reason: ASK_USER_QUESTION_REDIRECT };
  }
  if (agentID && SUBAGENT_BLOCKED_TOOLS.has(toolName)) {
    return { kind: "deny", reason: `${toolName} is not available to sub-agents` };
  }
  const reason = classifyToolCall(toolName, input);
  if (reason) return { kind: "ask", reason };
  return { kind: "allow" };
}

/** Build a canUseTool hook for one Slack thread / session. */
export function buildCanUseTool(ctx: Ctx): CanUseTool {
  return async (toolName, input, options) => {
    const agentID = options.agentID;
    const decision = classifyCall(toolName, input, agentID);
    if (decision.kind === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    if (decision.kind === "deny") {
      return { behavior: "deny", message: decision.reason };
    }
    const command = typeof input.command === "string" ? input.command : JSON.stringify(input);
    const approved = await askConsent({
      client: ctx.client,
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      toolName,
      command,
      reason: decision.reason,
      agentID,
    });
    if (approved) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `User declined: ${decision.reason}` };
  };
}
