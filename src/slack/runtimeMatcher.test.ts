// Verify detectRuntimeSwitch accepts the natural control-phrase orderings
// and rejects prose / partial matches. Mirrors endSessionMatcher.test.ts
// in spirit — accept list, reject list, both run through one harness.

import { detectRuntimeSwitch, detectRuntimeOpener } from "./runtimeMatcher.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Case = { text: string; expect: "claude" | "codex" | null };

const ACCEPTS_CLAUDE: string[] = [
  "use claude",
  "Use Claude",
  "USE CLAUDE",
  "use claude.",
  "use claude!",
  "switch to claude",
  "switch back to claude",
  "back to claude",
  "please switch to claude",
  "switch this thread to claude",
  "use claude for this thread",
  "set runtime to claude",
  "set runtime claude",
  "runtime claude",
  "/claude",
  "/runtime claude",
  "/use-claude",
  // with leading bot mention (stripped by normalizeForCommand)
  "<@U123> use claude",
];

const ACCEPTS_CODEX: string[] = [
  "use codex",
  "Use Codex",
  "USE CODEX",
  "use codex.",
  "use codex!",
  "switch to codex",
  "switch back to codex",
  "back to codex",
  "please switch to codex",
  "switch this thread to codex",
  "use codex for this thread",
  "set runtime to codex",
  "set runtime codex",
  "runtime codex",
  "/codex",
  "/runtime codex",
  "/use-codex",
  "<@U123> use codex",
];

const REJECTS: string[] = [
  // Prose mentioning the runtimes shouldn't trigger.
  "I think claude is better for this",
  "should I use claude or codex?",
  "codex would handle this faster, what do you think",
  "tell me about claude",
  // Empty / whitespace
  "",
  "    ",
  // Partial words
  "claud",
  "code",
  // Wrong polarity (turn off all runtimes — unsupported phrase)
  "turn off claude",
  "stop claude",
  // Other commands
  "end session",
  "close session",
  // Looks command-y but isn't ours
  "switch to /admin",
  "use the claude tool from the docs",
];

async function main() {
  let pass = 0;
  let fail = 0;
  const cases: Case[] = [
    ...ACCEPTS_CLAUDE.map((text) => ({ text, expect: "claude" as const })),
    ...ACCEPTS_CODEX.map((text) => ({ text, expect: "codex" as const })),
    ...REJECTS.map((text) => ({ text, expect: null })),
  ];

  for (const { text, expect } of cases) {
    const got = detectRuntimeSwitch(text);
    if (got === expect) {
      pass += 1;
    } else {
      fail += 1;
      console.error(`  ✗ "${text}" → expected ${expect}, got ${got}`);
    }
  }

  // Belt-and-suspenders: ensure the two phrase sets don't overlap.
  // A phrase that maps to both runtimes would be a bug in the matcher.
  for (const c of ACCEPTS_CLAUDE) {
    const codexMatch = ACCEPTS_CODEX.find((d) => d === c);
    assert(!codexMatch, `phrase appears in both lists: ${c}`);
  }

  if (fail > 0) {
    console.error(`❌ runtimeMatcher: ${fail} of ${cases.length} cases failed`);
    process.exit(1);
  }
  console.log(`✅ runtimeMatcher switch verified — ${pass} cases (claude=${ACCEPTS_CLAUDE.length}, codex=${ACCEPTS_CODEX.length}, rejects=${REJECTS.length})`);

  // --- detectRuntimeOpener tests ---
  let openerPass = 0;
  let openerFail = 0;

  type OpenerCase = { text: string; expect: { runtime: string; prompt: string } | null };
  const openerCases: OpenerCase[] = [
    // Should match
    { text: "codex> write me hello world", expect: { runtime: "codex", prompt: "write me hello world" } },
    { text: "Codex> fix the bug", expect: { runtime: "codex", prompt: "fix the bug" } },
    { text: "CODEX> help", expect: { runtime: "codex", prompt: "help" } },
    { text: "codex: do the thing", expect: { runtime: "codex", prompt: "do the thing" } },
    { text: "claude> explain this code", expect: { runtime: "claude", prompt: "explain this code" } },
    { text: "claude: what is this", expect: { runtime: "claude", prompt: "what is this" } },
    { text: "<@U123> codex> build it", expect: { runtime: "codex", prompt: "build it" } },
    { text: "<@U456> claude: run tests", expect: { runtime: "claude", prompt: "run tests" } },
    // Should NOT match
    { text: "codex>", expect: null },              // no prompt after prefix
    { text: "codex> ", expect: null },             // only whitespace after prefix
    { text: "use codex for this", expect: null },  // not the prefix pattern
    { text: "I think codex: is great", expect: null }, // not at start
    { text: "hello world", expect: null },
    { text: "", expect: null },
  ];

  for (const { text, expect } of openerCases) {
    const got = detectRuntimeOpener(text);
    const match =
      (got === null && expect === null) ||
      (got !== null && expect !== null && got.runtime === expect.runtime && got.prompt === expect.prompt);
    if (match) {
      openerPass += 1;
    } else {
      openerFail += 1;
      const gotStr = got ? `{runtime:${got.runtime}, prompt:"${got.prompt}"}` : "null";
      const expStr = expect ? `{runtime:${expect.runtime}, prompt:"${expect.prompt}"}` : "null";
      console.error(`  ✗ opener "${text}" → expected ${expStr}, got ${gotStr}`);
    }
  }

  if (openerFail > 0) {
    console.error(`❌ runtimeOpener: ${openerFail} of ${openerCases.length} cases failed`);
    process.exit(1);
  }
  console.log(`✅ runtimeOpener verified — ${openerPass} cases`);
}

main().catch((err) => {
  console.error("❌ runtimeMatcher verification failed:", err);
  process.exit(1);
});
