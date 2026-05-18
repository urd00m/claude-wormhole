import path from "node:path";
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { WebClient } from "@slack/web-api";
import { uploadFile } from "../../slack/upload.js";

export type SlackContext = {
  client: WebClient;
  channel: string;
  threadTs: string;
  workdir: string;
};

/**
 * Build an MCP server scoped to a single Slack thread so the agent (and
 * sub-agents) can post messages and upload files back into the conversation.
 */
export function buildSlackMcp(ctx: SlackContext) {
  const postMessage = tool(
    "slack_post_message",
    "Post a plain text message into the current Slack thread. Use for status updates or extra context.",
    { text: z.string().describe("Message text (Slack mrkdwn allowed).") },
    async ({ text }) => {
      await ctx.client.chat.postMessage({
        channel: ctx.channel,
        thread_ts: ctx.threadTs,
        text,
      });
      return { content: [{ type: "text", text: "posted" }] };
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
