/**
 * Recursion cap for nested sub-agents. Sub-agents are allowed to call the
 * Task tool (so they can spawn further sub-agents), but the chain is bounded:
 * a Task tool_use is denied if its spawned child's depth would exceed this.
 *
 * Depth semantics:
 *   - Main thread = depth 0.
 *   - A sub-agent spawned by the main thread runs at depth 1.
 *   - That sub-agent's own Task calls spawn depth-2 children, and so on.
 *
 * Tuned empirically: ~10 levels comfortably covers orchestrator → planner →
 * verifier → workers patterns while still tripping if a model accidentally
 * recurses into itself.
 */
export const MAX_SUBAGENT_DEPTH = 10;

/**
 * Given the `parent_tool_use_id` of the assistant message that emitted a Task
 * tool_use, compute the depth of the child that Task will spawn.
 *
 * `parentToolUseId === null` → the Task was issued by the main thread (depth
 * 0), so the child runs at depth 1.
 *
 * Otherwise the Task was issued by a sub-agent whose own depth equals
 * `childDepths.get(parentToolUseId)` (the depth of the child spawned by THAT
 * parent's Task call — which IS the issuing sub-agent). The new child runs
 * one level deeper.
 *
 * If the parent's depth isn't yet recorded (race with the message stream),
 * assume the issuing agent is at depth 1; that's the lowest possible
 * non-main depth and keeps the cap conservative.
 */
export function computeChildDepth(
  parentToolUseId: string | null,
  childDepths: Map<string, number>,
): number {
  if (parentToolUseId === null) return 1;
  const issuerDepth = childDepths.get(parentToolUseId) ?? 1;
  return issuerDepth + 1;
}
