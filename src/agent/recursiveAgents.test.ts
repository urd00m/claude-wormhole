// Structural verification of the RECURSIVE_AGENTS config passed to the SDK
// query()'s `agents` option. This is the surface where Problem 2 was living:
// when this config silently strips the Agent/Task spawn tool or Bash, the
// orchestrator → planner → verifier worker pattern (validation.md criteria
// 3, 6, 7, 8) becomes impossible.
//
// We cannot do a fully live SDK call here without Anthropic credentials, but
// we can pin the SHAPE of the config so any regression that re-introduces an
// explicit `tools` array (which historically dropped Agent/Task by silent
// name-mismatch) or accidentally disallows Bash/Agent/Task is caught at
// `npm run test` time.

import { BACKGROUND_WORKER_TYPE } from "./subagentDepth.js";
import { RECURSIVE_AGENTS } from "./session.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const REQUIRED_AGENTS = ["general-purpose", BACKGROUND_WORKER_TYPE];

// --- 1. Both required agent types exist. -----------------------------------

for (const name of REQUIRED_AGENTS) {
  assert(name in RECURSIVE_AGENTS, `agent definition '${name}' must be registered`);
}

// --- 2. tools MUST be set EXPLICITLY and include the spawning tool.
// The CLI's anti-recursion behavior silently strips Agent/Task from any
// surface that's inherited from the parent's preset; listing them
// explicitly here overrides that. Confirmed by live integration test
// scripts/it.sh toolSurface (commit 5300e2a era reproduced the strip).

const REQUIRED_TOOLS = [
  "Bash",
  "Agent",
  "Task",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "NotebookEdit",
  "TodoWrite",
];

for (const name of REQUIRED_AGENTS) {
  const def = RECURSIVE_AGENTS[name];
  assert(
    Array.isArray(def.tools),
    `agent '${name}': tools must be set EXPLICITLY (not omitted). ` +
      `Omitting it means inherit-from-parent, which strips Agent/Task as anti-recursion safety. ` +
      `See subagentDepth.ts SUBAGENT_TOOLS comment.`,
  );
  const tools = def.tools as string[];
  for (const required of REQUIRED_TOOLS) {
    assert(
      tools.includes(required),
      `agent '${name}': required tool '${required}' must appear in tools array. ` +
        `Missing this breaks validation.md criteria 3/5/6/7/8 (sub-agents need the full canonical surface + the spawning tool).`,
    );
  }
}

// --- 3. tools must NOT contain the four parent-state mutators.
for (const name of REQUIRED_AGENTS) {
  const def = RECURSIVE_AGENTS[name];
  const tools = (def.tools as string[]) ?? [];
  for (const bad of [
    "mcp__workdir__set_workdir",
    "mcp__workdir__reset_workdir",
    "mcp__cron__cron_add",
    "mcp__cron__cron_remove",
  ]) {
    assert(!tools.includes(bad), `agent '${name}': '${bad}' must NOT appear in tools (sub-agent isolation).`);
  }
}

// --- 4. disallowedTools MUST contain the four parent-state mutators on
// every agent — sub-agent isolation invariant.

const REQUIRED_BLOCKED = [
  "mcp__workdir__set_workdir",
  "mcp__workdir__reset_workdir",
  "mcp__cron__cron_add",
  "mcp__cron__cron_remove",
];

for (const name of REQUIRED_AGENTS) {
  const def = RECURSIVE_AGENTS[name];
  const disallowed = def.disallowedTools ?? [];
  for (const tool of REQUIRED_BLOCKED) {
    assert(
      disallowed.includes(tool),
      `agent '${name}': '${tool}' MUST be in disallowedTools so sub-agents can't hijack parent-thread state.`,
    );
  }
}

// --- 5. permissionMode must be 'bypassPermissions' so the CLI's internal
// gate doesn't auto-deny when the wormhole has no TTY. canUseTool (set at
// the top-level query) is the real policy gate.

for (const name of REQUIRED_AGENTS) {
  const def = RECURSIVE_AGENTS[name];
  assert(
    def.permissionMode === "bypassPermissions",
    `agent '${name}': permissionMode must be 'bypassPermissions' (got ${JSON.stringify(def.permissionMode)}). ` +
      `Without this, the CLI's interactive gate auto-denies repo tooling commands.`,
  );
}

// --- 6. The background-worker MUST have background: true.

{
  const bg = RECURSIVE_AGENTS[BACKGROUND_WORKER_TYPE];
  assert(bg.background === true, "background-worker must have background: true");
}
{
  const gp = RECURSIVE_AGENTS["general-purpose"];
  assert(gp.background !== true, "general-purpose must NOT have background: true (it's the blocking default)");
}

// --- 7. Sanity: each agent has a non-empty description + prompt.

for (const name of REQUIRED_AGENTS) {
  const def = RECURSIVE_AGENTS[name];
  assert(typeof def.description === "string" && def.description.length > 0, `${name}: description required`);
  assert(typeof def.prompt === "string" && def.prompt.length > 0, `${name}: prompt required`);
}

console.log(
  `✅ RECURSIVE_AGENTS config verified — ${REQUIRED_AGENTS.length} agents, all inherit-from-parent tools, ` +
    `${REQUIRED_BLOCKED.length} mutators blocked, permissionMode bypassed`,
);
