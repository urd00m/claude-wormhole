// Per-session context + usage footer appended to each Claude reply.
//
// Both numbers come straight from the SDK result message that ClaudeRuntime
// already captures every turn (see usageSnapshot):
//   - context size = the turn's prompt tokens (input + cache_read +
//     cache_creation) — the same metered value the arch-common
//     context_length skill extracts from the transcript, but read in-process
//     so it's available on EVERY turn with no transcript-flush race (the
//     earlier skill-based version missed turns when the transcript hadn't
//     flushed yet, especially the first turn).
//   - usage = cumulative cost + subscription quota utilization.
//
// (The context_length skill is still vendored under arch-common/ for use as
// a manual /command; the footer no longer shells out to it.)

import type { SessionUsage } from "../agent/runtime/types.js";

function humanTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * The subscription-usage segment, e.g. "📊 5h 42% · wk 18% · $0.42".
 * Percentages show "n/a" when the SDK hasn't reported utilization.
 */
export function formatUsageSegment(usage: SessionUsage): string {
  const pct = (v: number | undefined): string => (typeof v === "number" ? `${Math.round(v)}%` : "n/a");
  return `📊 5h ${pct(usage.fiveHourPct)} · wk ${pct(usage.weeklyPct)} · $${usage.costUsd.toFixed(2)}`;
}

/**
 * The full footer, computed entirely from the in-process session usage:
 *   _🧠 `[▰▰▱▱▱]` 38% · 380k/1M · 📊 5h 42% · wk 18% · $0.42_
 * Context emoji escalates with fullness: 🧠 (<60%) → ⚠️ (60–84%) → 🔴 (≥85%).
 * Returns null only when there's no context measurement yet (no completed
 * turn) — otherwise it always renders, so the footer fires every turn.
 */
export function formatContextFooter(usage: SessionUsage, windowTokens: number): string | null {
  const measured = usage.contextTokens;
  if (typeof measured !== "number" || measured <= 0 || windowTokens <= 0) return null;
  const peak = usage.peakContextTokens ?? measured;
  const usedPct = Math.max(0, Math.min(100, (100 * measured) / windowTokens));
  const slots = 5;
  const filled = Math.max(0, Math.min(slots, Math.round((slots * usedPct) / 100)));
  const bar = "▰".repeat(filled) + "▱".repeat(slots - filled);
  const emoji = usedPct >= 85 ? "🔴" : usedPct >= 60 ? "⚠️" : "🧠";
  let line = `${emoji} \`[${bar}]\` ${usedPct.toFixed(0)}% · ${humanTokens(measured)}/${humanTokens(windowTokens)}`;
  if (peak - measured > 0.15 * windowTokens) line += " · compacted";
  line += ` · ${formatUsageSegment(usage)}`;
  return `_${line}_`;
}
