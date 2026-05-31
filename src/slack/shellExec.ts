// Shell executor for the `!`-prefix passthrough. Deliberately small —
// no agent, no MCP, no canUseTool gate. The trusted Slack user is
// requesting a direct shell command in the thread's workdir; we run it
// and return stdout/stderr/exit code as a single result object.
//
// Guards:
//   - 60s wall-clock timeout (kill PID + group).
//   - 32 KB stdout cap and 32 KB stderr cap. Past the cap, output is
//     truncated and a `[…truncated]` marker is appended (so we never
//     OOM the bot streaming a huge `cat`).
//   - Uses `bash -lc <cmd>` so shell syntax (pipes, redirects, $VAR)
//     works as the user expects, and login shell picks up their PATH
//     additions from .bashrc/.bash_profile.
//
// No interactivity: stdin is closed. A command that prompts for input
// will hang until the timeout fires; that's acceptable for a fire-and-
// forget shell shortcut.

import { spawn } from "node:child_process";

export interface ShellExecOpts {
  cwd: string;
  timeoutMs?: number;
  /** Per-stream cap in bytes. Defaults to 32 KB. */
  maxOutputBytes?: number;
}

export interface ShellExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; null when killed by signal (incl. timeout). */
  exitCode: number | null;
  /** Signal that terminated the process, if any. */
  signal: NodeJS.Signals | null;
  /** True when we killed it due to timeoutMs. */
  timedOut: boolean;
  /** True when either stream hit maxOutputBytes. */
  truncated: boolean;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;

export async function shellExec(command: string, opts: ShellExecOpts): Promise<ShellExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cap = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const startedAt = Date.now();

  return await new Promise<ShellExecResult>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so we can kill the whole tree on timeout.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const collect = (stream: NodeJS.ReadableStream, into: (chunk: string) => void) => {
      stream.on("data", (chunk: Buffer) => {
        into(chunk.toString("utf8"));
      });
    };
    collect(child.stdout, (s) => {
      if (Buffer.byteLength(stdout, "utf8") >= cap) {
        truncated = true;
        return;
      }
      stdout += s;
      if (Buffer.byteLength(stdout, "utf8") > cap) {
        stdout = stdout.slice(0, cap);
        truncated = true;
      }
    });
    collect(child.stderr, (s) => {
      if (Buffer.byteLength(stderr, "utf8") >= cap) {
        truncated = true;
        return;
      }
      stderr += s;
      if (Buffer.byteLength(stderr, "utf8") > cap) {
        stderr = stderr.slice(0, cap);
        truncated = true;
      }
    });

    killTimer = setTimeout(() => {
      timedOut = true;
      // Negative pid = kill the whole process group.
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        /* ignore */
      }
      // Hard-kill if SIGTERM didn't finish it in another second.
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
      }, 1000);
    }, timeoutMs);

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + `spawn error: ${err.message}`,
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Render a shellExec result as a Slack-friendly reply: command echo,
 * stdout (if any), stderr (if any), and a short footer line covering
 * exit code, duration, and any truncation/timeout markers. Each output
 * block goes inside a triple-backtick fence so Slack monospace-renders
 * it cleanly.
 */
export function formatShellResultForSlack(command: string, r: ShellExecResult, cwd: string): string {
  const parts: string[] = [];
  parts.push(`> \`!${command}\``);
  if (r.stdout) {
    parts.push("```\n" + r.stdout.replace(/```/g, "`​``") + (r.stdout.endsWith("\n") ? "" : "\n") + "```");
  }
  if (r.stderr) {
    parts.push("_stderr:_\n```\n" + r.stderr.replace(/```/g, "`​``") + (r.stderr.endsWith("\n") ? "" : "\n") + "```");
  }
  if (!r.stdout && !r.stderr) {
    parts.push("_(no output)_");
  }
  const footerBits: string[] = [];
  if (r.timedOut) {
    footerBits.push("⏱ timed out");
  } else if (r.signal) {
    footerBits.push(`killed by ${r.signal}`);
  } else if (r.exitCode !== 0) {
    footerBits.push(`exit ${r.exitCode}`);
  }
  if (r.truncated) footerBits.push("output truncated");
  footerBits.push(`${(r.durationMs / 1000).toFixed(1)}s`);
  footerBits.push(`in \`${cwd}\``);
  parts.push(`_${footerBits.join(" · ")}_`);
  return parts.join("\n");
}
