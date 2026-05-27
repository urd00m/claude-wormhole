// Verify the resident-worker MCP tool layer: handleResidentSpawn,
// formatWorkerList, killResidentWorker. These are the handlers the agent
// actually invokes via mcp__spawn__spawn (resident:true), worker_list, and
// worker_kill. We inject a fake ResidentWorkerRegistry wired with fake
// workers so no real Claude process is spawned — the worker/registry
// internals are covered by their own suites; this verifies the glue.

import {
  handleResidentSpawn,
  formatWorkerList,
  killResidentWorker,
  type SpawnCtx,
} from "./tools/spawn.js";
import { ResidentWorkerRegistry } from "./residentWorkerRegistry.js";
import type { ResidentWorker } from "./runtime/residentWorker.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

/**
 * Fake worker that records every prompt it receives, so a test can prove
 * that two resident spawns with the same name hit the SAME worker (the
 * continuity-routing guarantee). `failWith` makes send() reject.
 */
function makeFakeWorker(opts: {
  name: string;
  ownerThread: string;
  failWith?: string;
}): ResidentWorker & { prompts: string[] } {
  const prompts: string[] = [];
  let killed = false;
  const fake = {
    name: opts.name,
    ownerThread: opts.ownerThread,
    workdir: "/tmp",
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastError: null,
    prompts,
    get status() {
      return killed ? "dead" : "idle";
    },
    send: async (p: string) => {
      if (opts.failWith) throw new Error(opts.failWith);
      prompts.push(p);
      return `reply#${prompts.length}:${p}`;
    },
    kill: () => {
      killed = true;
    },
  };
  return fake as unknown as ResidentWorker & { prompts: string[] };
}

function ctxFor(threadKey: string | undefined): SpawnCtx {
  return {
    workdir: "/tmp",
    depth: 0,
    threadKey,
    buildSlackMcp: () => ({ instance: {}, name: "slack", type: "sdk" as const }) as never,
    buildCanUseTool: () => async () => ({ behavior: "allow" as const, updatedInput: {} }),
  };
}

async function main() {
  // --- (1) Happy path: creates worker, sends prompt, returns reply ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const res = await handleResidentSpawn(ctxFor("C:T"), { prompt: "hello", name: "bob" }, reg);
    assert(res.isError !== true, `expected success: ${JSON.stringify(res)}`);
    assert(res.content[0].text.includes("hello"), `reply echoes prompt: ${res.content[0].text}`);
    assert(reg.has("C:T", "bob"), "worker registered");
  }

  // --- (2) Continuity: two spawns with same name hit the SAME worker ---
  // This is the core feature guarantee — the second invocation routes to
  // the already-warm worker, not a fresh one.
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const ctx = ctxFor("C:T");
    await handleResidentSpawn(ctx, { prompt: "first", name: "researcher" }, reg);
    await handleResidentSpawn(ctx, { prompt: "second", name: "researcher" }, reg);
    const worker = reg.get("C:T", "researcher") as ResidentWorker & { prompts: string[] };
    assert(worker.prompts.length === 2, `same worker got both prompts, got ${worker.prompts.length}`);
    assert(worker.prompts[0] === "first" && worker.prompts[1] === "second", "prompts in order on one worker");
  }

  // --- (3) Different names → different workers ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const ctx = ctxFor("C:T");
    await handleResidentSpawn(ctx, { prompt: "a", name: "alpha" }, reg);
    await handleResidentSpawn(ctx, { prompt: "b", name: "beta" }, reg);
    assert(reg.list("C:T").length === 2, "two distinct workers");
  }

  // --- (4) Missing / empty name → error, no worker created ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const r1 = await handleResidentSpawn(ctxFor("C:T"), { prompt: "x" }, reg);
    assert(r1.isError === true, "missing name errors");
    assert(r1.content[0].text.includes("name"), "error mentions name");
    const r2 = await handleResidentSpawn(ctxFor("C:T"), { prompt: "x", name: "   " }, reg);
    assert(r2.isError === true, "blank name errors");
    assert(reg.size() === 0, "no worker created on bad name");
  }

  // --- (5) Missing threadKey → error ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const res = await handleResidentSpawn(ctxFor(undefined), { prompt: "x", name: "n" }, reg);
    assert(res.isError === true, "missing threadKey errors");
    assert(res.content[0].text.includes("top spawn level"), `msg: ${res.content[0].text}`);
    assert(reg.size() === 0, "no worker created");
  }

  // --- (6) Worker.send throws → error result with message, isError true ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker({ ...o, failWith: "boom" }));
    const res = await handleResidentSpawn(ctxFor("C:T"), { prompt: "x", name: "explodes" }, reg);
    assert(res.isError === true, "send failure → isError");
    assert(res.content[0].text.includes("boom"), `propagates error message: ${res.content[0].text}`);
    assert(res.content[0].text.includes("explodes"), "names the worker");
  }

  // --- (7) formatWorkerList: empty vs populated ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const empty = formatWorkerList(reg, "C:T");
    assert(empty.content[0].text === "No resident workers in this thread.", `empty: ${empty.content[0].text}`);

    await handleResidentSpawn(ctxFor("C:T"), { prompt: "x", name: "watcher" }, reg);
    const populated = formatWorkerList(reg, "C:T");
    assert(populated.content[0].text.includes("watcher"), "lists worker name");
    assert(populated.content[0].text.includes("idle"), "shows status");
  }

  // --- (8) formatWorkerList scopes to the thread ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    await handleResidentSpawn(ctxFor("C:T1"), { prompt: "x", name: "mine" }, reg);
    await handleResidentSpawn(ctxFor("C:T2"), { prompt: "y", name: "theirs" }, reg);
    const t1 = formatWorkerList(reg, "C:T1");
    assert(t1.content[0].text.includes("mine"), "T1 sees its worker");
    assert(!t1.content[0].text.includes("theirs"), "T1 does NOT see T2's worker");
  }

  // --- (9) killResidentWorker: existing → success, missing → error ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    await handleResidentSpawn(ctxFor("C:T"), { prompt: "x", name: "victim" }, reg);
    const ok = killResidentWorker(reg, "C:T", "victim");
    assert(ok.isError !== true, "kill existing → success");
    assert(ok.content[0].text.includes("Killed"), `msg: ${ok.content[0].text}`);
    assert(!reg.has("C:T", "victim"), "worker gone after kill");

    const miss = killResidentWorker(reg, "C:T", "ghost");
    assert(miss.isError === true, "kill missing → error");
    assert(miss.content[0].text.includes("No live resident worker"), `msg: ${miss.content[0].text}`);
  }

  // --- (10) After kill, same name spawns a fresh worker ---
  {
    const reg = new ResidentWorkerRegistry((o) => makeFakeWorker(o));
    const ctx = ctxFor("C:T");
    await handleResidentSpawn(ctx, { prompt: "first life", name: "phoenix" }, reg);
    const before = reg.get("C:T", "phoenix");
    killResidentWorker(reg, "C:T", "phoenix");
    await handleResidentSpawn(ctx, { prompt: "second life", name: "phoenix" }, reg);
    const after = reg.get("C:T", "phoenix");
    assert(after !== before, "fresh worker after kill+respawn");
    const w = after as ResidentWorker & { prompts: string[] };
    assert(w.prompts.length === 1 && w.prompts[0] === "second life", "fresh worker has only the new prompt");
  }

  console.log(
    "✅ resident MCP tool layer verified — handleResidentSpawn (create/route/validate/error), " +
      "formatWorkerList (empty/populated/scoped), killResidentWorker (hit/miss), kill+respawn",
  );
}

main().catch((err) => {
  console.error("❌ resident MCP tool layer verification failed:", err);
  process.exit(1);
});
