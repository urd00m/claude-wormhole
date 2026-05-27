// Verify the context-usage indicator: getContextUsage parsing (via an
// injected fake runner — no python, no real transcript) and the
// formatContextFooter rendering. The skill (context_length.py) itself is
// arch-common's; here we only test our glue + presentation.

import { getContextUsage, formatContextFooter, type ContextUsage } from "./contextIndicator.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

/** A fake skill runner that returns a fixed --json payload. */
function runnerReturning(json: unknown) {
  return async () => JSON.stringify(json);
}

async function main() {
  // ============ getContextUsage ============

  // --- (1) valid skill JSON → parsed usage ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 1_000_000,
      runner: runnerReturning({
        measured_prompt_tokens: 380_000,
        window: 1_000_000,
        used_pct: 38.0,
        peak_prompt_tokens: 400_000,
        estimated_next_prompt_tokens: 390_000,
      }),
    });
    assert(u !== null, "valid → non-null");
    assert(u!.measured === 380_000, `measured: ${u!.measured}`);
    assert(u!.window === 1_000_000, "window");
    assert(Math.abs(u!.usedPct - 38) < 0.01, `usedPct: ${u!.usedPct}`);
    assert(u!.compaction === false, "no compaction (peak-measured small)");
  }

  // --- (2) used_pct missing → computed from measured/window ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 1_000_000,
      runner: runnerReturning({ measured_prompt_tokens: 250_000, window: 1_000_000 }),
    });
    assert(u !== null && Math.abs(u.usedPct - 25) < 0.01, `computed pct: ${u?.usedPct}`);
  }

  // --- (3) compaction detected (peak well above measured) ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 1_000_000,
      runner: runnerReturning({
        measured_prompt_tokens: 200_000,
        window: 1_000_000,
        peak_prompt_tokens: 450_000, // 250k drop > 15% of 1M
      }),
    });
    assert(u !== null && u.compaction === true, "compaction flagged");
  }

  // --- (4) runner throws (no transcript / python missing) → null ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 1_000_000,
      runner: async () => {
        throw new Error("no transcript for session sid");
      },
    });
    assert(u === null, "runner error → null");
  }

  // --- (5) garbage stdout → null (never throws) ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 1_000_000,
      runner: async () => "not json at all",
    });
    assert(u === null, "garbage → null");
  }

  // --- (6) malformed JSON (missing required fields) → null ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 1_000_000,
      runner: runnerReturning({ window: 1_000_000 }), // no measured_prompt_tokens
    });
    assert(u === null, "missing measured → null");
  }

  // --- (7) window 0/negative guarded → null (no divide-by-zero) ---
  {
    const u = await getContextUsage("sid", {
      windowTokens: 0,
      runner: runnerReturning({ measured_prompt_tokens: 100, window: 0 }),
    });
    assert(u === null, "non-positive window → null");
  }

  // ============ formatContextFooter ============

  const mk = (over: Partial<ContextUsage>): ContextUsage => ({
    measured: 0,
    window: 1_000_000,
    usedPct: 0,
    peak: 0,
    compaction: false,
    ...over,
  });

  // --- (8) low usage → 🧠, mostly-empty bar ---
  {
    const f = formatContextFooter(mk({ measured: 380_000, usedPct: 38 }));
    assert(f.includes("🧠"), `low emoji: ${f}`);
    assert(f.includes("38%"), "pct shown");
    assert(f.includes("380k/1M"), `human tokens: ${f}`);
    // 38% of 5 slots → 2 filled
    assert(f.includes("▰▰▱▱▱"), `bar fill: ${f}`);
  }

  // --- (9) mid usage (60–84%) → ⚠️ ---
  {
    const f = formatContextFooter(mk({ measured: 700_000, usedPct: 70 }));
    assert(f.includes("⚠️"), `mid emoji: ${f}`);
  }

  // --- (10) high usage (≥85%) → 🔴 ---
  {
    const f = formatContextFooter(mk({ measured: 920_000, usedPct: 92 }));
    assert(f.includes("🔴"), `high emoji: ${f}`);
    assert(f.includes("▰▰▰▰▰"), `near-full bar: ${f}`);
  }

  // --- (11) compaction note appended ---
  {
    const f = formatContextFooter(mk({ measured: 200_000, usedPct: 20, compaction: true }));
    assert(f.includes("compacted"), `compaction note: ${f}`);
  }

  // --- (12) k/M humanization boundaries ---
  {
    const f = formatContextFooter(mk({ measured: 200_000, window: 200_000, usedPct: 100 }));
    assert(f.includes("200k/200k"), `200k formatting: ${f}`);
    const g = formatContextFooter(mk({ measured: 1_500_000, window: 2_000_000, usedPct: 75 }));
    assert(g.includes("1.5M/2M"), `M formatting: ${g}`);
  }

  // --- (13) pct clamped to [0,100] for the bar ---
  {
    const f = formatContextFooter(mk({ usedPct: 130 }));
    assert(f.includes("▰▰▰▰▰"), "over-100 clamps to full bar");
    assert(f.includes("130%") === false, "displayed pct clamped");
    assert(f.includes("100%"), `clamped display: ${f}`);
  }

  console.log(
    "✅ contextIndicator verified — getContextUsage (parse/compute/compaction/error/garbage/window-guard) + formatContextFooter (emoji buckets, bar fill, k/M, compaction, clamp)",
  );
}

main().catch((err) => {
  console.error("❌ contextIndicator verification failed:", err);
  process.exit(1);
});
