// Wiring that gives a Codex worker a `spawn` tool so it can launch further
// agents instead of being one-shot. Codex consumes MCP over stdio, so we
// run a small stdio MCP server (src/mcp/codexSpawnServer.ts) as a child of
// the `codex exec` process, configured via -c mcp_servers.wormhole_spawn.
//
// Verified against codex v0.133.0: a `-c mcp_servers.<name>.command` +
// `.args` pair makes codex load the server, list its tools, and call them
// (see the ping spike that preceded this).
//
// Recursion: the spawn server, when its tool fires, launches another codex
// worker with THIS same MCP config at depth+1 (paths + depth passed via
// WORMHOLE_SPAWN_* env), bounded by WORMHOLE_SPAWN_MAX_DEPTH.

import path from "node:path";
import { ROOT_DIR } from "../../config.js";
import { MAX_SUBAGENT_DEPTH } from "../subagentDepth.js";

/** MCP server name codex sees; tool is wormhole_spawn__spawn on its side. */
export const CODEX_SPAWN_MCP_NAME = "wormhole_spawn";

function tsxBin(): string {
  return path.join(ROOT_DIR, "node_modules", ".bin", "tsx");
}
function serverScript(): string {
  return path.join(ROOT_DIR, "src", "mcp", "codexSpawnServer.ts");
}

/**
 * CLI flags + env additions that attach the spawn MCP server to a `codex
 * exec` invocation. `depth` is the depth of the worker being launched (the
 * server it talks to will spawn its own children at depth+1). `workdir` is
 * where sub-workers run.
 */
export function codexSpawnMcpFlags(depth: number, workdir: string): { args: string[]; env: Record<string, string> } {
  const tsx = tsxBin();
  const server = serverScript();
  const name = CODEX_SPAWN_MCP_NAME;
  return {
    // Values are parsed as TOML by codex: a quoted string, and a string array.
    args: [
      "-c",
      `mcp_servers.${name}.command="${tsx}"`,
      "-c",
      `mcp_servers.${name}.args=["${server}"]`,
    ],
    env: {
      WORMHOLE_SPAWN_DEPTH: String(depth),
      WORMHOLE_SPAWN_MAX_DEPTH: String(MAX_SUBAGENT_DEPTH),
      WORMHOLE_SPAWN_TSX: tsx,
      WORMHOLE_SPAWN_SERVER: server,
      WORMHOLE_SPAWN_WORKDIR: workdir,
    },
  };
}
