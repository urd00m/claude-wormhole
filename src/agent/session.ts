import type { CanUseTool, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime } from "./runtime/claude.js";
import type { Runtime, SessionInput, SessionOutput, StreamHooks } from "./runtime/types.js";

// Re-export runtime-neutral types so existing imports
// (`import { ... } from "./session.js"`) keep working unchanged.
export type { SessionInput, SessionOutput, StreamHooks, TaskEvent } from "./runtime/types.js";
export { BACKGROUND_WORKER_TYPE } from "./subagentDepth.js";
// RECURSIVE_AGENTS and QueryFn are Claude-specific but exposed here for
// backward compatibility with existing tests / callers.
export { RECURSIVE_AGENTS, type QueryFn } from "./runtime/claude.js";

/**
 * Two ways to construct a Session:
 *
 *   (a) "Legacy" — pass workdir + optional Claude-specific opts. Session
 *       builds a ClaudeRuntime internally. Used by the existing tests
 *       (sessionStream, sessionIsolation, manager) and by any caller that
 *       hasn't been updated to pick a runtime.
 *
 *   (b) "Runtime injection" — pass a pre-built `runtime` directly. Used by
 *       SessionManager once it learned how to pick Claude vs Codex based
 *       on the per-thread store + DEFAULT_RUNTIME. The (a) path is just
 *       sugar for the common Claude case.
 *
 * setMcpServers / setCanUseTool are Claude-specific and silently no-op
 * when the underlying runtime is not Claude (e.g. Codex). Callers that
 * need to know — like handlers.ts when deciding whether to build the MCP
 * server map — should branch on `session.runtimeName` first.
 */
type SessionLegacyOpts = {
  threadKey: string;
  workdir: string;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
  queryFn?: import("./runtime/claude.js").QueryFn;
  runtime?: never;
};

type SessionInjectedOpts = {
  threadKey: string;
  runtime: Runtime;
  workdir?: never;
  canUseTool?: never;
  mcpServers?: never;
  queryFn?: never;
};

type SessionOpts = SessionLegacyOpts | SessionInjectedOpts;

export class Session {
  readonly threadKey: string;
  private readonly _runtime: Runtime;
  private _active = false;

  /**
   * True while a send() turn is in flight. Used by the completion-wake
   * mechanism (slack/completionWake.ts) to decide whether a background-task
   * completion needs to re-invoke the agent: if a turn is already active the
   * SDK delivers the completion into it, so we only wake when idle.
   */
  get isActive(): boolean {
    return this._active;
  }

  constructor(opts: SessionOpts) {
    this.threadKey = opts.threadKey;
    if (opts.runtime) {
      this._runtime = opts.runtime;
    } else {
      this._runtime = new ClaudeRuntime({
        threadKey: opts.threadKey,
        workdir: opts.workdir,
        canUseTool: opts.canUseTool,
        mcpServers: opts.mcpServers,
        queryFn: opts.queryFn,
      });
    }
  }

  get workdir(): string {
    return this._runtime.workdir;
  }

  get runtime(): Runtime {
    return this._runtime;
  }

  get runtimeName(): Runtime["name"] {
    return this._runtime.name;
  }

  /**
   * Claude-specific. Silent no-op on non-Claude runtimes — callers
   * deciding whether to BUILD the MCP map should branch on `runtimeName`
   * first to avoid wasted work.
   */
  setMcpServers(servers: Record<string, McpSdkServerConfigWithInstance>): void {
    if (this._runtime instanceof ClaudeRuntime) {
      this._runtime.setMcpServers(servers);
    }
  }

  /**
   * Claude-specific. Silent no-op on non-Claude runtimes. Codex's
   * approval surface is the sandbox / bypass flag pair set at process
   * spawn time (see codex.ts) — there's no per-call hook to wire here.
   */
  setCanUseTool(fn: CanUseTool): void {
    if (this._runtime instanceof ClaudeRuntime) {
      this._runtime.setCanUseTool(fn);
    }
  }

  setWorkdir(newWorkdir: string): void {
    this._runtime.setWorkdir(newWorkdir);
  }

  resetConversation(): void {
    this._runtime.resetConversation();
  }

  /**
   * Best-effort interrupt of the in-flight turn (the "ctrl+c" control
   * phrase). Runtime-neutral — Claude signals the SDK control channel,
   * Codex kills its subprocess. Resolves true if a turn was signalled.
   */
  interrupt(): Promise<boolean> {
    return this._runtime.interrupt();
  }

  /**
   * The session id the context_length skill can read a transcript for, or
   * null. Claude-only — Codex stores its rollout differently, so the
   * context-usage footer is skipped for Codex threads.
   */
  contextSessionId(): string | null {
    return this._runtime instanceof ClaudeRuntime ? this._runtime.contextSessionId : null;
  }

  /** Cumulative session usage (Claude only), or null. Displayed with the context footer. */
  usageSnapshot(): import("./runtime/types.js").SessionUsage | null {
    return this._runtime instanceof ClaudeRuntime ? this._runtime.usageSnapshot() : null;
  }

  async send(input: SessionInput, hooks: StreamHooks = {}): Promise<SessionOutput> {
    this._active = true;
    try {
      return await this._runtime.send(input, hooks);
    } finally {
      this._active = false;
    }
  }
}
