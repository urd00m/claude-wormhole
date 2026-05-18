import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { classifyToolCall } from "./guards.js";
import { askConsent } from "../slack/consent.js";

type Ctx = {
  client: WebClient;
  channel: string;
  threadTs: string;
};

/** Build a canUseTool hook for one Slack thread / session. */
export function buildCanUseTool(ctx: Ctx): CanUseTool {
  return async (toolName, input) => {
    const reason = classifyToolCall(toolName, input);
    if (!reason) {
      return { behavior: "allow", updatedInput: input };
    }
    const command = typeof input.command === "string" ? input.command : JSON.stringify(input);
    const approved = await askConsent({
      client: ctx.client,
      channel: ctx.channel,
      threadTs: ctx.threadTs,
      toolName,
      command,
      reason,
    });
    if (approved) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `User declined: ${reason}` };
  };
}
