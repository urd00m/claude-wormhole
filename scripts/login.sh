#!/usr/bin/env bash
# Authenticate against a Claude Pro/Max subscription via OAuth.
# Credentials are stored under ~/.claude/ and reused by the SDK runtime.
set -euo pipefail

echo "▸ Launching Claude Code OAuth login…"
echo "  This will open a browser. Sign in with the Claude.ai account that"
echo "  has your Pro/Max subscription, then return to this terminal."
echo ""

# Use npx so the user doesn't need a global install.
exec npx -y @anthropic-ai/claude-code login
