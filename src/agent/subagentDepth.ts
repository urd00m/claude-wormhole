/**
 * Sub-agent type name for fire-and-forget background workers. Used in two
 * places: (1) the AgentDefinition registered in session.ts under this key,
 * (2) the rewrite below that translates `run_in_background: true` into a
 * `subagent_type` selection.
 */
export const BACKGROUND_WORKER_TYPE = "background-worker";

/**
 * Recursion cap for nested sub-agents. Sub-agents are allowed to call the
 * sub-agent-spawning tool, but the chain is bounded: the call is denied when
 * the spawned child would exceed this depth.
 *
 * Depth semantics:
 *   - Main thread = depth 0.
 *   - A sub-agent spawned by the main thread runs at depth 1.
 *   - That sub-agent's own spawn calls produce depth-2 children, and so on.
 *
 * Tuned empirically: ~10 levels comfortably covers orchestrator → planner →
 * critic → verifier → workers patterns while still tripping if a model
 * accidentally recurses into itself.
 */
export const MAX_SUBAGENT_DEPTH = 10;

/**
 * The sub-agent-spawning tool has been named both `Agent` (current Claude
 * Code / Agent SDK) and `Task` (older naming). Match either so depth
 * tracking and the cap fire regardless of which surface the SDK exposes.
 */
export function isSpawnTool(name: string): boolean {
  return name === "Agent" || name === "Task";
}

/**
 * Tool allowlist for sub-agents we spawn via our `general-purpose` override.
 *
 * Important: we list tools explicitly rather than relying on the SDK's
 * "omit tools to inherit from parent" semantic. In practice the SDK's
 * built-in default for `general-purpose` excludes `Bash` and `Agent` as a
 * safety measure, and our override only takes effect for fields we name.
 * Listing them here is what actually grants them to sub-agents.
 *
 * Includes:
 *   - File / shell / search tools — the canonical Claude Code surface.
 *   - `Agent` — so sub-agents can spawn further sub-agents (bounded by
 *     MAX_SUBAGENT_DEPTH; enforced in canUseTool).
 *   - Read-only MCP tools (`get_workdir`, `cron_list`).
 *   - Slack-post MCP tools (sub-agents can post status / files back).
 *
 * Deliberately omitted:
 *   - `mcp__workdir__set_workdir` / `reset_workdir` — sub-agents must not
 *     mutate the parent thread's workdir.
 *   - `mcp__cron__cron_add` / `cron_remove` — sub-agents must not persist
 *     schedules without an explicit user ask.
 */
export const SUBAGENT_TOOL_ALLOWLIST: readonly string[] = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "NotebookEdit",
  "NotebookRead",
  "TodoWrite",
  // Both names for the sub-agent-spawning tool. The CLI binary contains
  // both strings as alternate identifiers; matching only one of them leaves
  // sub-agents without the ability to spawn further workers depending on
  // which name the CLI uses internally for allowlist matching. List both.
  "Agent",
  "Task",
  "mcp__slack__slack_post_message",
  "mcp__slack__slack_post_file",
  "mcp__workdir__get_workdir",
  "mcp__cron__cron_list",
];

/**
 * Given the `parent_tool_use_id` of the assistant message that emitted a
 * spawn tool_use, compute the depth of the child that the spawn will create.
 *
 * `parentToolUseId === null` → the call was issued by the main thread (depth
 * 0), so the child runs at depth 1.
 *
 * Otherwise the call was issued by a sub-agent whose own depth equals
 * `childDepths.get(parentToolUseId)` (the depth of the child spawned by THAT
 * parent's spawn — which IS the issuing sub-agent). The new child runs one
 * level deeper.
 *
 * If the parent's depth isn't yet recorded (race with the message stream),
 * assume the issuing agent is at depth 1; that's the lowest possible
 * non-main depth and keeps the cap conservative.
 */
/**
 * Translate an Agent/Task tool input into the canonical form the SDK
 * understands. Two purposes:
 *
 *   1. If the model passed `run_in_background: true` (the Claude Code CLI
 *      style), rewrite it to `subagent_type: "background-worker"` so our
 *      AgentDefinition with `background: true` is what actually runs. The
 *      SDK exposes no `run_in_background` field on the Agent tool's input
 *      schema; without rewriting, the flag is silently ignored and the
 *      call runs blocking.
 *
 *   2. Surface whether the resulting call is background, so the session
 *      loop can tag the tool_use_id and route task-lifecycle events to
 *      Slack.
 *
 * Acceptable truthy values for run_in_background: literal `true` and the
 * string "true" (some clients stringify booleans on tool calls). Anything
 * else is treated as not-background.
 */
export function rewriteSpawnInput(
  input: Record<string, unknown>,
): { input: Record<string, unknown>; isBackground: boolean } {
  const rib = input.run_in_background;
  const wantsBackground = rib === true || rib === "true";
  const explicitType = typeof input.subagent_type === "string" ? input.subagent_type : undefined;
  const explicitBackground = explicitType === BACKGROUND_WORKER_TYPE;

  if (!wantsBackground) {
    return { input, isBackground: explicitBackground };
  }

  // Drop run_in_background (the SDK's Agent tool doesn't accept it; leaving
  // it in causes the CLI to log an unknown-parameter warning) and force
  // subagent_type to background-worker.
  const rewritten: Record<string, unknown> = { ...input, subagent_type: BACKGROUND_WORKER_TYPE };
  delete rewritten.run_in_background;
  return { input: rewritten, isBackground: true };
}

export function computeChildDepth(
  parentToolUseId: string | null,
  childDepths: Map<string, number>,
): number {
  if (parentToolUseId === null) return 1;
  const issuerDepth = childDepths.get(parentToolUseId) ?? 1;
  return issuerDepth + 1;
}
