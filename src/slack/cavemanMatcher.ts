// Slack control-phrase parser for caveman compression toggle.
//
// Whole-message matcher (like endSessionMatcher / runtimeMatcher) so prose
// containing the word "caveman" doesn't trigger. Tolerant of leading bot
// mention, trailing punctuation, "please/pls" prefixes, and a few natural
// orderings.
//
// Matched phrases → resulting action:
//   "caveman"                     → set on (full)
//   "caveman on"                  → set on (full)
//   "caveman off" | "no caveman"  → set off
//   "caveman <level>"             → set to <level> ∈ {lite, full, ultra,
//                                   wenyan, wenyan-lite, wenyan-full,
//                                   wenyan-ultra}
//   "caveman status"              → emit "status" action (handler replies
//                                   with current level)
//   "enable caveman" / "disable caveman" — same as on/off
//
// Anything else returns null and the message continues through the normal
// dispatch ladder.

import type { CavemanLevel } from "../agent/cavemanStore.js";

function stripMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "");
}

const TRAILING_PUNCT = /[.!?,;:]+$/;
const POLITE_PREFIX = /^(please|pls|hey|yo|ok|okay)\s+/;

function normalize(text: string): string {
  let s = stripMention(text).toLowerCase().trim();
  // Drop trailing punctuation
  s = s.replace(TRAILING_PUNCT, "").trim();
  // Drop a polite leading word
  s = s.replace(POLITE_PREFIX, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ");
  return s;
}

export type CavemanAction =
  | { kind: "set"; level: CavemanLevel }
  | { kind: "status" };

const LEVEL_WORDS: Record<string, CavemanLevel> = {
  lite: "lite",
  full: "full",
  ultra: "ultra",
  wenyan: "wenyan",
  "wenyan-lite": "wenyan-lite",
  "wenyan-full": "wenyan-full",
  "wenyan-ultra": "wenyan-ultra",
};

/**
 * Return the parsed caveman action, or null if the message isn't a
 * caveman control phrase.
 */
export function detectCavemanAction(text: string | undefined | null): CavemanAction | null {
  if (typeof text !== "string") return null;
  const s = normalize(text);
  if (s.length === 0) return null;

  // Bare "caveman" → on at full
  if (s === "caveman" || s === "caveman on" || s === "enable caveman") {
    return { kind: "set", level: "full" };
  }

  // off / disable / no
  if (
    s === "caveman off" ||
    s === "disable caveman" ||
    s === "no caveman" ||
    s === "stop caveman" ||
    s === "turn off caveman" ||
    s === "turn caveman off"
  ) {
    return { kind: "set", level: "off" };
  }

  // status
  if (s === "caveman status" || s === "status caveman") {
    return { kind: "status" };
  }

  // "caveman <level>" or "<level> caveman"
  const m1 = s.match(/^caveman\s+([a-z\-]+)$/);
  if (m1 && LEVEL_WORDS[m1[1]]) return { kind: "set", level: LEVEL_WORDS[m1[1]] };

  const m2 = s.match(/^([a-z\-]+)\s+caveman$/);
  if (m2 && LEVEL_WORDS[m2[1]]) return { kind: "set", level: LEVEL_WORDS[m2[1]] };

  return null;
}
