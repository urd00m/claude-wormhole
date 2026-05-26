// Claude-MCP adapter for runtime-neutral ToolDef instances.
//
// The per-tool def files (slackPostDef.ts, workdirDef.ts, cronDef.ts) are
// pure data + handler — no Anthropic SDK imports. This file is the single
// place where those defs get wrapped into Anthropic's in-process MCP server
// shape via `tool()` + `createSdkMcpServer()`.
//
// When the Codex runtime lands (Phase 4), a parallel `codexMcp.ts` will
// take the same defs and stand them up over the standard MCP stdio
// transport that the Codex CLI consumes. That's the whole point of the
// split — defs stay the same; adapters fork per runtime.

import type { ZodRawShape } from "zod";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import type { ToolDef } from "./types.js";

/** Wrap a single ToolDef as a Claude SDK tool. */
export function toClaudeTool<S extends ZodRawShape>(def: ToolDef<S>) {
  return tool(def.name, def.description, def.schema, def.handler);
}

/**
 * Build a Claude SDK MCP server from a set of runtime-neutral ToolDefs.
 * `name` is the MCP server name as the agent sees it (e.g. "slack",
 * "workdir", "cron"); tool names within are taken from each def.
 */
export function buildClaudeMcpServer(
  name: string,
  defs: ReadonlyArray<ToolDef<ZodRawShape>>,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    version: "0.1.0",
    tools: defs.map((d) => toClaudeTool(d)),
    alwaysLoad: true,
  });
}
