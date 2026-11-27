import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ContinuityStore, type Binding } from "./continuityStore.js";
import { SessionManager } from "./manager.js";
import { parseProviderError, isSafetyStop, ProviderError } from "./providerError.js";
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
  const cyberStopped = path.join(tmp, "cyber-stopped/state.sqlite");
  child(cyberStopped, "block-cyber"); child(cyberStopped, "assert-stopped-cyber");
  child(cyberStopped, "cyber-followup"); child(cyberStopped, "assert-stopped-cyber");
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

  for (const code of ["misalignment_policy_violation", "cyber_policy", "legacy-cyber"]) {
    let providerCalls = 0;
    let acceptRevisedRequest = false;
    const blockedKey = `C123:blocked-${code}`;
    const diagnostic = code === "legacy-cyber"
      ? "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request."
      : "blocked";
    const expectedCode = code === "legacy-cyber" ? "cyber_policy" : code;
    store.put(binding(blockedKey));
    const blockedManager = new SessionManager(store, () => {}, (key, workdir, registry, b) => new CodexRuntime({ threadKey: key, workdir,
      continuity: { sessionId: b.sessionId, started: b.started, providerHome: b.providerHome, onIdentity: (identity) => { registry.update(key, identity); } },
      lastMessageFileFactory: () => path.join(tmp, code + "-last.txt"),
      processFactory: (opts) => {
        providerCalls++;
        if (acceptRevisedRequest) {
          assert(opts.args.includes("resume") && opts.args.includes(blockedKey + "-native"));
          assert(!opts.args.includes("first"), "a follow-up must not replay the rejected input");
          fs.writeFileSync(path.join(tmp, code + "-last.txt"), "Revised request accepted");
        }
        return { lines: () => (async function* () {
          yield JSON.stringify({ type: "thread.started", thread_id: b.sessionId });
          if (acceptRevisedRequest) {
            yield JSON.stringify({ type: "turn.completed" });
            return;
          }
          // A preceding generic error must not hide the later policy failure.
          yield JSON.stringify({ type: "error", message: "generic failure" });
          yield JSON.stringify(code === "legacy-cyber"
            ? { type: "error", message: diagnostic }
            : { type: "turn.failed", error: { code, message: diagnostic } });
          if (code === "misalignment_policy_violation") {
            yield JSON.stringify({ type: "error", code: "cyber_policy", message: "later cyber error must not hide the terminal stop" });
          }
        })(), wait: async () => 0, stderr: async () => "", kill: () => {} };
      },
    }));
    const stoppedEntry = (await blockedManager.get(blockedKey)).entry;
    const queuedAt = Date.now() - 1;
    const outcomes = await Promise.allSettled([
      stoppedEntry.enqueue(() => stoppedEntry.session.send({ text: "first", userMessageAt: queuedAt }).then(() => {})),
      stoppedEntry.enqueue(() => stoppedEntry.session.send({ text: "already queued", userMessageAt: queuedAt }).then(() => {})),
    ]);
    assert(outcomes.every((x) => x.status === "rejected"));
    for (const outcome of outcomes) {
      if (outcome.status !== "rejected") continue;
      assert(outcome.reason instanceof ProviderError);
      assert.equal(outcome.reason.failure.code, expectedCode);
      assert.equal(outcome.reason.failure.sessionId, blockedKey + "-native");
    }
    await assert.rejects(() => stoppedEntry.session.send({ text: "background wake" }));
    await assert.rejects(() => stoppedEntry.session.runtime.send({ text: "direct runtime call" }), (error: unknown) => {
      assert(error instanceof ProviderError);
      assert.equal(error.failure.code, expectedCode);
      assert.equal(error.failure.sessionId, blockedKey + "-native");
      return true;
    });
    assert.equal(providerCalls, 1, "queued turns and wakes must not call a stopped provider, including exit-zero failures");
    assert.equal(store.get(blockedKey)?.state, expectedCode === "cyber_policy" ? "ready" : "stopped");
    assert.equal(store.get(blockedKey)?.failure?.code, expectedCode);
    assert.equal(store.get(blockedKey)?.failure?.message, diagnostic);
    assert.equal(store.get(blockedKey)?.sessionId, blockedKey + "-native");
    blockedManager.close(blockedKey);
    const reloaded = (await blockedManager.get(blockedKey)).entry;
    await assert.rejects(() => reloaded.session.send({ text: "hello" }), (error: unknown) => {
      assert(error instanceof ProviderError);
      assert.equal(error.failure.code, expectedCode);
      assert.equal(error.failure.sessionId, blockedKey + "-native");
      return true;
    });
    assert.equal(providerCalls, 1, "reloading a stopped conversation must not call the provider");
    if (expectedCode === "cyber_policy") {
      const rejection = store.get(blockedKey)!.cyberRejection!;
      acceptRevisedRequest = true;
      const revisedAt = rejection.occurredAt! + 1;
      const reply = await reloaded.session.send({ text: "A revised request", userMessageAt: revisedAt });
      assert.equal(reply.finalText, "Revised request accepted");
      assert.equal(providerCalls, 2, "a deliberate new message gets exactly one provider call");
      assert.equal(store.get(blockedKey)?.failure, undefined);
      await assert.rejects(() => reloaded.session.send({ text: "old queued input", userMessageAt: queuedAt }));
      await assert.rejects(() => reloaded.session.send({ text: "late wake from rejected turn", userMessageAt: queuedAt }));
      assert.equal(providerCalls, 2, "successful follow-up must not release stale queued work");
      await reloaded.session.send({ text: "wake belonging to the revised request", userMessageAt: revisedAt });
      assert.equal(providerCalls, 3, "background work authorized by the new request can proceed");
      acceptRevisedRequest = false;
      await assert.rejects(() => reloaded.session.send({ text: "another new request", userMessageAt: Date.now() + 1000 }));
      assert.equal(providerCalls, 4, "a second rejection must not start an automatic retry");
      await assert.rejects(() => reloaded.session.send({ text: "automatic continuation" }));
      assert.equal(providerCalls, 4);
      assert.equal(store.get(blockedKey)?.state, "ready", "another cyber rejection still does not terminate the conversation");
      assert.equal(store.get(blockedKey)?.sessionId, blockedKey + "-native");
    } else {
      await assert.rejects(() => reloaded.session.send({ text: "new input", userMessageAt: Date.now() + 1000 }));
      assert.equal(providerCalls, 1, "a new user message cannot clear a terminal safety stop");
    }
  }
  store.put(binding("C123:transient"));
  store.beginTurn("C123:transient");
  store.finishTurn("C123:transient", { code: "server_error", message: "temporary service failure" });
  assert.equal(store.assertRunnable("C123:transient").sessionId, "C123:transient-native");
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
