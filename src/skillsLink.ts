// Make the vendored arch-common command library discoverable in every Slack
// session, regardless of the per-thread working directory.
//
// Claude Code only discovers slash commands in `~/.claude/commands` (user
// scope) or `<cwd>/.claude/commands` (project scope). The agent's cwd is the
// arbitrary per-thread workdir, so project scope never points at this repo.
// The robust answer is user scope: symlink the repo's arch-common/commands
// into `~/.claude/commands`, which the SDK's settingSources default loads in
// every session. Done at boot so the user never wires it by hand.
//
// We never clobber an existing real directory or a differently-targeted
// symlink — if the user already manages ~/.claude/commands themselves, we
// step aside and report it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type LinkStatus = "linked" | "ok" | "skipped" | "missing-source";

export interface LinkResult {
  status: LinkStatus;
  message: string;
  target: string;
  source: string;
}

/**
 * Ensure `target` is a symlink to `source` (arch-common/commands → ~/.claude/
 * commands by default). Idempotent; safe to call every boot. Paths are
 * injectable for tests.
 */
export function ensureCommandsLinked(opts?: { source?: string; target?: string }): LinkResult {
  const source = opts?.source ?? path.join(REPO_ROOT, "arch-common", "commands");
  const target = opts?.target ?? path.join(os.homedir(), ".claude", "commands");
  const base = { source, target };

  if (!fs.existsSync(source)) {
    return { ...base, status: "missing-source", message: `arch-common commands not found at ${source}` };
  }

  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(target);
  } catch {
    st = undefined; // ENOENT
  }

  if (st?.isSymbolicLink()) {
    const current = fs.readlinkSync(target);
    const resolved = path.isAbsolute(current) ? current : path.resolve(path.dirname(target), current);
    if (path.resolve(resolved) === path.resolve(source)) {
      return { ...base, status: "ok", message: `~/.claude/commands already linked to ${source}` };
    }
    return {
      ...base,
      status: "skipped",
      message: `~/.claude/commands is a symlink to ${resolved} (not arch-common) — left as-is`,
    };
  }

  if (st) {
    // Real file or directory already there — don't clobber user-managed config.
    return {
      ...base,
      status: "skipped",
      message: `~/.claude/commands already exists (${st.isDirectory() ? "directory" : "file"}) — left as-is`,
    };
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);
  return { ...base, status: "linked", message: `linked ~/.claude/commands → ${source}` };
}
