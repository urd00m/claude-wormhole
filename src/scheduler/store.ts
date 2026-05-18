import fs from "node:fs";
import path from "node:path";
import { CRONS_FILE, DATA_DIR } from "../config.js";

export type CronEntry = {
  id: string;
  expression: string;
  timezone?: string;
  channel: string;
  prompt: string;
  description?: string;
  createdAt: string;
  createdBy?: string;
};

export class CronStore {
  private entries: CronEntry[] = [];
  private readonly file: string;

  constructor(file: string = CRONS_FILE) {
    this.file = file;
    this.load();
  }

  list(): CronEntry[] {
    return [...this.entries];
  }

  get(id: string): CronEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  add(entry: Omit<CronEntry, "id" | "createdAt"> & { id?: string }): CronEntry {
    const id = entry.id ?? generateId();
    const full: CronEntry = {
      ...entry,
      id,
      createdAt: new Date().toISOString(),
    };
    this.entries.push(full);
    this.save();
    return full;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) {
        this.entries = [];
        return;
      }
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(isCronEntry);
      }
    } catch (err) {
      console.warn(`[cron] failed to load ${this.file}: ${err instanceof Error ? err.message : err}`);
      this.entries = [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
  }
}

function generateId(): string {
  return `cron_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isCronEntry(x: unknown): x is CronEntry {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.expression === "string" &&
    typeof e.channel === "string" &&
    typeof e.prompt === "string" &&
    typeof e.createdAt === "string"
  );
}

// Singleton for app use; tests can construct their own with a temp path.
let _singleton: CronStore | null = null;
export function getCronStore(): CronStore {
  if (!_singleton) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _singleton = new CronStore();
  }
  return _singleton;
}
