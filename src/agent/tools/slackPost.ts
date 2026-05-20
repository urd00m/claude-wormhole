import path from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { uploadFile } from "../../slack/upload.js";
import { splitForSlack } from "../../slack/stream.js";

// Slack's chat.postMessage `text` is capped at 40,000 chars and truncates
// silently past that. Stay well under to leave headroom for fence rebalancing
// when splitForSlack reopens code blocks across boundaries.
const MAX_PART_CHARS = 38000;

export type SlackContext = {
  client: WebClient;
  channel: string;
  threadTs: string;
  workdir: string;
};

/**
 * Post a (possibly long) message to a Slack thread, splitting at
 * MAX_PART_CHARS so each chunk stays under Slack's 40k cap and code fences
 * stay balanced across boundaries. Returns the number of thread messages
 * actually posted.
 */
export async function postSlackMessage(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<number> {
  const parts = splitForSlack(text, MAX_PART_CHARS);
  for (const part of parts) {
    await client.chat.postMessage({ channel, thread_ts: threadTs, text: part });
  }
  return parts.length;
}

/**
 * Build an MCP server scoped to a single Slack thread so the agent (and
 * sub-agents) can post messages and upload files back into the conversation.
 */
export function buildSlackMcp(ctx: SlackContext) {
  const postMessage = tool(
    "slack_post_message",
    "Post a plain text message into the current Slack thread. Use for status updates or extra context. Long messages are auto-split into multiple thread posts (code fences preserved across splits).",
    { text: z.string().describe("Message text (Slack mrkdwn allowed).") },
    async ({ text }) => {
      const n = await postSlackMessage(ctx.client, ctx.channel, ctx.threadTs, text);
      const summary = n === 1 ? "posted" : `posted (${n} parts)`;
      return { content: [{ type: "text", text: summary }] };
    },
  );

  const postFile = tool(
    "slack_post_file",
    "Upload a file from the current working directory into the Slack thread. Use for images, diagrams, generated PDFs, etc.",
    {
      path: z.string().describe("Relative path within the session workdir, e.g. 'diagram.png'."),
      title: z.string().optional().describe("Optional title shown in Slack."),
    },
    async ({ path: relPath, title }) => {
      const abs = path.isAbsolute(relPath) ? relPath : path.join(ctx.workdir, relPath);
      if (!abs.startsWith(ctx.workdir) && !path.isAbsolute(relPath)) {
        return { content: [{ type: "text", text: "error: path escapes workdir" }], isError: true };
      }
      try {
        await uploadFile(ctx.client, ctx.channel, ctx.threadTs, abs, title);
        return { content: [{ type: "text", text: `uploaded ${path.basename(abs)}` }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `upload failed: ${msg}` }], isError: true };
      }
    },
  );

  return createSdkMcpServer({
    name: "slack",
    version: "0.1.0",
    tools: [postMessage, postFile],
    alwaysLoad: true,
  });
}
