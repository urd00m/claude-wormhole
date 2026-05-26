// Runtime port — provider-neutral surface for the per-thread agent backend.
//
// Today the only implementation is `ClaudeRuntime` (Claude Agent SDK via the
// bundled `claude` CLI subprocess). A second implementation, `CodexRuntime`
// (OpenAI Codex CLI subprocess), will be added later. `Session` owns one
// `Runtime` and delegates per-turn work to it.
//
// The interface is deliberately minimal: anything that can be expressed in
// runtime-neutral terms lives here; anything provider-specific (Anthropic
// SDK options, MCP server shapes, canUseTool callbacks for Claude;
// approval-policy IPC for Codex) is configured directly on the concrete
// runtime instance and is NOT part of this port.

export type SessionInput = {
  text: string;
  attachments?: string[];
};

export type SessionOutput = {
  finalText: string;
};

/**
 * Lifecycle events for sub-agent Tasks (especially background ones, whose
 * completion arrives out-of-band on the parent's message stream).
 *
 * Runtime-neutral: each runtime is responsible for translating its own
 * sub-agent lifecycle representation into these events.
 */
export type TaskEvent =
  | {
      kind: "started";
      taskId: string;
      toolUseId?: string;
      description: string;
      subagentType?: string;
    }
  | {
      kind: "progress";
      taskId: string;
      toolUseId?: string;
      description: string;
      summary?: string;
    }
  | {
      kind: "notification";
      taskId: string;
      toolUseId?: string;
      status: "completed" | "failed" | "stopped";
      summary: string;
    };

export type StreamHooks = {
  onText?: (chunk: string) => void;
  /** `id` is the runtime's tool-use id; pair with onToolEnd for matching. */
  onToolStart?: (id: string, name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (id: string, ok: boolean) => void;
  /** Called once with the canonical final text after the agent finishes. */
  onFinal?: (text: string) => void;
  /** Called for sub-agent task lifecycle events (background workers, etc.). */
  onTaskEvent?: (event: TaskEvent) => void;
};

/**
 * Per-thread agent runtime. One instance per `Session`. Owns its own
 * conversation-continuation state (Claude session_id pinning, Codex resume
 * cookie, etc.) — `Session` is runtime-agnostic and just forwards.
 */
export interface Runtime {
  /** Stable identifier for telemetry / debug. */
  readonly name: "claude" | "codex";

  /** Current cwd. Reads through to whatever the runtime is using for its next turn. */
  readonly workdir: string;

  /** Send one user turn and stream the agent's response through `hooks`. */
  send(input: SessionInput, hooks?: StreamHooks): Promise<SessionOutput>;

  /**
   * Update the cwd for subsequent turns AND rotate any conversation-resume
   * state so the next turn starts fresh in the new directory (avoiding
   * cross-thread bleed when two threads happen to share a workdir).
   */
  setWorkdir(newWorkdir: string): void;

  /** Force the next turn to start a fresh conversation. */
  resetConversation(): void;
}
