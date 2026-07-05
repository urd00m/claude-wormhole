// Multi-account Claude credential pool.
//
// Balances usage across multiple Claude OAuth accounts by tracking which
// credential directories are available vs rate-limited, and handing out
// the least-recently-used "ok" slot on each acquire(). Each "slot" is a
// directory that contains the OAuth credentials produced by `claude login`
// (the same layout as ~/.claude/ — the SDK reads CLAUDE_CONFIG_DIR to
// find it).
//
// The pool is single-host, single-process, synchronous — no Ray, no
// distributed coordination. The SessionManager already serializes sends
// per-thread, so concurrent acquire() calls from different threads are
// safe (JS is single-threaded for the synchronous bits; the async gap
// between acquire and release is per-thread and non-overlapping).

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlotStatus = "ok" | "rate_limited" | "auth_failed";

export interface CredSlot {
  /** Absolute path to the credential directory (contains .credentials.json). */
  dir: string;
  /** Human label derived from the directory basename. */
  label: string;
  status: SlotStatus;
  /** UTC timestamp (ms) when a rate-limited/failed slot becomes available. */
  availableAt: number;
  /** UTC timestamp (ms) of the last successful acquire(). */
  lastUsedAt: number;
}

export interface PoolStatus {
  total: number;
  available: number;
  slots: ReadonlyArray<{
    label: string;
    status: SlotStatus;
    availableAt: number | null;
    lastUsedAt: number;
  }>;
}

export class AllRateLimitedError extends Error {
  /** Earliest UTC ms when any slot becomes available, or null. */
  earliestReset: number | null;
  constructor(message: string, earliestReset: number | null) {
    super(message);
    this.name = "AllRateLimitedError";
    this.earliestReset = earliestReset;
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

const AUTH_FAILURE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const REAPER_INTERVAL_MS = 30_000;

export class CredentialPool {
  private slots: CredSlot[];
  private reaperTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dirs: string[]) {
    this.slots = dirs.map((dir) => ({
      dir: path.resolve(dir),
      label: path.basename(dir),
      status: "ok" as SlotStatus,
      availableAt: 0,
      lastUsedAt: 0,
    }));
    if (this.slots.length > 0) {
      this.reaperTimer = setInterval(() => this.reap(), REAPER_INTERVAL_MS);
      this.reaperTimer.unref();
    }
  }

  get size(): number {
    return this.slots.length;
  }

  /** Pick the least-recently-used available slot, or throw. */
  acquire(): CredSlot {
    const now = Date.now();
    this.reap(now);

    const ok = this.slots
      .filter((s) => s.status === "ok")
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

    if (ok.length === 0) {
      const earliest = this.slots.length > 0
        ? Math.min(...this.slots.map((s) => s.availableAt))
        : null;
      throw new AllRateLimitedError(
        `All ${this.slots.length} credential slot(s) are unavailable`,
        earliest,
      );
    }

    const slot = ok[0];
    slot.lastUsedAt = now;
    return slot;
  }

  /** Mark a slot as rate-limited until `resetsAtMs` (UTC ms). */
  reportRateLimit(slot: CredSlot, resetsAtMs: number): void {
    const s = this.findSlot(slot.dir);
    if (!s) return;
    s.status = "rate_limited";
    s.availableAt = resetsAtMs;
  }

  /** Mark a slot as failed (expired auth, billing, etc) with a 4h cooldown. */
  reportAuthFailure(slot: CredSlot): void {
    const s = this.findSlot(slot.dir);
    if (!s) return;
    s.status = "auth_failed";
    s.availableAt = Date.now() + AUTH_FAILURE_COOLDOWN_MS;
  }

  /** Manually restore a slot (e.g. after re-authenticating). */
  restore(dir: string): boolean {
    const s = this.findSlot(dir);
    if (!s || s.status === "ok") return false;
    s.status = "ok";
    s.availableAt = 0;
    return true;
  }

  status(): PoolStatus {
    return {
      total: this.slots.length,
      available: this.slots.filter((s) => s.status === "ok").length,
      slots: this.slots.map((s) => ({
        label: s.label,
        status: s.status,
        availableAt: s.status !== "ok" ? s.availableAt : null,
        lastUsedAt: s.lastUsedAt,
      })),
    };
  }

  cleanup(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  // -- internals --

  private findSlot(dir: string): CredSlot | undefined {
    const resolved = path.resolve(dir);
    return this.slots.find((s) => s.dir === resolved);
  }

  private reap(now = Date.now()): void {
    for (const s of this.slots) {
      if (s.status !== "ok" && now >= s.availableAt) {
        s.status = "ok";
        s.availableAt = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton + config parsing
// ---------------------------------------------------------------------------

/**
 * Parse `CLAUDE_CREDENTIAL_DIRS` into validated absolute paths.
 * Returns an empty array when the var is unset/empty. Warns on
 * dirs that don't exist or lack a credentials file.
 */
export function parseCredentialDirs(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) return [];
  const dirs = raw.split(",").map((d) => d.trim()).filter(Boolean);
  const valid: string[] = [];
  for (const d of dirs) {
    const abs = path.resolve(d);
    if (!fs.existsSync(abs)) {
      console.warn(`[credentialPool] dir does not exist, skipping: ${abs}`);
      continue;
    }
    const credFile = path.join(abs, ".credentials.json");
    const credFileAlt = path.join(abs, "credentials.json");
    if (!fs.existsSync(credFile) && !fs.existsSync(credFileAlt)) {
      console.warn(`[credentialPool] no credentials file in ${abs}, skipping`);
      continue;
    }
    valid.push(abs);
  }
  return valid;
}

let _pool: CredentialPool | null = null;

export function getCredentialPool(): CredentialPool | null {
  return _pool;
}

/**
 * Initialize the singleton pool from the env var. Called once at startup.
 * Returns null when multi-account is not configured (zero valid dirs).
 */
export function initCredentialPool(raw: string | undefined): CredentialPool | null {
  const dirs = parseCredentialDirs(raw);
  if (dirs.length === 0) {
    _pool = null;
    return null;
  }
  _pool = new CredentialPool(dirs);
  console.log(
    `[credentialPool] initialized with ${dirs.length} account(s): ${dirs.map((d) => path.basename(d)).join(", ")}`,
  );
  return _pool;
}
