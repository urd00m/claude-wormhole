// Lazy-refreshed cache for subscription quota (5h / weekly utilization),
// sourced from `scripts/fetch-usage.sh` (which is the only thing in this
// repo that reads OAuth credentials — the wormhole reads ONLY the script's
// non-secret JSON output).
//
// Why the script + cache split: the Claude Agent SDK forwards
// rate_limit_event from per-message responses, but the server only emits
// `utilization` once you cross a threshold. The CLI itself bypasses that by
// hitting GET /api/oauth/usage directly. We replicate that, in an isolated
// subprocess, on a slow cadence (default 5 min) — the result is just two
// numbers and a reset time.
//
// Read order in the bot:
//   1. The disk cache (`data/usage.json`) if it's young enough.
//   2. The SDK's rate_limit_event values (already captured by ClaudeRuntime),
//      as a fallback for the gap between script runs.
//   3. "n/a" if neither has data.
//
// We never throw on a missing/broken cache — quota readout is best-effort.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CACHE_PATH = path.join(REPO_ROOT, "data", "usage.json");
const DEFAULT_SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "fetch-usage.sh");
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export type UsageSnapshot = {
  status: "ok" | "error";
  fetchedAt: number; // unix seconds
  fiveHourPct?: number;
  weeklyPct?: number;
  resetsAt?: string;
  reason?: string;
};

type RawDoc = {
  status?: "ok" | "error";
  fetched_at?: number;
  five_hour_pct?: number | null;
  weekly_pct?: number | null;
  resets_at?: string | null;
  reason?: string | null;
};

function parse(raw: string): UsageSnapshot | null {
  let doc: RawDoc;
  try {
    doc = JSON.parse(raw) as RawDoc;
  } catch {
    return null;
  }
  if (typeof doc.fetched_at !== "number" || (doc.status !== "ok" && doc.status !== "error")) return null;
  const snap: UsageSnapshot = { status: doc.status, fetchedAt: doc.fetched_at };
  if (typeof doc.five_hour_pct === "number") snap.fiveHourPct = doc.five_hour_pct;
  if (typeof doc.weekly_pct === "number") snap.weeklyPct = doc.weekly_pct;
  if (typeof doc.resets_at === "string") snap.resetsAt = doc.resets_at;
  if (typeof doc.reason === "string") snap.reason = doc.reason;
  return snap;
}

export interface UsageStoreOpts {
  cachePath?: string;
  scriptPath?: string;
  ttlMs?: number;
}

export class UsageStore {
  private cachePath: string;
  private scriptPath: string;
  private ttlMs: number;
  private inFlight: Promise<void> | null = null;

  constructor(opts: UsageStoreOpts = {}) {
    this.cachePath = opts.cachePath ?? DEFAULT_CACHE_PATH;
    this.scriptPath = opts.scriptPath ?? DEFAULT_SCRIPT_PATH;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Return the current snapshot from disk, or null if unreadable / absent. */
  read(): UsageSnapshot | null {
    try {
      const raw = fs.readFileSync(this.cachePath, "utf8");
      return parse(raw);
    } catch {
      return null;
    }
  }

  /** Is the on-disk cache fresh enough to skip a refresh? */
  isFresh(now: number = Date.now()): boolean {
    const snap = this.read();
    if (!snap) return false;
    const ageMs = now - snap.fetchedAt * 1000;
    return ageMs >= 0 && ageMs < this.ttlMs;
  }

  /**
   * Kick off a refresh if the cache is stale. Non-blocking: returns
   * immediately with the current snapshot (which may be stale or null). The
   * fresh value lands on disk a moment later and shows up on the next read.
   * Coalesces concurrent calls so we don't spawn the script in parallel.
   */
  maybeRefresh(now: number = Date.now()): UsageSnapshot | null {
    const snap = this.read();
    if (snap && this.isFresh(now)) return snap;
    if (!this.inFlight) {
      this.inFlight = new Promise<void>((resolve) => {
        execFile(
          "bash",
          [this.scriptPath],
          {
            cwd: REPO_ROOT,
            timeout: 20_000,
            // Do NOT inherit stderr/stdout into our logs by default — the
            // script is engineered not to print the token, but we keep the
            // belt-and-suspenders posture and discard them.
          },
          () => {
            this.inFlight = null;
            resolve();
          },
        );
      });
    }
    return snap; // possibly stale; the refresh updates the file out-of-band
  }
}

// Module singleton — created lazily so tests can construct their own with
// custom paths.
let singleton: UsageStore | null = null;
export function getUsageStore(): UsageStore {
  if (!singleton) singleton = new UsageStore();
  return singleton;
}
/** Reset the singleton (test-only). */
export function _resetUsageStoreForTests(): void {
  singleton = null;
}
