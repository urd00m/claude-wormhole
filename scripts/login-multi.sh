#!/usr/bin/env bash
# Authenticate an additional Claude account for the credential pool.
#
# Usage:
#   ./scripts/login-multi.sh <account-name>
#
# This creates a credential directory at ~/.claude-<account-name>/ and
# opens the OAuth flow. Once authenticated, add the path to your .env:
#
#   CLAUDE_CREDENTIAL_DIRS=~/.claude-acct1,~/.claude-acct2
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <account-name>"
  echo ""
  echo "  Creates ~/.claude-<account-name>/ and runs 'claude login' into it."
  echo "  Then add the path to CLAUDE_CREDENTIAL_DIRS in your .env."
  exit 1
fi

NAME="$1"
DIR="$HOME/.claude-${NAME}"

if [[ -d "$DIR" ]]; then
  echo "Directory $DIR already exists."
  read -rp "Re-authenticate? [y/N] " yn
  if [[ "$yn" != [yY]* ]]; then
    echo "Aborted."
    exit 0
  fi
fi

mkdir -p "$DIR"

echo "▸ Authenticating account '$NAME' into $DIR …"
echo "  A browser window will open. Sign in with the Claude account you"
echo "  want to add, then return here."
echo ""

CLAUDE_CONFIG_DIR="$DIR" npx -y @anthropic-ai/claude-code login

echo ""
echo "✅ Credentials saved to $DIR"
echo ""
echo "Add this to your .env (comma-separated with any existing paths):"
echo "  CLAUDE_CREDENTIAL_DIRS=$DIR"
