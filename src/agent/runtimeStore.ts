// Per-thread runtime overrides. When a thread has an override, its
// SessionManager.get constructs that runtime (Claude or Codex) instead of
// the env's DEFAULT_RUNTIME. Mirrors `workdirStore.ts` in spirit and on-disk
// layout: a single JSON file at data/runtimes.json, loaded once at first
// access, written synchronously on mutation.
//
// We persist runtime selection across restarts so users don't have to
// re-pin a thread to Codex every time the bot reboots. The file lives in
// the same data/ directory as crons.json and workdirs.json — easy to git-
// ignore, easy to back up.

import fs from "node:fs";
import path from "node:path";
import { RUNTIMES_FILE, DATA_DIR } from "../config.js";

export type RuntimeName = "claude" | "codex";

const VALID: ReadonlySet<RuntimeName> = new Set(["claude", "codex"]);

function isRuntimeName(v: unknown): v is RuntimeName {
  return typeof v === "string" && VALID.has(v as RuntimeName);
}

export class RuntimeStore {
  private map = new Map<string, RuntimeName>();
  private readonly file: string;

  constructor(file: string = RUNTIMES_FILE) {
    this.file = file;
    this.load();
  }

  get(threadKey: string): RuntimeName | undefined {
    return this.map.get(threadKey);
  }

  set(threadKey: string, runtime: RuntimeName): void {
    this.map.set(threadKey, runtime);
    this.save();
  }

  remove(threadKey: string): boolean {
    const had = this.map.delete(threadKey);
    if (had) this.save();
    return had;
  }

  /** Snapshot — exposed for diagnostics (doctor.sh reads this file directly). */
  entries(): ReadonlyArray<[string, RuntimeName]> {
    return Array.from(this.map.entries());
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (isRuntimeName(v)) this.map.set(k, v);
        }
      }
    } catch (err) {
      console.warn(
        `[runtimes] failed to load ${this.file}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const obj: Record<string, RuntimeName> = {};
    for (const [k, v] of this.map) obj[k] = v;
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
  }
}

let _singleton: RuntimeStore | null = null;
export function getRuntimeStore(): RuntimeStore {
  if (!_singleton) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _singleton = new RuntimeStore();
  }
  return _singleton;
}
