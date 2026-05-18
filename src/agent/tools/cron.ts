import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { validate } from "node-cron";
import type { Scheduler } from "../../scheduler/scheduler.js";

export type CronMcpCtx = {
  scheduler: Scheduler;
  /** Channel ID of the conversation registering the cron. Used as default. */
  currentChannel: string;
  createdBy?: string;
};

/**
 * MCP server exposing cron_add / cron_list / cron_remove. The agent calls
 * these when a user asks to schedule, list, or cancel a recurring task.
 */
export function buildCronMcp(ctx: CronMcpCtx) {
  const cronAdd = tool(
    "cron_add",
    "Schedule a recurring prompt. Use this when the user asks to do something on a schedule (e.g. 'every Monday at 9am'). The prompt fires as if the user sent it as a new message in the target channel.",
    {
      expression: z
        .string()
        .describe(
          "A 5- or 6-field cron expression (minute hour day month weekday [second]). Examples: '0 9 * * 1' = Mondays at 9am; '*/15 * * * *' = every 15 minutes; '0 0 1 * *' = first of each month at midnight.",
        ),
      prompt: z
        .string()
        .describe("The prompt the agent should execute when the cron fires. Be specific — the agent will have no other context."),
      channel: z
        .string()
        .optional()
        .describe("Slack channel ID to post into. Defaults to the current channel."),
      timezone: z
        .string()
        .optional()
        .describe("IANA timezone, e.g. 'America/Los_Angeles'. Defaults to the host timezone."),
      description: z
        .string()
        .optional()
        .describe("Short human-readable label shown when the cron fires and in cron_list output."),
    },
    async ({ expression, prompt, channel, timezone, description }) => {
      if (!validate(expression)) {
        return {
          content: [{ type: "text", text: `Invalid cron expression: ${expression}` }],
          isError: true,
        };
      }
      try {
        const entry = ctx.scheduler.add({
          expression,
          prompt,
          channel: channel ?? ctx.currentChannel,
          timezone,
          description,
          createdBy: ctx.createdBy,
        });
        const next = ctx.scheduler.nextRun(entry.id);
        const lines = [
          `Scheduled \`${entry.id}\` — \`${expression}\`${timezone ? ` (${timezone})` : ""}`,
          `Channel: <#${entry.channel}>`,
          `Next run: ${next ? next.toISOString() : "unknown"}`,
        ];
        if (description) lines.push(`Description: ${description}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to schedule: ${msg}` }], isError: true };
      }
    },
  );

  const cronList = tool(
    "cron_list",
    "List all currently scheduled cron jobs and their next-run times.",
    {},
    async () => {
      const entries = ctx.scheduler.list();
      if (entries.length === 0) {
        return { content: [{ type: "text", text: "No scheduled jobs." }] };
      }
      const lines = entries.map((e) => {
        const next = ctx.scheduler.nextRun(e.id);
        return [
          `• \`${e.id}\` — \`${e.expression}\`${e.timezone ? ` (${e.timezone})` : ""}`,
          `  channel: <#${e.channel}> · next: ${next ? next.toISOString() : "n/a"}`,
          e.description ? `  ${e.description}` : null,
          `  prompt: ${e.prompt.length > 100 ? e.prompt.slice(0, 100) + "…" : e.prompt}`,
        ]
          .filter(Boolean)
          .join("\n");
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  const cronRemove = tool(
    "cron_remove",
    "Cancel a scheduled cron job by id. The id comes from cron_add or cron_list output.",
    { id: z.string().describe("The cron id, e.g. 'cron_abc123'.") },
    async ({ id }) => {
      const ok = ctx.scheduler.remove(id);
      return {
        content: [{ type: "text", text: ok ? `Removed \`${id}\`.` : `No cron with id \`${id}\` found.` }],
        isError: !ok,
      };
    },
  );

  return createSdkMcpServer({
    name: "cron",
    version: "0.1.0",
    tools: [cronAdd, cronList, cronRemove],
    alwaysLoad: true,
  });
}
