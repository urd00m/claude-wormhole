#!/usr/bin/env bash
# caveman — statusline badge showing the active compression mode.
# Referenced from ~/.claude/settings.json statusLine.command; Claude Code
# pipes session JSON on stdin and renders whatever we print.
#
# Mode resolution (first hit wins):
#   1. CAVEMAN_DEFAULT_MODE env — set by the wormhole for spawned workers.
#   2. ~/.claude/.caveman-active flag — written by caveman-mode-tracker.js
#      for interactive CLI sessions (/caveman commands).
#   3. <repo>/data/cavemanState.json — the wormhole's global Slack toggle.
#
# Prints [CAVEMAN] for full, [CAVEMAN:<LEVEL>] otherwise, nothing when off.
set -euo pipefail

cat >/dev/null || true # drain the session JSON; we don't need it

mode="${CAVEMAN_DEFAULT_MODE:-}"

if [ -z "$mode" ]; then
  flag="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.caveman-active"
  if [ -f "$flag" ]; then
    mode="$(tr -d '[:space:]' < "$flag")"
  fi
fi

if [ -z "$mode" ]; then
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  state="$repo_root/data/cavemanState.json"
  if [ -f "$state" ]; then
    mode="$(sed -n 's/.*"level"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$state")"
  fi
fi

case "$mode" in
  "" | off) exit 0 ;;
  full) printf '[CAVEMAN]' ;;
  *) printf '[CAVEMAN:%s]' "$(printf '%s' "$mode" | tr '[:lower:]' '[:upper:]')" ;;
esac
