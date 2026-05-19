// Verification — run with: npx tsx src/agent/manager.test.ts
import { SessionManager, threadKeyOf } from "./manager.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const mgr = new SessionManager();
  const keyA = threadKeyOf("C1", "T1");
  const keyB = threadKeyOf("C1", "T2");

  // Same key → same session instance
  const a1Res = await mgr.get(keyA);
  const a2Res = await mgr.get(keyA);
  const a1 = a1Res.entry;
  const a2 = a2Res.entry;
  assert(a1 === a2, "same thread key must return same SessionEntry");
  assert(a1Res.created === true, "first get must report created=true");
  assert(a2Res.created === false, "second get must report created=false");

  // Different keys → different sessions
  const bRes = await mgr.get(keyB);
  const b = bRes.entry;
  assert(a1 !== b, "different thread keys must return distinct SessionEntries");
  assert(bRes.created === true, "new key must report created=true");

  // Per-thread queue: rapid enqueues on the same thread serialize
  const log: string[] = [];
  const work = (label: string, ms: number) => async () => {
    log.push(`start:${label}`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`end:${label}`);
  };

  await Promise.all([
    a1.enqueue(work("a", 50)),
    a1.enqueue(work("b", 20)),
    a1.enqueue(work("c", 10)),
  ]);

  assert(
    JSON.stringify(log) === JSON.stringify(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]),
    `same-thread work must serialize, got: ${log.join(",")}`,
  );

  // Cross-thread: a and b run in parallel
  const log2: string[] = [];
  const tick = (label: string, ms: number) => async () => {
    log2.push(`s:${label}`);
    await new Promise((r) => setTimeout(r, ms));
    log2.push(`e:${label}`);
  };
  const t0 = Date.now();
  await Promise.all([a1.enqueue(tick("a", 50)), b.enqueue(tick("b", 50))]);
  const elapsed = Date.now() - t0;
  assert(elapsed < 90, `parallel threads should finish in <90ms, took ${elapsed}ms`);

  // close() drops the entry; next get() returns a fresh instance with created=true.
  const closed = mgr.close(keyA);
  assert(closed === true, "close on existing key returns true");
  assert(mgr.has(keyA) === false, "close removes the entry");
  const closedAgain = mgr.close(keyA);
  assert(closedAgain === false, "close on missing key returns false");
  const a3Res = await mgr.get(keyA);
  assert(a3Res.entry !== a1, "post-close get returns a fresh SessionEntry");
  assert(a3Res.created === true, "post-close get reports created=true");

  console.log("✅ session manager verification passed");
}

main().catch((err) => {
  console.error("❌ session manager verification failed:", err);
  process.exit(1);
});
