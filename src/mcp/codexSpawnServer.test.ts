// Verify the codex spawn MCP shim at two levels:
//   (1) handleSpawn — pure handler logic (depth cap, runner dispatch) with a
//       fake runner, no subprocess.
//   (2) protocol integration — run the REAL server script as a subprocess in
//       stub mode (WORMHOLE_SPAWN_TEST=1) and drive it with a real MCP
//       client over stdio: list tools, call spawn. This exercises the
//       actual MCP wiring (the same path codex uses) without spending codex
//       credits. The codex-actually-loads-it path was verified live by the
//       ping spike that preceded this feature.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  handleSpawn,
  buildCodexSubArgs,
  buildClaudeSubArgs,
  type SpawnWorkerArgs,
  type SpawnWorkerRunner,
} from "./codexSpawnServer.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // ===== (1) handleSpawn unit =====
  {
    const calls: Array<{ prompt: string }> = [];
    const runner: SpawnWorkerRunner = async ({ prompt }) => {
      calls.push({ prompt });
      return { text: `ran:${prompt}`, isError: false };
    };

    // within cap → dispatches, returns text
    let r = await handleSpawn(runner, 2, 10, { prompt: "do x" });
    assert(r.isError !== true && r.content[0].text === "ran:do x", `dispatch: ${JSON.stringify(r)}`);
    assert(calls.length === 1, "runner called once");

    // at cap boundary: depth+1 === max is allowed
    r = await handleSpawn(runner, 9, 10, { prompt: "edge" });
    assert(r.isError !== true, "depth+1 == max allowed");

    // past cap: depth+1 > max → denied, runner NOT called
    const before = calls.length;
    r = await handleSpawn(runner, 10, 10, { prompt: "too deep" });
    assert(r.isError === true && r.content[0].text.includes("cap"), `cap deny: ${JSON.stringify(r)}`);
    assert(calls.length === before, "runner not called past cap");

    // worker error propagates
    const failRunner: SpawnWorkerRunner = async () => ({ text: "boom", isError: true });
    r = await handleSpawn(failRunner, 0, 10, { prompt: "x" });
    assert(r.isError === true && r.content[0].text === "boom", "worker error propagates");

    // empty worker text → sentinel
    const emptyRunner: SpawnWorkerRunner = async () => ({ text: "", isError: false });
    r = await handleSpawn(emptyRunner, 0, 10, { prompt: "x" });
    assert(r.content[0].text.includes("no text"), "empty → sentinel");

    // runtime is forwarded to the runner (codex vs claude dispatch)
    const seen: SpawnWorkerArgs[] = [];
    const recordRunner: SpawnWorkerRunner = async (a) => {
      seen.push(a);
      return { text: "ok", isError: false };
    };
    await handleSpawn(recordRunner, 0, 10, { prompt: "p", runtime: "claude" });
    assert(seen[0].runtime === "claude", "runtime forwarded to runner");
  }

  // ===== (1b) arg builders =====
  {
    // Codex sub-worker: exec + model + effort + recursion MCP flags + prompt last.
    const ca = buildCodexSubArgs({
      prompt: "do x",
      model: "gpt-5",
      effort: "high",
      workdir: "/w",
      lastFile: "/tmp/last.txt",
      tsx: "/bin/tsx",
      server: "/srv.ts",
    });
    assert(ca[0] === "exec", "codex args start with exec");
    assert(ca.includes("-m") && ca[ca.indexOf("-m") + 1] === "gpt-5", "codex -m model");
    assert(ca.some((a, i) => a === "-c" && ca[i + 1] === "model_reasoning_effort=high"), "codex effort");
    assert(ca.some((a) => a.startsWith("mcp_servers.wormhole_spawn.command=")), "codex recursion MCP flag");
    const sep = ca.indexOf("--");
    assert(ca[sep + 1] === "do x", "codex prompt after --");
    // Without tsx/server → no recursion flags (leaf-ish).
    const ca2 = buildCodexSubArgs({ prompt: "y", workdir: "/w", lastFile: "/tmp/l" });
    assert(!ca2.some((a) => a.startsWith("mcp_servers.wormhole_spawn")), "no recursion flag without tsx/server");

    // Claude sub-worker: print mode + json + model + prompt last.
    const la = buildClaudeSubArgs({ prompt: "review", model: "claude-opus-4-7" });
    assert(la.includes("-p"), "claude -p");
    assert(la.includes("--output-format") && la[la.indexOf("--output-format") + 1] === "json", "claude json output");
    assert(la.includes("--model") && la[la.indexOf("--model") + 1] === "claude-opus-4-7", "claude --model");
    assert(la[la.length - 1] === "review", "claude prompt last");
    // No model → no --model flag.
    const la2 = buildClaudeSubArgs({ prompt: "x" });
    assert(!la2.includes("--model"), "no --model when model omitted");
  }

  // ===== (2) protocol integration: real server subprocess, stub worker =====
  {
    const tsx = path.join(HERE, "..", "..", "node_modules", ".bin", "tsx");
    const serverScript = path.join(HERE, "codexSpawnServer.ts");
    const client = new Client({ name: "test-client", version: "0.0.1" });
    const transport = new StdioClientTransport({
      command: tsx,
      args: [serverScript],
      env: { ...process.env, WORMHOLE_SPAWN_TEST: "1", WORMHOLE_SPAWN_DEPTH: "0", WORMHOLE_SPAWN_MAX_DEPTH: "10" } as Record<string, string>,
    });
    await client.connect(transport);
    try {
      // tools/list exposes `spawn`
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      assert(names.includes("spawn"), `server exposes spawn tool, got: ${names.join(",")}`);

      // tools/call spawn → stub runner echoes
      const res = await client.callTool({ name: "spawn", arguments: { prompt: "hello world" } });
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content.map((c) => c.text ?? "").join("");
      assert(text === "stub-worker:hello world", `spawn tool result: ${text}`);
    } finally {
      await client.close();
    }
  }

  console.log(
    "✅ codexSpawnServer verified — handleSpawn (dispatch, depth cap, error, sentinel, runtime fwd) + arg builders (codex/claude) + live MCP protocol (tools/list + tools/call over stdio)",
  );
}

main().catch((err) => {
  console.error("❌ codexSpawnServer verification failed:", err);
  process.exit(1);
});
