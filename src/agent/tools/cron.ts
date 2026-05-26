// Claude-MCP wrapper for the `cron` tool surface. Tool defs live in
// cronDef.ts (runtime-neutral). This file preserves the existing
// `buildCronMcp` import shape for callers.

import { buildClaudeMcpServer } from "./claudeMcp.js";
import { cronToolDefs, type CronMcpCtx } from "./cronDef.js";

export type { CronMcpCtx } from "./cronDef.js";

export function buildCronMcp(ctx: CronMcpCtx) {
  return buildClaudeMcpServer("cron", cronToolDefs(ctx));
}
