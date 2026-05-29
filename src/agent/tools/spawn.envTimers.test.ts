// Verify the spawn-worker env applies the right timers to each CLI knob,
// and that user-supplied values win on all of them.
//   - Stall watchdog: 1 h for one-shot workers (proven enough for current
//     benches), 24 h for residents (they sit idle by design).
//   - MCP_TOOL_TIMEOUT / MCP_TIMEOUT: 2 h everywhere — defense-in-depth
//     against the bundled CLI's per-MCP-call wall-clock floor.

import { buildWorkerEnv } from "./spawn.js";
import { buildResidentEnv } from "../runtime/residentWorker.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const ONE_HOUR = "3600000";
const TWO_HOURS = "7200000";
const TWENTY_FOUR_HOURS = String(24 * 60 * 60 * 1000);

function withEnv<T>(over: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) {
    saved[k] = process.env[k];
    if (over[k] === undefined) delete process.env[k];
    else process.env[k] = over[k]!;
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function main() {
  // --- buildWorkerEnv defaults: stall = 1 h, MCP timers = 2 h ---
  {
    const env = withEnv(
      {
        CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: undefined,
        MCP_TOOL_TIMEOUT: undefined,
        MCP_TIMEOUT: undefined,
      },
      () => buildWorkerEnv(),
    );
    assert(env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS === ONE_HOUR, `worker stall 1h: ${env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS}`);
    assert(env.MCP_TOOL_TIMEOUT === TWO_HOURS, `worker MCP_TOOL_TIMEOUT: ${env.MCP_TOOL_TIMEOUT}`);
    assert(env.MCP_TIMEOUT === TWO_HOURS, `worker MCP_TIMEOUT: ${env.MCP_TIMEOUT}`);
  }

  // --- buildWorkerEnv: user-supplied values win on all three ---
  {
    const env = withEnv(
      {
        CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "999",
        MCP_TOOL_TIMEOUT: "888",
        MCP_TIMEOUT: "777",
      },
      () => buildWorkerEnv(),
    );
    assert(env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS === "999", "user stall wins");
    assert(env.MCP_TOOL_TIMEOUT === "888", "user MCP_TOOL_TIMEOUT wins");
    assert(env.MCP_TIMEOUT === "777", "user MCP_TIMEOUT wins");
  }

  // --- buildResidentEnv defaults: stall=24h, MCP timers=2h ---
  // Resident workers sit IDLE between calls by design, so the stall
  // watchdog stays at 24h; the per-call MCP timeouts get the same 2h
  // treatment as one-shot workers.
  {
    const env = withEnv(
      {
        CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: undefined,
        MCP_TOOL_TIMEOUT: undefined,
        MCP_TIMEOUT: undefined,
      },
      () => buildResidentEnv(),
    );
    assert(env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS === TWENTY_FOUR_HOURS, `resident stall 24h: ${env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS}`);
    assert(env.MCP_TOOL_TIMEOUT === TWO_HOURS, `resident MCP_TOOL_TIMEOUT: ${env.MCP_TOOL_TIMEOUT}`);
    assert(env.MCP_TIMEOUT === TWO_HOURS, `resident MCP_TIMEOUT: ${env.MCP_TIMEOUT}`);
  }

  console.log(
    "✅ env-timers verified — 1 h stall (one-shot) / 24 h stall (resident), 2 h MCP timeouts on both, user overrides win on every knob",
  );
}

main();
