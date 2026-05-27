import "dotenv/config";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const configSchema = z.object({
  SLACK_APP_TOKEN: z.string().startsWith("xapp-", "must start with xapp-"),
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-", "must start with xoxb-"),
  SLACK_SIGNING_SECRET: z.string().min(1),
  // Optional: leave unset (or blank) and `claude login` into a Claude Pro/Max
  // subscription instead. When unset/empty, the SDK uses the OAuth credentials
  // at ~/.claude/. Empty strings are treated as "not set" downstream.
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-7"),
  // Codex auth — same pattern as Claude: leave OPENAI_API_KEY unset/blank and
  // run `codex login` to authenticate via your ChatGPT / Codex subscription;
  // credentials get stored at ~/.codex/ and the Codex CLI uses them
  // automatically. Empty strings are treated as "not set" downstream.
  OPENAI_API_KEY: z.string().optional(),
  /**
   * Model arg passed to `codex exec -m <model>`. Leave EMPTY (the default)
   * to skip the flag entirely — codex then picks an auth-appropriate
   * default. `gpt-5-codex` is rejected under ChatGPT subscription auth
   * ("model is not supported when using Codex with a ChatGPT account"),
   * so blanking the default lets the same .env work across both auth
   * modes. Override here only if you specifically need a model name
   * (and know your auth tier accepts it).
   */
  OPENAI_MODEL: z.string().default(""),
  /**
   * Default runtime for new threads. A per-thread override (set via the
   * runtime-switch control phrase in Slack — "switch to codex" etc.,
   * persisted in `data/runtimes.json`) wins for any thread that has one;
   * everything else falls back to this.
   */
  DEFAULT_RUNTIME: z.enum(["claude", "codex"]).default("claude"),
  /**
   * Per-session context-usage footer on Claude replies. "on" (default)
   * appends a compact "🧠 [▰▰▱▱▱] 38% · 380k/1M" line to each reply,
   * computed from the session transcript via the arch-common
   * context_length skill. "off" disables it.
   */
  CONTEXT_INDICATOR: z.enum(["on", "off"]).default("on"),
  /**
   * Context window size (tokens) used to compute the % full in the
   * indicator. Default 1M matches claude-opus-4-7[1m]; set to 200000 for a
   * 200k-tier session.
   */
  CONTEXT_WINDOW_TOKENS: z.coerce.number().int().positive().default(1_000_000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

/**
 * Pure config parser. Exposed so tests can probe the schema's validation
 * + defaulting behavior without importing the live `env` (which triggers
 * `process.exit(1)` on bad input).
 */
export function parseConfig(raw: Record<string, string | undefined>): z.infer<typeof configSchema> {
  return configSchema.parse(raw);
}

const parsed = configSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Invalid environment:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  console.error("\nCopy .env.example to .env and fill in the values.");
  process.exit(1);
}

export const env = parsed.data;

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, "..");
export const SESSIONS_DIR = path.join(ROOT_DIR, "sessions");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CRONS_FILE = path.join(DATA_DIR, "crons.json");
export const WORKDIRS_FILE = path.join(DATA_DIR, "workdirs.json");
export const RUNTIMES_FILE = path.join(DATA_DIR, "runtimes.json");
export const MACROS_FILE = path.join(DATA_DIR, "macros.json");
export const ALIASES_FILE = path.join(DATA_DIR, "aliases.json");
export const THREAD_ALIASES_FILE = path.join(DATA_DIR, "thread-aliases.json");
