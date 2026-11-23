// Separate-process restart/crash fixture. Every provider is fake; no API calls.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { ContinuityStore, defaultProviderHome } from "./continuityStore.js";
import { CodexRuntime } from "./runtime/codex.js";
import { ClaudeRuntime } from "./runtime/claude.js";
import { Session } from "./session.js";

const [file, mode, runtimeName] = process.argv.slice(2);
const store = new ContinuityStore(file);
store.acquireOwner();
const key = "C123:1.1";
let binding = store.get(key);
if (!binding) {
  binding = { key, runtime: runtimeName as "claude" | "codex", workdir: path.dirname(file), providerHome: defaultProviderHome(runtimeName as "claude" | "codex"), sessionId: null, started: false, state: "ready" };
  store.put(binding);
}
const continuity = { sessionId: binding.sessionId, started: binding.started, providerHome: binding.providerHome,
  onIdentity: (identity: { sessionId: string | null; started: boolean; workdir: string; providerHome: string }) => { store.update(key, identity); } };
let calls = 0;
const retained = path.join(path.dirname(file), "fake-provider-history.json");
const sid = "11111111-1111-4111-8111-111111111111";
const runtime = runtimeName === "claude" ? new ClaudeRuntime({ threadKey: key, workdir: binding.workdir, continuity, queryFn: (params) => {
  calls++;
  const id = String(params.options?.resume ?? params.options?.sessionId);
  if (mode === "resume") { assert.equal(params.options?.resume, binding!.sessionId); assert.equal(JSON.parse(fs.readFileSync(retained, "utf8")).id, id); }
  return (async function* () {
    yield { type: "system", subtype: "init", session_id: id } as never;
    fs.writeFileSync(retained, JSON.stringify({ id, priorWork: "preserved" }));
    yield { type: "result", subtype: "success", result: "ok" } as never;
  })();
} }) : new CodexRuntime({ threadKey: key, workdir: binding.workdir, continuity, processFactory: (opts) => {
  calls++;
  if (mode === "resume") { assert(opts.args.includes("resume")); assert(opts.args.includes(sid)); assert.equal(JSON.parse(fs.readFileSync(retained, "utf8")).priorWork, "preserved"); }
  return { lines: () => (async function* () {
    yield JSON.stringify({ type: "thread.started", thread_id: sid });
    if (mode === "crash") process.exit(23);
    if (mode === "block") {
      yield JSON.stringify({ type: "turn.failed", error: { message: "stopped", code: "misalignment_policy_violation", misalignment: { detailed_explanation: "Review previous actions", review_target: "opaque-target" } } });
    } else fs.writeFileSync(retained, JSON.stringify({ id: sid, priorWork: "preserved" }));
  })(), wait: async () => mode === "block" ? 1 : 0, stderr: async () => "", kill: () => {} };
} });
const session = new Session({ threadKey: key, runtime });
session.attachContinuity(store, key);
if (mode === "assert-stopped" || mode === "assert-uncertain") {
  await assert.rejects(() => session.send({ text: "retry" }));
  assert.equal(calls, 0);
  assert.equal(store.get(key)?.state, mode === "assert-stopped" ? "stopped" : "recovery_required");
} else if (mode === "block") await assert.rejects(() => session.send({ text: "first turn" }));
else await session.send({ text: mode });
store.close();
console.log("fixture verified", mode, runtimeName);
