import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Session } from "../session.js";
import { getWorkdirStore, resolveWorkdir } from "../workdirStore.js";

export type WorkdirMcpCtx = {
  session: Session;
  threadKey: string;
};

/**
 * MCP server exposing set_workdir / get_workdir. When the user asks to work
 * inside a real project ("cd to /path/to/project"), the agent calls
 * set_workdir; the next message in this thread runs with that as cwd, so
 * CLAUDE.md and other project context get picked up.
 */
export function buildWorkdirMcp(ctx: WorkdirMcpCtx) {
  const setWorkdir = tool(
    "set_workdir",
    "Change the working directory for this Slack thread. Use this when the user asks you to cd into a project, work inside a specific repo, etc. The change takes effect on the next message in this thread (the current message keeps running in the old directory). The path must be absolute and exist.",
    {
      path: z
        .string()
        .describe("Absolute path to an existing directory (e.g. '/Users/you/projects/myrepo'). '~' is expanded."),
    },
    async ({ path: input }) => {
      try {
        const resolved = resolveWorkdir(input);
        ctx.session.setWorkdir(resolved);
        getWorkdirStore().set(ctx.threadKey, resolved);
        return {
          content: [
            {
              type: "text",
              text: `Workdir set to \`${resolved}\` for this thread. Your next message will run there (CLAUDE.md will be reloaded if present).`,
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to set workdir: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  const getWorkdir = tool(
    "get_workdir",
    "Report the current working directory for this Slack thread.",
    {},
    async () => {
      return { content: [{ type: "text", text: `Current workdir: \`${ctx.session.workdir}\`` }] };
    },
  );

  const resetWorkdir = tool(
    "reset_workdir",
    "Clear the workdir override for this thread, reverting to the default per-thread sandbox under sessions/. Takes effect on the next message.",
    {},
    async () => {
      const had = getWorkdirStore().remove(ctx.threadKey);
      return {
        content: [
          {
            type: "text",
            text: had
              ? "Workdir override cleared. Next message will use the default sessions/<threadKey>/ sandbox."
              : "No override set; already on the default sandbox.",
          },
        ],
      };
    },
  );

  return createSdkMcpServer({
    name: "workdir",
    version: "0.1.0",
    tools: [setWorkdir, getWorkdir, resetWorkdir],
    alwaysLoad: true,
  });
}
