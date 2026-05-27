---
user-invocable: false
description: "Load when designing new hardware modules, interfaces, or pipelines in SystemVerilog."
---

<!-- This is a shared reference file.  Do not run it directly as a command.  It should be referenced by other commands. -->

Design methodology for hardware implementation tasks.

## Sub-Module Decomposition

For non-trivial designs, break the design into sub-modules before implementing:

1. **Define interfaces first.** Write an `interfaces.md` per [project_conventions.md § Interfaces](../templates/project_conventions.md#interfaces).  Sub-modules should be defined with clean interfaces that will eventually enable clean invariants for use in formal verification.
2. **Build and validate sub-modules independently.** Apply the same test procedure to each sub-module as you would to the top module.  E.g., if the top module is applying `/arch-common:validation:test_best-effort` and `/dse:synth`, the sub-module should as well prior to integration.
3. **Integrate incrementally.** Wire sub-modules into the top-level one at a time, re-running tests after each addition.

Use sub-agents to implement independent sub-modules in parallel when possible.

## Output Artifacts

Every design directory should contain:

- **`design_log.md`** — Per the format in [project_conventions.md § Design Log](../templates/project_conventions.md#design-log).  For hardware designs, also append `/perf` reports (see Post-Modification Checklist below).
- **`interfaces.md`** (if sub-modules exist) — Per the format in [project_conventions.md § Interfaces](../templates/project_conventions.md#interfaces).

## Post-Modification Checklist

After creating or modifying `.sv` files (in addition to the `.sv` file rules in [project_conventions.md § .sv File Rules](../templates/project_conventions.md#sv-file-rules)):
1. Run `/arch-common:validation:test_best-effort` (verify correctness).
2. Run `/perf` and append the report to `design_log.md`.
