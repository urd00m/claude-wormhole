// Global on/off toggle for caveman compression. One value, bot-wide — not
// per-thread. Flipping in any Slack thread changes the next message in
// every thread. Persisted to data/cavemanState.json (gitignored).
//
// Levels mirror upstream caveman (skills/caveman/SKILL.md):
//   off, lite, full (default), ultra, wenyan, wenyan-lite, wenyan-full,
//   wenyan-ultra
// The wormhole's Slack matcher accepts the short aliases; this store
// stores the canonical name as returned by `parseCavemanLevel`.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config.js";

export type CavemanLevel =
  | "off"
  | "lite"
  | "full"
  | "ultra"
  | "wenyan"
  | "wenyan-lite"
  | "wenyan-full"
  | "wenyan-ultra";

const VALID_LEVELS: ReadonlySet<CavemanLevel> = new Set<CavemanLevel>([
  "off",
  "lite",
  "full",
  "ultra",
  "wenyan",
  "wenyan-lite",
  "wenyan-full",
  "wenyan-ultra",
]);

export function isCavemanLevel(s: unknown): s is CavemanLevel {
  return typeof s === "string" && VALID_LEVELS.has(s as CavemanLevel);
}

export interface CavemanState {
  level: CavemanLevel;
}

const STATE_FILE = path.join(DATA_DIR, "cavemanState.json");

export class CavemanStore {
  private level: CavemanLevel = "off";
  private readonly file: string;
  private mtimeMs = -1;

  constructor(file: string = STATE_FILE) {
    this.file = file;
    this.reloadIfChanged();
  }

  get(): CavemanLevel {
    this.reloadIfChanged();
    return this.level;
  }

  set(level: CavemanLevel): void {
    if (!VALID_LEVELS.has(level)) throw new Error(`invalid caveman level: ${level}`);
    this.level = level;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ level } satisfies CavemanState, null, 2));
    // Refresh our mtime so the next reloadIfChanged() is a no-op
    try {
      const st = fs.statSync(this.file);
      this.mtimeMs = st.mtimeMs;
    } catch {
      /* ignore */
    }
  }

  private reloadIfChanged(): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(this.file);
    } catch {
      // file doesn't exist — keep current in-memory value (defaults to "off")
      return;
    }
    const mtimeMs = st.mtimeMs;
    if (mtimeMs === this.mtimeMs) return;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<CavemanState>;
      if (parsed && isCavemanLevel(parsed.level)) {
        this.level = parsed.level;
      }
      this.mtimeMs = mtimeMs;
    } catch {
      // bad file — leave in-memory value alone
    }
  }
}

let _singleton: CavemanStore | null = null;
export function getCavemanStore(): CavemanStore {
  if (!_singleton) _singleton = new CavemanStore();
  return _singleton;
}
/** Test-only: reset the singleton so a test can construct one with a tmp file. */
export function _resetCavemanStoreForTests(): void {
  _singleton = null;
}
