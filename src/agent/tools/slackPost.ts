// Claude-MCP wrapper for the `slack` tool surface. The tool defs themselves
// live in slackPostDef.ts (runtime-neutral); this file only exists to
// preserve the existing public import shape (`buildSlackMcp`,
// `postSlackMessage`, `SlackContext`) so callers don't have to change.

import { buildClaudeMcpServer } from "./claudeMcp.js";
import { slackToolDefs, type SlackContext } from "./slackPostDef.js";

export { postSlackMessage, type SlackContext } from "./slackPostDef.js";

/**
 * Build the Claude SDK MCP server scoped to a single Slack thread so the
 * agent (and sub-agents) can post messages and upload files back into the
 * conversation.
 */
export function buildSlackMcp(ctx: SlackContext) {
  return buildClaudeMcpServer("slack", slackToolDefs(ctx));
}
