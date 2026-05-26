// Runtime-neutral tool defs for the `cron` MCP server
// (cron_add / cron_list / cron_remove).

import { z } from "zod";
import { validate } from "node-cron";
import type { CronEntry } from "../../scheduler/store.js";
import { textError, textResult, type ToolDef } from "./types.js";

/**
 * Minimal scheduler shape the cron tools need. Structurally typed so tests
 * can inject a fake without the on-disk store side effects.
 */
export interface CronCapableScheduler {
  add(input: Omit<CronEntry, "id" | "createdAt"> & { id?: string }): CronEntry;
  list(): CronEntry[];
  remove(id: string): boolean;
  nextRun(id: string): Date | null;
}

export type CronMcpCtx = {
  scheduler: CronCapableScheduler;
  /** Channel ID of the conversation registering the cron. Used as default. */
  currentChannel: string;
  createdBy?: string;
};

type CronAddSchema = {
  expression: z.ZodString;
  prompt: z.ZodString;
  channel: z.ZodOptional<z.ZodString>;
  timezone: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
};

export function cronAddDef(ctx: CronMcpCtx): ToolDef<CronAddSchema> {
  return {
    name: "cron_add",
    description:
      "Schedule a recurring prompt. Use this when the user asks to do something on a schedule (e.g. 'every Monday at 9am'). The prompt fires as if the user sent it as a new message in the target channel.",
    schema: {
      expression: z
        .string()
        .describe(
          "A 5- or 6-field cron expression (minute hour day month weekday [second]). Examples: '0 9 * * 1' = Mondays at 9am; '*/15 * * * *' = every 15 minutes; '0 0 1 * *' = first of each month at midnight.",
        ),
      prompt: z
        .string()
        .describe(
          "The prompt the agent should execute when the cron fires. Be specific — the agent will have no other context.",
        ),
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
    handler: async ({ expression, prompt, channel, timezone, description }) => {
      if (!validate(expression)) {
        return textError(`Invalid cron expression: ${expression}`);
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
        return textResult(lines.join("\n"));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textError(`Failed to schedule: ${msg}`);
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/ban-types
export function cronListDef(ctx: CronMcpCtx): ToolDef<{}> {
  return {
    name: "cron_list",
    description: "List all currently scheduled cron jobs and their next-run times.",
    schema: {},
    handler: async () => {
      const entries = ctx.scheduler.list();
      if (entries.length === 0) return textResult("No scheduled jobs.");
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
      return textResult(lines.join("\n"));
    },
  };
}

export function cronRemoveDef(ctx: CronMcpCtx): ToolDef<{ id: z.ZodString }> {
  return {
    name: "cron_remove",
    description:
      "Cancel a scheduled cron job by id. The id comes from cron_add or cron_list output.",
    schema: { id: z.string().describe("The cron id, e.g. 'cron_abc123'.") },
    handler: async ({ id }) => {
      const ok = ctx.scheduler.remove(id);
      return ok ? textResult(`Removed \`${id}\`.`) : textError(`No cron with id \`${id}\` found.`);
    },
  };
}

export function cronToolDefs(ctx: CronMcpCtx): ReadonlyArray<ToolDef<z.ZodRawShape>> {
  return [
    cronAddDef(ctx) as ToolDef<z.ZodRawShape>,
    cronListDef(ctx) as ToolDef<z.ZodRawShape>,
    cronRemoveDef(ctx) as ToolDef<z.ZodRawShape>,
  ];
}
