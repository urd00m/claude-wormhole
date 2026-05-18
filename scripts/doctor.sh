#!/usr/bin/env bash
# Health check: env vars filled, typecheck clean, tests pass.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; }

FAIL=0

step "Checking .env"
if [ ! -f .env ]; then
  err ".env not found — run scripts/setup.sh first"
  exit 1
fi

# shellcheck disable=SC1091
set -a; source .env; set +a

check_var() {
  local name=$1 prefix=$2
  local val=${!name:-}
  if [ -z "$val" ]; then
    err "$name is empty"
    FAIL=1
  elif [ -n "$prefix" ] && [[ "$val" != ${prefix}* ]]; then
    err "$name should start with '$prefix' (got '${val:0:8}…')"
    FAIL=1
  else
    ok "$name set"
  fi
}

check_var SLACK_APP_TOKEN "xapp-"
check_var SLACK_BOT_TOKEN "xoxb-"
check_var SLACK_SIGNING_SECRET ""

# Claude auth: either ANTHROPIC_API_KEY or an OAuth credentials file is required.
CREDS_PRIMARY="$HOME/.claude/.credentials.json"
CREDS_ALT="$HOME/.claude/credentials.json"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "Claude auth: ANTHROPIC_API_KEY set"
elif [ -f "$CREDS_PRIMARY" ] || [ -f "$CREDS_ALT" ]; then
  ok "Claude auth: subscription OAuth credentials present (~/.claude/)"
else
  err "Claude auth: neither ANTHROPIC_API_KEY nor ~/.claude/.credentials.json found — run 'npm run login' or set the env var"
  FAIL=1
fi

step "Type-check"
if npx tsc --noEmit; then ok "clean"; else err "type errors"; FAIL=1; fi

step "Verification suite"
if npm run test --silent >/dev/null 2>&1; then ok "all passing"; else err "tests failed (run 'npm run test' for details)"; FAIL=1; fi

if [ "$FAIL" -ne 0 ]; then
  printf "\n\033[31m✗ doctor: issues found above\033[0m\n"
  exit 1
fi
printf "\n\033[32m✓ doctor: all checks passed — ready to run 'npm run dev'\033[0m\n"
