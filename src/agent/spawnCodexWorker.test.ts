// Direct verification of `runCodexWorker` — the spawn-MCP dispatch path
// for Codex-backed sub-agent workers. Phase 7 added the `runtime: "codex"`
// arg to the spawn tool so a Claude parent can fan out to a Codex worker
// without an MCP shim on the worker side. The worker is a single-turn
// CodexRuntime.send() that returns its final text.
//
// We never spawn a real `codex` process. Tests inject a fake
// CodexProcessFactory through SpawnCtx.codexProcessFactory and synthesize
// the JSONL the runtime would see. Final text is delivered via the `-o`
// last-message file the runtime writes (we pre-populate it from
// beforeRun, same pattern as codex.test.ts).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runCodexWorker, runClaudeWorker, type SpawnCtx } from "./tools/spawn.js";
import type { CodexProcess, CodexProcessOpts } from "./runtime/codexProcess.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type FakeProcessConfig = {
  lines: string[];
  exitCode?: number;
  stderr?: string;
  beforeRun?: (args: string[]) => Promise<void>;
};

function makeFactory(
  captured: Array<{ args: string[]; cwd: string }>,
  responses: FakeProcessConfig[],
): import("./runtime/codexProcess.js").CodexProcessFactory {
  let call = 0;
  return (opts: CodexProcessOpts): CodexProcess => {
    captured.push({ args: opts.args, cwd: opts.cwd });
    const cfg = responses[call] ?? responses[responses.length - 1] ?? { lines: [] };
    call += 1;
    const exitCode = cfg.exitCode ?? 0;
    const stderr = cfg.stderr ?? "";

    return {
      lines: () => {
        const linesArray = cfg.lines;
        const beforeRun = cfg.beforeRun;
        const argsCopy = [...opts.args];
        return (async function* () {
          if (beforeRun) await beforeRun(argsCopy);
          for (const l of linesArray) yield l;
        })();
      },
      stderr: async () => stderr,
      wait: async () => exitCode,
      kill: () => {
        /* no-op */
      },
    };
  };
}

// Real `codex --json` stdout shape (verified against codex v0.133.0).
function metaLine(id: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: id });
}
function agentMessageLine(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id: `item_${Math.random().toString(36).slice(2, 8)}`, type: "agent_message", text },
  });
}
function taskCompleteLine(_text: string): string {
  return JSON.stringify({ type: "turn.completed", usage: {} });
}

const TMP_ROOT = path.join(os.tmpdir(), `wormhole-spawn-codex-test-${Date.now()}`);

function dummyCanUseTool() {
  return async () => ({ behavior: "allow" as const, updatedInput: {} });
}

function buildCtx(processFactoryArg: ReturnType<typeof makeFactory>, workdir?: string): SpawnCtx {
  return {
    workdir: workdir ?? TMP_ROOT,
    depth: 0,
    buildSlackMcp: () => ({ instance: {}, name: "slack", type: "sdk" as const }) as never,
    buildCanUseTool: dummyCanUseTool,
    codexProcessFactory: processFactoryArg,
  };
}

async function main() {
  await fs.mkdir(TMP_ROOT, { recursive: true });

  // --- (1) Success path: Codex worker returns its final text ---
  {
    const captured: Array<{ args: string[]; cwd: string }> = [];
    const lastFile = path.join(TMP_ROOT, "last-1.txt");
    // We can't intercept the last-message-file path the runtime picks at
    // random — instead let the beforeRun write to whatever path was passed
    // in args (via -o), so the runtime reads back what we put there.
    const factory = makeFactory(captured, [
      {
        lines: [
          metaLine("11111111-2222-3333-4444-555555555555"),
          agentMessageLine("codex worker reply"),
          taskCompleteLine("codex worker reply"),
        ],
        beforeRun: async (args) => {
          const idx = args.indexOf("-o");
          if (idx >= 0) await fs.writeFile(args[idx + 1], "codex worker reply");
        },
      },
    ]);
    void lastFile;

    const result = await runCodexWorker(buildCtx(factory), "explain quicksort");
    assert(result.outcome === "completed", `outcome: ${result.outcome}`);
    assert(result.finalText === "codex worker reply", `finalText: ${result.finalText}`);
    assert(captured.length === 1, "one codex spawn");
    assert(captured[0].args[0] === "exec", "first arg is exec");
    assert(captured[0].cwd === TMP_ROOT, "cwd matches workdir");
  }

  // --- (2) Error path: codex exits non-zero → outcome failed, msg propagates
  {
    const captured: Array<{ args: string[]; cwd: string }> = [];
    const factory = makeFactory(captured, [
      { lines: [metaLine("err")], exitCode: 1, stderr: "boom: model offline" },
    ]);
    const result = await runCodexWorker(buildCtx(factory), "do thing");
    assert(result.outcome === "failed", `outcome should be failed: ${result.outcome}`);
    assert(
      result.finalText.includes("boom") || result.finalText.includes("model offline"),
      `error message propagated: ${result.finalText}`,
    );
    assert(captured.length === 1, "one spawn attempt before failure");
  }

  // --- (3) Workdir plumbed through to the codex subprocess ---
  {
    const captured: Array<{ args: string[]; cwd: string }> = [];
    const customWorkdir = path.join(TMP_ROOT, "custom");
    await fs.mkdir(customWorkdir, { recursive: true });
    const factory = makeFactory(captured, [
      {
        lines: [metaLine("wd"), agentMessageLine("ok"), taskCompleteLine("ok")],
        beforeRun: async (args) => {
          const idx = args.indexOf("-o");
          if (idx >= 0) await fs.writeFile(args[idx + 1], "ok");
        },
      },
    ]);

    const ctx = buildCtx(factory, customWorkdir);
    await runCodexWorker(ctx, "in custom dir");
    const cdIdx = captured[0].args.indexOf("--cd");
    assert(cdIdx >= 0, "--cd present");
    assert(captured[0].args[cdIdx + 1] === customWorkdir, `--cd value: ${captured[0].args[cdIdx + 1]}`);
    assert(captured[0].cwd === customWorkdir, "subprocess cwd matches");
  }

  // --- (4) Empty final-message file → sentinel string surfaces ---
  // The CodexRuntime returns "_(no response)_" when -o is missing/empty.
  // runCodexWorker should propagate that as the finalText, NOT crash, and
  // outcome stays completed (the codex run itself succeeded).
  {
    const captured: Array<{ args: string[]; cwd: string }> = [];
    const factory = makeFactory(captured, [
      {
        lines: [metaLine("empty")],
        // NO beforeRun → -o file is never written.
      },
    ]);
    const result = await runCodexWorker(buildCtx(factory), "hi");
    assert(result.outcome === "completed", "still completed");
    assert(result.finalText === "_(no response)_", `sentinel: ${result.finalText}`);
  }

  // --- (5) runClaudeWorker still exists as a separate export (smoke check)
  // We don't actually invoke it (would need a fake query()), just verify
  // the symbol is exported and callable — guards against accidental
  // signature drift between the two helpers.
  {
    assert(typeof runClaudeWorker === "function", "runClaudeWorker exported");
    assert(runClaudeWorker.length === 3, `runClaudeWorker arity: ${runClaudeWorker.length}`);
  }

  await fs.rm(TMP_ROOT, { recursive: true, force: true });

  console.log(
    "✅ runCodexWorker verified — success, error propagation, workdir plumbing, sentinel final, claude/codex symbol parity",
  );
}

main().catch(async (err) => {
  console.error("❌ runCodexWorker verification failed:", err);
  try {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  process.exit(1);
});
