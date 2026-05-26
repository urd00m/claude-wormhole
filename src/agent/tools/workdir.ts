// Claude-MCP wrapper for the `workdir` tool surface. Tool defs live in
// workdirDef.ts (runtime-neutral). This file preserves the existing
// `buildWorkdirMcp` import shape for callers.

import { buildClaudeMcpServer } from "./claudeMcp.js";
import { workdirToolDefs, type WorkdirMcpCtx } from "./workdirDef.js";

export type { WorkdirMcpCtx } from "./workdirDef.js";

export function buildWorkdirMcp(ctx: WorkdirMcpCtx) {
  return buildClaudeMcpServer("workdir", workdirToolDefs(ctx));
}
