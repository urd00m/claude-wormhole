// Verify the depth math for nested sub-agent spawn calls, the cap behavior
// when wired into a canUseTool-shaped gate, and the explicit tool allowlist.
import {
  BACKGROUND_WORKER_TYPE,
  computeChildDepth,
  isSpawnTool,
  MAX_SUBAGENT_DEPTH,
  rewriteSpawnInput,
  SUBAGENT_DISALLOWED_TOOLS,
} from "./subagentDepth.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// Spawn-tool name detection covers both current and legacy naming.
assert(isSpawnTool("Agent"), "Agent must be recognized as spawn tool");
assert(isSpawnTool("Task"), "Task must be recognized as spawn tool (legacy)");
assert(!isSpawnTool("Bash"), "Bash is not a spawn tool");
assert(!isSpawnTool("agent"), "spawn-tool match is case-sensitive");

// Sub-agent disallowed list: ONLY parent-state mutators may appear here.
// Critically, neither Bash nor the spawn tool (Agent/Task) may be on this
// list — sub-agents need both to run repo tooling and to spawn workers
// (Planner / Plan-critic / Executor / Analyzer / Verifier / Verdict-critic).
assert(
  !SUBAGENT_DISALLOWED_TOOLS.includes("Bash"),
  "Bash must NOT be in disallowed list — sub-agents need it for repo tooling",
);
assert(
  !SUBAGENT_DISALLOWED_TOOLS.includes("Agent"),
  "Agent must NOT be in disallowed list — needed for nested spawn (validation criteria 3/6/7/8)",
);
assert(
  !SUBAGENT_DISALLOWED_TOOLS.includes("Task"),
  "Task (alt spawn name) must NOT be in disallowed list",
);
for (const t of ["Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "WebSearch", "NotebookRead", "NotebookEdit", "TodoWrite"]) {
  assert(!SUBAGENT_DISALLOWED_TOOLS.includes(t), `${t} must NOT be disallowed for sub-agents`);
}
// Parent-state mutators MUST be in the disallowed list.
for (const t of [
  "mcp__workdir__set_workdir",
  "mcp__workdir__reset_workdir",
  "mcp__cron__cron_add",
  "mcp__cron__cron_remove",
]) {
  assert(SUBAGENT_DISALLOWED_TOOLS.includes(t), `${t} must be in disallowed list (sub-agent isolation)`);
}

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

// rewriteSpawnInput: Claude-Code-style run_in_background gets translated.
{
  // Case 1: run_in_background: true with general-purpose → rewrite to background-worker
  const r = rewriteSpawnInput({
    subagent_type: "general-purpose",
    prompt: "do the thing",
    run_in_background: true,
  });
  assert(r.isBackground === true, "run_in_background: true → isBackground true");
  assert(r.input.subagent_type === BACKGROUND_WORKER_TYPE, "subagent_type rewritten");
  assert(!("run_in_background" in r.input), "run_in_background stripped from rewritten input");
  assert(r.input.prompt === "do the thing", "other fields preserved");
}
{
  // Case 2: run_in_background: "true" (stringified) also rewrites
  const r = rewriteSpawnInput({ subagent_type: "general-purpose", run_in_background: "true" });
  assert(r.isBackground === true, "stringified true also rewrites");
  assert(r.input.subagent_type === BACKGROUND_WORKER_TYPE, "stringified true → background-worker");
}
{
  // Case 3: explicit background-worker, no run_in_background → keep as-is, marked background
  const r = rewriteSpawnInput({ subagent_type: BACKGROUND_WORKER_TYPE, prompt: "x" });
  assert(r.isBackground === true, "explicit background-worker is background");
  assert(r.input.subagent_type === BACKGROUND_WORKER_TYPE, "type preserved");
}
{
  // Case 4: no run_in_background, general-purpose → unchanged, not background
  const r = rewriteSpawnInput({ subagent_type: "general-purpose", prompt: "y" });
  assert(r.isBackground === false, "plain general-purpose is not background");
  assert(r.input.subagent_type === "general-purpose", "type preserved");
}
{
  // Case 5: run_in_background: false → not background, no rewrite
  const r = rewriteSpawnInput({ subagent_type: "general-purpose", run_in_background: false });
  assert(r.isBackground === false, "run_in_background: false → not background");
  assert(r.input.subagent_type === "general-purpose", "no rewrite when flag is false");
}
{
  // Case 6: garbage truthy-ish values (1, "yes") → treated as NOT true, conservative
  const r = rewriteSpawnInput({ subagent_type: "general-purpose", run_in_background: 1 });
  assert(r.isBackground === false, "numeric 1 is not accepted as background flag (strict)");
}

console.log(
  `✅ subagent depth cap verified (MAX=${MAX_SUBAGENT_DEPTH}, disallowed size=${SUBAGENT_DISALLOWED_TOOLS.length})`,
);
