#!/usr/bin/env bash
# Integration test suite — exercises the wormhole's session config against
# the LIVE Claude Agent SDK. Each script in this suite costs a few thousand
# tokens to run, so they're NOT in the npm test default. Run when you
# suspect the spawn chain or tool surface is broken in ways unit tests
# can't catch.
#
# Requires either ANTHROPIC_API_KEY or ~/.claude credentials. The Slack
# tokens are stubbed (the integration tests don't hit Slack).
#
# Usage:
#   ./scripts/it.sh                  # runs every integration test
#   ./scripts/it.sh toolSurface      # runs just the named one
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ ! -f "$HOME/.claude/.credentials.json" ] && [ ! -f "$HOME/.claude/credentials.json" ]; then
  echo "❌ No Claude auth: set ANTHROPIC_API_KEY or run 'npm run login' first" >&2
  exit 1
fi

# Stub Slack env so config.ts validates. The integration tests don't hit Slack.
export SLACK_APP_TOKEN="${SLACK_APP_TOKEN:-xapp-stub}"
export SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-xoxb-stub}"
export SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-stub}"

# Discover all *.it.ts under src/integration/. (bash 3 compat: no mapfile)
ALL_TESTS=()
while IFS= read -r line; do ALL_TESTS+=("$line"); done < <(find src/integration -name '*.it.ts' | sort)

# Filter by optional name argument (basename match).
SELECTED=()
if [ $# -gt 0 ]; then
  for t in "${ALL_TESTS[@]}"; do
    base=$(basename "$t" .it.ts)
    for arg in "$@"; do
      if [ "$base" = "$arg" ]; then
        SELECTED+=("$t")
      fi
    done
  done
  if [ "${#SELECTED[@]}" -eq 0 ]; then
    echo "❌ no integration test matched: $*"
    echo "   available:"
    for t in "${ALL_TESTS[@]}"; do
      echo "     $(basename "$t" .it.ts)"
    done
    exit 1
  fi
else
  SELECTED=("${ALL_TESTS[@]}")
fi

FAIL=0
for t in "${SELECTED[@]}"; do
  echo ""
  echo "═══════════════════════════════════════════════"
  echo "▸ $(basename "$t")"
  echo "═══════════════════════════════════════════════"
  if ! npx tsx "$t"; then
    FAIL=1
  fi
done

echo ""
if [ "$FAIL" -ne 0 ]; then
  echo "❌ integration suite: at least one test failed"
  exit 1
fi
echo "✅ integration suite: all passed"
