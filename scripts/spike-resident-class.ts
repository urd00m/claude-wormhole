// LIVE manual check (needs Claude auth): drives the REAL ResidentWorker
// class (not the spike prototype) against a live process to confirm
// in-memory context survives across two send() calls and kill() works.
//   npx tsx scripts/spike-resident-class.ts
import { ResidentWorker } from "../src/agent/runtime/residentWorker.js";

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error("ASSERT: " + m);
}

async function main() {
  const w = new ResidentWorker({ name: "live", ownerThread: "C:live", workdir: process.cwd() });
  const t1 = await w.send("Remember the number 1337. Reply with just 'ok'.");
  console.log("[turn1]", JSON.stringify(t1.slice(0, 80)));
  const t2 = await w.send("What number did I ask you to remember? Digits only.");
  console.log("[turn2]", JSON.stringify(t2.slice(0, 80)));
  w.kill();
  assert(w.status === "dead", "status dead after kill");
  assert(t2.includes("1337"), `context not retained across sends: ${t2}`);
  console.log("\n✅ LIVE PASS: real ResidentWorker retained context across two sends, kill() worked.");
}
main().catch((e) => {
  console.error("\n❌ LIVE FAIL:", e);
  process.exit(1);
});
