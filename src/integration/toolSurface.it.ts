// Integration test: ask a freshly spawned `general-purpose` sub-agent to
// dump its tool surface (one tool name per line, fenced markers) and
// verify it contains Bash + a spawn tool. Single-level — the companion
// test (spawnChain.it.ts) covers nested spawning.
//
// Fails LOUDLY with the full sub-agent text dump if the surface is wrong,
// so a regression on the inherit-from-parent pathway shows up obviously.
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { RECURSIVE_AGENTS } from "../agent/session.js";

const SUB_PROMPT = [
  "Enumerate every tool you have access to. Emit one tool name per line",
  "between the literal markers below — nothing else inside the markers:",
  "",
  "TOOL_DUMP_BEGIN",
  "<one tool name per line, e.g. Bash, Agent, Read>",
  "TOOL_DUMP_END",
  "",
  "Do not run any tools. Do not include parameters or descriptions.",
  "Stop after emitting the dump.",
].join("\n");

const ROOT_PROMPT = [
  `Call the Agent tool exactly once with subagent_type: "general-purpose".`,
  `Pass the sub-agent the following prompt verbatim:`,
  "",
  SUB_PROMPT,
  "",
  "After the sub-agent returns, copy its full output verbatim in your reply inside a fenced code block.",
].join("\n");

async function main(): Promise<number> {
  console.log("▸ Tool-surface integration test (depth 1)");
  console.log(`  Model:  ${env.ANTHROPIC_MODEL}`);
  console.log("");

  const q = query({
    prompt: ROOT_PROMPT,
    options: {
      model: env.ANTHROPIC_MODEL,
      tools: { type: "preset", preset: "claude_code" },
      agents: RECURSIVE_AGENTS,
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
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") allText.push(block.text);
      }
    }
  }
  const fullText = allText.join("\n");

  const match = /TOOL_DUMP_BEGIN([\s\S]*?)TOOL_DUMP_END/.exec(fullText);
  if (!match) {
    console.log("❌ TOOL_DUMP markers not found in any agent output.");
    console.log("\n── Captured text ──");
    console.log(fullText.slice(0, 4000));
    return 1;
  }
  const tools = match[1]
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/[`,]/g, ""))
    .filter((l) => l.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));

  console.log(`Reported tools (${tools.length}):`);
  for (const t of tools) console.log(`  ${t}`);
  console.log("");

  const required = ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "WebSearch"];
  const spawnEither = ["Agent", "Task"];
  const have = new Set(tools);

  const missing: string[] = [];
  for (const t of required) if (!have.has(t)) missing.push(t);
  if (!spawnEither.some((t) => have.has(t))) missing.push(`one of [${spawnEither.join(", ")}]`);

  if (missing.length > 0) {
    console.log(`❌ Missing required tools: ${missing.join(", ")}`);
    console.log("\n── Captured text (for diagnosis) ──");
    console.log(fullText.slice(0, 4000));
    return 1;
  }

  console.log("✅ Sub-agent has the full canonical surface + a spawn tool.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error("❌ crashed:", err);
    process.exit(1);
  });
