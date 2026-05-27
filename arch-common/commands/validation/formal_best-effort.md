---
description: "Create and run a SymbiYosys formal verification bench. Use when asked to formally verify or prove properties of a module."
---

Create and run a SymbiYosys formal bench for: $ARGUMENTS

---

## Read these first

- [common_tools.md](common_tools.md)
- [common_Xbench.md](common_Xbench.md)
- [common_debugging.md](common_debugging.md)
- [common_formal.md](common_formal.md)

## Step 1: Write the Formal Bench

Create a new file `<ModuleName>Formalbench.sv` in the **same directory** as the module being verified. This file is separate from `<ModuleName>Testbench.sv`.

If the formal bench already exists, see if it needs to be updated and ask the user to approve suggested updates.

### Module structure

Follow the `ifdef FORMAL` guard and common module requirements from
[common_formal.md](common_formal.md), plus:

- Instantiate the DUT.
- **`assert`** statements for each formal property (see below).
- **`cover`** statements confirming that interesting input classes are reachable.

### Properties to include

Best-effort coverage without a reference model. Include:
1. **Correctness** — primary behavioral contract (exhaustive: inputs are unconstrained).
2. **Boundary / identity cases** — zero identity, overflow, etc.
3. **Cover goals** — non-vacuity checks for interesting input/output classes.

---

## Step 2: Write the `.sby` File

Create `<ModuleName>.sby` in the **same directory** as the module `.sv` file.

```
[options]
mode prove

[engines]
smtbmc

[script]
read -formal <ModuleName>.sv
read -formal <ModuleName>Formalbench.sv
prep -top <ModuleName>Formalbench

[files]
<ModuleName>.sv
<ModuleName>Formalbench.sv
```

See [common_formal.md](common_formal.md) § Common `.sby` Notes for `read -formal` semantics and existing-file policy.

---

## Step 3: Run the Formal Verification

See [common_formal.md](common_formal.md) § Running Formal Verification.
