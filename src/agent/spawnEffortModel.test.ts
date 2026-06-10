// Verify per-call model/effort launch overrides thread through every spawn
// dispatch path:
//   - Claude one-shot: runClaudeWorker → SDK query options (model + effort)
//   - Codex one-shot:  runCodexWorker  → argv (-m <model> / -c model_reasoning_effort=<level>)
//   - Resident:        handleResidentSpawn → ResidentWorkerOpts at creation
// No real subprocesses: Claude uses the SpawnCtx.claudeQueryFn seam, Codex
// the codexProcessFactory seam, resident a registry with a capturing
// makeWorker — same patterns as spawnCodexWorker.test.ts / spawnResident.test.ts.

import os from "node:os";
import {
  runClaudeWorker,
  runCodexWorker,
  handleResidentSpawn,
  type SpawnCtx,
} from "./tools/spawn.js";
import { ResidentWorkerRegistry } from "./residentWorkerRegistry.js";
import type { ResidentWorker, ResidentWorkerOpts } from "./runtime/residentWorker.js";
import type { CodexProcess, CodexProcessOpts } from "./runtime/codexProcess.js";
import type { QueryFn } from "./runtime/claude.js";
import { env } from "../config.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// --- Claude seam: capture query options, yield a minimal successful turn ---
function makeFakeQuery(captured: Array<Record<string, unknown>>): QueryFn {
  return ((params: { prompt: unknown; options?: Record<string, unknown> }) => {
    captured.push(params.options ?? {});
    return (async function* () {
      yield { type: "result", subtype: "success", result: "ok" };
    })();
  }) as unknown as QueryFn;
}

// --- Codex seam: capture argv, emit a minimal successful JSONL turn ---
function makeCodexFactory(captured: string[][]): (opts: CodexProcessOpts) => CodexProcess {
  return (opts: CodexProcessOpts): CodexProcess => {
    captured.push([...opts.args]);
    return {
      lines: () =>
        (async function* () {
          yield JSON.stringify({ type: "thread.started", thread_id: "t-1" });
          yield JSON.stringify({ type: "turn.completed", usage: {} });
        })(),
      stderr: async () => "",
      wait: async () => 0,
      kill: () => {
        /* no-op */
      },
    };
  };
}

function buildCtx(over: Partial<SpawnCtx> = {}): SpawnCtx {
  return {
    workdir: os.tmpdir(),
    depth: 0,
    buildSlackMcp: () => ({ instance: {}, name: "slack", type: "sdk" as const }) as never,
    buildCanUseTool: () => async () => ({ behavior: "allow" as const, updatedInput: {} }),
    ...over,
  };
}

function makeFakeWorker(opts: ResidentWorkerOpts): ResidentWorker {
  return {
    name: opts.name,
    ownerThread: opts.ownerThread,
    workdir: opts.workdir,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastError: null,
    status: "idle",
    send: async () => "ok",
    kill: () => {},
  } as unknown as ResidentWorker;
}

async function main() {
  // --- (1) Claude worker: model + effort land in SDK query options ---
  {
    const captured: Array<Record<string, unknown>> = [];
    const ctx = buildCtx({ claudeQueryFn: makeFakeQuery(captured) });
    const out = await runClaudeWorker(ctx, "hi", {}, { model: "claude-opus-4-8", effort: "high" });
    assert(out.outcome === "completed", `claude worker completed: ${out.finalText}`);
    assert(captured.length === 1, "one query() call");
    assert(captured[0].model === "claude-opus-4-8", `model override: ${captured[0].model}`);
    assert(captured[0].effort === "high", `effort override: ${captured[0].effort}`);
  }

  // --- (2) Claude worker: omitted → default model, NO effort key ---
  {
    const captured: Array<Record<string, unknown>> = [];
    const ctx = buildCtx({ claudeQueryFn: makeFakeQuery(captured) });
    await runClaudeWorker(ctx, "hi", {});
    assert(captured[0].model === env.ANTHROPIC_MODEL, `default model: ${captured[0].model}`);
    assert(!("effort" in captured[0]), "no effort key when omitted");
  }

  // --- (3) Codex worker: model + effort land in argv ---
  {
    const captured: string[][] = [];
    const ctx = buildCtx({ codexProcessFactory: makeCodexFactory(captured) });
    const out = await runCodexWorker(ctx, "hi", { model: "gpt-5", effort: "high" });
    assert(out.outcome === "completed", `codex worker completed: ${out.finalText}`);
    const args = captured[0];
    assert(
      args.some((a, i) => a === "-m" && args[i + 1] === "gpt-5"),
      `-m gpt-5 in argv: ${args.join(" ")}`,
    );
    assert(
      args.some((a, i) => a === "-c" && args[i + 1] === "model_reasoning_effort=high"),
      `effort flag in argv: ${args.join(" ")}`,
    );
  }

  // --- (4) Codex worker: omitted → no model/effort flags ---
  {
    const captured: string[][] = [];
    const ctx = buildCtx({ codexProcessFactory: makeCodexFactory(captured) });
    await runCodexWorker(ctx, "hi");
    const args = captured[0];
    assert(!args.includes("-m"), `no -m when omitted: ${args.join(" ")}`);
    assert(
      !args.some((a) => a.startsWith("model_reasoning_effort=")),
      `no effort flag when omitted: ${args.join(" ")}`,
    );
  }

  // --- (5) Resident: model + effort reach the worker's creation opts ---
  {
    const capturedOpts: ResidentWorkerOpts[] = [];
    const reg = new ResidentWorkerRegistry((o) => {
      capturedOpts.push(o);
      return makeFakeWorker(o);
    });
    const ctx = buildCtx({ threadKey: "C:T" });
    const res = await handleResidentSpawn(
      ctx,
      { prompt: "hello", name: "bob", model: "claude-opus-4-8", effort: "max" },
      reg,
    );
    assert(res.isError !== true, `resident spawn ok: ${JSON.stringify(res)}`);
    assert(capturedOpts[0].model === "claude-opus-4-8", `resident model: ${capturedOpts[0].model}`);
    assert(capturedOpts[0].effort === "max", `resident effort: ${capturedOpts[0].effort}`);

    // Second spawn to the same warm worker: no new creation, so a different
    // effort is (by design) ignored — creation-only semantics.
    await handleResidentSpawn(ctx, { prompt: "again", name: "bob", effort: "low" }, reg);
    assert(capturedOpts.length === 1, "same-name spawn reuses worker (no second creation)");
  }

  console.log("✅ spawn model/effort overrides verified (claude options, codex argv, resident creation)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
