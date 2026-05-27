---
user-invocable: false
description: "Load when running CAD tools: synthesis (Yosys/ABC), simulation, or verification."
---

<!-- This is a shared reference file.  Do not run it directly as a command.  It should be referenced by other commands. -->

Useful information for when running tools.

Only add to this file if the information benefits all CAD tool use (simulation, synthesis, verification, etc.).

## Canonical Runner Locations

The runner scripts live in **arch-common**, not in each consuming project:

| Flow | Script | Purpose |
|---|---|---|
| sim | `../arch-common/scripts/run_test.py` | Verilator-driven testbench build + run |
| formal | `../arch-common/scripts/run_formal.py` | symbiyosys-driven `.sby` execution |
| synth | `../arch-common/scripts/run_synth.py` | Yosys/ABC synthesis with optional ASIC liberty |
| lint | `../arch-common/scripts/run_lint.py` | Verilator `--lint-only` static check |

Paths shown assume the **sibling-directory layout** (`<project>/` and `<arch-common>/` are siblings). Consumers may symlink or wrap; the rest of this reference uses the sibling-layout form.

The Sky130 HD liberty file lives at `../arch-common/old/resources/sky130_fd_sc_hd__tt_025C_1v80.lib` and is auto-discovered by `run_synth.py` from the script's own location.

## `-I` Search Paths

`run_synth.py` resolves `-I` directories by dependency: only files defining modules referenced (transitively) by the design are included. This means unsynthesizable files (e.g., `ClockSource.sv`) in `-I gatelib` are safely ignored if unused.

`run_test.py` includes all `.sv` files from `-I` directories. Both tools exclude `*Testbench.sv` and `*Formalbench.sv` from `-I` paths.

New scripts that need to import `.sv` files should use `-I` flags and reuse the resolution logic from `run_synth.py` / `run_test.py`.

## `run_synth.py` Dependency Resolution Gotcha

The dependency resolver uses word-boundary regex matching on **all** file content, including comments. A comment containing an exact module name (e.g., `// uses Mux for selection`) will pull in that module's file even if it's not instantiated. This can cause synthesis failures if the pulled-in file has Yosys-incompatible constructs. Avoid exact GateLib module names in comments, or use alternate phrasing (e.g., "multiplexor" instead of "Mux").
