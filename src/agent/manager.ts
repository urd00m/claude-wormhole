import path from "node:path";
import fs from "node:fs/promises";
import { SESSIONS_DIR } from "../config.js";
import { Session } from "./session.js";
import { getWorkdirStore } from "./workdirStore.js";

export type ThreadKey = string;

export function threadKeyOf(channel: string, threadTs: string): ThreadKey {
  return `${channel}:${threadTs}`;
}

type QueueEntry = () => Promise<void>;

class SessionEntry {
  readonly session: Session;
  private queue: QueueEntry[] = [];
  private running = false;

  constructor(session: Session) {
    this.session = session;
  }

  /** Enqueue work; processes serially per thread. */
  async enqueue(work: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          await work();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        await next();
      }
    } finally {
      this.running = false;
    }
  }
}

export class SessionManager {
  private readonly entries = new Map<ThreadKey, SessionEntry>();

  async get(key: ThreadKey): Promise<{ entry: SessionEntry; created: boolean }> {
    const existing = this.entries.get(key);
    if (existing) {
      return { entry: existing, created: false };
    }
    const override = getWorkdirStore().get(key);
    let workdir: string;
    if (override) {
      workdir = override;
    } else {
      const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "_");
      workdir = path.join(SESSIONS_DIR, safeKey);
      await fs.mkdir(path.join(workdir, "uploads"), { recursive: true });
    }
    const entry = new SessionEntry(new Session({ threadKey: key, workdir }));
    this.entries.set(key, entry);
    return { entry, created: true };
  }

  has(key: ThreadKey): boolean {
    return this.entries.has(key);
  }

  /**
   * Drop the in-memory session entry for `key`. Returns true if an entry was
   * removed, false if none existed. The next message in that thread will
   * spin up a fresh session (created=true). `close` does not interrupt
   * in-flight work — the orphaned entry's queue continues running on its
   * own reference; this only prevents future messages from being routed
   * back to that same session.
   */
  close(key: ThreadKey): boolean {
    return this.entries.delete(key);
  }
}

export const sessions = new SessionManager();
