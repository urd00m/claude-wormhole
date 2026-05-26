# Codex CLI wire-format fixtures

These files are **captured bytes** from real invocations of the `codex` CLI.
They exist so `codex.test.ts` and the runtime parser don't drift away from
the actual format codex emits. If codex changes its `--json` shape (event
type names, payload structure, etc.), the contract test against these
fixtures fails loudly — before a user hits the mismatch in Slack.

## Files

| File | Contents |
|---|---|
| `exec-success.stdout.jsonl` | Stdout of a successful `codex exec --json` turn — `thread.started`, `turn.started`, `item.completed` with assistant text, `turn.completed` |
| `exec-success.stderr.txt`   | Stderr from the same run — just the harmless `Reading additional input from stdin...` log |
| `exec-success.last-message.txt` | What `codex exec -o <file>` wrote at end of turn — the authoritative final agent text |
| `exec-error-model.stdout.jsonl` | Stdout of a failed turn (`-m gpt-5-codex` rejected under ChatGPT-subscription auth) — `thread.started`, `turn.started`, `error`, `turn.failed` |
| `exec-error-model.stderr.txt` | Stderr from the failed run |

## How to refresh

Codex versions change; re-capture when bumping the CLI. Run from anywhere:

```bash
DEST=src/agent/runtime/fixtures/codex
mkdir -p "$DEST" /tmp/wormhole-fixture-repro && cd /tmp/wormhole-fixture-repro

# Success — leave -m unset so codex picks an auth-appropriate default
codex exec --json --skip-git-repo-check --cd /tmp/wormhole-fixture-repro \
    --dangerously-bypass-approvals-and-sandbox \
    -o /tmp/wormhole-success-last.txt \
    --sandbox workspace-write --add-dir / \
    -- "respond with exactly the single word 'pong'" \
    > "$DEST/exec-success.stdout.jsonl" \
    2> "$DEST/exec-success.stderr.txt"
cp /tmp/wormhole-success-last.txt "$DEST/exec-success.last-message.txt"

# Error — gpt-5-codex rejected on ChatGPT subscription auth, gives us a
# realistic OpenAI 4xx error event to verify the unwrap logic against.
codex exec --json --skip-git-repo-check --cd /tmp/wormhole-fixture-repro \
    -m gpt-5-codex \
    --dangerously-bypass-approvals-and-sandbox \
    -o /tmp/wormhole-err-last.txt \
    --sandbox workspace-write --add-dir / \
    -- "anything" \
    > "$DEST/exec-error-model.stdout.jsonl" \
    2> "$DEST/exec-error-model.stderr.txt"

# Strip bash-environment noise that wouldn't appear when Node spawns codex
sed -i '' '/^Shell cwd was reset/d' "$DEST"/*.stderr.txt
```

Then re-run `npm run test` — the fixture-driven test should still pass. If
it doesn't, update the parser in `src/agent/runtime/codex.ts` to match the
new shape, then update tests to assert the new behavior.

## Why fixtures and not just unit tests

The Codex slice originally shipped with ~30 unit tests that all passed but
parsed the wrong wire shape — tests verified my *assumptions* about codex,
not codex's actual output. The bug only surfaced when a real Slack user hit
it. Fixtures pin the contract to real bytes, so "tests pass" and "the
parser handles real input" are the same statement.
