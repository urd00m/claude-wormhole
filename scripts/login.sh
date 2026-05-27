#!/usr/bin/env bash
# Authenticate against a Claude Pro/Max subscription via OAuth, and ensure the
# token lives in a FILE (~/.claude/.credentials.json) rather than only the
# macOS Keychain.
#
# Why the file matters: current Claude Code on macOS stores the OAuth token in
# the Keychain, and the runtime reads the Keychain on every query — which adds
# significant per-turn latency (and can prompt for access). A file-based
# credential is read instantly. Writing ~/.claude/.credentials.json makes
# Claude Code use file-based storage again (the pre-migration behavior).
#
# The token is mirrored Keychain -> file entirely on THIS machine via
# `security`; it is never printed.
set -euo pipefail

CLAUDE_DIR="$HOME/.claude"
CREDS="$CLAUDE_DIR/.credentials.json"
KEYCHAIN_SERVICE="Claude Code-credentials"

echo "▸ Launching Claude Code OAuth login…"
echo "  This will open a browser. Sign in with the Claude.ai account that"
echo "  has your Pro/Max subscription, then return to this terminal."
echo ""

# Use npx so the user doesn't need a global install. (No `exec` — we have
# post-login work to do.)
npx -y @anthropic-ai/claude-code login

# --- Ensure file-based credentials (fast path) -----------------------------
# On macOS the login above typically writes the token to the Keychain. Mirror
# it into the credentials file so the runtime reads the file instead of doing
# a per-query Keychain lookup.
if [ "$(uname)" = "Darwin" ]; then
  if security find-generic-password -s "$KEYCHAIN_SERVICE" >/dev/null 2>&1; then
    echo ""
    echo "▸ Mirroring Keychain credentials to a file for faster auth…"
    echo "  (macOS may ask you to allow access to the Keychain item — click Allow.)"
    mkdir -p "$CLAUDE_DIR"
    umask 077
    # `-w` writes ONLY the secret value to stdout; we redirect it straight to
    # the file. The token is not displayed.
    if security find-generic-password -s "$KEYCHAIN_SERVICE" -w > "$CREDS.tmp" 2>/dev/null && [ -s "$CREDS.tmp" ]; then
      mv "$CREDS.tmp" "$CREDS"
      chmod 600 "$CREDS"
      echo "  ✓ Wrote $CREDS (chmod 600)."
      echo "    The runtime will now read this file instead of the Keychain."
      echo "    Security note: this is your OAuth token in a plaintext file."
      echo "    Delete it to revert to Keychain-only auth."
    else
      rm -f "$CREDS.tmp"
      echo "  ✗ Could not export Keychain credentials — auth will fall back to"
      echo "    the Keychain (correct, just slower per query)."
    fi
  fi
fi

echo ""
echo "▸ Done. Run ./scripts/doctor.sh to verify, then 'npm run dev'."
