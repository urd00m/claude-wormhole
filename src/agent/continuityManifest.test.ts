import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { inventoryThreads, validateManifest, importManifest, type MigrationManifest } from "./continuityManifest.js";
import { ContinuityStore, type Binding } from "./continuityStore.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-manifest-"));
try {
  fs.mkdirSync(path.join(root, "data")); fs.mkdirSync(path.join(root, "native"));
  fs.writeFileSync(path.join(root, "data/active-sessions.json"), JSON.stringify([{ channel: "C123", threadTs: "1.1" }]));
  fs.writeFileSync(path.join(root, "data/aliases.json"), JSON.stringify({ sol: { runtime: "codex" } }));
  fs.writeFileSync(path.join(root, "data/thread-aliases.json"), JSON.stringify({ "C123:1.1": "sol" }));
  const cwd = path.join(root, "sessions/C123_1_1"); fs.mkdirSync(cwd, { recursive: true });
  const rollout = path.join(root, "native/rollout.jsonl");
  fs.writeFileSync(rollout, JSON.stringify({ payload: { type: "task_complete", error: { message: "blocked", codex_error_info: "misalignment_policy_violation" } } }) + "\n");
  const home = path.join(root, "native");
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT,cwd TEXT,rollout_path TEXT,source TEXT,updated_at INTEGER)");
  db.prepare("INSERT INTO threads VALUES (?,?,?,'exec',?)").run("native-id", cwd, rollout, 100); db.close();
  const inventory = inventoryThreads(root, home, root);
  assert.equal(inventory.threads[0].candidates.length, 1);
  const b: Binding = { key: "C123:1.1", runtime: "codex", workdir: cwd, providerHome: home, sessionId: "native-id", started: true, state: "ready" };
  const manifest: MigrationManifest = { ...inventory, verified: true, bindings: [b] };
  assert.equal(validateManifest(manifest, inventory)[0].state, "stopped", "migration must preserve a native safety stop");
  assert.throws(() => validateManifest({ ...manifest, bindings: [] }, inventory), /Missing mapping/);
  assert.throws(() => validateManifest({ ...manifest, bindings: [b, b] }, inventory), /Duplicate/);
  assert.throws(() => validateManifest({ ...manifest, verified: false } as unknown as MigrationManifest, inventory), /unverified/);
  assert.throws(() => validateManifest(manifest, { ...inventory, indexSha256: "changed" }), /changed/);
  const file = path.join(root, "state/sessions.sqlite"); importManifest(manifest, inventory, file);
  const store = new ContinuityStore(file); assert.equal(store.get(b.key)?.sessionId, b.sessionId); assert.equal(store.get(b.key)?.state, "stopped"); store.close();
  console.log("✅ migration verified — exact mappings, completeness, duplicate/stale rejection and preservation of native stops");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
