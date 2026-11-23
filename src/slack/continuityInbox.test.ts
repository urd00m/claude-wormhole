import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerHandlers } from "./handlers.js";
import { sessions } from "../agent/manager.js";
import { getContinuityStore } from "../agent/continuityStore.js";

const mode = process.argv[2];
if (mode) {
  let posts = 0;
  const events: Record<string, (args: unknown) => Promise<void>> = {};
  const client = { chat: { postMessage: async () => { posts++; return { ts: "9.1" }; } }, reactions: { remove: async () => ({ ok: true }) } };
  const app = { event: (name: string, fn: (args: unknown) => Promise<void>) => { events[name] = fn; } };
  const handlers = registerHandlers(app as never);
  const store = getContinuityStore();
  store.acquireOwner();
  if (mode === "queue" || mode === "queue-closed") {
    if (mode === "queue-closed") store.put({ key: "C123:1.1", runtime: "codex", workdir: process.cwd(), providerHome: process.env.CODEX_HOME!, sessionId: "ended", started: true, state: "closed" });
    sessions.startDrain();
    await events.app_mention({ event: { channel: "C123", thread_ts: "1.1", ts: "2.1", user: "U1", text: "end session" }, client });
    assert.equal(posts, 0); assert.equal(store.deliveries("queued").length, 1);
  } else if (mode === "crash") {
    store.acceptDelivery("C123:3.1", "C123:1.1", { channel: "C123", thread_ts: "1.1", ts: "3.1", user: "U1", text: "end session" });
    store.claimDelivery("C123:3.1"); process.exit(23);
  } else {
    await handlers.replayPending(client as never);
    assert.equal(posts, mode === "replay" ? 1 : 0);
    assert.equal(store.deliveries("queued").length, 0);
    if (mode === "uncertain") assert.equal(store.deliveries("uncertain").length, 1);
  }
  store.close();
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-inbox-"));
  const self = fileURLToPath(import.meta.url);
  const run = (state: string, phase: string, expected = 0) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", self, phase], { env: { ...process.env, WORMHOLE_STATE_DIR: path.join(tmp, state), SLACK_ALLOWED_USER_IDS: "U1" }, encoding: "utf8" });
    assert.equal(result.status, expected, result.stdout + result.stderr);
  };
  try {
    run("normal", "queue"); run("normal", "replay"); run("normal", "dedupe");
    run("closed", "queue-closed"); run("closed", "replay");
    run("crashed", "crash", 23); run("crashed", "uncertain");
    console.log("✅ Slack inbox verified — maintenance queues, process-restart replay, durable dedupe and no automatic replay of uncertain actions");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
