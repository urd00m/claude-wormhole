import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ContinuityStore } from "./continuityStore.js";
import { ResidentWorkerRegistry } from "./residentWorkerRegistry.js";
import { ResidentWorker, type ResidentWorkerOpts } from "./runtime/residentWorker.js";
import { CredentialPool } from "../credentialPool.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-workers-"));
const captured: Record<string, unknown>[] = [];
const make = (opts: ResidentWorkerOpts) => new ResidentWorker({ ...opts, queryFn: (p) => {
  captured.push(p.options!);
  const id = p.options!.resume ?? p.options!.sessionId;
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: id } as never;
    for (;;) yield { type: "result", subtype: "success", result: "worker context" } as never;
  })();
} });
try {
  const file = path.join(tmp, "registry.sqlite");
  const firstStore = new ContinuityStore(file);
  const first = new ResidentWorkerRegistry(make, firstStore, () => {});
  const opts = { ownerThread: "C123:1.1", name: "researcher", workdir: tmp };
  const worker = first.getOrCreate(opts);
  assert.equal(await worker.send("remember"), "worker context");
  const id = captured[0].sessionId;
  await first.drain(); firstStore.close();
  const secondStore = new ContinuityStore(file);
  const second = new ResidentWorkerRegistry(make, secondStore, () => {});
  assert.equal(second.list(opts.ownerThread)[0].name, opts.name, "unloaded workers remain discoverable after restart");
  assert.equal(await second.getOrCreate(opts).send("continue"), "worker context");
  assert.equal(captured[1].resume, id, "worker resumes its original native ID");
  await second.drain(); secondStore.close();
  fs.unlinkSync(file);
  assert.throws(() => new ContinuityStore(file), /missing/);

  const pool = new CredentialPool([path.join(tmp, "account-a"), path.join(tmp, "account-b")]);
  const slot = pool.acquire(path.join(tmp, "account-a"));
  pool.reportRateLimit(slot, Date.now() + 60_000);
  assert.throws(() => pool.acquire(slot.dir), /unavailable/, "existing conversation must not switch account when rate-limited");
  assert.equal(pool.acquire().dir, path.join(tmp, "account-b")); pool.cleanup();
  console.log("✅ worker continuity verified — native ID restoration, lazy discovery, account pinning and missing-registry protection");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
