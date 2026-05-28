#!/usr/bin/env bash
#
# fetch-usage.sh — pull subscription quota (5h / weekly) from the same
# endpoint the interactive `claude` CLI hits to power /usage-credits, and
# write a NON-SECRET JSON snapshot to data/usage.json.
#
# Why this exists:
#   The Claude Agent SDK only exposes subscription quota via
#   `rate_limit_event`, which the server omits at low usage — so the
#   wormhole's footer shows "n/a" most of the time. The CLI binary calls
#   `GET /api/oauth/usage` directly with its OAuth bearer token. This
#   script does the same call from a small isolated process, with strict
#   rules about not leaking the token. The wormhole reads ONLY the JSON
#   output file; it never reads the credentials file itself.
#
# Safety rules (intentionally paranoid — read before editing):
#   - No `set -x`; no `curl -v`. The token never appears in stdout/stderr.
#   - The token is passed to curl via `--header @-` (stdin), keeping the
#     literal token off /proc/<pid>/cmdline (visible to ps).
#   - The TOKEN shell variable is `unset`ed as soon as the request is sent.
#   - On any failure, write a {"status":"error","reason":...} doc to the
#     output file. Errors describe shapes (e.g. "credentials file missing"),
#     never values.
#   - Output is overwritten atomically (tmp + mv) so the bot never reads
#     a half-written file.
#
# Output schema (data/usage.json):
#   {
#     "status": "ok" | "error",
#     "fetched_at": <unix-seconds>,
#     "five_hour_pct": <0-100 | null>,
#     "weekly_pct":    <0-100 | null>,
#     "resets_at":     <iso8601-string | null>,
#     "raw":           <full upstream body, server-derived, no secrets>,
#     "reason":        <error reason string, only when status=error>
#   }
#
# Usage:
#   bash scripts/fetch-usage.sh                    # writes data/usage.json
#   bash scripts/fetch-usage.sh --out path.json    # custom out path

set -eu  # NOT set -x; NOT pipefail (we want explicit error handling)

CREDS_FILE="${CLAUDE_CREDENTIALS_FILE:-$HOME/.claude/.credentials.json}"
OUT_FILE="data/usage.json"
USAGE_URL="${CLAUDE_USAGE_URL:-https://api.anthropic.com/api/oauth/usage}"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT_FILE="$2"; shift 2 ;;
    --url) USAGE_URL="$2"; shift 2 ;;
    --creds) CREDS_FILE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$OUT_FILE")"
TMP_OUT="$(mktemp "${OUT_FILE}.XXXXXX")"
HTTP_OUT="$(mktemp)"
HTTP_ERR="$(mktemp)"
cleanup() { rm -f "$TMP_OUT" "$HTTP_OUT" "$HTTP_ERR"; }
trap cleanup EXIT

write_error() {
  # $1 = reason
  printf '{"status":"error","fetched_at":%d,"reason":%s,"five_hour_pct":null,"weekly_pct":null,"resets_at":null}\n' \
    "$(date +%s)" "$(printf '%s' "$1" | jq -Rs .)" > "$TMP_OUT"
  mv "$TMP_OUT" "$OUT_FILE"
  exit 1
}

# --- input validation (shape only; never echo the file) ---
if [ ! -f "$CREDS_FILE" ]; then
  write_error "credentials file not found at $CREDS_FILE — run 'npm run login'"
fi
if ! command -v jq >/dev/null 2>&1; then
  write_error "jq is required (brew install jq)"
fi
if ! command -v curl >/dev/null 2>&1; then
  write_error "curl is required"
fi

# Pull the access token. We use --raw-output so the value is unquoted; we
# never echo or re-expand it, and unset it immediately after use.
TOKEN="$(jq -r '.claudeAiOauth.accessToken // .accessToken // empty' < "$CREDS_FILE" 2>/dev/null || true)"
if [ -z "${TOKEN:-}" ] || [ "$TOKEN" = "null" ]; then
  write_error "no accessToken in credentials (file shape unexpected or expired — run 'npm run login')"
fi

# Headers via curl --header @- (stdin) so the literal token never appears
# on the command line.
HTTP_CODE="$(
  printf 'Authorization: Bearer %s\r\naccept: application/json\r\nUser-Agent: claude-wormhole/fetch-usage\r\n' "$TOKEN" \
    | curl -sS \
        --header @- \
        -o "$HTTP_OUT" \
        -w '%{http_code}' \
        --max-time 15 \
        "$USAGE_URL" 2>"$HTTP_ERR" || echo "000"
)"

# Token is no longer needed. Drop it before any branch that might log.
unset TOKEN

case "$HTTP_CODE" in
  200) ;;
  401|403)
    write_error "HTTP $HTTP_CODE — token rejected (likely expired; run 'npm run login')"
    ;;
  000)
    # Do NOT echo curl stderr — defensive: it shouldn't contain the token
    # but we don't gamble.
    write_error "network failure contacting usage endpoint"
    ;;
  *)
    write_error "HTTP $HTTP_CODE from usage endpoint"
    ;;
esac

BODY="$(cat "$HTTP_OUT")"
if [ -z "$BODY" ]; then
  write_error "empty response body from usage endpoint"
fi
if ! printf '%s' "$BODY" | jq empty >/dev/null 2>&1; then
  write_error "non-JSON response from usage endpoint"
fi

# Map upstream fields to a stable schema. The CLI's strings dump shows
# field names `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
# `utilization`, `resets_at`. Upstream may evolve; missing fields → null.
# Utilization values can be a fraction (0–1) or a percent; we normalize.
JSON_OUT="$(printf '%s' "$BODY" | jq --arg now "$(date +%s)" '
  def pct(x): if x == null then null
              elif (x|type) == "number" then (if x <= 1 then (x * 100) else x end)
              else null end;
  def first(opts): reduce opts[] as $v (null; if . == null then $v else . end);
  {
    status: "ok",
    fetched_at: ($now | tonumber),
    five_hour_pct: pct(first([.five_hour.utilization, .five_hour_utilization, .fiveHour.utilization])),
    weekly_pct:    pct(first([.seven_day.utilization, .seven_day_opus.utilization, .seven_day_sonnet.utilization, .weekly.utilization])),
    resets_at:     first([.five_hour.resets_at, .resets_at, .five_hour.reset, .reset]),
    raw:           .
  }' 2>/dev/null || true)"

if [ -z "$JSON_OUT" ]; then
  write_error "response JSON did not match any known shape"
fi

printf '%s\n' "$JSON_OUT" > "$TMP_OUT"
mv "$TMP_OUT" "$OUT_FILE"
exit 0
