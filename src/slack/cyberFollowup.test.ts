// Exercise the real Slack dispatch path. All provider processes and Slack calls
// are fake; no live conversation, credentials or provider endpoints are used.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHandlers } from "./handlers.js";
import { sessions, SessionManager } from "../agent/manager.js";
import { getContinuityStore } from "../agent/continuityStore.js";
import { CodexRuntime } from "../agent/runtime/codex.js";
import type { TaskEvent } from "../agent/runtime/types.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-slack-cyber-"));
const store = getContinuityStore();
const key = "C123:1.1";
const sid = "11111111-1111-4111-8111-111111111111";
store.put({ key, runtime: "codex", workdir: tmp, providerHome: tmp, sessionId: sid, started: true, state: "ready" });
const requests: string[] = [];
const edits: string[] = [];
const callbacks = new Map<string, (args: any) => Promise<void>>();
let posts = 0;
let reject = true;
let notify: ((event: TaskEvent) => void) | undefined;
const client = {
  chat: {
    postMessage: async () => ({ ts: `post${++posts}` }),
    update: async (args: { text: string }) => { edits.push(args.text); return { ok: true }; },
  },
  reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
};
const manager = new SessionManager(store, () => {}, (threadKey, workdir, registry, b) => {
  const runtime = new CodexRuntime({
  threadKey, workdir,
  continuity: { sessionId: b.sessionId, started: b.started, providerHome: b.providerHome,
    onIdentity: (identity) => { registry.saveIdentity(threadKey, identity); } },
  lastMessageFileFactory: () => path.join(tmp, "last.txt"),
  processFactory: (opts) => {
    assert(opts.args.includes("resume") && opts.args.includes(sid));
    requests.push(opts.args.at(-1)!);
    if (!reject) fs.writeFileSync(path.join(tmp, "last.txt"), "Revised request accepted");
    return { lines: () => (async function* () {
      yield JSON.stringify({ type: "thread.started", thread_id: sid });
      yield JSON.stringify(reject
        ? { type: "turn.failed", error: { code: "cyber_policy", message: "Request rejected; review and revise it." } }
        : { type: "turn.completed" });
    })(), wait: async () => 0, stderr: async () => "", kill: () => {} };
  },
});
  const send = runtime.send.bind(runtime);
  runtime.send = (input, hooks = {}) => { notify = hooks.onTaskEvent; return send(input, hooks); };
  return runtime;
});
const originalGet = sessions.get;
sessions.get = (threadKey) => manager.get(threadKey);

async function send(text: string, at: number) {
  const ts = String(at / 1000);
  await callbacks.get("app_mention")!({ client, event: { channel: "C123", thread_ts: "1.1", ts, user: "U1", text } });
  return `C123:${ts}`;
}

try {
  registerHandlers({ event: (name: string, callback: (args: any) => Promise<void>) => callbacks.set(name, callback) } as never);
  const oldAt = Date.now() - 100;
  const firstId = await send("Initial request", oldAt);
  assert.equal(requests.length, 1);
  assert(edits.at(-1)?.includes("send a revised request as a new message"));
  assert(!edits.at(-1)?.includes("conversation is stopped"));
  assert(store.deliveries("failed").some((delivery) => delivery.id === firstId), "provider rejections must not be recorded as successful deliveries");
  const rejectedAt = store.get(key)!.cyberRejection!.occurredAt!;
  const oldWake = notify!;
  oldWake({ kind: "notification", taskId: "rejected-turn-before", status: "completed", summary: "old task" });
  assert.equal(requests.length, 1, "a completion from the rejected turn cannot auto-wake the provider");
  await send("Message written before the rejection", oldAt + 1);
  assert.equal(requests.length, 1);
  reject = false;
  const revisedId = await send("A reviewed revised request", rejectedAt + 1000);
  assert.deepEqual(requests, ["Initial request", "A reviewed revised request"]);
  assert(edits.at(-1)?.includes("Revised request accepted"));
  assert(store.deliveries("completed").some((delivery) => delivery.id === revisedId));
  oldWake({ kind: "notification", taskId: "rejected-turn-after", status: "completed", summary: "late old task" });
  assert.equal(requests.length, 2, "a successful follow-up must not authorize a stale completion wake");
  await send("Duplicate Slack delivery", rejectedAt + 1000);
  await send("Late stale message", oldAt + 2);
  assert.equal(requests.length, 2, "duplicates and stale work must not reach the provider after recovery");
  store.update(key, { state: "stopped", failure: { code: "misalignment_policy_violation", message: "Terminal monitoring stop", sessionId: sid } });
  await send("New message after terminal stop", rejectedAt + 2000);
  assert.equal(requests.length, 2);
  assert(edits.at(-1)?.includes("stopped by safety monitoring"));
  assert(edits.at(-1)?.includes("Terminal monitoring stop"));
  assert.equal(store.get(key)?.sessionId, sid);
  console.log("✅ Slack cyber follow-up verified — revised input in same conversation, no replay, stale-message guard, honest delivery outcomes and terminal stops");
} finally {
  sessions.get = originalGet;
  store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
