// Verify the spawn-worker / resident-worker env sets the async-agent
// stall watchdog (the only CLI timer with documented firings in this
// repo) and that user-supplied values win.
//   - One-shot worker: stall = 2 h.
//   - Resident worker: stall = 24 h (residents sit idle by design).
// MCP_TOOL_TIMEOUT / MCP_TIMEOUT are NOT set by us — we don't have
// evidence they were ever firing, so we leave them to the CLI's default.

import { buildWorkerEnv } from "./spawn.js";
import { buildResidentEnv } from "../runtime/residentWorker.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

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
  // --- buildWorkerEnv: stall = 2 h, MCP timers left to CLI default ---
  {
    const env = withEnv(
      { CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: undefined, MCP_TOOL_TIMEOUT: undefined, MCP_TIMEOUT: undefined },
      () => buildWorkerEnv(),
    );
    assert(env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS === TWO_HOURS, `worker stall 2h: ${env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS}`);
    assert(env.MCP_TOOL_TIMEOUT === undefined, `MCP_TOOL_TIMEOUT not set: ${env.MCP_TOOL_TIMEOUT}`);
    assert(env.MCP_TIMEOUT === undefined, `MCP_TIMEOUT not set: ${env.MCP_TIMEOUT}`);
  }

  // --- buildWorkerEnv: user-supplied stall wins; user-supplied MCP timeouts pass through unchanged ---
  {
    const env = withEnv(
      { CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "999", MCP_TOOL_TIMEOUT: "888", MCP_TIMEOUT: "777" },
      () => buildWorkerEnv(),
    );
    assert(env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS === "999", "user stall wins");
    assert(env.MCP_TOOL_TIMEOUT === "888", "user-supplied MCP_TOOL_TIMEOUT pass-through");
    assert(env.MCP_TIMEOUT === "777", "user-supplied MCP_TIMEOUT pass-through");
  }

  // --- buildResidentEnv: stall = 24 h, MCP timers left to CLI default ---
  {
    const env = withEnv(
      { CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: undefined, MCP_TOOL_TIMEOUT: undefined, MCP_TIMEOUT: undefined },
      () => buildResidentEnv(),
    );
    assert(env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS === TWENTY_FOUR_HOURS, `resident stall 24h: ${env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS}`);
    assert(env.MCP_TOOL_TIMEOUT === undefined, "resident MCP_TOOL_TIMEOUT not set");
    assert(env.MCP_TIMEOUT === undefined, "resident MCP_TIMEOUT not set");
  }

  console.log(
    "✅ env-timers verified — 2 h stall (one-shot) / 24 h stall (resident); MCP_TOOL_TIMEOUT and MCP_TIMEOUT left to CLI defaults; user overrides pass through",
  );
}

main();
