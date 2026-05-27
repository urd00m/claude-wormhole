---
user-invocable: false
description: "Load when debugging hardware designs, investigating test failures, or diagnosing simulation mismatches."
---

<!-- Shared reference file. Do not run directly as a command; reference from other commands. -->

# Common Debugging Principles

---

## First Principle: Minimize the Debug Inner Loop

Minimize one iteration of: reproduce → hypothesize root cause → test fix → repeat. Everything below serves this goal.

1. **Reduce design complexity at the point of reproduction.** Debug the smallest subsystem that still exhibits the bug (see Layered Validation). Don't debug an integrated system when the bug lives in an isolated sub-module.

2. **Reduce test case size.** If a benchmark suite exposes a failure, don't rerun it in the inner loop. Identify the failing benchmark, extract a **minimal test case** that reproduces the bug, and use it for all hypothesis/fix iterations. Rerun the full suite only as a final regression check.

3. **One change at a time.** If two simultaneous changes make the bug disappear, you can't tell which (or whether both) were necessary → extra iterations.

4. **Verify inputs before debugging internals.** When a module's output is wrong, check its inputs first. Many "bugs" are correct logic operating on upstream garbage. Layered Validation orders *which* module to debug; this orders *where to look first* inside it.

Before debugging, ask: *"What is the fastest way I can see whether my next fix attempt worked?"* Optimize for that.

---

## Layered Validation

For complex designs, validate subsystems independently in dependency order, lowest-level first. Propose the strategy in the plan file if one exists.

**Never debug a higher layer before finishing all lower layers.** A lower-layer bug corrupts higher-layer inputs and makes symptoms uninterpretable.

**Example (CPU pipeline):**

1. **Functional correctness**: `pc_mismatch == 0` for all benchmarks.
2. **Memory subsystem (isolated)**: Traffic generator with deterministic addresses; compare cycle counts vs RTL.
3. **Core pipeline (isolated)**: IPC vs RTL using variable-latency magic memory. Constant error across latencies → core bug; scales with latency → load pipeline bug; unaffected → store pipeline bug.
4. **Integrated**: IPC vs RTL with real cache model.

---

## Instrumentation-Guided Localization

**Do not read RTL in circles by inspection.** Instrument the DUT to form and test hypotheses about bug location.

**Instrumentation approaches:**
- **Performance counters** for each major subsystem (cache hits/misses, stalls per stage, queue occupancy, dispatch/commit rates). Run the failing test; anomalous counter values identify the buggy subsystem.
- **Per-cycle text traces** via `$display` blocks (gated by `ifdef`, e.g., `DEBUG_CACHE`) printing key FSM state and control signals every posedge. They show per-cycle logical relationships without waveform cursor correlation. Reserve VCD for multi-signal visual correlation.

**Examples:**
- Cache miss count far exceeds expected → tag or replacement logic bug, not fill path.
- Disproportionate stall count at one pipeline stage → throughput mismatch there.
- Queue unexpectedly full or empty → upstream overproduction or downstream underconsumption.

When a structural reference exists (e.g., a surrogate or shadow model vs RTL), consult the project's surrogate / shadow-model design notes for targeted comparison (e.g., PMC parity between reference and DUT).

---

## Assertions as Testable Hypotheses

Encode believed invariants as assertions. Firing → bug localized; not firing → hypothesis ruled out. Assertions persist as regression guards after the fix.

**With SVA support:** Use `assert property` for temporal invariants (e.g., "a FIFO's read pointer never passes its write pointer", "every request eventually gets a grant").

**Without SVA (plain Verilog):** Emulate assertions with guarded `$display` + `$finish` in an `always` block:
```verilog
`ifdef DEBUG_ASSERT
always @(posedge clk) begin
    if (rd_ptr > wr_ptr) begin
        $display("ASSERT FAIL [%0t]: rd_ptr (%0d) > wr_ptr (%0d)", $time, rd_ptr, wr_ptr);
        $finish;
    end
end
`endif
```

Gate with `ifdef` so assertions are zero-cost in synthesis and toggled per-build.

---

## Subsystem Isolation via Benchmarks

Write benchmarks that stress one subsystem's edge cases. Expose that subsystem's bugs (e.g., dropped requests, forwarding failures, full-queue backpressure) while keeping other subsystems trivial so symptoms stay unambiguous.

**Examples:**
- **Store-heavy**: fills the SQ to capacity; tests whether the LSQ drops requests when full, whether store-to-load forwarding works under pressure, whether commit drain keeps up.
- **Load-heavy, L1-resident**: saturates load bandwidth; tests MLP, IQ scheduling priority, load pipeline structural hazards.
- **Branch-heavy**: many conditional branches; tests predictor training, redirect penalty, checkpoint allocation/deallocation under pressure.
- **Cache-miss-heavy**: stride exceeding cache capacity; tests MSHR allocation, fill path latency, eviction policy correctness.

When the command is completed, ask the user whether new microbenchmarks should be added to the design's microbenchmark library.

---

## Feature-Disable Isolation

Temporarily disable a suspected sub-module or feature. Bug disappears → it lives there. Persists → look elsewhere.

---

## Root Cause Discipline

Always fix the root cause. NEVER hide bugs (e.g., by changing parameters).

- **Resource exhaustion is a symptom, not a root cause.** If changing a queue depth doesn't change IPC, something upstream is wasting entries. Fix the upstream waste first.
- **Oracle divergence does not imply incorrectness.** `pc_mismatch != 0` means speculative execution diverged, but the pipeline may still commit correctly. High mismatch counts indicate wasted work, not necessarily a bug.
- **Fixing one bug can expose others.** A large error can mask smaller ones. Re-run the full suite after every fix.

---

## Don't Lose Sight of the Top-Level Objective

A debug session has a **top-level objective** (e.g., "the entire test suite passes", "IPC error < 1% across all benchmarks") even while you chase a **specific bug in a specific test case**. The narrow case probes the objective; it is not the objective.

**Before committing any fix, ask:**
- Does this fix address the underlying mechanism, or only the surface symptom in this one test?
- Will it hold for the *other* tests in the suite, including ones that currently pass?
- Could it regress a case I am not currently looking at?
- Is the failing test exposing a general bug, or am I about to special-case it?

**Anti-patterns to refuse:**
- Adding a guard, mask, or skip that triggers only on the specific opcode/address/PC of the failing test.
- Tuning a constant until *this* test passes, without a principled reason the new value is correct in general.
- "Fixing" the oracle/reference instead of the DUT (or vice versa) just to make the diff disappear.
- Patching a downstream symptom when an upstream module produces wrong inputs.

**The correct fix** makes the *class* of behavior correct, not just this one failure quiet. If the obvious patch is narrow, scrutinize it: broaden the hypothesis, re-check upstream inputs, and compare symmetric constructs (below) before changing anything. A robust fix taking one extra iteration beats a narrow fix that creates two regressions.

After every fix, re-run the **full suite**, not just the previously-failing test.

---

## Debugging Tactics

- **Event-filtered trace for narrowing long bugs.** Once you know which address/index/entry is wrong, print only state-changing events (write enables, allocations, deallocations) for that index. Example: `cda_wr_en && cda_wr_set_idx == 5` immediately reveals which writer corrupted set 5.

- **Binary search to narrow the failure.** When many tests pass and one fails, or a long trace diverges at an unknown point, bisect by test, cycle range, or code region. Halve each iteration; don't scan linearly.

- **Destructive verification can mask bugs.** Verification loops that mutate state (e.g., reading all ways causes evictions) obscure the real result. Break out early or use non-destructive checks.

- **Diff against last known good.** If the design used to work, diff against the last passing commit or `git bisect`. This binary-searches *changes* rather than tests or cycle ranges, often the fastest path for recent regressions.

- **Coincident-event bugs.** When two events are assumed mutually exclusive but can coincide (enqueue + dequeue, grant + new request, consumption + arrival), check the coincident case. Ask: "what if A and B are both high in the same cycle?"

---

## Compare Symmetric Constructs

Pipelined and replicated designs repeat idioms across stages or instances. Any deviation from the pattern is immediately suspect.

**Examples:**
- Pipeline valid/kill chains: if stages 1–3 each set `valid := !kill_prev_stage`, a stage that sets `valid := true` stands out.
- Register address extraction: if all stages extract bits `[11:7]` but one uses `[12:8]`, the off-by-one is visible by comparison.
- Bypass/forwarding source conditions: if two of three use `ctrl.wxd` but one uses `true`, the unconditional enable is anomalous.

**Rule**: When investigating a signal in one stage, check the corresponding signal in ALL other stages. If the first match looks correct, don't stop; check the rest.

---

## Avoid Tunnel Vision

After ~10 tool calls investigating one file or module without converging on a hypothesis, **stop and broaden the search**. Systematically scan all source files in the design for anomalies. A bug may live in an auxiliary module (instruction buffer, TLB, branch predictor) rather than the main pipeline file.

**Signs of tunnel vision:**
- Repeatedly re-reading the same function looking for something subtle.
- Exploring increasingly unlikely hypotheses within the same module.
- More than 3 dead-end hypotheses in the same file.

---

## Performance-Only Symptoms

Correct results but cycle counts differ uniformly from baseline → bug on a **non-critical path** that affects throughput but not correctness:

- **Uniform speedup**: a flush, stall, or serialization point was weakened or removed (e.g., CSR side-effect detection changed, reducing pipeline flushes).
- **Uniform slowdown**: a hazard detection, prefetch, or prediction mechanism was weakened (e.g., `||` → `&&` in hazard detection means fewer stalls, but wrong results cause longer recovery paths).
- **Single-benchmark delta**: the mutation affects a functional unit only exercised by that workload (e.g., divider bug only affects division-heavy benchmark).

Harder to localize than crash bugs because a cycle count delta gives less directional signal. Focus on logic that *gates* work (stall conditions, flush triggers, prediction accuracy) rather than logic that *computes* values.
