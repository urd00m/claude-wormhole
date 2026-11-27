/** Explicit, small paid/subscription smoke test. Slack is replaced with a recording callback. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESTRICTED_USERS, RESTRICTED_CHANNEL, restrictedKey, sessionDirectory, containerName } from "../restricted/policy.js";
if (process.env.WORMHOLE_MODEL_SMOKE !== "1") throw new Error("Set WORMHOLE_MODEL_SMOKE=1 explicitly to run model calls");
const state = await fs.mkdtemp(path.join(os.tmpdir(), "wormhole-restricted-models-"));
Object.assign(process.env, { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test", SLACK_SIGNING_SECRET: "test", WORMHOLE_STATE_DIR: state });
const { ContinuityStore } = await import("../agent/continuityStore.js");
const { ContainerRuntime } = await import("../restricted/runtime.js");
const { Session } = await import("../agent/session.js");
const store = new ContinuityStore(path.join(state, "tests.sqlite"));
try {
  const providers = (process.env.WORMHOLE_SMOKE_RUNTIMES ?? "codex,claude").split(",");
  assert(providers.length === 2 && providers.every(p => p === "codex" || p === "claude"));
  for (const [index, provider] of (providers as ("codex" | "claude")[]).entries()) {
    const user = RESTRICTED_USERS[index];
    const key = restrictedKey(user, RESTRICTED_CHANNEL, "2.234567");
    const binding = { key, runtime: provider, workdir: sessionDirectory(key), providerHome: `/user/${provider}`, sessionId: null, started: false, state: "ready" as const,
      execution: { kind: "docker" as const, user, container: containerName(user), channel: RESTRICTED_CHANNEL, thread: "2.234567" } };
    store.put(binding);
    let adapter = new ContainerRuntime(binding, store);
    const calls: string[] = [];
    adapter.onGateway = async (tool) => { calls.push(tool); return "Integration test callback recorded; no Slack message was sent."; };
    let session = new Session({ threadKey: key, runtime: adapter }); session.attachContinuity(store, key);
    try {
      await adapter.prepare();
      console.log(user, provider, "initialized; checking model and bridge");
      const result = await session.send({ text: "This is an integration check. Call get_workdir once, then call slack_post_message with the text worker-smoke-ok. The Slack gateway is mocked for this test. Do not call notify_alan or any other tools. Finish with worker-smoke-ok.", userMessageAt: Date.now() });
      assert(result.finalText.includes("worker-smoke-ok"), result.finalText);
      assert(calls.includes("slack_post_message"), "Model did not reach the scoped gateway bridge");
      const first = store.get(key)!;
      assert(first.started && first.sessionId, "Provider did not save a resumable native identity");
      await adapter.close();
      adapter = new ContainerRuntime(first, store);
      session = new Session({ threadKey: key, runtime: adapter }); session.attachContinuity(store, key);
      await adapter.prepare();
      console.log(user, provider, "native transcript validated inside container; resuming");
      const resumed = await session.send({ text: "Reply exactly resumed-ok. Do not use tools.", userMessageAt: Date.now() });
      assert(resumed.finalText.includes("resumed-ok"), resumed.finalText);
      assert.equal(store.get(key)!.sessionId, first.sessionId, "Resumed session identity changed");
      if (process.env.WORMHOLE_SMOKE_WORKER === "1" && index === 0) {
        const child = await session.send({ text: "Integration check: use the wormhole_spawn spawn tool to launch one Codex child. Tell it to run python3 -c 'import os; print(os.getuid())' and report the UID. Finish your response with child-sandbox-ok and the child UID. No other tools or Slack posts.", userMessageAt: Date.now() });
        assert(child.finalText.includes("child-sandbox-ok") && child.finalText.includes("1000"), child.finalText);
        console.log(user, provider, "recursive child worker inside container: OK");
      }
      console.log(user, provider, "real model, scoped bridge and exact-ID resume: OK");
    } finally { await adapter.close(); }
  }
  console.log("✅ Both container model runtimes and exact conversation resumes passed; no Slack messages sent");
} finally { store.close(); await fs.rm(state, { recursive: true, force: true }); }
