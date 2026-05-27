---
disable-model-invocation: true
---

Search all `.sv` / `.svh` files in the project for repeated functionality that
is a candidate to be added to GateLib or `gatelib/TestLib.svh`.

---

## Read these first

- [gatelib_modules.md](../../templates/gatelib_modules.md)
- `gatelib/TestLib.svh`

---

## Phase 1 — Discovery

### 1. Build the inventory of existing modules

Read [gatelib_modules.md](../../templates/gatelib_modules.md) and `gatelib/TestLib.svh` to compile the full list
of modules and utilities that already exist.  These are **excluded** from
candidate results.

### 2. Scan the project

Glob `**/*.sv` and `**/*.svh`.  Exclude:
- `gatelib/` (the library itself)
- `old/` (legacy code)

### 3. Identify repeated patterns

For each file, look for logic blocks that:
- Appear **structurally similar** in **2 or more** files (the more the better).
- Are **not** already covered by an existing GateLib module or `gatelib/TestLib.svh`
  utility.
- Are good candidates for **parameterization** (width, depth, count, number of
  ports, etc.) — i.e., the repeated instances differ only in numeric constants
  or signal names.

### 4. Classify each candidate

- **Synthesizable** → candidate for a new `gatelib/*.sv` module.
- **Non-synthesizable** (test / formal constructs) → candidate for `gatelib/TestLib.svh`.

### 5. Rank candidates

Order by:
1. Number of use sites (more is better).
2. Parameterizability breadth (serves many use cases via parameters).
3. Code savings per site.

### 6. Report

Present a ranked table.  Do **not** edit any files yet.

#### Per-candidate fields

| Field | Description |
|-------|-------------|
| **Rank** | Position in the ranked list |
| **Proposed name** | Module / task name |
| **Description** | One-line summary |
| **Category** | `gatelib` or `TestLib` |
| **Use sites** | `file:line` list of every occurrence |
| **Representative snippet** | Shortest representative code block |
| **Suggested parameters** | `parameter` list with descriptions |
| **Lines saved / site** | Approximate savings |

#### Reviewed and excluded

After the table, list patterns that were considered but **rejected**, with a
one-line reason (e.g., "already covered by `Register`", "only one use site",
"too design-specific to parameterize").

### 7. Ask the user

Present the report and ask which candidates (by rank number) to implement.

---

## Phase 2 — Implementation (after user approval)

For **each approved candidate**, in order:

### A. Create the module

- **Synthesizable**: create `gatelib/<ModuleName>.sv`.
- **Non-synthesizable**: append to `gatelib/TestLib.svh`.

### B. Run `/arch-common:maintenance:apply_sv_styleguide` and `/arch-common:maintenance:gatelib_use`

Apply to the new or modified file.

### C. Update the gatelib modules reference

Add an entry for the new module to [gatelib_modules.md](../../templates/gatelib_modules.md) following the existing format and sort order.

### D. Test

Create `gatelib/<ModuleName>Testbench.sv` using `gatelib/TestLib.svh`, then run
`/arch-common:validation:test_best-effort gatelib/<ModuleName>Testbench.sv`.

---

## On completion

Produce a concise summary listing:
- Modules added (with parameter lists).
- Patterns excluded and why.
- Any issues encountered.

Ask the user whether and where to incorporate insights.
