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
  OPENAI_MODEL: z.string().default("gpt-5-codex"),
  /**
   * Default runtime for new threads. A per-thread override (set via the
   * runtime-switch control phrase in Slack — "switch to codex" etc.,
   * persisted in `data/runtimes.json`) wins for any thread that has one;
   * everything else falls back to this.
   */
  DEFAULT_RUNTIME: z.enum(["claude", "codex"]).default("claude"),
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
