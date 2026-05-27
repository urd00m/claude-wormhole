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
import { handleSpawn, type SpawnWorkerRunner } from "./codexSpawnServer.js";

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
    "✅ codexSpawnServer verified — handleSpawn (dispatch, depth cap, error, sentinel) + live MCP protocol (tools/list + tools/call over stdio)",
  );
}

main().catch((err) => {
  console.error("❌ codexSpawnServer verification failed:", err);
  process.exit(1);
});
