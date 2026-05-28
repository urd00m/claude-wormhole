// Claude-MCP wrapper for the macro/alias management tools. Tool defs live in
// configToolsDef.ts (runtime-neutral). Exposes one `config` MCP server with
// macro_set / macro_remove / macro_list / alias_set / alias_remove /
// alias_list, so the user can manage macros and launch aliases by asking
// the bot instead of hand-editing data/*.json.

import { buildClaudeMcpServer } from "./claudeMcp.js";
import { configToolDefs } from "./configToolsDef.js";

export function buildConfigMcp() {
  return buildClaudeMcpServer("config", configToolDefs());
}
