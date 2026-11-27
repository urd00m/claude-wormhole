import assert from "node:assert/strict";
import { ContainerRuntime } from "./runtime.js";
import { RESTRICTED_USERS, RESTRICTED_CHANNEL, containerName } from "./policy.js";
const user = RESTRICTED_USERS[0];
const binding = { key: "owned-conversation", runtime: "codex" as const, workdir: "/user/work", providerHome: "/user/codex", sessionId: null, started: false, state: "ready" as const,
  execution: { kind: "docker" as const, user, container: containerName(user), channel: RESTRICTED_CHANNEL, thread: "1.2" } };
const saved: any[] = [];
const runtime = new ContainerRuntime(binding, { saveIdentity: (key: string, value: unknown) => saved.push({ key, value }) } as any);
const peer = runtime as any;
await peer.receive({ type: "identity", identity: { sessionId: "12345678-1234-1234-1234-123456789abc", started: true, workdir: "/user/work", providerHome: "/user/codex", key: "other-conversation", execution: { kind: "host" } } });
assert.equal(saved[0].key, "owned-conversation");
assert.equal(saved[0].value.execution, undefined);
assert.equal(binding.key, "owned-conversation");
assert.equal(binding.execution.kind, "docker");
const wakes: any[] = [];
runtime.onWake = (prompt, author) => wakes.push({ prompt, author });
peer.activeAuthorAt = 1000;
await peer.receive({ type: "task", event: { kind: "started", taskId: "old-task" }, userMessageAt: 999999 });
peer.activeAuthorAt = 2000; // A later human message cannot authorize the old task's continuation.
await peer.receive({ type: "wake", taskId: "old-task", prompt: "old completion", userMessageAt: 999999 });
await peer.receive({ type: "wake", taskId: "unknown-task", prompt: "unknown completion", userMessageAt: 999999 });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(wakes, [{ prompt: "old completion", author: 1000 }], "unknown or duplicate worker wakes must not enqueue arbitrary gateway work");
console.log("✅ Restricted worker protocol: immutable host ownership, original human authorization for background work, no synthetic authorization from worker timestamps");
