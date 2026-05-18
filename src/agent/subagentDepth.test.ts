// Verify the depth math for nested sub-agent Task calls and the cap behavior
// when wired into a canUseTool-shaped gate.
import { computeChildDepth, MAX_SUBAGENT_DEPTH } from "./subagentDepth.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const depths = new Map<string, number>();

// Main thread (parent_tool_use_id === null) issues a Task → child at depth 1.
{
  const d = computeChildDepth(null, depths);
  assert(d === 1, `null parent → depth 1, got ${d}`);
  depths.set("T1", d);
}

// The depth-1 sub-agent emits its own Task. Its assistant messages carry
// parent_tool_use_id = T1, so the new child is depth 2.
{
  const d = computeChildDepth("T1", depths);
  assert(d === 2, `T1 parent → depth 2, got ${d}`);
  depths.set("T2", d);
}

// Chain up to the cap.
let prev = "T2";
for (let depth = 3; depth <= MAX_SUBAGENT_DEPTH; depth++) {
  const next = `T${depth}`;
  const d = computeChildDepth(prev, depths);
  assert(d === depth, `chain step → expected depth ${depth}, got ${d}`);
  depths.set(next, d);
  prev = next;
}

// One more step would exceed the cap.
{
  const d = computeChildDepth(prev, depths);
  assert(d === MAX_SUBAGENT_DEPTH + 1, `at-cap step → expected ${MAX_SUBAGENT_DEPTH + 1}, got ${d}`);
  assert(d > MAX_SUBAGENT_DEPTH, "child depth must exceed cap for deny");
}

// Unknown parent (race with message stream) → conservative depth 2, not undefined.
{
  const d = computeChildDepth("never-seen", new Map());
  assert(d === 2, `unknown parent → depth 2 (1+1 conservative), got ${d}`);
}

// Simulate the canUseTool gate's decision logic to be sure the wiring matches.
function gate(toolName: string, toolUseId: string, childDepths: Map<string, number>): "allow" | "deny" {
  if (toolName !== "Task") return "allow";
  const childDepth = childDepths.get(toolUseId) ?? 1;
  return childDepth > MAX_SUBAGENT_DEPTH ? "deny" : "allow";
}

// Depth-1 spawn: allow.
assert(gate("Task", "T1", depths) === "allow", "depth-1 Task must allow");
// Depth-at-cap spawn: allow.
assert(
  gate("Task", `T${MAX_SUBAGENT_DEPTH}`, depths) === "allow",
  `depth ${MAX_SUBAGENT_DEPTH} Task must allow (at cap)`,
);
// A would-be over-cap Task: synthesize and gate.
{
  const overId = "T_over";
  depths.set(overId, MAX_SUBAGENT_DEPTH + 1);
  assert(gate("Task", overId, depths) === "deny", "over-cap Task must deny");
}
// Non-Task tool always allowed regardless of depth.
assert(gate("Bash", "T_over", depths) === "allow", "non-Task tool ignores depth");

console.log(`✅ subagent depth cap verified (MAX=${MAX_SUBAGENT_DEPTH})`);
