import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKDIRS_FILE, DATA_DIR } from "../config.js";

/**
 * Per-thread working-directory overrides. When a thread has an override, the
 * agent runs with that as its cwd instead of `sessions/<threadKey>/`. This is
 * how CLAUDE.md files in a real project get picked up.
 */
export class WorkdirStore {
  private map = new Map<string, string>();
  private readonly file: string;

  constructor(file: string = WORKDIRS_FILE) {
    this.file = file;
    this.load();
  }

  get(threadKey: string): string | undefined {
    return this.map.get(threadKey);
  }

  set(threadKey: string, workdir: string): void {
    this.map.set(threadKey, workdir);
    this.save();
  }

  remove(threadKey: string): boolean {
    const had = this.map.delete(threadKey);
    if (had) this.save();
    return had;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch (err) {
      console.warn(`[workdirs] failed to load ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of this.map) obj[k] = v;
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
  }
}

let _singleton: WorkdirStore | null = null;
export function getWorkdirStore(): WorkdirStore {
  if (!_singleton) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _singleton = new WorkdirStore();
  }
  return _singleton;
}

/**
 * Validate and canonicalize a user-supplied workdir path.
 * Throws with a human-readable reason if invalid.
 */
export function resolveWorkdir(input: string): string {
  let p = input.trim();
  if (!p) throw new Error("path is empty");

  // Expand ~ and ~/
  if (p === "~" || p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(1));
  }

  if (!path.isAbsolute(p)) {
    throw new Error(`path must be absolute (got '${input}')`);
  }

  const resolved = path.resolve(p);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`path does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`path is not a directory: ${resolved}`);
  }
  return resolved;
}
