import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentLaunchConfig } from "./runtime/types.js";
import { ProviderError, isSafetyStop, isCyberRejection, assertCyberFollowup, stoppedMessage, type ProviderFailure } from "./providerError.js";

export type Binding = {
  execution?: { kind: "docker"; user: string; container: string; channel: string; thread: string };
  key: string;
  runtime: "claude" | "codex";
  workdir: string;
  providerHome: string;
  sessionId: string | null;
  started: boolean;
  launch?: AgentLaunchConfig;
  state: "ready" | "stopped" | "recovery_required" | "closed";
  failure?: ProviderFailure;
  /** Retained after success so stale queued work cannot revive a rejected turn. */
  cyberRejection?: ProviderFailure;
  inFlight?: boolean;
  identityRotated?: boolean;
  ownerThread?: string;
  workerName?: string;
};

export class RecoveryRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "RecoveryRequiredError"; }
}

/** One durable registry, independent of the installed release and its cwd. */
export class ContinuityStore {
  private db: DatabaseSync;
  private owner: string | null = null;
  constructor(readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const anchor = file + ".identity";
    if (fs.existsSync(anchor) && !fs.existsSync(file)) throw new RecoveryRequiredError("The continuity database is missing. Restore it from backup; refusing an empty replacement.");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, thread_key TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, thread_key TEXT NOT NULL, value TEXT NOT NULL);`);
    const schema = this.meta("schema");
    if (schema && schema !== "1") { this.db.close(); throw new RecoveryRequiredError("Unsupported continuity registry version; refusing to start."); }
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('schema','1')").run();
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('registry_id',?)").run(randomUUID());
    const registryId = this.meta("registry_id")!;
    if (!fs.existsSync(anchor)) {
      try { fs.writeFileSync(anchor, registryId, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (fs.readFileSync(anchor, "utf8") !== registryId) { this.db.close(); throw new RecoveryRequiredError("Continuity registry identity differs from its deployment anchor."); }
  }

  private meta(key: string): string | null {
    return (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  get(key: string): Binding | undefined {
    const row = this.db.prepare("SELECT value FROM bindings WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as Binding : undefined;
  }

  list(): Binding[] {
    return (this.db.prepare("SELECT value FROM bindings ORDER BY key").all() as { value: string }[]).map((r) => JSON.parse(r.value));
  }

  put(binding: Binding): void {
    this.db.prepare("INSERT INTO bindings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(binding.key, JSON.stringify(binding));
  }

  update(key: string, patch: Partial<Binding>): Binding {
    const before = this.get(key);
    if (!before) throw new RecoveryRequiredError(`No conversation binding exists for ${key}.`);
    const next = { ...before, ...patch, key };
    this.put(next);
    return next;
  }

  saveIdentity(key: string, identity: Pick<Binding, "sessionId" | "started" | "workdir" | "providerHome">): void {
    this.transaction(() => {
      const before = this.get(key);
      if (!before) throw new RecoveryRequiredError(`No conversation binding exists for ${key}.`);
      const changed = before.sessionId !== identity.sessionId || before.workdir !== identity.workdir;
      if (changed && before.sessionId) this.db.prepare("INSERT INTO events(thread_key,value) VALUES (?,?)").run(key, JSON.stringify(before));
      this.update(key, { ...identity, ...(changed && !identity.started && before.inFlight ? { identityRotated: true } : {}) });
    });
  }

  assertRunnable(key: string, userMessageAt?: number): Binding {
    const b = this.get(key);
    if (!b || b.state === "closed") throw new RecoveryRequiredError(`Conversation ${key} has no active binding.`);
    if (b.state === "stopped") throw new ProviderError({ ...b.failure, code: b.failure?.code ?? "misalignment_policy_violation", sessionId: b.sessionId, message: stoppedMessage(b.sessionId, b.failure) });
    if (b.state === "recovery_required") throw new RecoveryRequiredError(`Conversation ${b.sessionId ?? key} needs recovery: ${b.failure?.message ?? "its previous turn is uncertain"}. No replacement conversation was created.`);
    assertCyberFollowup(b.cyberRejection ?? b.failure, userMessageAt);
    return b;
  }

  beginTurn(key: string, userMessageAt?: number): void {
    this.transaction(() => {
      const b = this.assertRunnable(key, userMessageAt);
      if (b.inFlight) throw new RecoveryRequiredError(`Conversation ${key} already has a turn in progress.`);
      this.update(key, { inFlight: true });
    });
  }

  finishTurn(key: string, failure?: ProviderFailure): void {
    this.transaction(() => {
      const b = this.get(key);
      if (!b) return;
      if (b.state === "closed") { this.update(key, { inFlight: false }); return; }
      // A workdir tool may deliberately reserve a fresh conversation while
      // the old turn finishes. That unused identity is ready for its first turn.
      const uncertain = (!b.sessionId || !b.started) && !b.identityRotated;
      this.update(key, {
        inFlight: false,
        identityRotated: false,
        state: failure && isSafetyStop(failure) ? "stopped" : b.state === "recovery_required" || uncertain || failure?.code === "native_session_missing" || failure?.code === "conversation_identity_mismatch" ? "recovery_required" : "ready",
        failure: failure ?? (uncertain ? { message: "The provider did not confirm a usable conversation identity." } : undefined),
        ...(failure && isCyberRejection(failure) ? { cyberRejection: { ...failure, occurredAt: failure.occurredAt ?? Date.now() } } : {}),
      });
    });
  }

  end(key: string, allowActive = false): void {
    const b = this.get(key);
    if (!b) return;
    if (b.state === "closed") return;
    if (b.inFlight && !allowActive) throw new RecoveryRequiredError("Interrupt the active turn and wait for it to finish before ending this conversation.");
    this.transaction(() => {
      this.db.prepare("INSERT INTO events(thread_key,value) VALUES (?,?)").run(key, JSON.stringify(b));
      this.update(key, { state: "closed" });
    });
  }

  acceptDelivery(id: string, threadKey: string, payload: unknown): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?,?,?,'queued',NULL,?)")
      .run(id, threadKey, JSON.stringify(payload), Date.now()).changes === 1;
  }

  claimDelivery(id: string): boolean {
    return this.db.prepare("UPDATE deliveries SET state='running' WHERE id=? AND state='queued'").run(id).changes === 1;
  }

  finishDelivery(id: string, error?: string): void {
    this.db.prepare("UPDATE deliveries SET state=?,error=? WHERE id=? AND state='running'")
      .run(error ? "failed" : "completed", error ?? null, id);
  }

  deliveries(state: string): { id: string; thread_key: string; payload: string; state: string }[] {
    return this.db.prepare("SELECT id,thread_key,payload,state FROM deliveries WHERE state=? ORDER BY created_at,id").all(state) as ReturnType<ContinuityStore["deliveries"]>;
  }

  /** Only the real bot acquires ownership. Read/export tooling never starts it. */
  acquireOwner(): void {
    this.transaction(() => {
      const existing = this.meta("owner");
      if (existing) {
        const other = JSON.parse(existing) as { pid: number; start: string };
        if (processIdentity(other.pid) === other.start) throw new RecoveryRequiredError("Another Wormhole process owns this registry; refusing concurrent dispatch.");
      }
      this.owner = randomUUID();
      this.db.prepare("INSERT INTO metadata VALUES ('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ pid: process.pid, start: processIdentity(process.pid), token: this.owner }));
      this.db.prepare("UPDATE deliveries SET state='uncertain',error='Process exited during delivery; reconcile before replay' WHERE state='running'").run();
      for (const b of this.list()) if (b.inFlight) this.update(b.key, {
        inFlight: false,
        identityRotated: false,
        state: b.state === "stopped" || b.state === "closed" ? b.state : "recovery_required",
        failure: b.state === "stopped" || b.state === "closed" ? b.failure : { message: "The previous process exited during a turn; inspect the native transcript before continuing." },
      });
    });
  }

  releaseOwner(): void {
    if (!this.owner) return;
    const value = this.meta("owner");
    if (value && JSON.parse(value).token === this.owner) this.db.prepare("DELETE FROM metadata WHERE key='owner'").run();
    this.owner = null;
  }

  close(): void { this.releaseOwner(); this.db.close(); }
}

function processIdentity(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return null; }
}

export function defaultProviderHome(runtime: Binding["runtime"]): string {
  return path.resolve(runtime === "codex" ? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex") : process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"));
}

let singleton: ContinuityStore | undefined;
export function getContinuityStore(): ContinuityStore {
  const dir = process.env.WORMHOLE_STATE_DIR ?? path.join(os.homedir(), ".local/state/claude-wormhole");
  return singleton ??= new ContinuityStore(path.join(dir, "sessions.sqlite"));
}
