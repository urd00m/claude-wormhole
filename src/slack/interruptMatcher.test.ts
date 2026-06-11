// Verify ctrl+c interrupt control-phrase matching: accept the chord in its
// common spellings (ctrl+c / ctrl-c / ^c / control+c / "interrupt"), with
// the usual mention/politeness/punctuation tolerance; reject prose that
// merely mentions the chord.
import { isInterruptPhrase } from "./interruptMatcher.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const accept: string[] = [
  // Canonical
  "ctrl+c",
  "ctrl-c",
  "ctrl c",
  "ctrlc",
  "ctrl + c",
  "control+c",
  "control-c",
  "control c",
  "^c",
  "/interrupt",
  "interrupt",
  // Case / whitespace tolerance
  "Ctrl+C",
  "CTRL+C",
  "  ctrl+c  ",
  "^C",
  "Interrupt",
  // Trailing punctuation
  "ctrl+c!",
  "ctrl+c.",
  "ctrl+c!!!",
  "interrupt!",
  // Polite prefixes
  "please ctrl+c",
  "pls interrupt",
  "can you interrupt?",
  // Mention prefix (simulating Slack's <@U123> on app-mention events)
  "<@U12345> ctrl+c",
  "<@U12345>   interrupt.",
];

const reject: string[] = [
  "",
  "hello",
  "ctrl", // bare modifier
  "c",
  "ctrl+v",
  "ctrl+x",
  "interrupted", // not the command
  "how do I interrupt this?",
  "press ctrl+c to stop the build",
  "the test traps ctrl+c",
  "interrupt the build when it finishes", // prose, not a whole-message command
  "!ctrl+c", // bang prefix is shell passthrough (checked earlier anyway)
];

for (const t of accept) {
  assert(isInterruptPhrase(t), `should ACCEPT: ${JSON.stringify(t)}`);
}
for (const t of reject) {
  assert(!isInterruptPhrase(t), `should REJECT: ${JSON.stringify(t)}`);
}

console.log(`interruptMatcher.test.ts OK (${accept.length} accepted, ${reject.length} rejected)`);
