import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContinuityStore, type Binding } from "./continuityStore.js";
import { SessionManager } from "./manager.js";
import { parseProviderError, isSafetyStop } from "./providerError.js";
import { verifyIndexedThreads } from "./startupContinuity.js";
import { validateNativeSession } from "./nativeSession.js";
import { DatabaseSync } from "node:sqlite";
import { CodexRuntime } from "./runtime/codex.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-continuity-"));
const fixture = fileURLToPath(new URL("./continuityRestart.fixture.ts", import.meta.url));
function child(file: string, mode: string, runtime = "codex", expected = 0) {
  const r = spawnSync(process.execPath, ["--import", "tsx", fixture, file, mode, runtime], { encoding: "utf8", env: process.env });
  assert.equal(r.status, expected, r.stdout + r.stderr);
}
function binding(key: string, runtime: Binding["runtime"] = "codex"): Binding {
  return { key, runtime, workdir: tmp, providerHome: tmp, sessionId: key + "-native", started: true, state: "ready" };
}
try {
  for (const runtime of ["codex", "claude"]) {
    const file = path.join(tmp, runtime, "state.sqlite");
    child(file, "initial", runtime); child(file, "resume", runtime);
  }
  const stopped = path.join(tmp, "stopped/state.sqlite");
  child(stopped, "block"); child(stopped, "assert-stopped");
  const s = new ContinuityStore(stopped);
  assert.equal(s.get("C123:1.1")?.failure?.details?.review_target, "opaque-target"); s.close();
  const crashed = path.join(tmp, "crashed/state.sqlite");
  child(crashed, "crash", "codex", 23); child(crashed, "assert-uncertain");

  const store = new ContinuityStore(path.join(tmp, "registry.sqlite"));
  store.acquireOwner();
  const competing = new ContinuityStore(store.file);
  assert.throws(() => competing.acquireOwner(), /Another Wormhole/); competing.close();
  assert.throws(() => store.transaction(() => { store.put(binding("C123:rollback")); throw new Error("abort"); }), /abort/);
  assert.equal(store.get("C123:rollback"), undefined, "a failed transaction must not leave a partial binding");

  store.put(binding("C123:rotated"));
  store.beginTurn("C123:rotated");
  store.saveIdentity("C123:rotated", { sessionId: null, started: false, workdir: tmp, providerHome: tmp });
  store.finishTurn("C123:rotated");
  assert.equal(store.assertRunnable("C123:rotated").started, false, "an intentional mid-turn workdir reset remains usable");
  store.beginTurn("C123:rotated");
  store.end("C123:rotated", true);
  store.finishTurn("C123:rotated");
  assert.equal(store.get("C123:rotated")?.state, "closed");
  assert.equal(store.get("C123:rotated")?.inFlight, false, "a retired worker must finish settling before its name is reused");

  let providerCalls = 0;
  store.put(binding("C123:blocked"));
  const blockedManager = new SessionManager(store, () => {}, (key, workdir, registry, b) => new CodexRuntime({ threadKey: key, workdir,
    continuity: { sessionId: b.sessionId, started: b.started, providerHome: b.providerHome, onIdentity: (identity) => { registry.update(key, identity); } },
    processFactory: () => {
      providerCalls++;
      return { lines: () => (async function* () {
        yield JSON.stringify({ type: "thread.started", thread_id: b.sessionId });
        yield JSON.stringify({ type: "turn.failed", error: { code: "misalignment_policy_violation", message: "blocked" } });
      })(), wait: async () => 0, stderr: async () => "", kill: () => {} };
    },
  }));
  const stoppedEntry = (await blockedManager.get("C123:blocked")).entry;
  const outcomes = await Promise.allSettled([
    stoppedEntry.enqueue(() => stoppedEntry.session.send({ text: "first" }).then(() => {})),
    stoppedEntry.enqueue(() => stoppedEntry.session.send({ text: "already queued" }).then(() => {})),
  ]);
  assert(outcomes.every((x) => x.status === "rejected"));
  await assert.rejects(() => stoppedEntry.session.send({ text: "background wake" }));
  assert.equal(providerCalls, 1, "queued turns and wakes must not call a stopped provider, including exit-zero failures");
  assert.equal(store.get("C123:blocked")?.state, "stopped");
  store.put(binding("C123:2.1")); store.put(binding("C123:3.1"));
  const manager = new SessionManager(store, () => {});
  const a = (await manager.get("C123:2.1")).entry;
  const b = (await manager.get("C123:3.1")).entry;
  assert.notEqual(a.session.runtime.conversationId, b.session.runtime.conversationId, "shared cwd must not merge threads");
  manager.close("C123:2.1");
  assert.equal((await manager.get("C123:2.1")).entry.session.runtime.conversationId, a.session.runtime.conversationId, "unloading must preserve identity");
  assert(store.acceptDelivery("event-1", "C123:2.1", { text: "queued" }));
  assert(!store.acceptDelivery("event-1", "C123:2.1", { text: "duplicate" }));
  assert(store.claimDelivery("event-1")); assert(!store.claimDelivery("event-1"));
  store.finishDelivery("event-1"); assert.equal(store.deliveries("completed").length, 1);
  assert(store.acceptDelivery("event-2", "C123:2.1", { text: "pending" }));
  await manager.drain();
  assert.equal(store.deliveries("queued").length, 1);
  await assert.rejects(() => manager.get("C123:4.1"), /draining/);

  const nativeDir = path.join(tmp, "native"); fs.mkdirSync(nativeDir);
  const native = new DatabaseSync(path.join(nativeDir, "state_5.sqlite"));
  native.exec("CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT)");
  const rollout = path.join(nativeDir, "history.jsonl"); fs.writeFileSync(rollout, "{}");
  native.prepare("INSERT INTO threads VALUES (?,?,?)").run("known", tmp, rollout); native.close();
  validateNativeSession({ ...binding("native"), sessionId: "known", providerHome: nativeDir });
  assert.throws(() => validateNativeSession({ ...binding("native"), sessionId: "missing", providerHome: nativeDir }), /could not be verified/);
  fs.mkdirSync(path.join(tmp, "data"));
  fs.writeFileSync(path.join(tmp, "data/active-sessions.json"), JSON.stringify([{ channel: "C123", threadTs: "2.1" }, { channel: "C123", threadTs: "9.1" }]));
  await assert.rejects(() => verifyIndexedThreads(tmp, store), /Missing verified bindings/);
  store.put(binding("C123:9.1")); await verifyIndexedThreads(tmp, store);
  store.close();

  const error = parseProviderError({ type: "turn.failed", error: { message: "plain", codex_error_info: "misalignment_policy_violation", misalignment: { detailed_explanation: "public" } } });
  assert(error && isSafetyStop(error)); assert.equal(error.details?.detailed_explanation, "public");
  assert(isSafetyStop(parseProviderError({ type: "error", message: JSON.stringify({ error: { message: "blocked", code: "misalignment_policy_violation" } }) })!));
  assert(!isSafetyStop(parseProviderError({ type: "error", message: "temporary network failure" })!));
  console.log("✅ continuity verified — real process restarts, both providers, crash recovery, stopped state, migration gate, durable inbox and shared-cwd isolation");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
