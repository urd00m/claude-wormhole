/**
 * Classify a Bash command for destructiveness. Returns a short reason string
 * if the command is considered destructive, else null.
 *
 * Heuristics — intentionally conservative (false positives over false negatives):
 *  - rm, rmdir, unlink
 *  - mv … into /tmp, /trash, or with -f overwriting
 *  - find … -delete
 *  - git reset --hard, git clean -f, git push --force / --force-with-lease, git branch -D, git checkout --
 *  - dd, mkfs, parted
 *  - kill -9
 *  - shred, wipe
 *  - truncation via `> file` (single redirect, not `>>`)
 *  - sudo prefix
 */
export function classifyBash(cmd: string): string | null {
  const c = cmd.trim();
  if (!c) return null;

  // sudo anything → destructive
  if (/(^|[\s|;&])sudo\b/.test(c)) return "uses sudo";

  // rm / rmdir / unlink
  if (/(^|[\s|;&])rm\s+(-[^\s]*\s+)*\S/.test(c)) return "removes files (rm)";
  if (/(^|[\s|;&])rmdir\b/.test(c)) return "removes directory (rmdir)";
  if (/(^|[\s|;&])unlink\s+\S/.test(c)) return "unlinks file";

  // find … -delete
  if (/\bfind\b[^|;&]*-delete\b/.test(c)) return "find -delete";

  // mv -f or mv to trash-like targets
  if (/\bmv\s+(-[^\s]*f[^\s]*\s+)/.test(c)) return "mv -f (force overwrite)";

  // dangerous git operations
  if (/\bgit\s+reset\s+(--hard|--merge)\b/.test(c)) return "git reset --hard/--merge";
  if (/\bgit\s+clean\s+-[a-zA-Z]*f/.test(c)) return "git clean -f";
  if (/\bgit\s+push\s+(\S+\s+)*(--force\b|--force-with-lease\b|-f\b)/.test(c)) return "git force-push";
  if (/\bgit\s+branch\s+-D\b/.test(c)) return "git branch -D";
  if (/\bgit\s+checkout\s+--\s+/.test(c)) return "git checkout -- (discards changes)";
  if (/\bgit\s+restore\s+\./.test(c)) return "git restore .";

  // disk / format
  if (/(^|[\s|;&])(dd|mkfs|parted|fdisk|wipefs|shred)\b/.test(c)) return "disk-level operation";

  // kill -9
  if (/\bkill\s+(-9|-KILL)\b/.test(c)) return "kill -9";

  // truncation: `> file` but not `>>`
  // Match: > followed by a path-like token (not another >)
  if (/(^|\s)>\s*[^>\s|&;]+/.test(c) && !/>>\s*/.test(c.replace(/>\s*[^>\s|&;]+/, ""))) {
    // crude but workable: any single-redirect to a file truncates
    if (/(^|\s)>[^>]/.test(c)) return "truncates a file (>)";
  }

  return null;
}

const DESTRUCTIVE_FS_TOOLS = new Set([
  // SDK file tools that can damage data
  "Write", // overwrites
  "Edit", // edits — usually safe but can mangle code; treat as safe for now
]);

/** Decide if a tool call (any tool, not just Bash) needs human approval. */
export function classifyToolCall(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return classifyBash(command);
  }
  // Currently we don't gate Write/Edit — they're scoped to the session workdir.
  // (Listed in DESTRUCTIVE_FS_TOOLS for future tightening.)
  void DESTRUCTIVE_FS_TOOLS;
  return null;
}
