---
user-invocable: false
description: "Load when writing or modifying formal or test benches in SystemVerilog."
---

<!-- This is a shared reference file.  Do not run it directly as a command.  It should be referenced by other commands. -->

# Common Testbench Notes

> "X" in the filename stands for Formal or Test — this file applies to both types of benches.

## Checking Retired State in Pipelines

Testbenches must check **retired (committed) architectural state**, not transient internal state. Two factors make this non-trivial:

1. **Internal state != architectural state.** In any pipeline, values may be in-flight in pipeline registers, reorder buffers, or speculation structures. Reading an internal register file or pipeline stage can observe values that have not yet been architecturally committed — or that will never commit (e.g., wrong-path speculative execution).

2. **Determining retired state requires a commit interface.** Simple in-order pipelines may expose architectural state directly (e.g., the register file is always up to date after writeback). But once a design has any of the following, the register file or memory may contain speculative/stale values:
   - Out-of-order completion (scoreboard, Tomasulo, full OoO)
   - Speculative execution past branches
   - Store buffers or store queues (memory state lags commit)

**Rule:** Always derive testbench checks from the **commit port** — the signal(s) that indicate an instruction has retired and its effects are architecturally visible. A useful pattern is to build a shadow model of committed state in the testbench:

```systemverilog
logic [31:0] committed_rf [0:NUM_REG-1];

always_ff @(posedge clk) begin
    if (rst) begin
        for (int i = 0; i < NUM_REG; i++)
            committed_rf[i] <= 32'd0;
    end
    else if (dut.commit_valid_o && dut.commit_rd_we) begin
        committed_rf[dut.commit_rd_idx] <= dut.commit_rd_data;
    end
end

// Use committed_rf[reg] for all correctness checks
```

For simple in-order pipelines without speculation, reading `dut.regfile` directly is acceptable — but the committed-RF pattern is always safe and generalizes across all microarchitectures.
