import path from "node:path";
import fs from "node:fs/promises";
import { SESSIONS_DIR, env } from "../config.js";
import { Session } from "./session.js";
import { getWorkdirStore } from "./workdirStore.js";
import { getRuntimeStore, type RuntimeName } from "./runtimeStore.js";
import { getAliasStore, getActiveAliasStore, launchConfigOf } from "./aliasStore.js";
import { ClaudeRuntime } from "./runtime/claude.js";
import { CodexRuntime } from "./runtime/codex.js";
import type { AgentLaunchConfig, Runtime } from "./runtime/types.js";
import { getContinuityStore, defaultProviderHome, RecoveryRequiredError, type ContinuityStore, type Binding } from "./continuityStore.js";
import { validateNativeSession } from "./nativeSession.js";

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

  /**
   * True while a queued turn is executing — the window where
   * `session.interrupt()` has something to stop.
   */
  get busy(): boolean {
    return this.running;
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
  return resolveThreadLaunch(key).runtime;
}

/**
 * Resolve the runtime + launch config a thread should use:
 *   1. An active alias (set by invoking it in Slack) wins — its `runtime`
 *      and {model, effort, args} drive the session.
 *   2. Otherwise the per-thread runtime override, then env.DEFAULT_RUNTIME,
 *      with no launch config.
 *
 * Exposed for tests + so handlers can report the selection without
 * instantiating a runtime.
 */
export function resolveThreadLaunch(key: ThreadKey): { runtime: RuntimeName; launch?: AgentLaunchConfig } {
  const aliasName = getActiveAliasStore().get(key);
  return decideLaunch({
    aliasName,
    aliasDef: aliasName ? getAliasStore().get(aliasName) : undefined,
    runtimeOverride: getRuntimeStore().get(key),
    defaultRuntime: env.DEFAULT_RUNTIME,
  });
}

/**
 * Pure launch-resolution decision (no I/O), exported for tests:
 *   - A live alias (name present AND its definition still exists) wins,
 *     contributing both its runtime and launch config.
 *   - A dangling alias (name set but definition gone — file edited) falls
 *     through to the runtime override / default with no launch config.
 *   - No alias → runtime override, then default.
 */
export function decideLaunch(opts: {
  aliasName: string | undefined;
  aliasDef: import("./aliasStore.js").AliasDef | undefined;
  runtimeOverride: RuntimeName | undefined;
  defaultRuntime: RuntimeName;
}): { runtime: RuntimeName; launch?: AgentLaunchConfig } {
  if (opts.aliasName && opts.aliasDef) {
    return { runtime: opts.aliasDef.runtime, launch: launchConfigOf(opts.aliasDef) };
  }
  return { runtime: opts.runtimeOverride ?? opts.defaultRuntime };
}

/**
 * Build the concrete runtime instance for a thread. Kept separate from
 * `Session` construction so SessionManager.get can swap runtimes without
 * Session having to know how to build them.
 */
function buildRuntime(key: ThreadKey, workdir: string, store: ContinuityStore, binding: Binding): Runtime {
  const { runtime, launch } = binding;
  const continuity: import("./runtime/types.js").RuntimeContinuity = {
    sessionId: binding.sessionId, started: binding.started, providerHome: binding.providerHome,
    onIdentity: (identity) => { store.saveIdentity(key, identity); },
  };
  if (runtime === "codex") {
    return new CodexRuntime({ threadKey: key, workdir, launch, continuity });
  }
  return new ClaudeRuntime({ threadKey: key, workdir, launch, continuity });
}

export class SessionManager {
  private draining = false;
  constructor(private readonly store: ContinuityStore = getContinuityStore(), private readonly validate = validateNativeSession, private readonly runtimeFactory = buildRuntime) {}
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
      if (this.draining) throw new RecoveryRequiredError("Wormhole is draining for a deployment; the message remains queued.");
      const saved = this.store.get(key);
      const override = getWorkdirStore().get(key);
      let workdir: string;
      if (saved && saved.state !== "closed") {
        workdir = saved.workdir;
        if (saved.state === "ready") {
          try { this.validate(saved); }
          catch (error) {
            this.store.update(key, { state: "recovery_required", failure: { message: error instanceof Error ? error.message : String(error) } });
          }
        }
      } else if (override) {
        workdir = override;
      } else {
        const safeKey = key.replace(/[^A-Za-z0-9_-]/g, "_");
        workdir = path.join(SESSIONS_DIR, safeKey);
        await fs.mkdir(path.join(workdir, "uploads"), { recursive: true });
      }
      let binding = this.store.get(key);
      if (!binding || binding.state === "closed") {
        const resolved = resolveThreadLaunch(key);
        binding = { key, ...resolved, workdir, sessionId: null, started: false, providerHome: defaultProviderHome(resolved.runtime), state: "ready" };
        this.store.put(binding);
      }
      const runtime = this.runtimeFactory(key, workdir, this.store, binding);
      const entry = new SessionEntry(new Session({ threadKey: key, runtime }));
      entry.session.attachContinuity(this.store, key);
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
   * The existing entry for `key` WITHOUT creating one. Interrupt path:
   * a "ctrl+c" against a thread with no live session must not spin one up
   * just to find there's nothing to stop.
   */
  peek(key: ThreadKey): SessionEntry | undefined {
    return this.entries.get(key);
  }

  /**
   * Drop the in-memory session entry for `key`. Returns true if an entry was
   * removed, false if none existed. The next access rebuilds a runtime
   * using the durable conversation binding. Explicit resets call end().
   */
  close(key: ThreadKey): boolean {
    if (this.entries.get(key)?.busy) throw new RecoveryRequiredError("Wait for the active turn before unloading this session.");
    return this.entries.delete(key);
  }

  /** Explicit user operation. Process shutdown must never call this. */
  end(key: ThreadKey): boolean {
    if (this.entries.get(key)?.busy) throw new RecoveryRequiredError("Interrupt the active turn and wait for queued work before ending this conversation.");
    this.store.end(key);
    return this.close(key);
  }

  get isDraining(): boolean { return this.draining; }
  startDrain(): void { this.draining = true; }
  async drain(): Promise<void> {
    this.startDrain();
    await Promise.all(this.creating.values());
    // Enqueuing a barrier lets every previously accepted turn finish.
    await Promise.all([...this.entries.values()].map((entry) => entry.enqueue(async () => {})));
  }
}

export const sessions = new SessionManager();
