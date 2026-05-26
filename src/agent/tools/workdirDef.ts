// Runtime-neutral tool defs for the `workdir` MCP server
// (set_workdir / get_workdir / reset_workdir).

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { SESSIONS_DIR } from "../../config.js";
import { getWorkdirStore, resolveWorkdir } from "../workdirStore.js";
import { textError, textResult, type ToolDef } from "./types.js";

/**
 * Minimal session shape this tool needs: a mutator for the live workdir
 * plus a current-workdir read-through. Typed structurally so tests can
 * inject a duck-typed mock without spinning up a full `Session`/runtime.
 */
export interface WorkdirCapableSession {
  readonly workdir: string;
  setWorkdir(p: string): void;
}

export type WorkdirMcpCtx = {
  session: WorkdirCapableSession;
  threadKey: string;
};

/** Default per-thread sandbox dir, matching SessionManager.get's computation. */
function defaultSandboxFor(threadKey: string): string {
  const safe = threadKey.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(SESSIONS_DIR, safe);
}

export function setWorkdirDef(ctx: WorkdirMcpCtx): ToolDef<{ path: z.ZodString }> {
  return {
    name: "set_workdir",
    description:
      "Change the working directory for this Slack thread. Use this when the user asks you to cd into a project, work inside a specific repo, etc. The change takes effect on the next message in this thread (the current message keeps running in the old directory). The path must be absolute and exist.",
    schema: {
      path: z
        .string()
        .describe("Absolute path to an existing directory (e.g. '/Users/you/projects/myrepo'). '~' is expanded."),
    },
    handler: async ({ path: input }) => {
      try {
        const resolved = resolveWorkdir(input);
        ctx.session.setWorkdir(resolved);
        getWorkdirStore().set(ctx.threadKey, resolved);
        return textResult(
          `Workdir set to \`${resolved}\` for this thread. Your next message will run there (CLAUDE.md will be reloaded if present).`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return textError(`Failed to set workdir: ${msg}`);
      }
    },
  };
}

// eslint-disable-next-line @typescript-eslint/ban-types
export function getWorkdirDef(ctx: WorkdirMcpCtx): ToolDef<{}> {
  return {
    name: "get_workdir",
    description: "Report the current working directory for this Slack thread.",
    schema: {},
    handler: async () => textResult(`Current workdir: \`${ctx.session.workdir}\``),
  };
}

// eslint-disable-next-line @typescript-eslint/ban-types
export function resetWorkdirDef(ctx: WorkdirMcpCtx): ToolDef<{}> {
  return {
    name: "reset_workdir",
    description:
      "Clear the workdir override for this thread, reverting to the default per-thread sandbox under sessions/. Takes effect on the next message.",
    schema: {},
    handler: async () => {
      const had = getWorkdirStore().remove(ctx.threadKey);
      // Also rotate the live Session's workdir back to the default sandbox.
      // SessionManager.get only reads the workdirStore on session creation,
      // so without this the in-memory Session keeps running in the OLD
      // override forever — the user-visible "next message uses default"
      // promise was a lie.
      const defaultDir = defaultSandboxFor(ctx.threadKey);
      try {
        fs.mkdirSync(path.join(defaultDir, "uploads"), { recursive: true });
      } catch {
        /* best-effort */
      }
      ctx.session.setWorkdir(defaultDir);
      return textResult(
        had
          ? `Workdir override cleared. Next message will use the default sandbox \`${defaultDir}\`.`
          : "No override set; already on the default sandbox.",
      );
    },
  };
}

export function workdirToolDefs(ctx: WorkdirMcpCtx): ReadonlyArray<ToolDef<z.ZodRawShape>> {
  return [
    setWorkdirDef(ctx) as ToolDef<z.ZodRawShape>,
    getWorkdirDef(ctx) as ToolDef<z.ZodRawShape>,
    resetWorkdirDef(ctx) as ToolDef<z.ZodRawShape>,
  ];
}
