// Matcher for runtime-switch control phrases. A user can switch a Slack
// thread between the Claude and Codex runtimes by sending a short phrase
// like "switch to codex" — the message is intercepted in handlers.ts
// before sessions.get(), the existing in-memory session is closed, the
// per-thread runtime override is written to data/runtimes.json, and the
// NEXT message in the thread spins up the new runtime.
//
// Why a control phrase instead of an MCP tool: until Codex has the stdio
// MCP shim (Phase 4b / a follow-up), Codex-backed threads can't see MCP
// tools at all. Control phrases work uniformly across both runtimes.
//
// Matching mirrors endSessionMatcher: tolerant of trailing punctuation,
// polite prefixes, and a couple of natural orderings — but the whole
// (normalized) message must BE the phrase, so prose like "I think codex
// would be better here" doesn't trigger.

import { normalizeForCommand } from "./endSessionMatcher.js";
import type { RuntimeName } from "../agent/runtimeStore.js";

const CLAUDE_PHRASES = new Set<string>([
  // direct
  "use claude",
  "switch to claude",
  "switch back to claude",
  "back to claude",
  "claude please",
  // with "this thread"
  "switch this thread to claude",
  "use claude for this thread",
  "set runtime to claude",
  "set runtime claude",
  "runtime claude",
  // /-style
  "/claude",
  "/runtime claude",
  "/use-claude",
]);

const CODEX_PHRASES = new Set<string>([
  "use codex",
  "switch to codex",
  "switch back to codex",
  "back to codex",
  "codex please",
  "switch this thread to codex",
  "use codex for this thread",
  "set runtime to codex",
  "set runtime codex",
  "runtime codex",
  "/codex",
  "/runtime codex",
  "/use-codex",
]);

/**
 * True iff `text` is a runtime-switch control phrase. Returns which
 * runtime the user is asking for, or null when it's a normal message.
 */
export function detectRuntimeSwitch(text: string): RuntimeName | null {
  const normalized = normalizeForCommand(text);
  if (CLAUDE_PHRASES.has(normalized)) return "claude";
  if (CODEX_PHRASES.has(normalized)) return "codex";
  return null;
}
