// Integrated test for the Agent/Task spawn flow: composes rewriteSpawnInput +
// computeChildDepth + the canUseTool depth-cap check the way Session.send
// does, without standing up a live Session. Three regression paths:
//
//   (a) Main-thread Agent call with run_in_background: true → rewritten input
//       has subagent_type "background-worker", no run_in_background field,
//       AND the tool_use_id is tagged background for downstream lifecycle
//       routing.
//
//   (b) Same call but issued at the depth cap (the issuing sub-agent is at
//       depth MAX, so the child would be MAX+1) → the depth gate denies with
//       the expected message format.
//
//   (c) `Task` (legacy spawn name) gets the same treatment as `Agent` — both
//       for the rewrite and the depth gate.

import {
  BACKGROUND_WORKER_TYPE,
  computeChildDepth,
  isSpawnTool,
  MAX_SUBAGENT_DEPTH,
  rewriteSpawnInput,
} from "./subagentDepth.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// Replicate the wrappedCanUseTool decision logic from session.ts in pure form
// so we can drive it with a known childDepth map and a known toolUseID.
type Decision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string };

function decide(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseID: string,
  childDepthByToolUseId: Map<string, number>,
  backgroundToolUseIds: Set<string>,
): Decision {
  let effectiveInput = toolInput;
  if (isSpawnTool(toolName)) {
    const childDepth = childDepthByToolUseId.get(toolUseID) ?? 1;
    if (childDepth > MAX_SUBAGENT_DEPTH) {
      return {
        behavior: "deny",
        message: `sub-agent depth ${childDepth} exceeds cap ${MAX_SUBAGENT_DEPTH}`,
      };
    }
    const { input: rewritten, isBackground } = rewriteSpawnInput(toolInput);
    effectiveInput = rewritten;
    if (isBackground) backgroundToolUseIds.add(toolUseID);
  }
  return { behavior: "allow", updatedInput: effectiveInput };
}

// --- (a) main-thread Agent + run_in_background: true ---------------------
{
  const depths = new Map<string, number>();
  // Main thread emits a spawn tool_use; computeChildDepth(null, …) = 1.
  const childDepth = computeChildDepth(null, depths);
  assert(childDepth === 1, `main-thread spawn depth must be 1, got ${childDepth}`);
  depths.set("tu_agent_a", childDepth);

  const bgIds = new Set<string>();
  const d = decide(
    "Agent",
    { subagent_type: "general-purpose", prompt: "run bench", run_in_background: true },
    "tu_agent_a",
    depths,
    bgIds,
  );
  assert(d.behavior === "allow", "main-thread Agent must allow");
  if (d.behavior !== "allow") throw new Error("unreachable");
  const ui = d.updatedInput;
  assert(
    ui.subagent_type === BACKGROUND_WORKER_TYPE,
    `subagent_type must be rewritten to ${BACKGROUND_WORKER_TYPE}, got ${String(ui.subagent_type)}`,
  );
  assert(!("run_in_background" in ui), "run_in_background must be stripped from rewritten input");
  assert(ui.prompt === "run bench", "prompt field preserved");
  assert(
    bgIds.has("tu_agent_a"),
    "tool_use_id must be tagged background after rewrite for lifecycle routing",
  );
}

// --- (b) depth-cap deny --------------------------------------------------
{
  const depths = new Map<string, number>();
  // Simulate a parent chain that establishes depth MAX for the issuing agent,
  // so that THIS spawn's child would be MAX+1.
  depths.set("tu_at_cap", MAX_SUBAGENT_DEPTH + 1);

  const bgIds = new Set<string>();
  const d = decide(
    "Agent",
    { subagent_type: "general-purpose", prompt: "go deeper" },
    "tu_at_cap",
    depths,
    bgIds,
  );
  assert(d.behavior === "deny", `at-cap spawn must deny, got ${d.behavior}`);
  if (d.behavior !== "deny") throw new Error("unreachable");
  assert(
    d.message.includes(`${MAX_SUBAGENT_DEPTH + 1}`) && d.message.includes(`${MAX_SUBAGENT_DEPTH}`),
    `deny message should mention both depth and cap, got: ${d.message}`,
  );
  assert(
    !bgIds.has("tu_at_cap"),
    "denied spawns must NOT tag the tool_use_id as background (no rewrite happened)",
  );
}

// --- (c) Task (legacy name) parity ---------------------------------------
{
  // (c1) Task + run_in_background: same rewrite.
  const depths = new Map<string, number>([["tu_task_1", 1]]);
  const bgIds = new Set<string>();
  const d = decide(
    "Task",
    { subagent_type: "general-purpose", prompt: "go", run_in_background: true },
    "tu_task_1",
    depths,
    bgIds,
  );
  assert(d.behavior === "allow", "Task must allow at depth 1");
  if (d.behavior !== "allow") throw new Error("unreachable");
  assert(
    d.updatedInput.subagent_type === BACKGROUND_WORKER_TYPE,
    "Task gets the same background rewrite as Agent",
  );
  assert(!("run_in_background" in d.updatedInput), "Task: run_in_background stripped");
  assert(bgIds.has("tu_task_1"), "Task tool_use_id tagged background");

  // (c2) Task at cap: same deny path.
  const overDepths = new Map<string, number>([["tu_task_over", MAX_SUBAGENT_DEPTH + 1]]);
  const d2 = decide(
    "Task",
    { subagent_type: "general-purpose", prompt: "x" },
    "tu_task_over",
    overDepths,
    new Set<string>(),
  );
  assert(d2.behavior === "deny", "Task at cap must deny");
  if (d2.behavior === "deny") {
    assert(
      d2.message.includes(`${MAX_SUBAGENT_DEPTH}`),
      `Task deny message should mention cap, got: ${d2.message}`,
    );
  }

  // (c3) Non-spawn tool name does not get rewritten or depth-gated, even
  // when the input *contains* run_in_background. Guards against an
  // over-eager rewrite that fired on any tool whose input had that field.
  const d3 = decide(
    "Bash",
    { command: "echo hi", run_in_background: true },
    "tu_bash_1",
    new Map(),
    new Set<string>(),
  );
  assert(d3.behavior === "allow", "Bash with run_in_background must allow (not spawn)");
  if (d3.behavior !== "allow") throw new Error("unreachable");
  assert(
    "run_in_background" in d3.updatedInput,
    "non-spawn tool must NOT have run_in_background stripped",
  );
  assert(
    d3.updatedInput.subagent_type === undefined,
    "non-spawn tool must NOT get a subagent_type field injected",
  );
}

// --- (d) Sanity: when the spawn passes subagent_type: background-worker
// EXPLICITLY (no run_in_background flag), the tool_use_id is still tagged
// background so lifecycle events route through. session.ts ALSO tags this
// via the assistant-message pre-pass; this test verifies the canUseTool
// path agrees.
{
  const depths = new Map<string, number>([["tu_explicit_bg", 1]]);
  const bgIds = new Set<string>();
  const d = decide(
    "Agent",
    { subagent_type: BACKGROUND_WORKER_TYPE, prompt: "x" },
    "tu_explicit_bg",
    depths,
    bgIds,
  );
  assert(d.behavior === "allow", "explicit bg-worker must allow");
  assert(
    bgIds.has("tu_explicit_bg"),
    "explicit background-worker subagent_type must also tag the tool_use_id as background",
  );
}

console.log(
  `✅ spawn flow verified (rewrite + depth cap at ${MAX_SUBAGENT_DEPTH}, Agent/Task parity)`,
);
