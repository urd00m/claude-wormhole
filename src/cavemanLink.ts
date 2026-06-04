// Boot-time prep for the caveman compression feature.
//
// Two outputs:
//   1. data/wormhole-claude-settings.json — a wormhole-owned Claude Code
//      settings file (passed to the bundled CLI via the SDK's
//      `extraArgs.settings`). It points at the vendored caveman hooks in
//      arch-common/caveman/hooks/ and sets the level via the
//      CAVEMAN_DEFAULT_MODE env var (which the hooks read).
//   2. cached caveman SKILL.md text, used by CodexRuntime as a per-prompt
//      preamble (Codex doesn't have a SessionStart hook concept, so we
//      inject the ruleset at prompt time instead).
//
// All paths absolute so the settings file is portable across cwds. The
// generated settings file is idempotent — same content every boot when
// nothing upstream changes.
//
// What stays untouched on disk: ~/.claude/, ~/.codex/, and the user's
// global config files. Everything caveman-related lives under the repo
// (arch-common/caveman/) or under data/ (gitignored).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./config.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CAVEMAN_DIR = path.join(REPO_ROOT, "arch-common", "caveman");
const HOOKS_DIR = path.join(CAVEMAN_DIR, "hooks");
const SKILL_PATH = path.join(CAVEMAN_DIR, "skills", "caveman", "SKILL.md");
const SETTINGS_OUT = path.join(DATA_DIR, "wormhole-claude-settings.json");

export interface CavemanArtifacts {
  /** Absolute path to the generated wormhole-owned Claude settings file. */
  settingsPath: string;
  /** Full SKILL.md text used as the Codex prompt preamble when caveman is on. */
  skillText: string;
}

let _cached: CavemanArtifacts | null = null;

/**
 * Generate (or refresh) the wormhole-owned Claude settings file and cache
 * the Codex preamble text. Idempotent — safe to call every boot.
 *
 * Returns null when the vendored caveman directory is missing (e.g. a
 * partial checkout). The bot keeps booting; toggling caveman just won't
 * have anything to point at.
 */
export function ensureCavemanReady(): CavemanArtifacts | null {
  if (_cached) return _cached;

  if (!fs.existsSync(HOOKS_DIR) || !fs.existsSync(SKILL_PATH)) {
    return null;
  }

  // Read SKILL.md once at boot — used by CodexRuntime as a prompt preamble.
  let skillText = "";
  try {
    skillText = fs.readFileSync(SKILL_PATH, "utf8");
  } catch {
    return null;
  }

  // Generate the Claude settings file. The hook entries match the schema
  // caveman's own installer writes into ~/.claude/settings.json, but with
  // wormhole-owned absolute paths to the vendored hook scripts.
  const activateScript = path.join(HOOKS_DIR, "caveman-activate.js");
  const trackerScript = path.join(HOOKS_DIR, "caveman-mode-tracker.js");

  const settings = {
    // Hook spec format documented at:
    //   https://docs.claude.com/en/docs/claude-code/hooks
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [{ type: "command", command: `node ${shellQuote(activateScript)}` }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{ type: "command", command: `node ${shellQuote(trackerScript)}` }],
        },
      ],
    },
  };

  fs.mkdirSync(path.dirname(SETTINGS_OUT), { recursive: true });
  fs.writeFileSync(SETTINGS_OUT, JSON.stringify(settings, null, 2) + "\n");

  _cached = { settingsPath: SETTINGS_OUT, skillText };
  return _cached;
}

/** Test-only: reset cache so a re-call regenerates. */
export function _resetCavemanArtifactsForTests(): void {
  _cached = null;
}

/** Test-only: get a pristine copy with custom paths. */
export function ensureCavemanReadyAt(opts: {
  cavemanDir: string;
  outFile: string;
}): CavemanArtifacts | null {
  const hooksDir = path.join(opts.cavemanDir, "hooks");
  const skillPath = path.join(opts.cavemanDir, "skills", "caveman", "SKILL.md");
  if (!fs.existsSync(hooksDir) || !fs.existsSync(skillPath)) return null;
  let skillText = "";
  try {
    skillText = fs.readFileSync(skillPath, "utf8");
  } catch {
    return null;
  }
  const activateScript = path.join(hooksDir, "caveman-activate.js");
  const trackerScript = path.join(hooksDir, "caveman-mode-tracker.js");
  const settings = {
    hooks: {
      SessionStart: [
        { matcher: "", hooks: [{ type: "command", command: `node ${shellQuote(activateScript)}` }] },
      ],
      UserPromptSubmit: [
        { matcher: "", hooks: [{ type: "command", command: `node ${shellQuote(trackerScript)}` }] },
      ],
    },
  };
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, JSON.stringify(settings, null, 2) + "\n");
  return { settingsPath: opts.outFile, skillText };
}

/**
 * Build the Codex prompt preamble for a given level. Returns "" when level
 * is "off". Otherwise: a small instruction blurb + the cached SKILL.md
 * text. Prepended to the user's prompt at `CodexRuntime.send()` time —
 * Codex has no SessionStart hook concept, so we inject per-turn.
 */
export function buildCodexCavemanPreamble(level: string, skillText: string): string {
  if (level === "off" || !skillText) return "";
  return (
    `[CAVEMAN MODE — level: ${level}]\n` +
    `Follow the caveman compression rules below for your entire response. ` +
    `Code blocks, paths, URLs, and quoted errors must remain verbatim.\n\n` +
    skillText +
    `\n\n---\n\n`
  );
}

function shellQuote(s: string): string {
  // Minimal: wrap in single quotes; escape any embedded single quotes.
  if (!/[\s"'$`\\]/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
