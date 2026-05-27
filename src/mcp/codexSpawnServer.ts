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

export type SpawnSubRuntime = "codex" | "claude";
export type SpawnWorkerArgs = { prompt: string; model?: string; effort?: string; runtime?: SpawnSubRuntime };
export type SpawnWorkerResult = { text: string; isError: boolean };
export type SpawnWorkerRunner = (args: SpawnWorkerArgs) => Promise<SpawnWorkerResult>;

function envInt(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Pure arg builder for a CODEX sub-worker (exported for tests). The worker
 * re-attaches this spawn MCP server at `childDepth` so it can recurse;
 * final text is captured from the `-o` file.
 */
export function buildCodexSubArgs(opts: {
  prompt: string;
  model?: string;
  effort?: string;
  workdir: string;
  lastFile: string;
  tsx?: string;
  server?: string;
}): string[] {
  const a = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--cd",
    opts.workdir,
    "--dangerously-bypass-approvals-and-sandbox",
    "-o",
    opts.lastFile,
  ];
  if (opts.model) a.push("-m", opts.model);
  if (opts.effort) a.push("-c", `model_reasoning_effort=${opts.effort}`);
  if (opts.tsx && opts.server) {
    a.push("-c", `mcp_servers.wormhole_spawn.command="${opts.tsx}"`, "-c", `mcp_servers.wormhole_spawn.args=["${opts.server}"]`);
  }
  a.push("--", opts.prompt);
  return a;
}

/**
 * Pure arg builder for a CLAUDE sub-worker (exported for tests). Uses the
 * claude CLI's non-interactive print mode with JSON output; final text is
 * the `.result` field of the printed JSON. Claude sub-workers are leaves —
 * they have claude's native tool surface but are not given the wormhole
 * spawn MCP (no further wormhole recursion).
 */
export function buildClaudeSubArgs(opts: { prompt: string; model?: string }): string[] {
  const a = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
  if (opts.model) a.push("--model", opts.model);
  a.push(opts.prompt);
  return a;
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
 * Real runner: launch a sub-worker and return its final text. Dispatches on
 * `runtime` (default codex):
 *   - codex  → `codex exec`, ITSELF spawn-enabled at depth+1 (recursion);
 *              final text from the -o file.
 *   - claude → `claude -p --output-format json` (print mode); final text
 *              from the printed JSON's `.result`. A leaf — no further
 *              wormhole spawn MCP, but it has claude's native tools.
 * Config-free: model/paths from env.
 */
export function makeRealRunner(): SpawnWorkerRunner {
  const childDepth = envInt("WORMHOLE_SPAWN_DEPTH", 0) + 1;
  const workdir = process.env.WORMHOLE_SPAWN_WORKDIR || process.cwd();
  const tsx = process.env.WORMHOLE_SPAWN_TSX || "";
  const server = process.env.WORMHOLE_SPAWN_SERVER || "";
  const claudeBin = process.env.WORMHOLE_SPAWN_CLAUDE || "claude";

  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") baseEnv[k] = v;

  return async ({ prompt, model, effort, runtime }) => {
    if ((runtime ?? "codex") === "claude") {
      // Claude leaf worker via print mode; parse JSON .result from stdout.
      const args = buildClaudeSubArgs({ prompt, model });
      return await new Promise<SpawnWorkerResult>((resolve) => {
        const child = spawn(claudeBin, args, { cwd: workdir, env: baseEnv, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
        child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
        child.on("close", (code) => {
          try {
            const j = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
            const text = typeof j.result === "string" ? j.result.trim() : "";
            resolve({ text, isError: j.is_error === true || (code !== 0 && !text) });
          } catch {
            resolve({
              text: `claude spawn worker failed (code ${code}): ${stderr.trim() || stdout.trim() || "(no output)"}`,
              isError: true,
            });
          }
        });
      });
    }

    // Codex worker (recursion-enabled).
    const lastFile = path.join(os.tmpdir(), `wormhole-codex-spawn-${randomUUID()}.txt`);
    const args = buildCodexSubArgs({
      prompt,
      model: model || process.env.OPENAI_MODEL || undefined,
      effort,
      workdir,
      lastFile,
      tsx: tsx || undefined,
      server: server || undefined,
    });
    const childEnv = { ...baseEnv };
    if (tsx && server) childEnv.WORMHOLE_SPAWN_DEPTH = String(childDepth);

    return await new Promise<SpawnWorkerResult>((resolve) => {
      const child = spawn("codex", args, { cwd: workdir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
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
  "Launch another agent for a self-contained task and get its final answer back. Use for parallel/decomposed work — the worker has no memory of this conversation, so put all needed context in `prompt`. runtime defaults to 'codex' (which can itself spawn more workers, bounded by a depth cap); set runtime:'claude' to delegate to a Claude agent instead (a leaf worker with Claude's native tools).";

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
        runtime: z.enum(["codex", "claude"]).optional().describe("Which agent to launch. Default 'codex' (recursion-capable); 'claude' delegates to a Claude leaf worker."),
        model: z.string().optional().describe("Override the worker's model."),
        effort: z.string().optional().describe("Reasoning effort: low | medium | high (codex)."),
      },
    },
    async ({ prompt, model, effort, runtime }) => handleSpawn(runWorker, depth, maxDepth, { prompt, model, effort, runtime }),
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
