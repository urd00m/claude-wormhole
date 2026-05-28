// Per-session context + usage footer appended to each Claude reply.
//
// All numbers come straight from the SDK result message that ClaudeRuntime
// captures every turn (see usageSnapshot):
//   - context size = the LAST iteration's input + cache_read + cache_creation
//     (per Anthropic SDK: "Calculate the true context window size from the
//     last iteration"). Top-level usage fields are summed across iterations
//     and would overshoot on multi-iteration turns; we pull from
//     usage.iterations[last] to avoid that.
//   - window = result.modelUsage[model].contextWindow when reported by the
//     SDK; falls back to env.CONTEXT_WINDOW_TOKENS otherwise.
//   - cost = SDK's total_cost_usd, summed across turns. This is the
//     equivalent API price the SDK computes from per-model token rates; on a
//     Claude subscription account it is NOTIONAL (you don't actually pay
//     per-token under a quota plan) and is shown as "$~X.XX" to flag that.
//   - subscription quota % = forwarded from SDK rate_limit_event (same
//     protocol the interactive `claude` CLI uses). The server omits
//     `utilization` at low usage, so the field shows "n/a" until your quota
//     is high enough for the server to report it — no client (CLI or SDK)
//     has access to a richer feed.
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
 * The subscription-usage segment, e.g. "📊 5h 42% · wk 18% · $~0.42".
 * Percentages show "n/a" when the SDK hasn't reported utilization. The "~"
 * before the dollar amount flags that on a Claude subscription it's an
 * equivalent-API price, not real money you pay under your quota plan.
 */
export function formatUsageSegment(usage: SessionUsage): string {
  const pct = (v: number | undefined): string => (typeof v === "number" ? `${Math.round(v)}%` : "n/a");
  return `📊 5h ${pct(usage.fiveHourPct)} · wk ${pct(usage.weeklyPct)} · $~${usage.costUsd.toFixed(2)}`;
}

/**
 * The full footer, computed entirely from the in-process session usage:
 *   _🧠 `[▰▰▱▱▱]` 38% · 380k/1M · 📊 5h 42% · wk 18% · $~0.42_
 * Context emoji escalates with fullness: 🧠 (<60%) → ⚠️ (60–84%) → 🔴 (≥85%).
 * Window comes from the SDK's reported model contextWindow when available,
 * else from `fallbackWindowTokens` (env.CONTEXT_WINDOW_TOKENS).
 * Returns null only when there's no context measurement yet (no completed
 * turn) — otherwise it always renders, so the footer fires every turn.
 */
export function formatContextFooter(usage: SessionUsage, fallbackWindowTokens: number): string | null {
  const measured = usage.contextTokens;
  const window = usage.contextWindowTokens ?? fallbackWindowTokens;
  if (typeof measured !== "number" || measured <= 0 || window <= 0) return null;
  const peak = usage.peakContextTokens ?? measured;
  const usedPct = Math.max(0, Math.min(100, (100 * measured) / window));
  const slots = 5;
  const filled = Math.max(0, Math.min(slots, Math.round((slots * usedPct) / 100)));
  const bar = "▰".repeat(filled) + "▱".repeat(slots - filled);
  const emoji = usedPct >= 85 ? "🔴" : usedPct >= 60 ? "⚠️" : "🧠";
  let line = `${emoji} \`[${bar}]\` ${usedPct.toFixed(0)}% · ${humanTokens(measured)}/${humanTokens(window)}`;
  if (peak - measured > 0.15 * window) line += " · compacted";
  line += ` · ${formatUsageSegment(usage)}`;
  return `_${line}_`;
}
