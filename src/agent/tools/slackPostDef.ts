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
 * stay balanced across boundaries. Returns the `ts` of every thread message
 * actually posted (one per part), in order — the count is `.length`. The
 * timestamps let a caller delete the messages later (see
 * `slack_delete_message`). Used by the tool handler below AND by spawn.ts +
 * handlers.ts for direct posting.
 */
export async function postSlackMessage(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
): Promise<string[]> {
  const parts = splitForSlack(text, MAX_PART_CHARS);
  const tsList: string[] = [];
  for (const part of parts) {
    const res = await client.chat.postMessage({ channel, thread_ts: threadTs, text: part });
    if (res.ts) tsList.push(res.ts);
  }
  return tsList;
}

/**
 * Delete messages from a Slack channel by `ts`. Scoped to a single channel —
 * the caller passes the channel the bot is operating in, so the agent can
 * never reach into other channels. Slack's `chat.delete` only succeeds for
 * messages the bot itself authored (with the `chat:write` scope), so this is
 * naturally limited to the wormhole's own posts. Returns the per-ts outcome
 * so the handler can report partial failures rather than silently dropping
 * them.
 */
export async function deleteSlackMessages(
  client: WebClient,
  channel: string,
  tsList: string[],
): Promise<{ deleted: string[]; failed: Array<{ ts: string; error: string }> }> {
  const deleted: string[] = [];
  const failed: Array<{ ts: string; error: string }> = [];
  for (const ts of tsList) {
    try {
      await client.chat.delete({ channel, ts });
      deleted.push(ts);
    } catch (err) {
      failed.push({ ts, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { deleted, failed };
}

export function slackPostMessageDef(ctx: SlackContext): ToolDef<{ text: z.ZodString }> {
  return {
    name: "slack_post_message",
    description:
      "Post a plain text message into the current Slack thread. Use for status updates or extra context. Long messages are auto-split into multiple thread posts (code fences preserved across splits). Returns the message timestamp(s) (`ts`); pass them to slack_delete_message to remove the posts later.",
    schema: { text: z.string().describe("Message text (Slack mrkdwn allowed).") },
    handler: async ({ text }) => {
      const ts = await postSlackMessage(ctx.client, ctx.channel, ctx.threadTs, text);
      if (ts.length === 0) return textResult("posted");
      const tsCsv = ts.join(", ");
      return textResult(
        ts.length === 1 ? `posted (ts ${tsCsv})` : `posted (${ts.length} parts; ts ${tsCsv})`,
      );
    },
  };
}

export function slackDeleteMessageDef(
  ctx: SlackContext,
): ToolDef<{ ts: z.ZodArray<z.ZodString> }> {
  return {
    name: "slack_delete_message",
    description:
      "Delete one or more messages the bot posted in the current Slack channel, by their `ts` timestamp (as returned by slack_post_message). Use to clean up after yourself — e.g. removing oversized debug messages. Only the bot's own messages can be deleted, and only in the current channel. Reports which deletions succeeded and which failed.",
    schema: {
      ts: z
        .array(z.string())
        .describe("Message timestamps (`ts`) to delete, e.g. ['1716740000.123456']."),
    },
    handler: async ({ ts }) => {
      if (ts.length === 0) return textError("error: no message timestamps given");
      const { deleted, failed } = await deleteSlackMessages(ctx.client, ctx.channel, ts);
      const parts: string[] = [];
      if (deleted.length > 0) parts.push(`deleted ${deleted.length} (${deleted.join(", ")})`);
      if (failed.length > 0) {
        parts.push(`failed ${failed.length} (${failed.map((f) => `${f.ts}: ${f.error}`).join("; ")})`);
      }
      const summary = parts.join("; ") || "nothing to delete";
      return failed.length > 0 ? textError(summary) : textResult(summary);
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
    slackDeleteMessageDef(ctx) as ToolDef<z.ZodRawShape>,
  ];
}
