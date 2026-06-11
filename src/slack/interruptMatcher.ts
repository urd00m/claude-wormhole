/**
 * Matcher for the "ctrl+c" interrupt control phrase — the Slack analog of
 * hitting ctrl+c in a terminal. A matching message does NOT start a turn;
 * handlers.ts short-circuits it into `Session.interrupt()` against the
 * thread's in-flight turn.
 *
 * Same tolerance philosophy as endSessionMatcher: polite prefixes, trailing
 * punctuation, and case are forgiven, but the whole (normalized) message
 * must BE the phrase — so prose like "press ctrl+c to stop the build" never
 * triggers an interrupt.
 */
import { normalizeForCommand } from "./endSessionMatcher.js";

const PHRASES = new Set<string>([
  // The canonical chord, in every spelling people actually type
  "ctrl+c",
  "ctrl-c",
  "ctrl c",
  "ctrlc",
  "ctrl + c",
  "control+c",
  "control-c",
  "control c",
  // Terminal echo of the chord
  "^c",
  // Explicit forms
  "/interrupt",
  "interrupt",
]);

/** True iff `text` is a ctrl+c / interrupt control phrase. */
export function isInterruptPhrase(text: string): boolean {
  return PHRASES.has(normalizeForCommand(text));
}
