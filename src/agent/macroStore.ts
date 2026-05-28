// User-defined text macros. A macro is just a name → expansion string;
// when a macro name appears as a whitespace-delimited token in an incoming
// message, it's replaced by its expansion before the agent sees the
// message. Pure text substitution — the expansion layer doesn't interpret
// what the string says (e.g. "swd" → "Work in /Users/me/code/foo and use
// its CLAUDE.md" just becomes that text; the agent does the workdir change
// with its normal tools).
//
// The macro file (data/macros.json) is HAND-EDITED by the user — there's no
// add/remove tool. To make edits take effect without a bot restart, the
// store re-reads the file whenever its mtime changes.

import fs from "node:fs";
import path from "node:path";
import { MACROS_FILE } from "../config.js";

export type MacroMap = Record<string, string>;

/** A macro name must be a single non-whitespace token to ever match. */
export function isValidMacroName(name: string): boolean {
  return name.length > 0 && !/\s/.test(name);
}

export class MacroStore {
  private readonly file: string;
  private cache: MacroMap = {};
  private cachedMtimeMs = -1;

  constructor(file: string = MACROS_FILE) {
    this.file = file;
  }

  /** Current macros, re-reading the file if it changed since last access. */
  all(): MacroMap {
    this.refreshIfStale();
    return this.cache;
  }

  /** Define/overwrite a macro and persist. Throws on an invalid name. */
  set(name: string, expansion: string): void {
    if (!isValidMacroName(name)) throw new Error(`invalid macro name '${name}' (no whitespace, non-empty)`);
    this.refreshIfStale();
    this.cache[name] = expansion;
    this.save();
  }

  /** Remove a macro and persist. Returns true if it existed. */
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
    // Adopt the file's new mtime so the next all() doesn't needlessly reload.
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
      // Missing file → no macros. Reset cache so deleting the file clears them.
      this.cache = {};
      this.cachedMtimeMs = -1;
      return;
    }
    if (mtimeMs === this.cachedMtimeMs) return;
    this.cachedMtimeMs = mtimeMs;
    this.cache = this.load();
  }

  private load(): MacroMap {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      const out: MacroMap = {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, expansion] of Object.entries(parsed)) {
          // Drop empty/whitespace names and non-string expansions — a name
          // with whitespace could never match a token anyway, and a
          // non-string expansion can't be substituted.
          if (typeof expansion !== "string") continue;
          if (name.trim().length === 0 || /\s/.test(name)) continue;
          out[name] = expansion;
        }
      }
      return out;
    } catch (err) {
      console.warn(
        `[macros] failed to load ${this.file}: ${err instanceof Error ? err.message : err}`,
      );
      return {};
    }
  }
}

/**
 * Expand every macro occurrence in `text`. A macro fires only when it is a
 * whole whitespace-delimited token that EXACTLY (case-sensitively) equals a
 * macro name — so `swd` expands but `swder` and `Swd` do not, and
 * punctuation-glued tokens like `swd,` are left alone. Original whitespace
 * is preserved exactly.
 *
 * Pure function (macros passed in) so it's trivially testable and has no
 * filesystem dependency.
 */
export function expandMacros(text: string, macros: MacroMap): string {
  if (!text) return text;
  // split(/(\s+)/) yields alternating tokens and whitespace runs, both
  // preserved, so join("") reproduces the original spacing exactly. A
  // whitespace segment can never equal a macro name (names reject
  // whitespace at load), so only real tokens get substituted.
  return text
    .split(/(\s+)/)
    .map((seg) => (Object.prototype.hasOwnProperty.call(macros, seg) ? macros[seg] : seg))
    .join("");
}

let _singleton: MacroStore | null = null;
export function getMacroStore(): MacroStore {
  if (!_singleton) _singleton = new MacroStore();
  return _singleton;
}
