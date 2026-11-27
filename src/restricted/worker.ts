/** Entire process, all SDK/CLI tools and MCP children execute inside Docker. */
import readline from "node:readline";
import fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import type { Binding } from "../agent/continuityStore.js";
import type { Runtime } from "../agent/runtime/types.js";
import { bridgeToolDefs } from "./bridgeTools.js";
// No module logging may corrupt the JSON transport.
console.log = (...args) => console.error(...args);
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
let runtime: Runtime | undefined;
let initialized = false, sending = false;
let activeId: string | undefined;
let drainWorkers: (() => Promise<void>) | undefined;
let drainResidents: (() => Promise<void>) | undefined;
let socketServer: net.Server | undefined;
const waiting = new Map<string, { resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
async function hostCall(tool: string, args: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Gateway request timed out")); }, 120000);
    waiting.set(id, { resolve, reject, timer }); emit({ type: "gateway", id, tool, args });
  });
}
async function bridgeCall(tool: string, args: Record<string, unknown>): Promise<string> {
  if (!runtime) throw new Error("Session is not ready");
  if (tool === "get_workdir") return runtime.workdir;
  if (tool === "set_workdir") {
    const next = path.resolve(runtime.workdir, String(args.path).replace(/^~(?=\/|$)/, "/user/home"));
    if (!(await fs.stat(next)).isDirectory()) throw new Error("Not a directory inside the container");
    runtime.setWorkdir(next); return `Next message will use ${next}`;
  }
  if (!["notify_alan", "slack_post_message", "slack_post_file"].includes(tool)) throw new Error("Unknown gateway operation");
  return hostCall(tool, { ...args, workdir: runtime.workdir });
}
async function initialize(binding: Binding): Promise<void> {
  if (initialized || !binding.execution || process.env.WORMHOLE_WORKER !== "1") throw new Error("Invalid worker initialization");
  initialized = true;
  const auth = JSON.parse(await fs.readFile("/user/auth/runtime.json", "utf8"));
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_MODEL", "OPENAI_MODEL"]) if (typeof auth[key] === "string" && auth[key]) process.env[key] = auth[key];
  await fs.mkdir(binding.workdir, { recursive: true });
  const socket = "/tmp/wormhole-" + randomUUID() + ".sock";
  process.env.WORMHOLE_BRIDGE_SOCKET = socket;
  const { validateNativeSession } = await import("../agent/nativeSession.js");
  validateNativeSession(binding);
  const continuity = {
    sessionId: binding.sessionId, started: binding.started, providerHome: binding.providerHome,
    onIdentity: (identity: unknown) => emit({ type: "identity", identity }),
  };
  if (binding.runtime === "codex") {
    const { CodexRuntime } = await import("../agent/runtime/codex.js");
    runtime = new CodexRuntime({ threadKey: binding.key, workdir: binding.workdir, launch: binding.launch, continuity, enableSpawnMcp: true });
  } else {
    const { ClaudeRuntime } = await import("../agent/runtime/claude.js");
    const { buildClaudeMcpServer } = await import("../agent/tools/claudeMcp.js");
    const { buildSpawnMcp, drainBackgroundWorkers } = await import("../agent/tools/spawn.js");
    const { getResidentWorkerRegistry } = await import("../agent/residentWorkerRegistry.js");
    drainWorkers = drainBackgroundWorkers;
    drainResidents = () => getResidentWorkerRegistry().drain();
    const makeBridge = () => buildClaudeMcpServer("bridge", bridgeToolDefs(bridgeCall));
    const canUseTool = async () => ({ behavior: "allow" as const, updatedInput: undefined });
    runtime = new ClaudeRuntime({ threadKey: binding.key, workdir: binding.workdir, launch: binding.launch, continuity, canUseTool,
      mcpServers: {
        bridge: makeBridge(),
        spawn: buildSpawnMcp({ workdir: binding.workdir, threadKey: binding.key, depth: 0, buildSlackMcp: makeBridge, buildCanUseTool: () => canUseTool,
          onTaskEvent: async event => {
            emit({ type: "task", event });
            if (event.kind === "notification" && !sending) emit({ type: "wake", taskId: event.taskId, prompt: `Background task ${event.taskId} ${event.status}: ${event.summary}` });
          },
        }),
      },
    });
  }
  socketServer = net.createServer(client => {
    client.on("error", () => {});
    readline.createInterface({ input: client }).once("line", async line => {
      try { const req = JSON.parse(line); const text = await bridgeCall(req.tool, req.args ?? {}); client.end(JSON.stringify({ text }) + "\n"); }
      catch (e) { client.end(JSON.stringify({ error: String(e) }) + "\n"); }
    });
  });
  await new Promise<void>((resolve, reject) => { socketServer!.once("error", reject); socketServer!.listen(socket, resolve); });
}
async function handle(msg: any): Promise<void> {
  if (msg.op === "gateway_result") {
    const w = waiting.get(msg.id); if (!w) return;
    waiting.delete(msg.id); clearTimeout(w.timer);
    msg.error ? w.reject(new Error(msg.error)) : w.resolve(msg.text); return;
  }
  try {
    if (msg.op === "init") { await initialize(msg.binding); emit({ type: "result", id: msg.id, value: true }); return; }
    if (!runtime) throw new Error("Worker not initialized");
    if (msg.op === "interrupt") { emit({ type: "result", id: msg.id, value: await runtime.interrupt() }); return; }
    if (msg.op === "drain") {
      await drainWorkers?.(); await drainResidents?.();
      await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify({ type: "result", id: msg.id, value: true }) + "\n", e => e ? reject(e) : resolve()));
      socketServer?.close(); process.exit(0);
    }
    if (msg.op !== "send" || sending) throw new Error("Worker is busy or operation is invalid");
    sending = true; activeId = msg.id;
    try {
      const out = await runtime.send(msg.input, {
        onText: text => emit({ type: "text", id: activeId, text }),
        onToolStart: (toolId, name) => emit({ type: "tool_start", id: activeId, toolId, name }),
        onToolEnd: (toolId, ok) => emit({ type: "tool_end", id: activeId, toolId, ok }),
        onFinal: text => emit({ type: "final", id: activeId, text }),
        onTaskEvent: event => emit({ type: "task", event }),
      });
      emit({ type: "result", id: msg.id, value: out });
    } finally { sending = false; activeId = undefined; }
  } catch (e) {
    const failure = e && typeof e === "object" && "failure" in e ? e.failure : undefined;
    emit({ type: "error", id: msg.id, message: e instanceof Error ? e.message : String(e), failure });
  }
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
  try { void handle(JSON.parse(line)); } catch { emit({ type: "error", message: "Invalid gateway request" }); }
}).on("close", () => { void runtime?.interrupt().finally(() => process.exit(0)); if (!runtime) process.exit(0); });
