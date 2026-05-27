// Stdio MCP server that gives a Codex worker a `spawn` tool, so codex
// sub-agents can launch further agents instead of being one-shot. Codex
// runs this as a child of `codex exec` (configured via -c mcp_servers,
// see agent/runtime/codexSpawnMcp.ts).
//
// CONFIG-FREE BY DESIGN: this process is spawned by codex, which is spawned
// by the wormhole. It must NOT import ../config.js — that validates the
// full env and process.exit(1)s on anything missing, which would kill the
// MCP server on startup. Everything it needs comes from WORMHOLE_SPAWN_*
// env vars set by codexSpawnMcpFlags.
//
// Recursion + depth cap: this server runs at WORMHOLE_SPAWN_DEPTH. Its
// `spawn` tool launches a child codex worker at depth+1, re-attaching this
// same MCP server so the child can spawn too. The handler denies once
// depth+1 exceeds WORMHOLE_SPAWN_MAX_DEPTH, so the chain is bounded.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

export type SpawnWorkerArgs = { prompt: string; model?: string; effort?: string };
export type SpawnWorkerResult = { text: string; isError: boolean };
export type SpawnWorkerRunner = (args: SpawnWorkerArgs) => Promise<SpawnWorkerResult>;

function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Pure spawn-tool handler — extracted from the MCP wiring so it can be
 * unit-tested with a fake runner. Enforces the depth cap, then delegates to
 * `runWorker`. `depth` is THIS server's level; a spawn creates a child at
 * depth+1.
 */
export async function handleSpawn(
  runWorker: SpawnWorkerRunner,
  depth: number,
  maxDepth: number,
  args: SpawnWorkerArgs,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const childDepth = depth + 1;
  if (childDepth > maxDepth) {
    return {
      content: [{ type: "text", text: `spawn denied: worker would run at depth ${childDepth}, cap is ${maxDepth}` }],
      isError: true,
    };
  }
  const r = await runWorker(args);
  return { content: [{ type: "text", text: r.text || "(worker produced no text)" }], isError: r.isError };
}

/**
 * Real runner: spawn a `codex exec` worker that is ITSELF spawn-enabled at
 * depth+1 (re-attaching this MCP server), capture its final message from
 * the -o file, and return it. Config-free: model/paths from env.
 */
export function makeRealRunner(): SpawnWorkerRunner {
  const childDepth = envInt("WORMHOLE_SPAWN_DEPTH", 0) + 1;
  const workdir = process.env.WORMHOLE_SPAWN_WORKDIR || process.cwd();
  const tsx = process.env.WORMHOLE_SPAWN_TSX || "";
  const server = process.env.WORMHOLE_SPAWN_SERVER || "";

  return async ({ prompt, model, effort }) => {
    const lastFile = path.join(os.tmpdir(), `wormhole-codex-spawn-${randomUUID()}.txt`);
    const a: string[] = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--cd",
      workdir,
      "--dangerously-bypass-approvals-and-sandbox",
      "-o",
      lastFile,
    ];
    const m = model || process.env.OPENAI_MODEL || "";
    if (m) a.push("-m", m);
    if (effort) a.push("-c", `model_reasoning_effort=${effort}`);

    // Re-attach this MCP server so the child can recurse. The child server
    // runs at childDepth and will itself deny past the cap.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") childEnv[k] = v;
    if (tsx && server) {
      a.push("-c", `mcp_servers.wormhole_spawn.command="${tsx}"`, "-c", `mcp_servers.wormhole_spawn.args=["${server}"]`);
      childEnv.WORMHOLE_SPAWN_DEPTH = String(childDepth);
    }
    a.push("--", prompt);

    return await new Promise<SpawnWorkerResult>((resolve) => {
      const child = spawn("codex", a, { cwd: workdir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      // Drain stdout so the pipe doesn't fill; final text comes from -o.
      const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      rl.on("line", () => {});
      child.on("close", async (code) => {
        let text = "";
        try {
          text = (await fs.readFile(lastFile, "utf8")).trim();
        } catch {
          /* no -o file on weird exit */
        }
        await fs.unlink(lastFile).catch(() => {});
        if (code !== 0 && !text) {
          resolve({ text: `codex spawn worker failed (code ${code}): ${stderr.trim() || "(no stderr)"}`, isError: true });
        } else {
          resolve({ text, isError: false });
        }
      });
    });
  };
}

const SPAWN_DESCRIPTION =
  "Launch another agent (a fresh codex worker) for a self-contained task and get its final answer back. Use for parallel/decomposed work — the worker has no memory of this conversation, so put all needed context in `prompt`. The worker can itself spawn more workers, bounded by a depth cap.";

/** Build the MCP server with an injected worker runner (test seam). */
export function buildCodexSpawnServer(
  runWorker: SpawnWorkerRunner,
  opts?: { depth?: number; maxDepth?: number },
): McpServer {
  const depth = opts?.depth ?? envInt("WORMHOLE_SPAWN_DEPTH", 0);
  const maxDepth = opts?.maxDepth ?? envInt("WORMHOLE_SPAWN_MAX_DEPTH", 10);
  const server = new McpServer({ name: "wormhole_spawn", version: "0.1.0" });
  server.registerTool(
    "spawn",
    {
      description: SPAWN_DESCRIPTION,
      inputSchema: {
        prompt: z.string().describe("Self-contained task for the worker."),
        model: z.string().optional().describe("Override the worker's model."),
        effort: z.string().optional().describe("Reasoning effort: low | medium | high."),
      },
    },
    async ({ prompt, model, effort }) => handleSpawn(runWorker, depth, maxDepth, { prompt, model, effort }),
  );
  return server;
}

async function main(): Promise<void> {
  const runner = process.env.WORMHOLE_SPAWN_TEST === "1"
    ? async ({ prompt }: SpawnWorkerArgs): Promise<SpawnWorkerResult> => ({ text: `stub-worker:${prompt}`, isError: false })
    : makeRealRunner();
  const server = buildCodexSpawnServer(runner);
  await server.connect(new StdioServerTransport());
}

// Run main only when executed directly (codex spawns `tsx codexSpawnServer.ts`),
// not when imported by tests.
if ((process.argv[1] ?? "").includes("codexSpawnServer")) {
  void main();
}
