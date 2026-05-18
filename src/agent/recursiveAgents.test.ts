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

// --- 2. tools MUST be omitted on every agent. ------------------------------
// An explicit tools array means the sub-agent only sees those names.
// Spawning has alternate names in the CLI binary ("Agent" / "Task"), so
// listing one and not the other silently strips the spawn capability.
// Omitting `tools` inherits the parent's full preset surface — that's the
// design the user's orchestrator pattern needs.

for (const name of REQUIRED_AGENTS) {
  const def = RECURSIVE_AGENTS[name];
  assert(
    !("tools" in def) || def.tools === undefined,
    `agent '${name}': tools must be omitted (let it inherit parent's preset). ` +
      `Explicit tools arrays silently dropped Agent/Task in prior versions and broke orchestrator → worker patterns.`,
  );
}

// --- 3. disallowedTools must NOT contain Bash, Agent, Task, or any of the
// canonical Claude Code surface tools the user needs to run repo tooling.

const REQUIRED_INHERITABLE_TOOLS = [
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
  const disallowed = def.disallowedTools ?? [];
  for (const tool of REQUIRED_INHERITABLE_TOOLS) {
    assert(
      !disallowed.includes(tool),
      `agent '${name}': '${tool}' must NOT be in disallowedTools. ` +
        `Sub-agents need it to satisfy the orchestrator/worker spawn pattern (validation criteria 3/6/7/8) or to run repo Python/Bash tooling (criterion 5).`,
    );
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
