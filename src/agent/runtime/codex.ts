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
import type {
  AgentLaunchConfig,
  Runtime,
  SessionInput,
  SessionOutput,
  StreamHooks,
} from "./types.js";
import {
  spawnCodexProcess,
  type CodexProcess,
  type CodexProcessFactory,
} from "./codexProcess.js";
import { codexSpawnMcpFlags } from "./codexSpawnMcp.js";

export type CodexRuntimeOpts = {
  threadKey: string;
  workdir: string;
  /** Per-session launch overrides (from an alias): model, effort, extra args. */
  launch?: AgentLaunchConfig;
  /**
   * Attach the wormhole spawn MCP server so this codex worker can launch
   * further agents (not one-shot). Used for spawned codex workers; the
   * top-level thread session leaves it off. `spawnDepth` is this worker's
   * depth (children spawn at depth+1, capped at MAX_SUBAGENT_DEPTH).
   */
  enableSpawnMcp?: boolean;
  spawnDepth?: number;
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
 * resume <uuid>`. The two subcommands accept DIFFERENT flag surfaces:
 *
 *   - `codex exec` accepts --cd, --sandbox, --add-dir (the cwd/sandbox
 *     setup for a fresh session).
 *   - `codex exec resume` does NOT accept --cd, --sandbox, --add-dir —
 *     it inherits all of them from the resumed session's rollout. Passing
 *     them anyway crashes with "unexpected argument '--cd' found".
 *
 * Both accept --json, --skip-git-repo-check, -m, -o,
 * --dangerously-bypass-approvals-and-sandbox.
 *
 * `model` is optional: when empty we omit `-m` entirely so codex falls
 * back to its auth-aware default (`gpt-5-codex` rejects under ChatGPT
 * subscription auth — letting codex pick lets it work across auth modes).
 */
function buildArgs(opts: {
  resumeFrom: string | null;
  workdir: string;
  model: string;
  effort?: string;
  /** Extra alias args spliced in before the prompt separator (e.g. -c k=v). */
  extraArgs?: string[];
  lastMessageFile: string;
  prompt: string;
}): string[] {
  const sharedFlags: string[] = [
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "-o",
    opts.lastMessageFile,
  ];
  if (opts.model.length > 0) {
    sharedFlags.push("-m", opts.model);
  }
  if (opts.effort && opts.effort.length > 0) {
    // Reasoning effort is a config override, accepted on both exec + resume.
    sharedFlags.push("-c", `model_reasoning_effort=${opts.effort}`);
  }
  const extra = opts.extraArgs ?? [];
  if (opts.resumeFrom === null) {
    // Fresh session: --cd / --sandbox / --add-dir all live here.
    return [
      "exec",
      ...sharedFlags,
      "--cd",
      opts.workdir,
      "--sandbox",
      "workspace-write",
      "--add-dir",
      "/",
      ...extra,
      "--",
      opts.prompt,
    ];
  }
  // Resume: NO --cd / --sandbox / --add-dir; positional UUID before prompt.
  return ["exec", "resume", ...sharedFlags, ...extra, opts.resumeFrom, "--", opts.prompt];
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
 * Extract the session UUID from a `thread.started` event. This is the
 * wire-format codex --json actually emits on stdout (verified against
 * codex v0.133.0):
 *
 *   {"type":"thread.started","thread_id":"019e6649-..."}
 *
 * Note: the persisted rollout files under ~/.codex/sessions/ use a
 * different shape ({"type":"session_meta","payload":{"id":...}}). We
 * pinned to the wrong one initially; the smoke test against the real
 * binary uncovered the mismatch. The stdout shape is what we get when
 * we spawn `codex exec --json` and consume its output.
 */
function extractSessionId(ev: unknown): string | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: string; thread_id?: unknown };
  if (e.type !== "thread.started") return null;
  return typeof e.thread_id === "string" ? e.thread_id : null;
}

/**
 * Extract a human-readable error message from `error` or `turn.failed`
 * events. These come on stdout (NOT stderr — codex's stderr typically only
 * carries the harmless `"Reading additional input from stdin..."` log
 * line). Surface them in preference to stderr so the user gets the
 * actual model/billing/auth error rather than the stdin-mode log.
 *
 * Wire shapes:
 *   {"type":"error","message":"...inner json or text..."}
 *   {"type":"turn.failed","error":{"message":"...same..."}}
 *
 * The `message` is sometimes itself a JSON-stringified inner error
 * (e.g. an OpenAI 4xx). We try to unwrap one level to surface the
 * human-readable inner `.error.message`, falling back to the raw string.
 */
function extractErrorMessage(ev: unknown): string | null {
  if (typeof ev !== "object" || ev === null) return null;
  const e = ev as { type?: string; message?: unknown; error?: { message?: unknown } };
  let raw: string | null = null;
  if (e.type === "error" && typeof e.message === "string") raw = e.message;
  else if (e.type === "turn.failed" && typeof e.error?.message === "string") raw = e.error.message;
  if (raw === null) return null;
  return unwrapNestedErrorJson(raw);
}

function unwrapNestedErrorJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return raw;
  try {
    const inner = JSON.parse(trimmed) as { error?: { message?: unknown } };
    if (typeof inner?.error?.message === "string") return inner.error.message;
  } catch {
    /* not nested JSON, fall through */
  }
  return raw;
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
  private readonly launch?: AgentLaunchConfig;
  private readonly enableSpawnMcp: boolean;
  private readonly spawnDepth: number;
  private readonly processFactory: CodexProcessFactory;
  private readonly lastMessageFileFactory: () => string;

  constructor(opts: CodexRuntimeOpts) {
    this.threadKey = opts.threadKey;
    this.workdir = opts.workdir;
    this.launch = opts.launch;
    this.enableSpawnMcp = opts.enableSpawnMcp ?? false;
    this.spawnDepth = opts.spawnDepth ?? 0;
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

    // When spawn-MCP is enabled, attach the wormhole spawn server so this
    // codex worker can launch further agents. Its `-c mcp_servers…` flags
    // join the alias's extra args, and its WORMHOLE_SPAWN_* env joins the
    // subprocess env.
    const spawn = this.enableSpawnMcp
      ? codexSpawnMcpFlags(this.spawnDepth, this.workdir)
      : { args: [] as string[], env: {} as Record<string, string> };

    const args = buildArgs({
      resumeFrom: sessionIdAtStart,
      workdir: this.workdir,
      model: this.launch?.model ?? env.OPENAI_MODEL,
      effort: this.launch?.effort,
      extraArgs: [...(this.launch?.codexArgs ?? []), ...spawn.args],
      lastMessageFile,
      prompt,
    });

    const proc: CodexProcess = this.processFactory({
      args,
      cwd: this.workdir,
      env: { ...buildCodexEnv(), ...spawn.env },
    });

    let observedSessionId: string | null = null;
    // Errors come on stdout as `error` / `turn.failed` events, not on
    // stderr (stderr typically only has the harmless "Reading additional
    // input from stdin..." log). We capture the first one we see and
    // surface it in preference to stderr when codex exits non-zero.
    let observedErrorMessage: string | null = null;

    try {
      for await (const line of proc.lines()) {
        const ev = tryParseLine(line);
        if (ev === null) continue;
        const newId = extractSessionId(ev);
        if (newId !== null && observedSessionId === null) {
          observedSessionId = newId;
        }
        const errMsg = extractErrorMessage(ev);
        if (errMsg !== null && observedErrorMessage === null) {
          observedErrorMessage = errMsg;
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
        // Build the user-facing message: prefer the stdout error event
        // (the real diagnostic), then fall back to stderr, then a sentinel.
        const detail =
          observedErrorMessage ??
          (stderr.trim().length > 0 ? stderr.trim() : null) ??
          "(no error detail)";
        throw new Error(
          `codex exec ${sessionIdAtStart === null ? "" : "resume "}exited with code ${exitCode}: ${detail}`,
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
   * callbacks. Defensive — unknown event types are ignored.
   *
   * Wire shape verified against `codex --json` v0.133.0 stdout. Each line
   * is a flat object whose `type` discriminates:
   *
   *   {"type":"thread.started","thread_id":"..."}
   *   {"type":"turn.started"}
   *   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
   *   {"type":"turn.completed","usage":{...}}
   *   {"type":"error","message":"..."}
   *   {"type":"turn.failed","error":{"message":"..."}}
   *
   * Sessions/error extraction happens in the send() loop (it needs the
   * UUID + error text by reference). This method handles user-visible
   * streaming text.
   */
  private dispatchEvent(ev: unknown, hooks: StreamHooks): void {
    if (typeof ev !== "object" || ev === null) return;
    const e = ev as {
      type?: string;
      item?: { type?: string; text?: unknown };
    };

    switch (e.type) {
      case "item.completed": {
        // Currently the only sub-type we surface is agent_message — Codex
        // emits this once per assistant turn (per the v0.133.0 stdout
        // probe; not a true delta-stream, more like end-of-turn). Other
        // item types (tool calls, reasoning blocks) may surface here as
        // Codex evolves; ignore them defensively.
        const item = e.item;
        if (item?.type === "agent_message" && typeof item.text === "string") {
          hooks.onText?.(item.text);
        }
        break;
      }
      case "thread.started":
      case "turn.started":
      case "turn.completed":
      case "error":
      case "turn.failed":
        // thread.started / turn.* are lifecycle markers handled in send()
        // (session-id extraction, error capture). Nothing user-visible
        // to fire from dispatchEvent for them.
        break;
      default:
        // Unknown event — defensively ignored.
        break;
    }
  }
}
