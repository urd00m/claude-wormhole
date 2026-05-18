// Probe: does the CLI strip Agent/Task only for the built-in name
// "general-purpose", or for ANY sub-agent regardless of name?
//
// Registers two custom agent types and spawns each with the same tool
// allowlist that explicitly includes Agent + Task. If the custom-name
// agent reports Agent/Task in its surface but "general-purpose" doesn't,
// the strip is name-specific and we can work around it by renaming.

import { query, type SDKMessage, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";

const FULL_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
  "TodoWrite",
];

const AGENTS: Record<string, AgentDefinition> = {
  // Built-in name — we expect this to be stripped.
  "general-purpose": {
    description: "Custom general-purpose w/ explicit tools incl Agent/Task",
    prompt: "You are a worker. Enumerate tools.",
    tools: [...FULL_TOOLS],
    permissionMode: "bypassPermissions",
  },
  // Custom names — these may bypass the auto-strip.
  "wormhole-worker": {
    description: "Custom-named worker with explicit Agent/Task in tools",
    prompt: "You are a worker. Enumerate tools.",
    tools: [...FULL_TOOLS],
    permissionMode: "bypassPermissions",
  },
  spawner: {
    description: "Different custom name to rule out specific string matching",
    prompt: "You are a worker. Enumerate tools.",
    tools: [...FULL_TOOLS],
    permissionMode: "bypassPermissions",
  },
};

const SUB_PROMPT = `Emit the literal markers below, one tool name per line between them. Do not include parameters or descriptions. Do not run any tools. Stop after the END marker.

TOOL_DUMP_BEGIN
<tool names>
TOOL_DUMP_END`;

async function probe(subagentType: string): Promise<string[]> {
  console.log(`\n── Probing subagent_type: "${subagentType}" ──`);
  const root = [
    `Call the Agent tool exactly once with subagent_type: "${subagentType}". Pass this prompt to the sub-agent verbatim:`,
    "",
    SUB_PROMPT,
    "",
    "After the sub-agent returns, copy its full output in your reply.",
  ].join("\n");

  const q = query({
    prompt: root,
    options: {
      model: env.ANTHROPIC_MODEL,
      tools: { type: "preset", preset: "claude_code" },
      agents: AGENTS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      additionalDirectories: ["/"],
    },
  });

  const chunks: string[] = [];
  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      const m = msg as { message?: { content?: unknown } };
      const content = (m.message?.content ?? []) as Array<{ type?: string; text?: string }>;
      for (const b of content) {
        if (b.type === "text" && typeof b.text === "string") chunks.push(b.text);
      }
    }
  }
  const full = chunks.join("\n");
  const match = /TOOL_DUMP_BEGIN([\s\S]*?)TOOL_DUMP_END/.exec(full);
  if (!match) {
    console.log(`  ⚠️  no TOOL_DUMP markers — sub-agent may have errored`);
    console.log(`  raw: ${full.slice(0, 500)}`);
    return [];
  }
  return match[1]
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/[`,]/g, ""))
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
}

async function main(): Promise<number> {
  const results = new Map<string, string[]>();
  for (const name of Object.keys(AGENTS)) {
    const tools = await probe(name);
    results.set(name, tools);
    const hasSpawn = tools.includes("Agent") || tools.includes("Task");
    console.log(`  → ${tools.length} tools, spawn-tool present: ${hasSpawn ? "YES ✅" : "NO ❌"}`);
    console.log(`  → tools: ${tools.join(", ")}`);
  }

  console.log("\n══ Summary ══");
  let anyHasSpawn = false;
  for (const [name, tools] of results) {
    const has = tools.includes("Agent") || tools.includes("Task");
    console.log(`  ${has ? "✅" : "❌"} ${name}: spawn-tool ${has ? "present" : "STRIPPED"}`);
    if (has) anyHasSpawn = true;
  }

  if (!anyHasSpawn) {
    console.log("\n❌ Spawn tool stripped from EVERY agent type tested.");
    console.log("   The CLI's anti-recursion strip is universal, not name-specific.");
    return 1;
  }
  console.log("\n✅ At least one agent type retained the spawn tool — rename trick viable.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error("crashed:", err);
    process.exit(1);
  });
