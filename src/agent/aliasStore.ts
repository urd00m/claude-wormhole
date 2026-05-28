// Launch aliases — named agent configurations, distinct from macros.
// A macro expands text; an alias LAUNCHES an agent with a specific
// runtime + model + effort + extra CLI args. Invoked as the first token of
// a Slack message:
//
//     <alias> [workdir] [prompt...]
//
// e.g. `custom_claude ~/code/M5CacheRE review the readme` launches the
// custom_claude agent in that directory and runs "review the readme".
// Workdir is an optional positional arg (not part of the alias definition),
// so one alias can be pointed at any project.
//
// Definitions live in data/aliases.json (hand-edited, mtime-cached). The
// per-thread "which alias is active" pointer lives in data/thread-aliases.json.

import fs from "node:fs";
import path from "node:path";
import { ALIASES_FILE, THREAD_ALIASES_FILE, DATA_DIR } from "../config.js";
import type { AgentLaunchConfig, EffortLevel } from "./runtime/types.js";
import type { RuntimeName } from "./runtimeStore.js";

const VALID_RUNTIMES: ReadonlySet<string> = new Set(["claude", "codex"]);
const VALID_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export type AliasDef = {
  runtime: RuntimeName;
  model?: string;
  effort?: EffortLevel;
  /** Codex only: extra `codex exec` argv tokens. */
  codexArgs?: string[];
  /** Claude only: SDK extraArgs (flag without `--` → value, or null for boolean). */
  claudeArgs?: Record<string, string | null>;
};

/** The launch config an alias contributes (everything except runtime). */
export function launchConfigOf(def: AliasDef): AgentLaunchConfig {
  return { model: def.model, effort: def.effort, codexArgs: def.codexArgs, claudeArgs: def.claudeArgs };
}

export class AliasStore {
  private readonly file: string;
  private cache: Record<string, AliasDef> = {};
  private cachedMtimeMs = -1;

  constructor(file: string = ALIASES_FILE) {
    this.file = file;
  }

  get(name: string): AliasDef | undefined {
    this.refreshIfStale();
    return this.cache[name];
  }

  names(): string[] {
    this.refreshIfStale();
    return Object.keys(this.cache);
  }

  all(): Record<string, AliasDef> {
    this.refreshIfStale();
    return this.cache;
  }

  /** Define/overwrite an alias and persist. Throws on an invalid name/def. */
  set(name: string, def: AliasDef): void {
    if (name.trim().length === 0 || /\s/.test(name)) {
      throw new Error(`invalid alias name '${name}' (no whitespace, non-empty)`);
    }
    const clean = validateDef(def);
    if (!clean) throw new Error(`invalid alias definition for '${name}' (need runtime: claude|codex)`);
    this.refreshIfStale();
    this.cache[name] = clean;
    this.save();
  }

  /** Remove an alias and persist. Returns true if it existed. */
  remove(name: string): boolean {
    this.refreshIfStale();
    if (!(name in this.cache)) return false;
    delete this.cache[name];
    this.save();
    return true;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.cache, null, 2));
    try {
      this.cachedMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      /* best-effort */
    }
  }

  private refreshIfStale(): void {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.cache = {};
      this.cachedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.cachedMtimeMs) return;
    this.cachedMtimeMs = mtimeMs;
    this.cache = this.load();
  }

  private load(): Record<string, AliasDef> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const out: Record<string, AliasDef> = {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, raw] of Object.entries(parsed)) {
          const def = validateDef(raw);
          // Reject empty/whitespace names (couldn't be a message token).
          if (def && name.trim().length > 0 && !/\s/.test(name)) out[name] = def;
        }
      }
      return out;
    } catch (err) {
      console.warn(`[aliases] failed to load ${this.file}: ${err instanceof Error ? err.message : err}`);
      return {};
    }
  }
}

/** Validate one raw alias entry; returns a clean AliasDef or null if invalid. */
function validateDef(raw: unknown): AliasDef | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.runtime !== "string" || !VALID_RUNTIMES.has(r.runtime)) return null;
  const def: AliasDef = { runtime: r.runtime as RuntimeName };
  if (typeof r.model === "string" && r.model.length > 0) def.model = r.model;
  if (typeof r.effort === "string" && VALID_EFFORTS.has(r.effort)) def.effort = r.effort as EffortLevel;
  if (Array.isArray(r.codexArgs) && r.codexArgs.every((a) => typeof a === "string")) {
    def.codexArgs = r.codexArgs as string[];
  }
  // claudeArgs: a flat object of string|null values (SDK extraArgs shape).
  if (typeof r.claudeArgs === "object" && r.claudeArgs !== null && !Array.isArray(r.claudeArgs)) {
    const ca: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(r.claudeArgs as Record<string, unknown>)) {
      if (v === null || typeof v === "string") ca[k] = v as string | null;
    }
    if (Object.keys(ca).length > 0) def.claudeArgs = ca;
  }
  return def;
}

/**
 * Per-thread active-alias pointer. When a thread is "launched" under an
 * alias, its name is recorded here so SessionManager applies that alias's
 * runtime + launch config on (re)build. Persisted so it survives restarts,
 * like the workdir/runtime stores.
 */
export class ActiveAliasStore {
  private map = new Map<string, string>();
  private readonly file: string;

  constructor(file: string = THREAD_ALIASES_FILE) {
    this.file = file;
    this.load();
  }

  get(threadKey: string): string | undefined {
    return this.map.get(threadKey);
  }
  set(threadKey: string, aliasName: string): void {
    this.map.set(threadKey, aliasName);
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
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string") this.map.set(k, v);
        }
      }
    } catch (err) {
      console.warn(`[thread-aliases] failed to load ${this.file}: ${err instanceof Error ? err.message : err}`);
    }
  }
  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of this.map) obj[k] = v;
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2));
  }
}

/**
 * Parse a message against known alias names. Returns null when the first
 * token isn't an alias (normal message). When it is, splits off the
 * optional workdir (token 2) and the remaining prompt. Macro expansion of
 * the workdir/prompt is the caller's job — this is pure tokenization.
 */
export function parseAliasInvocation(
  text: string,
  aliasNames: ReadonlySet<string>,
): { alias: string; workdirArg: string | null; prompt: string } | null {
  const trimmed = text.trimStart();
  const firstSpace = trimmed.search(/\s/);
  const first = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  if (!aliasNames.has(first)) return null;

  const afterAlias = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trimStart();
  if (afterAlias.length === 0) {
    return { alias: first, workdirArg: null, prompt: "" };
  }
  const sp2 = afterAlias.search(/\s/);
  const workdirArg = sp2 === -1 ? afterAlias : afterAlias.slice(0, sp2);
  const prompt = sp2 === -1 ? "" : afterAlias.slice(sp2).trimStart();
  return { alias: first, workdirArg, prompt };
}

let _aliasStore: AliasStore | null = null;
export function getAliasStore(): AliasStore {
  if (!_aliasStore) _aliasStore = new AliasStore();
  return _aliasStore;
}

let _activeAliasStore: ActiveAliasStore | null = null;
export function getActiveAliasStore(): ActiveAliasStore {
  if (!_activeAliasStore) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    _activeAliasStore = new ActiveAliasStore();
  }
  return _activeAliasStore;
}
