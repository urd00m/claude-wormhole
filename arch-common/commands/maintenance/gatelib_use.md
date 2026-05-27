---
disable-model-invocation: true
---

Refactor the following file(s) to use GateLib modules wherever possible: $ARGUMENTS

---

## Read these first

- [gatelib_modules.md](../../templates/gatelib_modules.md)

## Instructions
Do not read GateLib source files unless you think they will be useful after reading `gatelib_modules.md`.

GateLib is a gateware library that implements many useful modules (registers, shift registers, FIFOs, RAMs, etc.).

For each file listed above:

1. Read the file.
2. Identify any logic that could be replaced by a GateLib module — either a single module or a composition of GateLib modules.
3. Replace that logic with the appropriate GateLib instantiation(s).
4. Report a short summary of what was changed.
