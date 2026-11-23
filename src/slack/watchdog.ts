import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { DATA_DIR } from "../config.js";
import { isAllowedSlackUser } from "./access.js";

export const WATCHDOG_ACCESS_FILE = path.join(DATA_DIR, "watchdog-access.json");
const REPORT_DIR = "/var/tmp/ucb-machine-monitor-alan";
const COMMAND = `${REPORT_DIR}/wdcheck`;
const HELP = "Usage: wdcheck [a1 ... a16] [--hours 1..24] [--top 0..20] [--details] [--json]";

/** Reload on each request; malformed/missing configuration grants nobody extra access. */
export function readWatchdogUsers(file = WATCHDOG_ACCESS_FILE): string[] {
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || !("allowed_user_ids" in data)) return [];
    const ids = data.allowed_user_ids;
    if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && /^U[A-Z0-9]+$/.test(id))) return [];
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

export function canUseWatchdog(user: string | undefined): boolean {
  return !!user && (isAllowedSlackUser(user) || readWatchdogUsers().includes(user));
}

export type WatchdogCommand = { args: string[]; error?: string };

/** Accept a tiny command grammar, never shell syntax or caller-selected paths. */
export function parseWatchdogCommand(text: string): WatchdogCommand | null {
  const tokens = text.replace(/^\s*<@[^>]+>\s*/, "").trim().split(/\s+/);
  if (!["wdcheck", "!wdcheck", `!${COMMAND}`].includes(tokens[0])) return null;
  const args: string[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (/^a(?:[1-9]|1[0-6])$/.test(token)) {
      args.push(token);
    } else if (["--details", "--json", "--help"].includes(token) && !seen.has(token)) {
      seen.add(token);
      args.push(token);
    } else if (["--hours", "--top"].includes(token) && !seen.has(token)) {
      seen.add(token);
      const raw = tokens[++i];
      if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return { args: [], error: HELP };
      const value = Number(raw);
      if (token === "--hours" ? !(value > 0 && value <= 24) : !(Number.isInteger(value) && value >= 0 && value <= 20)) {
        return { args: [], error: HELP };
      }
      args.push(token, raw);
    } else {
      return { args: [], error: HELP };
    }
  }
  return { args };
}

let running = 0;
export async function runWatchdog(args: string[]): Promise<string> {
  // Validate again at the execution boundary, including direct internal callers.
  const command = parseWatchdogCommand(["wdcheck", ...args].join(" "));
  if (!command || command.error || JSON.stringify(command.args) !== JSON.stringify(args)) return HELP;
  if (running >= 2) return "Two watchdog reports are already running. Please try again shortly.";
  running++;
  try {
    return await new Promise<string>(resolve => {
      execFile("/usr/bin/python3", [path.join(REPORT_DIR, "wdcheck.py"), "--from-report", path.join(REPORT_DIR, "report.json"), ...args], {
        cwd: REPORT_DIR, timeout: 10_000, maxBuffer: 24 * 1024, encoding: "utf8", shell: false,
      }, (error, stdout, stderr) => {
        const output = stdout.trim();
        if (error) {
          const reason = error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "Report was truncated. Select one host or fewer users with --top."
            : error.killed ? "Report timed out. Please try again." : "Report failed; the shared report may be unavailable.";
          resolve(output ? `${output}\n\n${reason}` : `${reason}\n${stderr.trim()}`);
        } else {
          resolve(output || "No report output was produced.");
        }
      });
    });
  } finally {
    running--;
  }
}

export type WatchdogRoute = {
  allowed: (user: string | undefined) => boolean;
  run: (args: string[]) => Promise<string>;
};
export const watchdogRoute: WatchdogRoute = { allowed: canUseWatchdog, run: runWatchdog };
