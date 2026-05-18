// Integration test: live SDK call against the EXACT config the wormhole
// uses in production (src/agent/session.ts → query options). Verifies that
// the spawn chain works at depth 1 AND depth 2, since the user's
// orchestrator pattern needs nested spawning (orchestrator → Planner /
// Plan-critic / Executor / Verifier / Verdict-critic).
//
// Prints a full diagnostic dump per level so when a level fails the
// output shows exactly which subagent_type was used, what tools the
// sub-agent reported it had, and any errors verbatim.
//
// REQUIRES live Anthropic credentials (ANTHROPIC_API_KEY env var or
// ~/.claude credentials). Costs a few thousand tokens per run. Don't
// add to npm test — run via scripts/it.sh.
//
// Exits 0 if every level reports Bash + a spawn tool (Agent OR Task);
// exits 1 with the failing level's diagnostic block otherwise.

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config.js";
import { RECURSIVE_AGENTS } from "../agent/session.js";
import { MAX_SUBAGENT_DEPTH } from "../agent/subagentDepth.js";

const REQUIRED_TOOLS = ["Bash", "Read", "Write", "Edit", "Grep", "Glob"];
const REQUIRED_SPAWN_TOOL_EITHER_OF = ["Agent", "Task"];

/**
 * Prompt for the level-N sub-agent. Asks for a hard, structured tool dump
 * so the parser can't be fooled by surrounding prose.
 */
function toolDumpPrompt(level: number, alsoSpawnFurther: boolean): string {
  const parts: string[] = [
    `You are sub-agent level ${level}. Your ONLY task is to enumerate your available tools, then optionally spawn one more sub-agent.`,
    "",
    `Step 1: emit a block exactly in this format (literal markers, NO Markdown):`,
    `TOOL_DUMP_BEGIN_LEVEL_${level}`,
    `<one tool name per line, e.g. "Bash", "Agent", "Read"; do NOT include parameters or descriptions>`,
    `TOOL_DUMP_END_LEVEL_${level}`,
  ];
  if (alsoSpawnFurther) {
    parts.push(
      "",
      `Step 2: AFTER emitting your tool dump, call the Agent tool ONCE with`,
      `  subagent_type: "general-purpose"`,
      `and pass the spawned sub-agent the following prompt verbatim:`,
      "",
      toolDumpPrompt(level + 1, false),
    );
  } else {
    parts.push("", "Do NOT spawn anything. Stop after emitting the tool dump.");
  }
  parts.push("", "Do not run any tools other than what step 2 requires. Do not run Bash, Read, etc. — only enumerate them and (if step 2 is present) call Agent.");
  return parts.join("\n");
}

const ROOT_PROMPT = [
  "You are the test driver. Run these two steps:",
  "",
  `Step A: Call the Agent tool with subagent_type: "general-purpose" and pass the following prompt VERBATIM as the sub-agent's prompt:`,
  "",
  toolDumpPrompt(1, true),
  "",
  "Step B: After the Agent call returns, copy the sub-agent's full output into your final response inside a fenced code block. Do not summarize.",
].join("\n");

type LevelReport = {
  level: number;
  tools: string[];
  raw: string;
  agentId?: string;
};

function parseToolDumps(text: string): LevelReport[] {
  const reports: LevelReport[] = [];
  const re = /TOOL_DUMP_BEGIN_LEVEL_(\d+)\s*([\s\S]*?)TOOL_DUMP_END_LEVEL_\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const level = Number(m[1]);
    const body = m[2];
    const tools = body
      .split(/\r?\n/)
      .map((l) => l.trim().replace(/^[-*]\s*/, "").replace(/[`,]/g, ""))
      .filter((l) => l.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
    reports.push({ level, tools, raw: body });
  }
  return reports;
}

function diagnoseLevel(report: LevelReport | undefined, level: number): string[] {
  const errs: string[] = [];
  if (!report) {
    errs.push(`level ${level}: NO TOOL_DUMP_BEGIN_LEVEL_${level}…END marker found — sub-agent didn't reach this depth or didn't follow the protocol.`);
    return errs;
  }
  const have = new Set(report.tools);
  for (const t of REQUIRED_TOOLS) {
    if (!have.has(t)) errs.push(`level ${level}: missing ${t}`);
  }
  if (!REQUIRED_SPAWN_TOOL_EITHER_OF.some((t) => have.has(t))) {
    errs.push(
      `level ${level}: missing the spawn tool (neither ${REQUIRED_SPAWN_TOOL_EITHER_OF.join(" nor ")} present) — orchestrator pattern broken at this depth`,
    );
  }
  return errs;
}

async function main(): Promise<number> {
  console.log("▸ Integration test: nested spawn chain");
  console.log(`  Model:           ${env.ANTHROPIC_MODEL}`);
  console.log(`  Agents:          ${Object.keys(RECURSIVE_AGENTS).join(", ")}`);
  console.log(`  Depth cap:       ${MAX_SUBAGENT_DEPTH}`);
  console.log(`  Testing depths:  1 → 2`);
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
      includePartialMessages: false,
    },
  });

  // Capture ALL assistant text — root + every sub-agent — so the parser
  // can find tool dumps no matter who emitted them.
  const allText: string[] = [];
  const perAgentText = new Map<string, string[]>();
  let parentFinalText = "";

  for await (const msg of q as AsyncIterable<SDKMessage>) {
    if (msg.type === "assistant") {
      const m = msg as { message?: { content?: unknown }; parent_tool_use_id?: string | null; subagent_type?: string };
      const content = (m.message?.content ?? []) as Array<{ type?: string; text?: string }>;
      const parentToolUseId = m.parent_tool_use_id ?? null;
      const key = parentToolUseId ? `subagent:${parentToolUseId.slice(0, 12)}` : "root";
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          allText.push(block.text);
          if (!perAgentText.has(key)) perAgentText.set(key, []);
          perAgentText.get(key)!.push(block.text);
          if (!parentToolUseId) parentFinalText = block.text;
        }
      }
    }
    if (msg.type === "result") {
      const r = msg as { subtype?: string; result?: string };
      if (r.subtype === "success" && typeof r.result === "string") parentFinalText = r.result;
    }
  }

  const fullText = allText.join("\n");
  const reports = parseToolDumps(fullText);
  const byLevel = new Map(reports.map((r) => [r.level, r]));

  console.log("── Parser results ──");
  for (let lv = 1; lv <= 2; lv++) {
    const r = byLevel.get(lv);
    if (!r) {
      console.log(`  level ${lv}: NOT FOUND`);
    } else {
      console.log(`  level ${lv}: ${r.tools.length} tools — ${r.tools.join(", ")}`);
    }
  }

  const errors: string[] = [];
  errors.push(...diagnoseLevel(byLevel.get(1), 1));
  errors.push(...diagnoseLevel(byLevel.get(2), 2));

  if (errors.length > 0) {
    console.log("\n── ❌ FAILURES ──");
    for (const e of errors) console.log(`  ${e}`);
    console.log("\n── Diagnostic dump (paste this if reporting) ──");
    console.log("\n## Parent final text:");
    console.log(parentFinalText.slice(0, 2000));
    console.log("\n## All sub-agent text (truncated to 4000 chars per agent):");
    for (const [key, chunks] of perAgentText) {
      console.log(`\n### ${key}:`);
      console.log(chunks.join("\n").slice(0, 4000));
    }
    return 1;
  }

  console.log("\n✅ Spawn chain works at depth 1 and depth 2.");
  console.log("   Both levels have Bash + a spawn tool.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("❌ integration test crashed:", err);
    process.exit(1);
  });
