// Verify detectBangCommand: bot-mention stripping, leading-! detection,
// whitespace tolerance, empty-command rejection, prose-with-! rejection.

import { detectBangCommand } from "./bangPrefix.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function main() {
  // --- basic positive cases ---
  assert(detectBangCommand("!ls")?.command === "ls", "bare !ls");
  assert(detectBangCommand("!ls -la /tmp")?.command === "ls -la /tmp", "args preserved");
  assert(detectBangCommand("!echo 'hello world'")?.command === "echo 'hello world'", "quoted args preserved");
  assert(detectBangCommand("!pwd && ls")?.command === "pwd && ls", "shell operators preserved");

  // --- whitespace tolerance ---
  assert(detectBangCommand("  !pwd")?.command === "pwd", "leading whitespace stripped");
  assert(detectBangCommand("!  ls")?.command === "ls", "whitespace after ! stripped");
  assert(detectBangCommand("!ls   ")?.command === "ls", "trailing whitespace stripped");
  assert(detectBangCommand("\t!ls")?.command === "ls", "leading tab stripped");

  // --- bot mention stripping ---
  assert(detectBangCommand("<@U123ABC> !git status")?.command === "git status", "mention stripped");
  assert(detectBangCommand("<@U123ABC>!ls")?.command === "ls", "no space between mention and !");
  assert(detectBangCommand("  <@U123ABC>  !cat README.md")?.command === "cat README.md", "leading WS + mention + WS + !");

  // --- negative cases ---
  assert(detectBangCommand("!") === null, "empty command rejected");
  assert(detectBangCommand("!   ") === null, "whitespace-only command rejected");
  assert(detectBangCommand("Hi !ls") === null, "! not first non-mention char");
  assert(detectBangCommand("/!foo") === null, "leading / blocks");
  assert(detectBangCommand("how are you") === null, "no ! → null");
  assert(detectBangCommand("") === null, "empty string → null");
  assert(detectBangCommand(undefined) === null, "undefined → null");
  assert(detectBangCommand(null) === null, "null → null");

  console.log("✅ detectBangCommand verified — mention stripping, whitespace tolerance, prose rejection, empty rejection");
}

main();
