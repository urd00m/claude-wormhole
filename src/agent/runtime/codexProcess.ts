// Subprocess seam for the Codex CLI. Carved out so CodexRuntime can be
// unit-tested without actually spawning `codex` (and without spending real
// API/subscription credits) — tests inject a fake CodexProcessFactory that
// yields hand-crafted JSONL lines.
//
// The Codex CLI surface this targets (v0.133.0, codex-rs / Homebrew install):
//
//   codex exec [OPTIONS] [PROMPT]
//   codex exec resume [OPTIONS] <SESSION_ID> [PROMPT]
//
// We always pass:
//   --json                                — one JSONL event per stdout line
//   --skip-git-repo-check                 — wormhole sandbox dirs aren't repos
//   --cd <workdir>                        — per-thread cwd
//   -m <model>                            — picked from OPENAI_MODEL env
//   --sandbox workspace-write             — coarse blast-radius bound
//   --dangerously-bypass-approvals-and-sandbox
//                                          — Codex has no canUseTool-style
//                                            per-command IPC hook; we disable
//                                            its interactive approval layer
//                                            and rely on the wormhole's
//                                            classifier + MCP gating where
//                                            it applies. The consent-gate
//                                            gap on Codex's native shell is
//                                            documented separately.
//   --add-dir /                           — fs visibility beyond cwd, mirrors
//                                            Claude's additionalDirectories
//   -o <last-message-file>                — authoritative final agent text
//
// Auth: when OPENAI_API_KEY is unset/empty we let the Codex CLI fall back to
// ~/.codex/auth.json (populated by `codex login`). This mirrors the
// ANTHROPIC_API_KEY behavior in ClaudeRuntime.

import { spawn } from "node:child_process";
import readline from "node:readline";

export type CodexProcessOpts = {
  /** CLI arguments AFTER the `codex` executable, e.g. ["exec", "--json", ...]. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export interface CodexProcess {
  /** Async iterator over stdout, one JSONL line at a time (no trailing newline). */
  lines(): AsyncIterable<string>;
  /** Resolves with the full stderr buffer once the process exits. */
  stderr(): Promise<string>;
  /** Resolves with the exit code once the process exits (`null` if killed by signal). */
  wait(): Promise<number | null>;
  /** Best-effort kill. */
  kill(signal?: NodeJS.Signals): void;
}

export type CodexProcessFactory = (opts: CodexProcessOpts) => CodexProcess;

/**
 * Real implementation: spawn the `codex` binary on PATH and stream stdout
 * line-by-line. `readline.createInterface` handles the line-buffering and
 * returns an async iterator, so consumers can `for await ... of proc.lines()`.
 *
 * stderr is collected into a single buffer (we surface it on non-zero
 * exits). Streaming stderr separately would be possible but the Codex CLI
 * only writes there on failure, so a single read at the end is enough.
 */
export const spawnCodexProcess: CodexProcessFactory = (opts) => {
  const child = spawn("codex", opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });

  const stderrPromise = new Promise<string>((resolve) => {
    child.on("close", () => resolve(Buffer.concat(stderrChunks).toString("utf8")));
  });

  const lines = (): AsyncIterable<string> => {
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    return rl;
  };

  return {
    lines,
    stderr: () => stderrPromise,
    wait: () => exitPromise,
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      if (!child.killed) child.kill(signal);
    },
  };
};
