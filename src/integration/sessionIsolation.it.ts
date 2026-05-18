// Live integration test: prove two Sessions sharing a workdir do NOT
// cross-bleed conversation state. The unit test proves we send the right
// SDK options (sessionId / resume / never continue). This test proves the
// SDK actually honors them — i.e. that Session A's "remember X" doesn't
// leak into Session B when both run with cwd=/same/path.
//
// Method:
//   A → "remember code PURPLE-RHINO-7"     (sets up A's history)
//   B → "what code am I supposed to know?" (B must NOT know — different session)
//   A → "what was the code?"               (A must remember — its own resume)
//
// Costs ~3-4k tokens. Run via scripts/it.sh sessionIsolation.

import { Session } from "../agent/session.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const SECRET = "PURPLE-RHINO-7";
const SHARED_WORKDIR = process.cwd();

// Tight prompts: instruct the model to answer with a specific sentinel so
// the parser doesn't have to fight prose.
const A_TURN_1 = `Remember this secret code exactly: ${SECRET}. Reply with only the single word ACKNOWLEDGED. Do not say anything else.`;

const B_TURN_1 = `I am a brand-new conversation. You should have NO prior context with me. If you remember a secret code from earlier, reply with that exact code. If you do not, reply with only the single word NONE. Do not say anything else.`;

const A_TURN_2 = `What was the secret code I told you to remember earlier? Reply with only the code, nothing else.`;

async function ask(session: Session, prompt: string, label: string): Promise<string> {
  const t = Date.now();
  const out = await session.send({ text: prompt });
  console.log(`  [${label}] ${Date.now() - t}ms · ${out.finalText.slice(0, 200)}`);
  return out.finalText.trim();
}

async function main(): Promise<number> {
  console.log("▸ Live session-isolation test (two Sessions, same workdir)");
  console.log(`  shared workdir: ${SHARED_WORKDIR}`);
  console.log(`  secret sentinel: ${SECRET}`);
  console.log("");

  const sessionA = new Session({ threadKey: "iso_test_A", workdir: SHARED_WORKDIR });
  const sessionB = new Session({ threadKey: "iso_test_B", workdir: SHARED_WORKDIR });

  // --- Turn 1: A learns the secret ---
  const a1 = await ask(sessionA, A_TURN_1, "A·1 (store secret)");

  // --- Turn 2: B asks about the secret. Must NOT know it. ---
  // This is the critical assertion: if `continue: true` (the old broken
  // path) were in effect, B's session would resume A's most-recent
  // conversation in this cwd and would know the secret.
  const b1 = await ask(sessionB, B_TURN_1, "B·1 (probe leakage)");

  // --- Turn 3: A asks for its own secret back. Must remember it. ---
  const a2 = await ask(sessionA, A_TURN_2, "A·2 (recall own secret)");

  console.log("\n── Assertions ──");

  let ok = true;

  if (b1.includes(SECRET)) {
    console.log(`❌ LEAK: Session B knew Session A's secret. continue-by-cwd bug NOT fixed.`);
    console.log(`   B's reply: ${b1}`);
    ok = false;
  } else if (/NONE/i.test(b1)) {
    console.log(`✅ Isolation: Session B does not know A's secret (replied NONE).`);
  } else {
    // B replied something other than NONE and didn't leak the secret.
    // That's still a pass (the strong invariant — no leak — holds). Log
    // for visibility.
    console.log(`✅ Isolation (soft): Session B did not leak the secret. Reply was ambiguous: ${b1.slice(0, 120)}`);
  }

  if (a2.includes(SECRET)) {
    console.log(`✅ Continuity: Session A still remembers its own secret (resumed correctly).`);
  } else {
    console.log(`❌ A did NOT remember its own secret on resume. Session continuity broken.`);
    console.log(`   A's recall reply: ${a2}`);
    ok = false;
  }

  // Sanity on A's first turn — it should have acknowledged. Don't fail on
  // this, just log.
  if (!/ACKNOWLEDGED/i.test(a1)) {
    console.log(`⚠️  A's first reply didn't contain ACKNOWLEDGED (model strayed from prompt): ${a1.slice(0, 120)}`);
  }

  if (!ok) return 1;
  console.log("\n✅ Live session isolation verified — distinct UUIDs prevent cwd-based bleed.");
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error("crashed:", err);
    process.exit(1);
  });
