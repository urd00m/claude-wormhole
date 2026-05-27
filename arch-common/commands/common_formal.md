---
user-invocable: false
description: "Load when creating or running formal verification benches with SymbiYosys."
---

<!-- This is a shared reference file.  Do not run it directly as a command.  It should be referenced by other commands. -->

# Formal Bench Common Reference

Shared conventions for all SymbiYosys formal benches (formal_best-effort, formal_miter, etc.).

---

## `ifdef FORMAL` Guard

Wrap the entire formal module in an `` `ifdef FORMAL `` / `` `endif `` guard.
This prevents Verilator from compiling it during simulation (Verilator does not
define `FORMAL`).

```systemverilog
`ifdef FORMAL

module <ModuleName>Formalbench #(
    // parameters matching the DUT
) (
    input logic clk_i
);
    // ...
endmodule

`endif // FORMAL
```

Place the standard file banner (author, date, description) **outside** the guard.

---

## Common Module Requirements

The formal module must:

- Accept a `clk_i` input (the formal clock).
- Declare unconstrained `logic` signals matching the DUT's input ports (no driver
  needed — the solver treats them as free variables).
- Declare a `f_past_valid` register (initialize to `0`, set to `1` after the first
  rising edge) so `$past` is safe to use.
- Inside an `always_ff @(posedge clk_i) begin ... end` block, declare `assert`
  and `cover` statements (see command-specific instructions for what to assert).

---

## Critical Yosys Constraints

- **Do not** use `assert property (@(posedge clk_i) ...)` at module scope.
  Yosys does not support the embedded clocking-event form.
  Use immediate `assert(...)` inside `always_ff` blocks instead.
- **Do not** use `cover property (...)`.
  Use immediate `cover(...)` inside `always_ff` blocks.
- **Do not** use hierarchical references to DUT internals (e.g., `dut.signal`,
  `dut.array[i]`). Yosys treats these as implicitly declared, undriven wires —
  assertions will silently check against undefined values. All formal properties
  must be expressed in terms of the DUT's port-level I/O.

---

## Style

- Follow [sv.md](../templates/style_guides/sv.md) for general
  SystemVerilog conventions (indentation, naming, section banners, etc.).
- Follow [sv_formal.md](../templates/style_guides/sv_formal.md)
  for formal-bench-specific structure (section ordering, auxiliary invariant
  placement, property and cover layout, annotated skeleton).

---

## Common `.sby` Notes

- `mode prove` runs both BMC and k-induction for exhaustive coverage.
- All paths in `[files]` and `[script]` are relative to the `.sby` file's directory.
- **Always use `../arch-common/scripts/run_formal.py` to run formal** — never invoke `sby` directly.
  `../arch-common/scripts/run_formal.py` passes `-d <ModuleName>_formal` to sby, so all tool output lands
  in `<ModuleName>_formal/` alongside the module — not in a bare `<ModuleName>/`
  directory that could be confused with a design subdirectory.
  The `**/*_formal/` `.gitignore` pattern depends on this naming convention.
- If a `.sby` file already exists with different options (e.g., `mode bmc`), use those.
- `read -formal` defines the `FORMAL` macro, activating `ifdef FORMAL` blocks.
  With `read_slang`, pass `-D FORMAL` explicitly (slang does not define it automatically).

---

## Property Statement Sync

Every formal bench must include its property statement in two places:

1. **The `.sv` file header** — in the module banner comment block, using the
   notation from [sv_formal.md](../templates/style_guides/sv_formal.md) § "Property
   notation".
2. **The design doc** (e.g., `formal_plan.md`) — with full elaboration (proof
   technique, what is NOT proved) - if one exists.  

**When modifying a formal bench, verify that the property statement in the `.sv`
header and the design doc still accurately reflect what is actually being
asserted.** If assertions are added, removed, or changed, update both locations.

---

## Running Formal Verification

Run the formal verification using `../arch-common/scripts/run_formal.py`.

The tool prints `DONE (PASS, rc=0)` on success.

If verification does not pass:
- Read the error and identify which assertion or cover goal failed.
- Debug until it passes.
- **Remove all debugging aids when you are done.**

Append a change-log entry to the design directory's `design_log.md` for each
formal verification run (pass or fail) following the changelog format in
[project_conventions.md](../templates/project_conventions.md#design-log)
§ "Section 2: Changelog" (Status, Category, Motivation, Change, Results,
Timestamp). Use category `Formal`. Results should include: pass/fail, mode
(BMC/prove), depth, engine, and wall-clock duration. Failed runs should note
which assertion or cover goal failed. If `design_log.md` does not exist,
create it following the template in
[project_conventions.md](../templates/project_conventions.md#design-log).

---

## Pipeline Equivalence Verification (commit-based stuttering)

For proving equivalence between a pipelined DUT and a single-cycle reference model:

### Reference model wrapper

The reference model must advance **once per commit** (not once per clock). Wire `step_i = f_commit_valid_o` (the pipeline's retire signal). The wrapper receives the committed instruction word directly from the DUT's formal port (`f_commit_instr_o`), not from `imem_rdata` (which is several cycles ahead of commit).

### Formal observation ports

Under `ifdef FORMAL`, expose from the DUT:

| Port | Source in pipeline | Meaning |
|------|--------------------|---------|
| `f_commit_valid_o` | `exmem_valid` | Instruction retires this cycle |
| `f_commit_pc_o` | `exmem_pc` | PC of retiring instruction |
| `f_commit_instr_o` | `exmem_instr` | Instruction word of retiring instr |
| `f_regfile_o` | `regfile` | Architectural register file |

`exmem_pc` / `exmem_instr` are FORMAL-only carry-through registers: `ifid_pc/instr → idex_pc/instr → exmem_pc/instr`. Zeroed on stall/flush; `exmem_valid = 0` for bubbles, so no spurious commit fires.

### Required k-induction depth for an N-stage pipeline

- `k = N` (pipeline depth) is the **minimum** to start with, but is often not sufficient.
- The invariant only constrains `ref_pc` at commit points. Between commits, `ref_pc` is unconstrained in the induction window, allowing the solver to manufacture counterexamples.
- Rule of thumb: k ≈ 1.5× pipeline depth. Increase by 2 until induction closes.
- A **fast failure** (solver returns in seconds) means the invariant is genuinely non-inductive at that k — increase k. A **slow run** (solver spends minutes/hours) means the solver is working on a proof — let it run.

### ARF equality auxiliary invariant

Always include an auxiliary assume that forces ARF equality at the induction start. Without it, the solver can start the induction window with an arbitrary divergent ARF. See the annotated code block in [sv_formal.md](../templates/style_guides/sv_formal.md) § "Auxiliary invariant: ARF equality at induction start".

---

## Notes when using SymbiYosys

### `$initstate` vs `f_past_valid`

`$initstate` (Yosys primitive, returns 1 only at the true initial state) is cleaner than `f_past_valid` for k-induction — it has no induction hole, so auxiliary invariants need only `assert`, not the assume/assert split. However, slang (`read_slang`) does not recognize `$initstate`. Use `f_past_valid` when the .sby uses slang; switch to `$initstate` if/when slang adds support or the design can use `read_verilog -formal`.

### Engine / solver guide

**SMT solvers** (via `smtbmc`):

| Solver | Architecture | Best for |
|--------|-------------|----------|
| `bitwuzla` | Lazy abstraction/refinement; word-level BV reasoning, bit-blasts only when forced | Wide-datapath miters, processor-scale equivalence proofs |
| `yices` | Eager bit-blast → SAT; fast on small instances | Narrow designs, quick BMC checks |
| `z3` | CDCL(T), broadest theory support | Mixed-theory problems (arithmetic, quantifiers); not great on pure wide-BV induction |

**AIGER engines** (via `abc` or `aiger`):

| Engine | Architecture | Best for |
|--------|-------------|----------|
| `abc bmc3` | Bounded model checking on AIG | Fast bug-finding in first N cycles; cannot prove unbounded safety |
| `abc pdr` | IC3/PDR — incremental reachability frames, no model unrolling | Single-property safety on gate-level designs; struggles with many outputs + wide state |

Strongly prefer bitwuzla when word-level reasoning is required.

**When unsure:** `sby --autotune` benchmarks multiple engine configs in parallel and ranks them.
