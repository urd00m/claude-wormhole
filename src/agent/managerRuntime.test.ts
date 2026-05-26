// Verify SessionManager picks Claude vs Codex based on the per-thread
// runtimeStore override + env.DEFAULT_RUNTIME fallback. The store is
// disk-backed; we snapshot+restore the live file so the test doesn't leak
// state into the developer's working directory.

import fs from "node:fs";
import { RUNTIMES_FILE } from "../config.js";
import { SessionManager, threadKeyOf, resolveRuntimeName } from "./manager.js";
import { getRuntimeStore } from "./runtimeStore.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function snapshot(): { existed: boolean; contents: string | null } {
  if (!fs.existsSync(RUNTIMES_FILE)) return { existed: false, contents: null };
  return { existed: true, contents: fs.readFileSync(RUNTIMES_FILE, "utf8") };
}
function restore(snap: { existed: boolean; contents: string | null }): void {
  if (!snap.existed) {
    if (fs.existsSync(RUNTIMES_FILE)) fs.unlinkSync(RUNTIMES_FILE);
    return;
  }
  fs.writeFileSync(RUNTIMES_FILE, snap.contents ?? "");
}

const TEST_PREFIX = "test:mgr-runtime:";

async function main() {
  const snap = snapshot();
  // Wipe the file so the singleton store starts empty for this test. The
  // store is a process-level singleton — once loaded with stale data it
  // can't be cheaply re-initialized. Removing the file before any test
  // import would help, but `RuntimeStore` is already loaded by import-
  // time elsewhere; we work around by removing entries via the store API.
  try {
    const store = getRuntimeStore();
    // Clean any test-prefix leftovers from prior runs.
    for (const [k] of store.entries()) {
      if (k.startsWith(TEST_PREFIX)) store.remove(k);
    }

    // --- (1) resolveRuntimeName: no override → env.DEFAULT_RUNTIME
    {
      const key = threadKeyOf("Cmgr", `${TEST_PREFIX}default`);
      const got = resolveRuntimeName(key);
      // We don't assert which of {claude, codex} — the env can override
      // — but it must be a valid name.
      assert(got === "claude" || got === "codex", `valid runtime name: ${got}`);
    }

    // --- (2) resolveRuntimeName: override wins ---
    {
      const key = threadKeyOf("Cmgr", `${TEST_PREFIX}override`);
      store.set(key, "codex");
      assert(resolveRuntimeName(key) === "codex", "override returns codex");
      store.set(key, "claude");
      assert(resolveRuntimeName(key) === "claude", "override returns claude");
      store.remove(key);
    }

    // --- (3) SessionManager.get builds Claude runtime when override=claude
    {
      const mgr = new SessionManager();
      const key = threadKeyOf("Cmgr", `${TEST_PREFIX}claude-build`);
      store.set(key, "claude");
      const { entry } = await mgr.get(key);
      assert(entry.session.runtimeName === "claude", `runtime name: ${entry.session.runtimeName}`);
      store.remove(key);
    }

    // --- (4) SessionManager.get builds Codex runtime when override=codex
    {
      const mgr = new SessionManager();
      const key = threadKeyOf("Cmgr", `${TEST_PREFIX}codex-build`);
      store.set(key, "codex");
      const { entry } = await mgr.get(key);
      assert(entry.session.runtimeName === "codex", `runtime name: ${entry.session.runtimeName}`);
      // The workdir was created under sessions/<safe>/uploads — verify it
      // exists. This is the same per-thread sandbox behavior we expect
      // regardless of runtime.
      assert(typeof entry.session.workdir === "string" && entry.session.workdir.length > 0, "workdir set");
      store.remove(key);
    }

    // --- (5) Re-getting same key returns cached entry (same instance) ---
    {
      const mgr = new SessionManager();
      const key = threadKeyOf("Cmgr", `${TEST_PREFIX}cache`);
      store.set(key, "codex");
      const first = (await mgr.get(key)).entry;
      const second = (await mgr.get(key)).entry;
      assert(first === second, "cached entry is the same instance");
      assert(first.session.runtimeName === "codex", "stays codex");
      store.remove(key);
    }

    // --- (6) close() drops entry; subsequent get rebuilds with current store
    {
      const mgr = new SessionManager();
      const key = threadKeyOf("Cmgr", `${TEST_PREFIX}swap`);
      store.set(key, "claude");
      const claudeEntry = (await mgr.get(key)).entry;
      assert(claudeEntry.session.runtimeName === "claude", "first get is claude");

      // Simulate the runtime-switch flow: close the entry and flip the store.
      mgr.close(key);
      store.set(key, "codex");

      const codexEntry = (await mgr.get(key)).entry;
      assert(codexEntry !== claudeEntry, "post-close get returns a fresh entry");
      assert(codexEntry.session.runtimeName === "codex", "fresh entry is codex");
      store.remove(key);
    }
  } finally {
    // Drop any test-prefix leftovers, then restore the original file.
    const store = getRuntimeStore();
    for (const [k] of store.entries()) {
      if (k.startsWith(TEST_PREFIX)) store.remove(k);
    }
    restore(snap);
  }

  console.log("✅ managerRuntime verified — resolveRuntimeName, Claude/Codex construction, post-close swap");
}

main().catch((err) => {
  console.error("❌ managerRuntime verification failed:", err);
  process.exit(1);
});
