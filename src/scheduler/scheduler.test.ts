// Verify CronStore persistence + Scheduler add/fire/remove cycle.
// Run via: npm run test
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CronStore } from "./store.js";
import { Scheduler } from "./scheduler.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  // Store: persist and reload
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cron-"));
  const file = path.join(tmp, "crons.json");
  const s1 = new CronStore(file);
  const a = s1.add({ expression: "* * * * *", channel: "C1", prompt: "hi" });
  assert(a.id.startsWith("cron_"), "id generated");
  assert(s1.list().length === 1, "one entry");

  const s2 = new CronStore(file);
  assert(s2.list().length === 1, "persisted across instances");
  assert(s2.get(a.id)?.prompt === "hi", "prompt round-trips");

  assert(s2.remove(a.id), "remove returns true");
  assert(s2.list().length === 0, "removed");
  assert(!s2.remove(a.id), "second remove returns false");

  // Scheduler: invalid expression rejected
  const store = new CronStore(path.join(tmp, "s.json"));
  let fired: string[] = [];
  const sched = new Scheduler(store, async (e) => {
    fired.push(e.id);
  });
  let threw = false;
  try {
    sched.add({ expression: "not a cron", channel: "C1", prompt: "x" });
  } catch {
    threw = true;
  }
  assert(threw, "invalid expression must throw");

  // Scheduler: fires on the cron tick
  // Use a 1-second granularity expression (6-field with seconds).
  const entry = sched.add({ expression: "* * * * * *", channel: "C1", prompt: "p" });
  await new Promise((r) => setTimeout(r, 2100));
  assert(fired.length >= 1, `expected at least 1 fire, got ${fired.length}`);
  assert(fired[0] === entry.id, "fired id matches");

  // Remove cancels future fires
  const firedBefore = fired.length;
  sched.remove(entry.id);
  await new Promise((r) => setTimeout(r, 1500));
  assert(fired.length === firedBefore, `no fires after remove, got ${fired.length - firedBefore} more`);

  // Reload from disk: scheduler.start picks up stored entries
  const store2 = new CronStore(path.join(tmp, "boot.json"));
  store2.add({ expression: "* * * * * *", channel: "C2", prompt: "boot" });
  let bootFired = 0;
  const sched2 = new Scheduler(store2, async () => {
    bootFired += 1;
  });
  sched2.start();
  await new Promise((r) => setTimeout(r, 1300));
  sched2.stopAll();
  assert(bootFired >= 1, "scheduler.start() activates stored crons");

  console.log("✅ scheduler verification passed");
}

main().catch((err) => {
  console.error("❌ scheduler verification failed:", err);
  process.exit(1);
});
