// Per-session context-usage indicator. Computes how full a Claude thread's
// context window is by delegating to the arch-common `context_length` skill
// (scripts/context_length.py), which reads the session transcript's API
// usage — the exact metered prompt size, not an estimate. The result is
// rendered as a compact footer appended to the bot's reply.
//
// We shell out to the skill rather than reimplement it because (a) the user
// asked to use the skill, and (b) it already handles session targeting,
// the one-turn lag, compaction, and window tiers correctly.

import { execFile } from "node:child_process";
import path from "node:path";
import { ROOT_DIR, env } from "../config.js";
import type { SessionUsage } from "../agent/runtime/types.js";

export type ContextUsage = {
  measured: number;
  window: number;
  usedPct: number;
  peak: number;
  /** True when context dropped well below peak — a compaction likely happened. */
  compaction: boolean;
};

/**
 * Runs the context_length skill for a session id and returns its raw stdout
 * (expected to be the `--json` block). Throws on non-zero exit / no
 * transcript. Injectable so tests don't need python or a real transcript.
 */
export type ContextRunner = (sessionId: string, windowTokens: number) => Promise<string>;

const defaultRunner: ContextRunner = (sessionId, windowTokens) =>
  new Promise((resolve, reject) => {
    const script = path.join(ROOT_DIR, "arch-common", "scripts", "context_length.py");
    execFile(
      "python3",
      [script, sessionId, "--json", "--window", String(windowTokens)],
      { timeout: 10_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || "").trim() || err.message));
        else resolve(stdout);
      },
    );
  });

/**
 * Measure a Claude session's context usage. Returns null on ANY failure
 * (no transcript yet, python missing, malformed output, etc.) — the
 * indicator is best-effort and must never break a reply.
 */
export async function getContextUsage(
  sessionId: string,
  opts?: { windowTokens?: number; runner?: ContextRunner },
): Promise<ContextUsage | null> {
  const windowTokens = opts?.windowTokens ?? env.CONTEXT_WINDOW_TOKENS;
  const runner = opts?.runner ?? defaultRunner;
  try {
    const out = await runner(sessionId, windowTokens);
    const j = JSON.parse(out) as Record<string, unknown>;
    const measured = j.measured_prompt_tokens;
    const window = j.window;
    if (typeof measured !== "number" || typeof window !== "number" || window <= 0) return null;
    const peak = typeof j.peak_prompt_tokens === "number" ? j.peak_prompt_tokens : measured;
    const usedPct = typeof j.used_pct === "number" ? j.used_pct : (100 * measured) / window;
    return {
      measured,
      window,
      usedPct,
      peak,
      compaction: peak - measured > 0.15 * window,
    };
  } catch {
    return null;
  }
}

function humanTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Render the session-usage segment, e.g. "📊 $0.42 · 1.5M tok". */
export function formatUsageSegment(usage: SessionUsage): string {
  const total = usage.inputTokens + usage.outputTokens;
  return `📊 $${usage.costUsd.toFixed(2)} · ${humanTokens(total)} tok`;
}

/**
 * Render the one-line footer, e.g.:
 *   _🧠 `[▰▰▱▱▱]` 38% · 380k/1M · 📊 $0.42 · 1.5M tok_
 * Context emoji escalates with fullness: 🧠 (<60%) → ⚠️ (60–84%) → 🔴 (≥85%).
 * The usage segment is appended when session usage is available.
 */
export function formatContextFooter(u: ContextUsage, usage?: SessionUsage | null): string {
  const pct = Math.max(0, Math.min(100, u.usedPct));
  const slots = 5;
  const filled = Math.max(0, Math.min(slots, Math.round((slots * pct) / 100)));
  const bar = "▰".repeat(filled) + "▱".repeat(slots - filled);
  const emoji = pct >= 85 ? "🔴" : pct >= 60 ? "⚠️" : "🧠";
  let line = `${emoji} \`[${bar}]\` ${pct.toFixed(0)}% · ${humanTokens(u.measured)}/${humanTokens(u.window)}`;
  if (u.compaction) line += " · compacted";
  if (usage) line += ` · ${formatUsageSegment(usage)}`;
  return `_${line}_`;
}
