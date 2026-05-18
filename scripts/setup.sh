#!/usr/bin/env bash
# One-command setup: verify Node, install deps, copy .env, run tests.
set -euo pipefail

cd "$(dirname "$0")/.."

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
err()  { printf "  \033[31m✗\033[0m %s\n" "$1"; exit 1; }

step "Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 20+ from https://nodejs.org/"
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 20 ]; then
  err "Node 20+ required (found v$(node -v))"
fi
ok "Node $(node -v)"

step "Installing dependencies"
npm install
ok "Dependencies installed"

step "Configuring environment"
if [ -f .env ]; then
  ok ".env already exists (leaving untouched)"
else
  cp .env.example .env
  ok ".env created from .env.example"
  warn "Edit .env and fill in the four required tokens before running 'npm run dev'"
fi

step "Type-checking source"
npx tsc --noEmit
ok "TypeScript strict check passed"

step "Running verification suite"
npm run test --silent
ok "All verifications passed"

cat <<EOF

────────────────────────────────────────────────────────────
  Setup complete.

  Next steps:
    1. Create the Slack app (see README.md → "Slack app setup")
    2. Fill in the four tokens in .env
    3. Run:  npm run dev

  Usage docs:  ./USAGE.md
────────────────────────────────────────────────────────────
EOF
