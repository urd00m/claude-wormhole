#!/usr/bin/env bash
# Live SDK verification: spawn a sub-agent through the wormhole's actual
# query() config and assert the sub-agent reports Agent + Bash + Task in
# its available tool list.
#
# Requires Anthropic credentials — either ANTHROPIC_API_KEY env var or a
# `npm run login` session. Costs a few thousand tokens per run.
#
# Usage:
#   ./scripts/verify-subagent-tools.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ] && [ ! -f "$HOME/.claude/credentials.json" ]; then
  echo "❌ No Claude auth: set ANTHROPIC_API_KEY or run 'npm run login' first" >&2
  exit 1
fi

# Stub the Slack env so config.ts validates. We never connect to Slack.
export SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-xapp-stub}"
export SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-xoxb-stub}"
export SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-stub}"

exec npx tsx scripts/verify-subagent-tools.ts
