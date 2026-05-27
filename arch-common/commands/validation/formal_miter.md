Create and run a SymbiYosys miter-style equivalence formal bench.

Arguments: `<DUT.sv> <XShadowModel.sv>`

The DUT and shadow model must have identical port interfaces.

---

## Read these first

- [common_tools.md](common_tools.md)
- [common_Xbench.md](common_Xbench.md)
- [common_debugging.md](common_debugging.md)
- [common_formal.md](common_formal.md)

## Step 1: Write the Formal Bench

Create a new file `<DUTName>Formalbench.sv` in the **same directory** as the DUT.

### Shadow model

If the shadow model is not specified, look for `<DUTName>ShadowModel.sv`.  If you can't find it, ask the user if they would like you to try to create one.  Only try if it seems feasible to create a meaningfully simpler model than the DUT.  If you make a shadow model, ask the user to review before proceeding.

### Module structure

Follow the `ifdef FORMAL` guard and common module requirements from
[common_formal.md](common_formal.md), plus:

- Instantiate **both** the DUT and the shadow model, driven by the **same**
  unconstrained inputs.
- Capture each module's outputs into separate named wires (e.g., `dut_out_x`,
  `shadow_out_x`).
- **`assert`** statements checking that **every** corresponding output pair is
  equal. This is the miter equivalence check — be comprehensive and cover all
  outputs, not just a subset.
- **`cover`** statements confirming that interesting, non-trivial output values
  are reachable (non-vacuity checks).

---

## Step 2: Write the `.sby` File

Create `<DUTName>.sby` in the **same directory** as the DUT.

### Discovering dependencies

Before writing the `.sby`, check the shadow model for `` `include `` directives and cross-file type/module references. Include all transitive dependencies in both `[script]` and `[files]`.

### Slang frontend (yosys-slang)

Use `read_slang` instead of the built-in Yosys SV parser (handles full IEEE 1800; bundled with OSS CAD Suite).

### Template

```
[options]
mode prove

[engines]
smtbmc

[script]
plugin -i slang
read_slang -D FORMAL --single-unit -I <include_dir> <all .sv files>
prep -top <DUTName>Formalbench

[files]
<DUTName>.sv
<DUTName>ShadowModel.sv
# <dependency>.sv
<DUTName>Formalbench.sv
```

See [common_formal.md](common_formal.md) § Common `.sby` Notes for existing-file policy and `FORMAL` macro semantics.

Key flags for `read_slang`:
- `-D FORMAL` — required (slang does not define it automatically, unlike `read -formal`).
- `--single-unit` — all `.sv` files in a single `read_slang` call for cross-file type resolution.
- `-I <dir>` — include search path (e.g., `-I gatelib`).

---

## Step 3: Run the Formal Verification (Phased)

Formal verification proceeds in four phases. **Only advance to phase N if
phase N−1 passes.** Log all progress to `design_log.md` in the output
directory (see § Formal Log below).

### Configurations

Many designs have parameters that control structure sizes (e.g., ROB depth,
cache lines, queue entries). Define two configurations:

- **Small** — choose the smallest non-trivial value for each size parameter.
  Use your judgement: the goal is to keep state space small so the solver
  converges quickly, while maximally exercising the logic (e.g., reducing
  the ways in a cache increases the chance of a conflict, which exercises
  more logic).

  "Size parameters" include **any** parameter that controls replicated state,
  not just microarchitectural buffers. In particular, **the ISA register file
  (ARF) size** is often the dominant source of induction state. When the full
  ARF (e.g., 64 × 32-bit) causes k-induction step 0 to diverge, constrain
  the solver to a small subset of registers (e.g., 8):
    - `assume` that register-index fields in instructions use only the low
      bits (upper bits zero).
    - `assume` that out-of-range register entries are zero in both DUT and
      reference model.
    - Reduce loop bounds in auxiliary invariants and assertions accordingly.

  **Do not** shrink the datapath width or the width of individual ARF
  entries (e.g., keep registers at 32 bits). Narrowing the datapath
  removes bit-level corner cases (carry propagation, sign extension,
  upper-bit forwarding) that the proof must cover.

  This preserves all pipeline/forwarding/hazard logic while cutting the
  effective register state by 8×. Other examples of size parameters:
  ROB depth, MSHR count, issue-queue entries, cache lines/ways,
  load/store-queue depth.

  **Mechanism:** Use a preprocessor guard `FORMAL_SMALL` in the formal bench.
  Wrap all small-config `assume` constraints and reduced loop bounds in
  `` `ifdef FORMAL_SMALL`` / `` `endif`` blocks, with an `` `else`` branch
  that sets full-size defaults. Then pass `-D FORMAL_SMALL` in the
  `read_slang` line of the small `.sby` files only. Normal `.sby` files
  omit the flag, getting the full-size config automatically.

  Do **not** use `chparam` for this — it runs after elaboration and cannot
  affect `generate if` or `ifdef` guards. Use `-D` (preprocessor define)
  which resolves before elaboration.
- **Normal** — the parameter values the user specified (or the module defaults).

If the design has no tuneable size parameters, small = normal and phases
collapse to two (BMC, then unbounded).

### Phase table

| Phase | Mode | Config | Purpose |
|-------|------|--------|---------|
| 1 | BMC | Small | Fast bug-finding on reduced state space |
| 2 | BMC | Normal | Bug-finding at full design size |
| 3 | Unbounded (`mode prove`) | Small | Induction proof on reduced state space |
| 4 | Unbounded (`mode prove`) | Normal | Full proof at design size |

### Depth strategy

For both BMC depth and k-induction depth, **start small and grow
incrementally**:

- BMC: start at depth 2, increase by 2 until reaching a target or
  a counterexample.  Set the target to 15.  Skip to an unbounded proof if BMC time exceeds 1 hour.
- k-induction: start at k = pipeline depth (or equivalent structural depth),
  increase by 2 until induction closes or a clear pattern emerges.
- A **fast failure** (seconds) means the invariant is non-inductive at that k —
  increase k. A **slow run** (minutes+) means the solver is working — let it run.

### Creating configuration-specific `.sby` files

Create a **separate `.sby` file for each phase** so that runs are
independently reproducible and can be launched in parallel:

| Phase | File name |
|-------|-----------|
| 1 | `<DUT>_small_bmc.sby` |
| 2 | `<DUT>_bmc.sby` |
| 3 | `<DUT>_small.sby` |
| 4 | `<DUT>.sby` |

Each file differs only in `mode` (`bmc` vs `prove`), `depth`, and any
`chparam` / `assume`-based parameter overrides for the small config.

### Logging

Log formal results to the design's `design_log.md` (see
[project_conventions.md § Design Log](../../templates/project_conventions.md#design-log)).
Each formal run is a changelog entry with **Category: Formal**. Use the standard changelog fields, with **Results** containing a
compact table of phases/depths/outcomes:

```markdown
### Entry N — Formal: miter equivalence (P0–P3)

- **Status**: Kept
- **Category**: Formal
- **Motivation**: Verify pipelined DUT against Sail reference model.
- **Change**: Added P0 (fetch integrity), constrained ARF to 8 regs
  for small config.
- **Results**:
  | Phase | Config | Mode | Depth/k | Result | Time |
  |-------|--------|------|---------|--------|------|
  | 1 | Small | BMC | 15 | PASS | 1s |
  | 3 | Small | prove | k=6 | PASS | 11m |
  | 2 | Normal | BMC | 15 | PASS | 6s |
  | 4 | Normal | prove | k=6 | TIMEOUT (step 0) | >30m |
- **Timestamp**: 2026-03-03, 12m wall-clock (small unbounded)
```

See also [common_formal.md](common_formal.md) §
Running Formal Verification.

---

## Sail-Generated Shadow Models

When the shadow model is produced by the Sail SV backend, expect two categories
of issues that must be patched before formal verification.

### Packed union width mismatch

Sail emits `union packed` types where members have different bit-widths (e.g.,
an AST union with 18-bit and 26-bit variants).  IEEE 1800 requires all packed
union members to be the same width.  Both the built-in Yosys frontend and slang
reject this.

**Fix:** Add a `_pad` field at the MSB of the smaller struct types to bring all
members to the same width.  Named field accesses are unaffected; the padding
bits become don't-cares.

### Unused modules

Sail generates top-level orchestration modules (`step`, `initialize_registers`,
`sail_toplevel`, `handle_trap`, `sail_setup_let_*`) that are not in the formal
elaboration path.  These may reference stubs or use non-synthesizable constructs.

**Fix:** Wrap them in `` `ifndef FORMAL `` / `` `endif `` guards.  Be careful
not to guard out modules that ARE instantiated by the shadow model wrapper
(e.g., `decode` and `execute`).
