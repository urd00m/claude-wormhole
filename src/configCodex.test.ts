// Verify the config schema's handling of the new Codex env vars
// (OPENAI_API_KEY, OPENAI_MODEL, DEFAULT_RUNTIME). Uses `parseConfig`, the
// pure-function seam, so we don't have to fork subprocesses with mutated
// envs.

import { parseConfig, configSchema } from "./config.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function baseEnv(): Record<string, string | undefined> {
  return {
    SLACK_APP_TOKEN: "xapp-stub",
    SLACK_BOT_TOKEN: "xoxb-stub",
    SLACK_SIGNING_SECRET: "stub",
  };
}

async function main() {
  // --- (1) Defaults: no Codex env vars set ---
  {
    const cfg = parseConfig(baseEnv());
    assert(cfg.DEFAULT_RUNTIME === "claude", `default runtime: ${cfg.DEFAULT_RUNTIME}`);
    assert(cfg.OPENAI_MODEL === "gpt-5-codex", `default OPENAI_MODEL: ${cfg.OPENAI_MODEL}`);
    assert(cfg.OPENAI_API_KEY === undefined, "OPENAI_API_KEY undefined when unset");
  }

  // --- (2) Explicit codex runtime ---
  {
    const cfg = parseConfig({ ...baseEnv(), DEFAULT_RUNTIME: "codex" });
    assert(cfg.DEFAULT_RUNTIME === "codex", "codex runtime accepted");
  }

  // --- (3) Invalid runtime → throws ---
  {
    let threw = false;
    try {
      parseConfig({ ...baseEnv(), DEFAULT_RUNTIME: "gpt" });
    } catch {
      threw = true;
    }
    assert(threw, "unknown runtime must reject");
  }

  // --- (4) OPENAI_API_KEY is optional but accepted ---
  {
    const cfg = parseConfig({ ...baseEnv(), OPENAI_API_KEY: "sk-test" });
    assert(cfg.OPENAI_API_KEY === "sk-test", "OPENAI_API_KEY plumbed");
  }

  // --- (5) OPENAI_MODEL override ---
  {
    const cfg = parseConfig({ ...baseEnv(), OPENAI_MODEL: "o4-mini" });
    assert(cfg.OPENAI_MODEL === "o4-mini", "OPENAI_MODEL override");
  }

  // --- (6) Existing Claude env vars still default correctly ---
  {
    const cfg = parseConfig(baseEnv());
    assert(cfg.ANTHROPIC_MODEL === "claude-opus-4-7", "ANTHROPIC_MODEL default intact");
    assert(cfg.LOG_LEVEL === "info", "LOG_LEVEL default intact");
  }

  // --- (7) Slack tokens still validated ---
  {
    let threw = false;
    try {
      parseConfig({ SLACK_APP_TOKEN: "wrong", SLACK_BOT_TOKEN: "xoxb-x", SLACK_SIGNING_SECRET: "s" });
    } catch {
      threw = true;
    }
    assert(threw, "bad SLACK_APP_TOKEN prefix must still reject");
  }

  // --- (8) Schema is exported and shaped as expected ---
  // Belt-and-suspenders: the schema's shape is a public surface that
  // doctor.sh and external tooling may grow to inspect.
  {
    const shape = configSchema.shape;
    assert("DEFAULT_RUNTIME" in shape, "schema exposes DEFAULT_RUNTIME");
    assert("OPENAI_API_KEY" in shape, "schema exposes OPENAI_API_KEY");
    assert("OPENAI_MODEL" in shape, "schema exposes OPENAI_MODEL");
  }

  console.log("✅ config (Codex env vars) verified — defaults, validation, schema shape");
}

main().catch((err) => {
  console.error("❌ config (Codex) verification failed:", err);
  process.exit(1);
});
