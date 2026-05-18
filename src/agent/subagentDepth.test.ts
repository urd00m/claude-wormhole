// Verify the depth math for nested sub-agent spawn calls, the cap behavior
// when wired into a canUseTool-shaped gate, and the explicit tool allowlist.
import {
  computeChildDepth,
  isSpawnTool,
  MAX_SUBAGENT_DEPTH,
  SUBAGENT_TOOL_ALLOWLIST,
} from "./subagentDepth.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// Spawn-tool name detection covers both current and legacy naming.
assert(isSpawnTool("Agent"), "Agent must be recognized as spawn tool");
assert(isSpawnTool("Task"), "Task must be recognized as spawn tool (legacy)");
assert(!isSpawnTool("Bash"), "Bash is not a spawn tool");
assert(!isSpawnTool("agent"), "spawn-tool match is case-sensitive");

// Sub-agent allowlist must include Bash and the spawning tool, or the
// orchestrator → planner → verifier patterns fail at runtime.
assert(SUBAGENT_TOOL_ALLOWLIST.includes("Bash"), "sub-agents must have Bash");
assert(SUBAGENT_TOOL_ALLOWLIST.includes("Agent"), "sub-agents must have Agent (for nested spawn)");
assert(SUBAGENT_TOOL_ALLOWLIST.includes("Read"), "sub-agents must have Read");
assert(SUBAGENT_TOOL_ALLOWLIST.includes("Write"), "sub-agents must have Write");
assert(SUBAGENT_TOOL_ALLOWLIST.includes("Edit"), "sub-agents must have Edit");
assert(SUBAGENT_TOOL_ALLOWLIST.includes("WebFetch"), "sub-agents must have WebFetch");
assert(
  SUBAGENT_TOOL_ALLOWLIST.includes("mcp__slack__slack_post_message"),
  "sub-agents must be able to post to Slack",
);
// Parent-state mutators stay out.
assert(
  !SUBAGENT_TOOL_ALLOWLIST.includes("mcp__workdir__set_workdir"),
  "sub-agents must NOT have set_workdir",
);
assert(
  !SUBAGENT_TOOL_ALLOWLIST.includes("mcp__cron__cron_add"),
  "sub-agents must NOT have cron_add",
);

// Depth math: chain from main → cap, with both Agent and Task as spawn names.
const depths = new Map<string, number>();

{
  const d = computeChildDepth(null, depths);
  assert(d === 1, `null parent → depth 1, got ${d}`);
  depths.set("T1", d);
}
{
  const d = computeChildDepth("T1", depths);
  assert(d === 2, `T1 parent → depth 2, got ${d}`);
  depths.set("T2", d);
}

let prev = "T2";
for (let depth = 3; depth <= MAX_SUBAGENT_DEPTH; depth++) {
  const next = `T${depth}`;
  const d = computeChildDepth(prev, depths);
  assert(d === depth, `chain step → expected depth ${depth}, got ${d}`);
  depths.set(next, d);
  prev = next;
}

{
  const d = computeChildDepth(prev, depths);
  assert(d === MAX_SUBAGENT_DEPTH + 1, `at-cap step → expected ${MAX_SUBAGENT_DEPTH + 1}, got ${d}`);
  assert(d > MAX_SUBAGENT_DEPTH, "child depth must exceed cap for deny");
}

// Unknown parent (race with message stream) → conservative depth 2.
{
  const d = computeChildDepth("never-seen", new Map());
  assert(d === 2, `unknown parent → depth 2 (1+1 conservative), got ${d}`);
}

// Gate logic: spawn calls past cap deny, non-spawn calls always allow.
function gate(toolName: string, toolUseId: string, childDepths: Map<string, number>): "allow" | "deny" {
  if (!isSpawnTool(toolName)) return "allow";
  const childDepth = childDepths.get(toolUseId) ?? 1;
  return childDepth > MAX_SUBAGENT_DEPTH ? "deny" : "allow";
}

assert(gate("Agent", "T1", depths) === "allow", "depth-1 Agent must allow");
assert(gate("Task", "T1", depths) === "allow", "depth-1 Task must allow");
assert(
  gate("Agent", `T${MAX_SUBAGENT_DEPTH}`, depths) === "allow",
  `depth ${MAX_SUBAGENT_DEPTH} Agent must allow (at cap)`,
);
{
  const overId = "T_over";
  depths.set(overId, MAX_SUBAGENT_DEPTH + 1);
  assert(gate("Agent", overId, depths) === "deny", "over-cap Agent must deny");
  assert(gate("Task", overId, depths) === "deny", "over-cap Task must deny");
}
assert(gate("Bash", "T_over", depths) === "allow", "non-spawn tool ignores depth");

console.log(
  `✅ subagent depth cap verified (MAX=${MAX_SUBAGENT_DEPTH}, allowlist size=${SUBAGENT_TOOL_ALLOWLIST.length})`,
);
