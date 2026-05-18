import "dotenv/config";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schema = z.object({
  SLACK_APP_TOKEN: z.string().startsWith("xapp-", "must start with xapp-"),
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-", "must start with xoxb-"),
  SLACK_SIGNING_SECRET: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().default("claude-opus-4-7"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = schema.safeParse(process.env);
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
