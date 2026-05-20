/**
 * Matcher for the "end session" control phrase a user can send in a Slack
 * thread to tear down its in-memory agent session.
 *
 * The matching is intentionally tolerant: trailing punctuation, polite
 * prefixes ("please"/"pls"), and articles ("the") shouldn't cause a user's
 * obvious intent to fall through to a normal turn. We still require the
 * whole (normalized) message to BE the phrase — e.g. "I'll end session
 * later" is not a match — so this doesn't false-positive on prose.
 */

/** Strip leading bot mention `<@U123>` and surrounding whitespace. */
function stripMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "");
}

const POLITE_PREFIX_RE =
  /^(?:please|pls|plz|kindly|could\s+you|can\s+you|would\s+you)\s+/;

const TRAILING_PUNCT_RE = /[\s.!?,;]+$/;

const PHRASES = new Set<string>([
  "/end",
  "/end-session",
  "/endsession",
  "end session",
  "end-session",
  "endsession",
  "end the session",
  "close session",
  "close the session",
  "stop session",
  "stop the session",
]);

/**
 * Normalize `text` for control-phrase matching:
 *  - strip a leading bot mention
 *  - lowercase
 *  - trim outer whitespace
 *  - drop a single polite prefix
 *  - strip trailing punctuation
 *  - collapse internal whitespace
 */
export function normalizeForCommand(text: string): string {
  let s = stripMention(text).toLowerCase().trim();
  s = s.replace(POLITE_PREFIX_RE, "");
  s = s.replace(TRAILING_PUNCT_RE, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** True iff `text` is an end-session control phrase. */
export function isEndSessionPhrase(text: string): boolean {
  return PHRASES.has(normalizeForCommand(text));
}
