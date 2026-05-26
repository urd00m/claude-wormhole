import path from "node:path";
import fs from "node:fs/promises";
import { SESSIONS_DIR, env } from "../config.js";
import { Session } from "./session.js";
import { getWorkdirStore } from "./workdirStore.js";
import { getRuntimeStore, type RuntimeName } from "./runtimeStore.js";
import { ClaudeRuntime } from "./runtime/claude.js";
import { CodexRuntime } from "./runtime/codex.js";
import type { Runtime } from "./runtime/types.js";

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

/**
 * Resolve which runtime a thread should use:
 *   1. The per-thread override in `data/runtimes.json` wins (set via the
 *      runtime-switch control phrase in Slack).
 *   2. Otherwise fall back to env.DEFAULT_RUNTIME.
 *
 * Exposed for tests + so handlers can show the user which runtime they're
 * about to talk to without instantiating one.
 */
export function resolveRuntimeName(key: ThreadKey): RuntimeName {
  return getRuntimeStore().get(key) ?? env.DEFAULT_RUNTIME;
}

/**
 * Build the concrete runtime instance for a thread. Kept separate from
 * `Session` construction so SessionManager.get can swap runtimes without
 * Session having to know how to build them.
 */
function buildRuntime(key: ThreadKey, workdir: string): Runtime {
  const name = resolveRuntimeName(key);
  if (name === "codex") {
    return new CodexRuntime({ threadKey: key, workdir });
  }
  return new ClaudeRuntime({ threadKey: key, workdir });
}

export class SessionManager {
  private readonly entries = new Map<ThreadKey, SessionEntry>();
  /**
   * In-flight creation promises keyed by ThreadKey. Without this, two
   * messages arriving back-to-back for an unknown thread both miss the
   * `entries` cache, both `await fs.mkdir`, both construct a `Session`,
   * and the second `entries.set` clobbers the first — leaving the first
   * caller streaming into an orphaned Session while subsequent messages
   * route to the survivor.
   */
  private readonly creating = new Map<ThreadKey, Promise<SessionEntry>>();

  async get(key: ThreadKey): Promise<{ entry: SessionEntry; created: boolean }> {
    const existing = this.entries.get(key);
    if (existing) {
      return { entry: existing, created: false };
    }
    const inFlight = this.creating.get(key);
    if (inFlight) {
      return { entry: await inFlight, created: false };
    }
    const work = (async (): Promise<SessionEntry> => {
      const override = getWorkdirStore().get(key);
      let workdir: string;
      if (override) {
        workdir = override;
      } else {
        const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "_");
        workdir = path.join(SESSIONS_DIR, safeKey);
        await fs.mkdir(path.join(workdir, "uploads"), { recursive: true });
      }
      const runtime = buildRuntime(key, workdir);
      const entry = new SessionEntry(new Session({ threadKey: key, runtime }));
      this.entries.set(key, entry);
      return entry;
    })();
    this.creating.set(key, work);
    try {
      const entry = await work;
      return { entry, created: true };
    } finally {
      this.creating.delete(key);
    }
  }

  has(key: ThreadKey): boolean {
    return this.entries.has(key);
  }

  /**
   * Drop the in-memory session entry for `key`. Returns true if an entry was
   * removed, false if none existed. The next message in that thread will
   * spin up a fresh session (created=true) — under whatever runtime the
   * store currently resolves to, so this is also the mechanism the
   * runtime-switch control phrase relies on.
   */
  close(key: ThreadKey): boolean {
    return this.entries.delete(key);
  }
}

export const sessions = new SessionManager();
