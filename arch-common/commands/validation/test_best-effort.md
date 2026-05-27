---
description: "Create and run a simulation test bench. Use when asked to test, verify, or write a testbench for a module."
---

Create and run a test bench for: $ARGUMENTS

---

## Read these first

- [common_tools.md](common_tools.md)
- [common_Xbench.md](common_Xbench.md)
- [common_debugging.md](common_debugging.md)

## Step 1: Write the Test Bench

Write a test bench for the module(s) specified above, named `<ModuleName>Testbench`.
If the test bench already exists, see if it needs to be updated and ask the user to approve suggested updates.

The test bench must:
- Use your best judgement and create a suite of tests that test **basic usage** along with **common edge cases**.
- Output **useful printouts** describing the tests being performed.
- Use **SystemVerilog assertions** and **`cover` statements** whenever possible.
- On failure: stop and print `Test FAILED`.
- On success: print `All tests PASSED.`

---

## Step 2: Run the Test Bench

Run the test bench using `python3 ../arch-common/scripts/run_test.py` (sibling-directory layout). See [common_tools.md § Canonical Runner Locations](common_tools.md#canonical-runner-locations).

If the test does not pass:
- Debug until it passes.
- You may add printouts or dump a `.vcd` file to assist in debugging.
- **Remove all debugging aids when you are done.**