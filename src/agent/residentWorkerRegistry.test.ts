// Verify ResidentWorkerRegistry lifecycle with fake workers — no live auth.
// The registry's job: namespace workers per owner thread, reuse live ones,
// replace dead ones, and scope list/kill correctly.

import { ResidentWorkerRegistry } from "./residentWorkerRegistry.js";
import type { ResidentWorker } from "./runtime/residentWorker.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// Minimal fake worker — enough surface for the registry's needs.
function makeFake(opts: { name: string; ownerThread: string }): ResidentWorker {
  let killed = false;
  const fake = {
    name: opts.name,
    ownerThread: opts.ownerThread,
    workdir: "/tmp",
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastError: null,
    get status() {
      return killed ? "dead" : "idle";
    },
    send: async (p: string) => `reply:${p}`,
    kill: () => {
      killed = true;
    },
  };
  return fake as unknown as ResidentWorker;
}

async function main() {
  let created = 0;
  const reg = new ResidentWorkerRegistry((o) => {
    created += 1;
    return makeFake({ name: o.name, ownerThread: o.ownerThread });
  });

  // --- (1) getOrCreate is idempotent for a live worker ---
  {
    const w1 = reg.getOrCreate({ name: "researcher", ownerThread: "C:T1", workdir: "/tmp" });
    const w2 = reg.getOrCreate({ name: "researcher", ownerThread: "C:T1", workdir: "/tmp" });
    assert(w1 === w2, "same name+thread returns same instance");
    assert(created === 1, `only one worker constructed, got ${created}`);
    assert(reg.has("C:T1", "researcher"), "has() true for live worker");
  }

  // --- (2) Per-thread namespacing — same name, different thread ---
  {
    const a = reg.getOrCreate({ name: "researcher", ownerThread: "C:T1", workdir: "/tmp" });
    const b = reg.getOrCreate({ name: "researcher", ownerThread: "C:T2", workdir: "/tmp" });
    assert(a !== b, "same name in different threads → distinct workers");
    assert(reg.list("C:T1").length === 1, "T1 sees only its worker");
    assert(reg.list("C:T2").length === 1, "T2 sees only its worker");
  }

  // --- (3) kill removes + frees the name; getOrCreate makes a fresh one ---
  {
    const before = reg.getOrCreate({ name: "tmp", ownerThread: "C:T3", workdir: "/tmp" });
    assert(reg.kill("C:T3", "tmp") === true, "kill live worker returns true");
    assert(!reg.has("C:T3", "tmp"), "killed worker no longer present");
    assert(reg.kill("C:T3", "tmp") === false, "kill missing worker returns false");
    const after = reg.getOrCreate({ name: "tmp", ownerThread: "C:T3", workdir: "/tmp" });
    assert(after !== before, "name reusable after kill — fresh instance");
  }

  // --- (4) A dead (not killed-via-registry) worker is replaced on getOrCreate ---
  {
    const w = reg.getOrCreate({ name: "diesonown", ownerThread: "C:T4", workdir: "/tmp" });
    w.kill(); // worker died on its own, still in the map
    assert(!reg.has("C:T4", "diesonown"), "has() false once worker is dead");
    const replacement = reg.getOrCreate({ name: "diesonown", ownerThread: "C:T4", workdir: "/tmp" });
    assert(replacement !== w, "dead worker replaced by a fresh one");
    assert(replacement.status !== "dead", "replacement is live");
  }

  // --- (5) killAllForThread scopes to one thread ---
  {
    const reg2 = new ResidentWorkerRegistry((o) => makeFake({ name: o.name, ownerThread: o.ownerThread }));
    reg2.getOrCreate({ name: "a", ownerThread: "C:X", workdir: "/tmp" });
    reg2.getOrCreate({ name: "b", ownerThread: "C:X", workdir: "/tmp" });
    reg2.getOrCreate({ name: "c", ownerThread: "C:Y", workdir: "/tmp" });
    const killed = reg2.killAllForThread("C:X");
    assert(killed === 2, `killAllForThread killed 2, got ${killed}`);
    assert(reg2.list("C:X").length === 0, "X has no workers after killAll");
    assert(reg2.list("C:Y").length === 1, "Y untouched");
  }

  // --- (6) list reports status + metadata ---
  {
    const reg3 = new ResidentWorkerRegistry((o) => makeFake({ name: o.name, ownerThread: o.ownerThread }));
    reg3.getOrCreate({ name: "watcher", ownerThread: "C:Z", workdir: "/tmp" });
    const infos = reg3.list("C:Z");
    assert(infos.length === 1, "one info");
    assert(infos[0].name === "watcher", "info name");
    assert(infos[0].status === "idle", "info status");
    assert(typeof infos[0].createdAt === "string", "info createdAt");
  }

  console.log(
    "✅ ResidentWorkerRegistry verified — idempotent getOrCreate, per-thread namespacing, kill/reuse, dead replacement, killAllForThread scoping",
  );
}

main().catch((err) => {
  console.error("❌ ResidentWorkerRegistry verification failed:", err);
  process.exit(1);
});
