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
