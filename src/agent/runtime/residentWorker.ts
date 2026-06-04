// Resident sub-agent workers — the MCP-spawn-only "stay alive and warm"
// model. Unlike the one-shot workers in spawn.ts (each a fresh `query()` /
// `codex exec` that runs once and exits), a ResidentWorker holds ONE
// streaming-input `query()` open across many invocations. Its context lives
// in that process's memory — no resume cookie, no re-spawn. It stays alive
// until kill() (by the main agent via worker_kill) or the bot process exits.
//
// Mechanism (validated by scripts/spike-resident.ts against the real SDK):
//   - query({ prompt: <AsyncIterable<SDKUserMessage>> }) opens streaming
//     input mode. The process stays alive as long as the input iterable
//     isn't closed.
//   - send(prompt) pushes a user message into the iterable and reads the
//     output generator until THAT turn's `result` message.
//   - CRITICAL: read with manual q.next(), never `for await...of`. Breaking
//     out of a for-await calls the iterator's .return(), which finalizes
//     the whole query — the spike caught exactly this (turn 2 came back
//     empty). Manual .next() leaves the generator live between turns.
//
// Claude-only for v1. Codex resident workers would need one of its
// experimental server modes (mcp-server / exec-server / app-server) and a
// separate spike — deferred.

import {
  query,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { env } from "../../config.js";
import { SYSTEM_PROMPT } from "../systemPrompt.js";
import type { QueryFn } from "./claude.js";

/**
 * Push-able async iterable used as the resident query's input channel. The
 * worker pushes a user message per invocation; the SDK consumes them in
 * order. close() ends the stream, which makes the resident query() finish
 * and the underlying CLI process exit.
 */
export class InputChannel {
  private queue: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error("InputChannel is closed");
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiting = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }
}

export type ResidentWorkerStatus = "idle" | "running" | "dead";

export type ResidentWorkerOpts = {
  name: string;
  ownerThread: string;
  workdir: string;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  /** Test seam — defaults to the real SDK query. */
  queryFn?: QueryFn;
};

/**
 * Env for the resident worker's CLI subprocess. We bump the async-agent
 * stall watchdog to 24 h — resident workers sit IDLE between invocations
 * by design, so they must not be reaped by the default 10-min watchdog.
 * One-shot workers use 2 h (see buildWorkerEnv); residents go further
 * because their idle periods are open-ended. User overrides win.
 */
export function buildResidentEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  if (!out.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS) {
    out.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS = String(24 * 60 * 60 * 1000);
  }
  return out;
}

export class ResidentWorker {
  readonly name: string;
  readonly ownerThread: string;
  readonly workdir: string;
  readonly createdAt: string;
  lastRunAt: string | null = null;
  status: ResidentWorkerStatus = "idle";
  lastError: string | null = null;

  private readonly input: InputChannel;
  private readonly q: AsyncGenerator<SDKMessage, void>;
  /** Tail of the per-worker send queue — serializes concurrent sends. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: ResidentWorkerOpts) {
    this.name = opts.name;
    this.ownerThread = opts.ownerThread;
    this.workdir = opts.workdir;
    this.createdAt = new Date().toISOString();
    this.input = new InputChannel();

    const queryFn: QueryFn = opts.queryFn ?? (query as unknown as QueryFn);
    this.q = queryFn({
      prompt: this.input as AsyncIterable<unknown>,
      options: {
        cwd: opts.workdir,
        model: env.ANTHROPIC_MODEL,
        systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_PROMPT },
        tools: { type: "preset", preset: "claude_code" },
        disallowedTools: ["AskUserQuestion"],
        canUseTool: opts.canUseTool,
        mcpServers: opts.mcpServers,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        additionalDirectories: ["/"],
        includePartialMessages: false,
        env: buildResidentEnv(),
      },
    }) as AsyncGenerator<SDKMessage, void>;
  }

  /**
   * Send one prompt to the warm worker and return its reply. Serialized
   * per-worker: concurrent sends queue behind each other so they don't
   * interleave on the single streaming input/output channel.
   */
  send(prompt: string): Promise<string> {
    const run = this.tail.then(() => this.sendInner(prompt));
    // Keep the chain alive even if a send rejects, so later sends still run.
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async sendInner(prompt: string): Promise<string> {
    if (this.status === "dead") {
      throw new Error(`resident worker '${this.name}' is dead (killed or process exited)`);
    }
    this.status = "running";
    this.lastRunAt = new Date().toISOString();
    try {
      this.input.push(prompt);
      const text = await this.readTurn();
      this.status = "idle";
      return text;
    } catch (err) {
      this.status = "dead";
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /**
   * Pull messages until the current turn's `result`. Manual q.next() —
   * see the class comment for why `for await` would finalize the query.
   * If the generator ends (process died), mark dead and throw.
   */
  private async readTurn(): Promise<string> {
    // Accumulate every assistant text block across the turn. The terminal
    // `result` message's text is only the FINAL assistant message, so using
    // it as an override would truncate a long, tool-interleaved report down
    // to its tail (the same "long messages cut off" bug fixed in
    // runtime/claude.ts). `result` is therefore a fallback used only when no
    // assistant text was seen. (A resident worker's spawns run as separate
    // query() processes, so this stream contains only its own messages.)
    let assistantText = "";
    let resultText: string | null = null;
    for (;;) {
      const step = await this.q.next();
      if (step.done) {
        this.status = "dead";
        throw new Error(`resident worker '${this.name}' ended unexpectedly mid-turn`);
      }
      const msg = step.value;
      if (msg.type === "assistant") {
        const content =
          (msg as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
            ?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string") assistantText += block.text;
        }
      } else if (msg.type === "result") {
        const r = msg as { subtype?: string; result?: string };
        if (r.subtype === "success" && typeof r.result === "string") resultText = r.result;
        return (assistantText.length > 0 ? assistantText : resultText ?? "") || "_(no response)_";
      }
    }
  }

  /** Terminate the worker: close the input stream so the query() finishes. */
  kill(): void {
    if (this.status === "dead") return;
    this.status = "dead";
    this.input.close();
  }
}
