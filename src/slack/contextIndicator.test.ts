// Verify the context + usage footer, now computed entirely from the
// in-process SessionUsage (no skill / no subprocess). The key property:
// it renders on EVERY turn that has a context measurement.

import { formatContextFooter, formatUsageSegment } from "./contextIndicator.js";
import type { SessionUsage } from "../agent/runtime/types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function mk(over: Partial<SessionUsage>): SessionUsage {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 1,
    contextTokens: 0,
    peakContextTokens: 0,
    ...over,
  };
}

const WINDOW = 1_000_000;

async function main() {
  // ============ formatUsageSegment ============
  {
    const seg = formatUsageSegment(mk({ costUsd: 0.42, fiveHourPct: 42, weeklyPct: 18.4 }));
    assert(seg.includes("5h 42%"), `5h pct: ${seg}`);
    assert(seg.includes("wk 18%"), `weekly rounded: ${seg}`);
    assert(seg.includes("$0.42"), `cost: ${seg}`);
    const na = formatUsageSegment(mk({ costUsd: 0.1 }));
    assert(na.includes("5h n/a") && na.includes("wk n/a"), `n/a fallback: ${na}`);
    assert(na.includes("$0.10"), "cost shown when % n/a");
  }

  // ============ formatContextFooter ============

  // --- (1) renders whenever there's a context measurement (every turn) ---
  {
    const f = formatContextFooter(mk({ contextTokens: 380_000, costUsd: 0.42 }), WINDOW);
    assert(f !== null, "footer renders with a context measurement");
    assert(f!.includes("38%"), `pct: ${f}`);
    assert(f!.includes("380k/1M"), `humanized tokens: ${f}`);
    assert(f!.includes("📊"), "usage segment appended");
  }

  // --- (2) null only when there's no measurement yet ---
  {
    assert(formatContextFooter(mk({ contextTokens: 0 }), WINDOW) === null, "no measurement → null");
    assert(formatContextFooter(mk({ contextTokens: undefined }), WINDOW) === null, "undefined → null");
    assert(formatContextFooter(mk({ contextTokens: 100 }), 0) === null, "zero window → null");
  }

  // --- (3) emoji buckets by fullness ---
  {
    assert(formatContextFooter(mk({ contextTokens: 380_000 }), WINDOW)!.includes("🧠"), "low → 🧠");
    assert(formatContextFooter(mk({ contextTokens: 700_000 }), WINDOW)!.includes("⚠️"), "mid → ⚠️");
    assert(formatContextFooter(mk({ contextTokens: 920_000 }), WINDOW)!.includes("🔴"), "high → 🔴");
  }

  // --- (4) bar fill ---
  {
    assert(formatContextFooter(mk({ contextTokens: 380_000 }), WINDOW)!.includes("▰▰▱▱▱"), "38% → 2/5");
    assert(formatContextFooter(mk({ contextTokens: 920_000 }), WINDOW)!.includes("▰▰▰▰▰"), "92% → 5/5");
  }

  // --- (5) compaction note when current dropped well below peak ---
  {
    const f = formatContextFooter(mk({ contextTokens: 200_000, peakContextTokens: 450_000 }), WINDOW);
    assert(f!.includes("compacted"), `compaction note: ${f}`);
    const g = formatContextFooter(mk({ contextTokens: 400_000, peakContextTokens: 420_000 }), WINDOW);
    assert(!g!.includes("compacted"), "no compaction note for small drop");
  }

  // --- (6) window humanization (200k tier) ---
  {
    const f = formatContextFooter(mk({ contextTokens: 100_000 }), 200_000);
    assert(f!.includes("100k/200k"), `200k tier: ${f}`);
    assert(f!.includes("50%"), "pct against 200k window");
  }

  // --- (7) over-full clamps to 100% / full bar ---
  {
    const f = formatContextFooter(mk({ contextTokens: 1_500_000 }), WINDOW);
    assert(f!.includes("100%") && f!.includes("▰▰▰▰▰"), `clamp: ${f}`);
  }

  console.log(
    "✅ contextIndicator verified — in-process footer (renders every turn, emoji buckets, bar, compaction, window scaling, clamp) + usage segment",
  );
}

main().catch((err) => {
  console.error("❌ contextIndicator verification failed:", err);
  process.exit(1);
});
