// Live SDK probe: run the wormhole's exact query() config and ask a
// spawned sub-agent to enumerate its tools. Asserts that Agent, Task, and
// Bash all appear — the three capabilities required to satisfy
// validation.md criteria 3/5/6/7/8 (recursive worker spawning + canonical
// tool surface).
//
// Run via scripts/verify-subagent-tools.sh (which sets up env). Requires
// live Anthropic credentials.
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../src/config.js";
import { RECURSIVE_AGENTS } from "../src/agent/session.js";

const PROBE_PROMPT = `Use the Agent tool RIGHT NOW with subagent_type: "general-purpose" to spawn a sub-agent. Its prompt should be exactly:

"List every tool you have access to, one per line, with no other prose. Then exit. Do not run any tools — just enumerate them."

After the sub-agent returns, report the tool list verbatim.`;

async function main() {
  console.log("▸ Spawning live query with wormhole's RECURSIVE_AGENTS config…");
  console.log(`  Agents registered: ${Object.keys(RECURSIVE_AGENTS).join(", ")}`);

  const q = query({
    prompt: PROBE_PROMPT,
    options: {
      model: env.ANTHROPIC_MODEL,
      tools: { type: "preset", preset: "claude_code" },
      agents: RECURSIVE_AGENTS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      additionalDirectories: ["/"],
    },
  });

  let finalText = "";
  const toolUseNamesSeenInSubAgent = new Set<string>();

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      const parentToolUseId =
        "parent_tool_use_id" in msg
          ? (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null
          : null;
      const isSubAgent = parentToolUseId != null;
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === "text") {
          if (isSubAgent) {
            // Capture the sub-agent's enumerated list.
            for (const line of block.text.split(/\r?\n/)) {
              const trimmed = line.trim().replace(/^[-*]\s*/, "");
              if (trimmed && /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
                toolUseNamesSeenInSubAgent.add(trimmed);
              }
            }
          }
          if (!isSubAgent) finalText = block.text;
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as { subtype?: string; result?: string };
      if (r.subtype === "success" && typeof r.result === "string") finalText = r.result;
    }
  }

  console.log("\n── Parent's final report ──");
  console.log(finalText);

  console.log("\n── Tool names extracted from sub-agent text ──");
  console.log([...toolUseNamesSeenInSubAgent].sort().join(", ") || "(none parsed)");

  const required = ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "WebSearch"];
  const required_spawn_either = ["Agent", "Task"];

  const missing: string[] = [];
  for (const t of required) if (!toolUseNamesSeenInSubAgent.has(t)) missing.push(t);
  const hasSpawn = required_spawn_either.some((t) => toolUseNamesSeenInSubAgent.has(t));
  if (!hasSpawn) missing.push("Agent OR Task (spawn)");

  if (missing.length > 0) {
    console.error(`\n❌ Sub-agent is missing required tools: ${missing.join(", ")}`);
    console.error("   This means the orchestrator → worker spawn pattern won't work.");
    process.exit(1);
  }

  console.log("\n✅ Sub-agent has Bash, Agent/Task, and the canonical file/web tools.");
}

main().catch((err) => {
  console.error("❌ verification crashed:", err);
  process.exit(1);
});
