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

# Claude auth: ANTHROPIC_API_KEY or a file-based OAuth credential. We do NOT
# use the macOS Keychain (per-query reads are too slow); `npm run login`
# produces ~/.claude/.credentials.json.
CREDS_PRIMARY="$HOME/.claude/.credentials.json"
CREDS_ALT="$HOME/.claude/credentials.json"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "Claude auth: ANTHROPIC_API_KEY set"
elif [ -f "$CREDS_PRIMARY" ] || [ -f "$CREDS_ALT" ]; then
  ok "Claude auth: subscription OAuth credentials file present (~/.claude/)"
else
  err "Claude auth: no ANTHROPIC_API_KEY and no ~/.claude/.credentials.json — run 'npm run login' (creates the file) or set the env var"
  FAIL=1
fi

# Codex auth — only required when Codex is reachable. We treat it as
# "reachable" whenever DEFAULT_RUNTIME is codex OR any thread in
# data/runtimes.json is pinned to codex. Otherwise the check is a soft hint.
DEFAULT_RT=${DEFAULT_RUNTIME:-claude}
CODEX_REACHABLE=0
if [ "$DEFAULT_RT" = "codex" ]; then
  CODEX_REACHABLE=1
fi
if [ -f data/runtimes.json ] && grep -q '"codex"' data/runtimes.json 2>/dev/null; then
  CODEX_REACHABLE=1
fi

CODEX_CREDS="$HOME/.codex/auth.json"
CODEX_CREDS_ALT="$HOME/.codex/credentials.json"
if [ "$CODEX_REACHABLE" -eq 1 ]; then
  if [ -n "${OPENAI_API_KEY:-}" ]; then
    ok "Codex auth: OPENAI_API_KEY set"
  elif [ -f "$CODEX_CREDS" ] || [ -f "$CODEX_CREDS_ALT" ]; then
    ok "Codex auth: subscription credentials present (~/.codex/)"
  else
    err "Codex auth: DEFAULT_RUNTIME=codex (or a thread is pinned to codex) but neither OPENAI_API_KEY nor ~/.codex/ credentials found — run 'codex login' or set OPENAI_API_KEY"
    FAIL=1
  fi
  if command -v codex >/dev/null 2>&1; then
    ok "Codex CLI: \`codex\` on PATH"
  else
    err "Codex CLI: \`codex\` not on PATH — install it before running threads under the codex runtime"
    FAIL=1
  fi
else
  ok "Codex auth: not required (DEFAULT_RUNTIME=$DEFAULT_RT, no codex threads in data/runtimes.json)"
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
