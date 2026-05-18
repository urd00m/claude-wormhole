import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { env } from "./config.js";

export type AuthMode =
  | { kind: "api_key" }
  | { kind: "subscription"; credentialsPath: string }
  | { kind: "none" };

/**
 * Detect which Claude auth path is configured. Priority:
 *   1. ANTHROPIC_API_KEY env var.
 *   2. OAuth credentials at ~/.claude/.credentials.json (from `claude login`).
 *   3. Nothing → user must run `npm run login` or set ANTHROPIC_API_KEY.
 */
export function detectAuth(): AuthMode {
  if (env.ANTHROPIC_API_KEY) return { kind: "api_key" };

  const candidates = [
    path.join(os.homedir(), ".claude", ".credentials.json"),
    path.join(os.homedir(), ".claude", "credentials.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { kind: "subscription", credentialsPath: p };
  }
  return { kind: "none" };
}

export function describeAuth(mode: AuthMode): string {
  switch (mode.kind) {
    case "api_key":
      return "API key (ANTHROPIC_API_KEY)";
    case "subscription":
      return `Claude subscription (OAuth at ${mode.credentialsPath})`;
    case "none":
      return "none configured";
  }
}
