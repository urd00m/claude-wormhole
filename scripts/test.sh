#!/usr/bin/env bash
# Run every verification script in src/**/*.test.ts. Stubbed env vars satisfy
# zod schema; no real Slack/Anthropic credentials needed.
set -euo pipefail
cd "$(dirname "$0")/.."

export SLACK_APP_TOKEN=xapp-stub
export SLACK_BOT_TOKEN=xoxb-stub
export SLACK_SIGNING_SECRET=stub
export SLACK_ALLOWED_USER_IDS=U1,U2,U3,U4
export ANTHROPIC_API_KEY=stub
export OPENAI_API_KEY=stub
export CODEX_API_KEY=stub

# Tests must never use the production continuity registry or provider homes.
TEST_STATE_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_STATE_ROOT"' EXIT
export CODEX_HOME="$TEST_STATE_ROOT/codex"
export CLAUDE_CONFIG_DIR="$TEST_STATE_ROOT/claude"

# Discover actual test files so new suites cannot be omitted and stale entries
# cannot point to tests that are not present in this checkout.
mapfile -t TESTS < <(node --input-type=module -e '
  import fs from "node:fs";
  console.log(fs.readdirSync("src", { recursive: true })
    .filter((p) => p.endsWith(".test.ts")).sort()
    .map((p) => "src/" + p).join("\n"));
')

for t in "${TESTS[@]}"; do
  export WORMHOLE_STATE_DIR="$TEST_STATE_ROOT/$(basename "$t" .test.ts)"
  npx tsx "$t"
done
