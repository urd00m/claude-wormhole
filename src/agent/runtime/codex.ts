// Codex implementation of the Runtime port. Wraps the local `codex` CLI
// (codex-rs v0.133.0+) as a per-thread subprocess.
//
// Design rationale, by section:
//
// === Invocation shape ===
// Each `send()` spawns a fresh `codex exec` (first send) or `codex exec
// resume <uuid>` (subsequent sends). Unlike Claude's Agent SDK — which
// keeps a long-lived CLI subprocess and streams over its control pipe —
// Codex's `exec` subcommand is one-shot: it runs the prompt to completion
// then exits. Resume via session UUID is how we glue turns together.
//
// === Session UUID lifecycle ===
// Codex mints the session UUID itself (printed as the `id` field on the
// first `session_meta` event of the stream, and embedded in the rollout
// filename at ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl).
// We parse it out of that event and pin it on the runtime instance. The
// first send uses `codex exec`; every send after uses `codex exec resume
// <uuid>`. setWorkdir / resetConversation clear the pin so the next send
// starts a fresh session — analogous to ClaudeRuntime.
//
// === Final-text capture ===
// `-o <file>` writes the final agent message to a file. We use this as
// the authoritative final (mirroring how ClaudeRuntime treats
// `result.subtype === "success"`). The JSONL stream is the source of
// streaming `onText` chunks; `-o` is the source of truth at end-of-turn.
//
// === Event mapping (provisional) ===
// Persisted rollout files have shape `{ timestamp, type, payload }` with
// the type tier being one of session_meta / turn_context / event_msg /
// response_item. The stdout `--json` stream is likely the same wire shape
// but has not yet been confirmed against a real `codex exec --json`
// invocation. The mapping below is defensive — unknown event types are
// silently ignored, so a minor shape change doesn't crash the runtime.
// First real Codex thread will validate (or surface, via tests, the need
// to refine) the mapping.
//
// === Consent gate ===
// `--dangerously-bypass-approvals-and-sandbox` disables Codex's
// interactive approval prompts (no TTY in the wormhole) AND its sandbox
// layer. The wormhole's consent gate (classifyCall + askConsent) fires
// only on MCP tools we own (slack/workdir/cron/runtime/spawn); Codex's
// native shell is NOT gated. This is a real gap vs the Claude runtime.
// Phase 5 ships `--sandbox workspace-write` as a coarse mitigation; full
// per-command gating would require a `wormhole_shell` MCP tool that the
// model uses by convention.

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { env } from "../../config.js";
import type { Runtime, SessionInput, SessionOutput, StreamHooks } from "./types.js";
import {
  spawnCodexProcess,
  type CodexProcess,
  type CodexProcessFactory,
} from "./codexProcess.js";

export type CodexRuntimeOpts = {
  threadKey: string;
  workdir: string;
  /** Test seam — defaults to the real `codex` subprocess factory. */
  processFactory?: CodexProcessFactory;
  /**
   * Test seam — overrides the per-send last-message file path. Default
   * generates a unique tmp file per send; tests inject a predictable path
   * and pre-populate it.
   */
  lastMessageFileFactory?: () => string;
};

/**
 * Per-turn handle on the last-message file. We need a fresh path for each
 * `send()` because `codex exec` truncates and writes the file at end of
 * turn — sharing one path across concurrent sends would let outputs clobber
 * each other. (In practice the per-thread queue serializes sends, but the
 * defense-in-depth is cheap.)
 */
function defaultLastMessageFile(): string {
  return path.join(os.tmpdir(), `wormhole-codex-last-${randomUUID()}.txt`);
}

/**
 * Env passed to the Codex subprocess. Inherits process.env; if
 * OPENAI_API_KEY is set in the wormhole's env we forward it; otherwise we
 * explicitly DELETE it so Codex falls back to ~/.codex/auth.json (the
 * `codex login` subscription path). Mirrors ClaudeRuntime.
 */
function buildCodexEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  if (env.OPENAI_API_KEY) {
    out.OPENAI_API_KEY = env.OPENAI_API_KEY;
  } else {
    delete out.OPENAI_API_KEY;
  }
  return out;
}

function buildPrompt(input: SessionInput): string {
  const parts: string[] = [];
  if (input.attachments && input.attachments.length > 0) {
    parts.push("User uploaded files (in ./uploads/):");
    for (const a of input.attachments) parts.push(`- ${a}`);
    parts.push("");
  }
  parts.push(input.text);
  return parts.join("\n");
}

/**
 * Build the CLI args for either a fresh `codex exec` or `codex exec
 * resume <uuid>`. The two diverge only in (a) the presence of the `resume`
 * subcommand + positional UUID, and (b) which mode-specific flags are
 * accepted by each.
 */
function buildArgs(opts: {
  resumeFrom: string | null;
  workdir: string;
  model: string;
  lastMessageFile: string;
  prompt: string;
}): string[] {
  const common = [
    "--json",
    "--skip-git-repo-check",
    "--cd",
    opts.workdir,
    "-m",
    opts.model,
    "--dangerously-bypass-approvals-and-sandbox",
    "-o",
    opts.lastMessageFile,
  ];
  if (opts.resumeFrom === null) {
    // Fresh session: include --sandbox + --add-dir (accepted by `exec`
    // but not by `exec resume`, which inherits the resumed session's
    // sandbox config).
    return [
      "exec",
      ...common,
      "--sandbox",
      "workspace-write",
      "--add-dir",
      "/",
      "--",
      opts.prompt,
    ];
  }
  return ["exec", "resume", ...common, opts.resumeFrom, "--", opts.prompt];
}

/**
 * Defensive JSON parse — Codex's stream is well-formed JSONL in practice,
 * but stray garbage (e.g. unflushed log lines that ended up on stdout) must
 * not crash the runtime. Returns `null` for unparseable lines.
 */
function tryParseLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Extract the session UUID from a `session_meta` event. Returns null if
 * the line isn't a session_meta event or the payload lacks `id`.
 */
function extractSessionId(ev: unknown): string | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: string; payload?: { id?: unknown } };
  if (e.type !== "session_meta") return null;
  return typeof e.payload?.id === "string" ? e.payload.id : null;
}

/**
 * Best-effort detection of "the rollout file for the resumed session no
 * longer exists" — the user pruned ~/.codex/sessions/ or it never wrote
 * (e.g. --ephemeral was used somewhere). In that case `codex exec resume`
 * exits non-zero and stderr complains about the session. We detect via
 * substring matching on stderr and rotate the sessionId so the NEXT send
 * starts fresh, instead of looping on the same dead UUID.
 */
function isDanglingRolloutError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes("session") &&
    (s.includes("not found") || s.includes("missing") || s.includes("no such"))
  );
}

export class CodexRuntime implements Runtime {
  readonly name = "codex" as const;
  readonly threadKey: string;
  workdir: string;
  private sessionId: string | null = null;
  private readonly processFactory: CodexProcessFactory;
  private readonly lastMessageFileFactory: () => string;

  constructor(opts: CodexRuntimeOpts) {
    this.threadKey = opts.threadKey;
    this.workdir = opts.workdir;
    this.processFactory = opts.processFactory ?? spawnCodexProcess;
    this.lastMessageFileFactory = opts.lastMessageFileFactory ?? defaultLastMessageFile;
  }

  setWorkdir(newWorkdir: string): void {
    if (newWorkdir === this.workdir) return;
    this.workdir = newWorkdir;
    // Workdir change → context changed → don't resume the old session.
    // Codex would either refuse (rollout cwd mismatch) or run in the old
    // logical context, neither of which is what the user asked for.
    this.sessionId = null;
  }

  resetConversation(): void {
    this.sessionId = null;
  }

  async send(input: SessionInput, hooks: StreamHooks = {}): Promise<SessionOutput> {
    const lastMessageFile = this.lastMessageFileFactory();
    const prompt = buildPrompt(input);
    const sessionIdAtStart = this.sessionId;

    const args = buildArgs({
      resumeFrom: sessionIdAtStart,
      workdir: this.workdir,
      model: env.OPENAI_MODEL,
      lastMessageFile,
      prompt,
    });

    const proc: CodexProcess = this.processFactory({
      args,
      cwd: this.workdir,
      env: buildCodexEnv(),
    });

    let observedSessionId: string | null = null;

    try {
      for await (const line of proc.lines()) {
        const ev = tryParseLine(line);
        if (ev === null) continue;
        const newId = extractSessionId(ev);
        if (newId !== null && observedSessionId === null) {
          observedSessionId = newId;
        }
        this.dispatchEvent(ev, hooks);
      }

      const exitCode = await proc.wait();
      if (exitCode !== 0) {
        const stderr = await proc.stderr();
        // Dangling-rollout recovery: clear our pinned UUID so the next send
        // starts a fresh Codex session, and surface the failure to the
        // caller as a normal error (Slack handler converts it into an :x:
        // + error message). We don't silently retry — the user might want
        // to know their conversation history is gone.
        if (sessionIdAtStart !== null && isDanglingRolloutError(stderr)) {
          this.sessionId = null;
        }
        throw new Error(
          `codex exec ${sessionIdAtStart === null ? "" : "resume "}exited with code ${exitCode}: ${stderr.trim() || "(no stderr)"}`,
        );
      }

      // Pin the session UUID only on first-send success. On resume we keep
      // the existing pin (already correct).
      if (sessionIdAtStart === null && observedSessionId !== null) {
        this.sessionId = observedSessionId;
      }

      // Read the authoritative final text from -o, falling back to empty
      // (Slack renders "_(no response)_" downstream — see ClaudeRuntime
      // for the same sentinel).
      let finalText = "";
      try {
        finalText = (await fs.readFile(lastMessageFile, "utf8")).trim();
      } catch {
        /* file may not exist on weird exits — treat as empty */
      }
      const out = finalText || "_(no response)_";
      hooks.onFinal?.(out);
      return { finalText: out };
    } finally {
      // Always clean up the last-message file. Best-effort: a leftover in
      // tmp isn't a correctness issue but it accumulates.
      fs.unlink(lastMessageFile).catch(() => {});
    }
  }

  /**
   * Translate one Codex JSONL event into runtime-neutral StreamHooks
   * callbacks. Defensive — unknown event types are ignored. The mapping
   * below targets the rollout file shape (`{ timestamp, type, payload }`);
   * stdout-shape differences will surface in Phase 4 smoke tests and get
   * folded in here.
   */
  private dispatchEvent(ev: unknown, hooks: StreamHooks): void {
    if (typeof ev !== "object" || ev === null) return;
    const e = ev as {
      type?: string;
      payload?: {
        type?: string;
        message?: unknown;
        text?: unknown;
        last_agent_message?: unknown;
      };
    };

    if (e.type !== "event_msg") return;

    switch (e.payload?.type) {
      case "agent_message": {
        // Streaming text from the assistant. Surface as an onText chunk
        // so the Slack streamer can append it. The wormhole's stream.ts
        // already handles ordering + throttling.
        const text = typeof e.payload.message === "string" ? e.payload.message : null;
        if (text) hooks.onText?.(text);
        break;
      }
      case "user_message":
      case "task_started":
      case "task_complete":
      case "token_count":
        // user_message: echo of our own prompt, no surface.
        // task_started/task_complete: Codex's high-level turn lifecycle
        //   markers; the agent_message events carry the actual user-visible
        //   text. We deliberately don't fire onToolStart/onToolEnd from
        //   these — that wiring lands once we map Codex's tool-call events
        //   (TBD pending real stdout probe).
        // token_count: cost telemetry, not user-visible.
        break;
      default:
        // Unknown subtype — defensively ignored.
        break;
    }
  }
}
