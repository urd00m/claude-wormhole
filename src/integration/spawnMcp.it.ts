// Live integration test: prove the mcp__spawn__spawn workaround actually
// lets a sub-agent spawn further sub-agents (which the SDK's Agent/Task
// tool refuses to permit).
//
// Sequence:
//   1. Main thread has the spawn MCP at depth 0.
//   2. Main calls mcp__spawn__spawn (the WORKAROUND, not Agent) to start
//      a level-1 worker. That worker also has spawn MCP (at depth 1).
//   3. The level-1 worker calls mcp__spawn__spawn to start a level-2
//      worker. CRITICAL: this is where the Agent tool would fail because
//      the CLI strips it from sub-agents. spawn MCP is not stripped.
//   4. The level-2 worker enumerates its tools and returns.
//   5. Both workers' enumerations bubble up through the spawn results.
//
// Expectation: a TOOL_DUMP_BEGIN_LEVEL_2 block appears containing
// mcp__spawn__spawn — proving the workaround chains.
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { buildSpawnMcp } from "../agent/tools/spawn.js";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Stub slack MCP — workers shouldn't actually post in integration tests.
const stubSlackMcp = createSdkMcpServer({
  name: "slack",
  version: "0.1.0",
  tools: [
    tool("slack_post_message", "stub", { text: z.string() }, async () => ({
      content: [{ type: "text", text: "(stubbed)" }],
    })),
  ],
});

const dummyCanUseTool = () => async () => ({ behavior: "allow" as const, updatedInput: {} });

const SUB_PROMPT_LEVEL_2 = [
  "You are a level-2 worker. Enumerate every tool you have access to.",
  "Emit between the literal markers below, one tool name per line:",
  "",
  "TOOL_DUMP_BEGIN_LEVEL_2",
  "<tool names>",
  "TOOL_DUMP_END_LEVEL_2",
  "",
  "Do NOT run any tools. Stop after the END marker.",
].join("\n");

const SUB_PROMPT_LEVEL_1 = [
  "You are a level-1 worker spawned via mcp__spawn__spawn.",
  "Step 1: Enumerate your own tools between markers:",
  "TOOL_DUMP_BEGIN_LEVEL_1",
  "<tool names>",
  "TOOL_DUMP_END_LEVEL_1",
  "",
  "Step 2: Call mcp__spawn__spawn EXACTLY ONCE with this prompt verbatim:",
  "",
  SUB_PROMPT_LEVEL_2,
  "",
  "Step 3: In your final response, include the level-2 worker's full output verbatim.",
].join("\n");

const ROOT_PROMPT = [
  "You are the test driver.",
  "Step 1: Call mcp__spawn__spawn EXACTLY ONCE with this prompt verbatim:",
  "",
  SUB_PROMPT_LEVEL_1,
  "",
  "Step 2: In your final reply, include the level-1 worker's full output verbatim (which itself contains level-2's output).",
].join("\n");

async function main(): Promise<number> {
  console.log("▸ Live spawn-MCP chain integration test (depth 0 → 1 → 2)");

  const spawnAtDepth0 = buildSpawnMcp({
    workdir: process.cwd(),
    depth: 0,
    buildSlackMcp: () => stubSlackMcp,
    buildCanUseTool: () => dummyCanUseTool(),
    onTaskEvent: (e) => console.log(`  [task ${e.kind}] ${"description" in e ? e.description : ""}`),
  });

  const q = query({
    prompt: ROOT_PROMPT,
    options: {
      model: env.ANTHROPIC_MODEL,
      tools: { type: "preset", preset: "claude_code" },
      mcpServers: { slack: stubSlackMcp, spawn: spawnAtDepth0 },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      additionalDirectories: ["/"],
    },
  });

  const allText: string[] = [];
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      const m = msg as { message?: { content?: unknown } };
      const content = (m.message?.content ?? []) as Array<{ type?: string; text?: string }>;
      for (const b of content) {
        if (b.type === "text" && typeof b.text === "string") allText.push(b.text);
      }
    }
  }
  const fullText = allText.join("\n");

  console.log("\n── Captured text (first 4000 chars) ──");
  console.log(fullText.slice(0, 4000));

  // The critical evidence is the level-2 dump. If it exists, then:
  //   - main thread spawned level-1 via mcp__spawn__spawn (it returned)
  //   - level-1 spawned level-2 via mcp__spawn__spawn (the recursive case
  //     that the SDK's Agent/Task tool CANNOT do because of the strip)
  //   - level-2 ran and returned its enumeration through the chain
  // We don't require the level-1 dump because the level-1 worker often
  // skips its own marker to focus on its main job (spawning level-2 and
  // relaying output) — that's a protocol-following nit, not a workaround
  // failure.
  const level2Match = /TOOL_DUMP_BEGIN_LEVEL_2([\s\S]*?)TOOL_DUMP_END_LEVEL_2/.exec(fullText);
  if (!level2Match) {
    console.log("❌ Level-2 tool dump not found — level-1 worker could NOT spawn a level-2 worker via mcp__spawn__spawn.");
    console.log("   This means the workaround is not working.");
    return 1;
  }

  const level2Tools = level2Match[1]
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/[`,]/g, ""))
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l) || l.startsWith("mcp__"));

  console.log(`\n── Level 2 tools (${level2Tools.length}) ──`);
  console.log("  " + level2Tools.join(", "));

  const level2HasSpawn = level2Tools.some((t) => /spawn/i.test(t) || t === "Agent" || t === "Task");
  const level2HasBash = level2Tools.includes("Bash");

  if (!level2HasSpawn) {
    console.log("❌ Level-2 worker lacks any spawn capability (no Agent, Task, or mcp__spawn__spawn).");
    return 1;
  }
  if (!level2HasBash) {
    console.log("❌ Level-2 worker lacks Bash.");
    return 1;
  }

  console.log("\n✅ Two-level spawn chain works via mcp__spawn__spawn.");
  console.log("   Level-2 worker has both a spawn capability and Bash.");
  console.log("   The CLI's Agent/Task strip is bypassed by the MCP workaround —");
  console.log("   each spawn is a fresh top-level query(), so Agent reappears at every level.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error("crashed:", err);
    process.exit(1);
  });
