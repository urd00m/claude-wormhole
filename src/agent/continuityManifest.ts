import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ContinuityStore, RecoveryRequiredError, type Binding } from "./continuityStore.js";
import { validateNativeSession } from "./nativeSession.js";
import { isSafetyStop, type ProviderFailure } from "./providerError.js";

export type Candidate = { sessionId: string; workdir: string; runtime: Binding["runtime"]; providerHome: string; updatedAt?: number; rolloutPath?: string };
export type Inventory = { version: 1; root: string; indexSha256: string; generatedAt: string; threads: { key: string; candidates: Candidate[] }[] };
export type MigrationManifest = Inventory & { verified: true; bindings: Binding[] };

/** Read-only inventory: historical candidates are deliberately NOT selected. */
export function inventoryThreads(root: string, codexHome: string, claudeHome: string): Inventory {
  root = path.resolve(root);
  const index = fs.readFileSync(path.join(root, "data/active-sessions.json"));
  const markers = JSON.parse(index.toString()) as { channel: string; threadTs: string }[];
  if (!Array.isArray(markers)) throw new RecoveryRequiredError("Invalid legacy index.");
  const read = (name: string) => {
    const p = path.join(root, "data", name);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : {};
  };
  const aliases = read("aliases.json"), active = read("thread-aliases.json"), workdirs = read("workdirs.json"), runtimes = read("runtimes.json");
  const dotenv = fs.existsSync(path.join(root, ".env")) ? fs.readFileSync(path.join(root, ".env"), "utf8") : "";
  const defaultRuntime = dotenv.match(/^DEFAULT_RUNTIME\s*=\s*["']?(claude|codex)/m)?.[1] ?? "claude";
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const db = fs.existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
  try {
    return { version: 1, root, indexSha256: createHash("sha256").update(index).digest("hex"), generatedAt: new Date().toISOString(), threads: markers.map((m) => {
      if (!m.channel || !m.threadTs) throw new RecoveryRequiredError("Invalid legacy thread identity.");
      const key = `${m.channel}:${m.threadTs}`;
      const runtime = aliases[active[key]]?.runtime ?? runtimes[key] ?? defaultRuntime;
      const workdir = workdirs[key] ?? path.join(root, "sessions", key.replace(/[^A-Za-z0-9_-]/g, "_"));
      let candidates: Candidate[] = [];
      if (runtime === "codex" && db) {
        const rows = db.prepare("SELECT id,cwd,updated_at,rollout_path FROM threads WHERE cwd=? AND source='exec' ORDER BY updated_at DESC").all(workdir) as { id: string; cwd: string; updated_at: number; rollout_path: string }[];
        candidates = rows.map((r) => ({ sessionId: r.id, runtime: "codex", workdir: r.cwd, providerHome: codexHome, updatedAt: r.updated_at, rolloutPath: r.rollout_path }));
      } else if (runtime === "claude") {
        const dir = path.join(claudeHome, "projects", workdir.replace(/[^a-zA-Z0-9]/g, "-"));
        if (fs.existsSync(dir)) candidates = fs.readdirSync(dir).filter((name) => /^[0-9a-f-]{36}\.jsonl$/.test(name)).map((name) => ({ sessionId: name.slice(0, -6), runtime: "claude", workdir, providerHome: claudeHome }));
      }
      return { key, candidates };
    }) };
  } finally { db?.close(); }
}

/** Inspect only the public terminal error, never private review state. */
function latestFailure(candidate: Candidate): ProviderFailure | undefined {
  if (!candidate.rolloutPath) return;
  const fd = fs.openSync(candidate.rolloutPath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    let failure: ProviderFailure | undefined;
    for (const line of buffer.toString("utf8").split("\n")) {
      try {
        const r = JSON.parse(line), q = r.payload;
        if (q?.type === "task_complete") failure = q.error ? { message: q.error.message, code: q.error.codex_error_info, details: q.error.misalignment } : undefined;
      } catch { /* buffer can begin mid-record */ }
    }
    return failure;
  } finally { fs.closeSync(fd); }
}

export function validateManifest(manifest: MigrationManifest, inventory: Inventory): Binding[] {
  if (manifest.version !== 1 || manifest.verified !== true || manifest.root !== inventory.root || manifest.indexSha256 !== inventory.indexSha256) throw new RecoveryRequiredError("Manifest is unverified or its legacy index changed. Re-inventory before deployment.");
  if (JSON.stringify(manifest.threads) !== JSON.stringify(inventory.threads)) throw new RecoveryRequiredError("Native session candidates changed after verification. Refresh and review the manifest before deployment.");
  if (!Array.isArray(manifest.bindings)) throw new RecoveryRequiredError("Manifest has no verified bindings.");
  const seen = new Set<string>();
  const bindings = manifest.bindings.map((b) => {
    if (seen.has(b.key)) throw new RecoveryRequiredError(`Duplicate binding: ${b.key}`);
    seen.add(b.key);
    const thread = inventory.threads.find((t) => t.key === b.key);
    const candidate = thread?.candidates.find((c) => c.sessionId === b.sessionId && c.runtime === b.runtime && c.workdir === b.workdir && c.providerHome === b.providerHome);
    if (!candidate || !b.started || b.inFlight || !["ready", "stopped", "recovery_required"].includes(b.state)) throw new RecoveryRequiredError(`Binding ${b.key} is not a verified existing candidate.`);
    validateNativeSession(b);
    const failure = latestFailure(candidate);
    return failure && isSafetyStop(failure) ? { ...b, state: "stopped" as const, failure } : b;
  });
  for (const t of inventory.threads) if (!seen.has(t.key)) throw new RecoveryRequiredError(`Missing mapping: ${t.key}`);
  return bindings;
}

/** Explicit operator-only import. No silent replacement of existing bindings. */
export function importManifest(manifest: MigrationManifest, inventory: Inventory, stateFile: string): void {
  const bindings = validateManifest(manifest, inventory);
  const store = new ContinuityStore(stateFile);
  try {
    store.acquireOwner();
    store.transaction(() => {
      for (const b of bindings) {
        const existing = store.get(b.key);
        if (existing && JSON.stringify(existing) !== JSON.stringify(b)) throw new RecoveryRequiredError(`Registry already contains a different binding for ${b.key}.`);
        store.put(b);
      }
    });
  } finally { store.close(); }
}
