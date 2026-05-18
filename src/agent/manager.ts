import path from "node:path";
import fs from "node:fs/promises";
import { SESSIONS_DIR } from "../config.js";
import { Session } from "./session.js";

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

  async get(key: ThreadKey): Promise<SessionEntry> {
    let entry = this.entries.get(key);
    if (!entry) {
      const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "_");
      const workdir = path.join(SESSIONS_DIR, safeKey);
      await fs.mkdir(path.join(workdir, "uploads"), { recursive: true });
      entry = new SessionEntry(new Session({ threadKey: key, workdir }));
      this.entries.set(key, entry);
    }
    return entry;
  }

  has(key: ThreadKey): boolean {
    return this.entries.has(key);
  }
}

export const sessions = new SessionManager();
