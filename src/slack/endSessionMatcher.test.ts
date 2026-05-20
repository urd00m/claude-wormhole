// Verify end-session control-phrase matching: accept polite prefixes,
// trailing punctuation, slash variants, and "the"-inserted forms; reject
// prose that merely contains the phrase.
import { isEndSessionPhrase, normalizeForCommand } from "./endSessionMatcher.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const accept: string[] = [
  // Canonical
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
  // Case / whitespace tolerance
  "End Session",
  "  end session  ",
  "END SESSION",
  // Trailing punctuation
  "end session.",
  "end session!",
  "end session?",
  "/end-session.",
  // Polite prefixes
  "please end session",
  "please end the session.",
  "pls end session",
  "plz close session!",
  "kindly stop the session",
  "could you end session",
  "can you end session?",
  "would you end the session",
  // Mention prefix (simulating Slack's <@U123> on app-mention events)
  "<@U12345> end session",
  "<@U12345>   end session.",
  "<@U99> please end session",
];

const reject: string[] = [
  "",
  "hello",
  "end", // ambiguous bare word
  "session",
  "close", // bare
  "I want to end session later",
  "let's not end the session yet",
  "end of session report",
  "/start",
  "/end -session", // mid-token space breaks it
  "endsesion", // typo, not in allowlist
  "remind me to end session tomorrow",
];

for (const text of accept) {
  assert(
    isEndSessionPhrase(text),
    `expected ACCEPT: ${JSON.stringify(text)} (normalized=${JSON.stringify(normalizeForCommand(text))})`,
  );
}

for (const text of reject) {
  assert(
    !isEndSessionPhrase(text),
    `expected REJECT: ${JSON.stringify(text)} (normalized=${JSON.stringify(normalizeForCommand(text))})`,
  );
}

console.log(
  `endSessionMatcher.test.ts: PASS (${accept.length} accepts, ${reject.length} rejects)`,
);
