// Runtime-neutral tool defs for the `slack` MCP server (slack_post_message,
// slack_post_file). No Anthropic SDK imports — see ./types.ts for the
// rationale.

import path from "node:path";
import { z } from "zod";
import type { WebClient } from "@slack/web-api";
import { uploadFile } from "../../slack/upload.js";
import { splitForSlack } from "../../slack/stream.js";
import { textError, textResult, type ToolDef } from "./types.js";

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
 * actually posted. Used by the tool handler below AND by spawn.ts +
 * handlers.ts for direct posting.
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

export function slackPostMessageDef(ctx: SlackContext): ToolDef<{ text: z.ZodString }> {
  return {
    name: "slack_post_message",
    description:
      "Post a plain text message into the current Slack thread. Use for status updates or extra context. Long messages are auto-split into multiple thread posts (code fences preserved across splits).",
    schema: { text: z.string().describe("Message text (Slack mrkdwn allowed).") },
    handler: async ({ text }) => {
      const n = await postSlackMessage(ctx.client, ctx.channel, ctx.threadTs, text);
      return textResult(n === 1 ? "posted" : `posted (${n} parts)`);
    },
  };
}

export function slackPostFileDef(
  ctx: SlackContext,
): ToolDef<{ path: z.ZodString; title: z.ZodOptional<z.ZodString> }> {
  return {
    name: "slack_post_file",
    description:
      "Upload a file from the current working directory into the Slack thread. Use for images, diagrams, generated PDFs, etc.",
    schema: {
      path: z.string().describe("Relative path within the session workdir, e.g. 'diagram.png'."),
      title: z.string().optional().describe("Optional title shown in Slack."),
    },
    handler: async ({ path: relPath, title }) => {
      const abs = path.isAbsolute(relPath) ? relPath : path.join(ctx.workdir, relPath);
      if (!abs.startsWith(ctx.workdir) && !path.isAbsolute(relPath)) {
        return textError("error: path escapes workdir");
      }
      try {
        await uploadFile(ctx.client, ctx.channel, ctx.threadTs, abs, title);
        return textResult(`uploaded ${path.basename(abs)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textError(`upload failed: ${msg}`);
      }
    },
  };
}

/** Convenience: all slack tool defs for a context, in deterministic order. */
export function slackToolDefs(ctx: SlackContext): ReadonlyArray<ToolDef<z.ZodRawShape>> {
  return [
    slackPostMessageDef(ctx) as ToolDef<z.ZodRawShape>,
    slackPostFileDef(ctx) as ToolDef<z.ZodRawShape>,
  ];
}
