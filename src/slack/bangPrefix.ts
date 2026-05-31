// `!`-prefix shell-passthrough parser.
//
// A Slack message whose payload (after the optional bot mention) starts
// with `!` is treated as a literal shell command to run in the thread's
// workdir, bypassing the agent entirely. Returns the command string with
// the leading `!` and any whitespace stripped, or null if the message
// isn't a bang-command.
//
// Examples:
//   "!ls -la"               → "ls -la"
//   "<@U123> !git status"   → "git status"
//   "  !  cat README.md"    → "cat README.md"
//   "!"                     → null (empty command)
//   "Hi !ls"                → null (! must be the first non-mention token)
//   "/!foo"                 → null
//
// Whole-message rule (like the alias and end-session matchers): the `!`
// must be the message's first meaningful character so prose with "!" in
// it doesn't accidentally trigger.

/** Strip a leading Slack bot mention `<@U123>` and surrounding whitespace. */
function stripMention(text: string): string {
  return text.replace(/^\s*<@[^>]+>\s*/, "");
}

export interface BangCommand {
  /** The raw command string, ready to hand to `bash -c`. */
  command: string;
}

/** Return the parsed command, or null if the message isn't a bang-command. */
export function detectBangCommand(text: string | undefined | null): BangCommand | null {
  if (typeof text !== "string") return null;
  const stripped = stripMention(text);
  const trimmed = stripped.trimStart();
  if (!trimmed.startsWith("!")) return null;
  const command = trimmed.slice(1).trim();
  if (command.length === 0) return null;
  return { command };
}
