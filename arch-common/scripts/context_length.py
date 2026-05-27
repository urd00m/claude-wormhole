#!/usr/bin/env python3
"""context_length.py - deduce the CALLER's Claude Code context length.

Claude cannot introspect its own context window mid-turn. But the Claude Code
session transcript records the exact API `usage` block for every assistant
turn, and the prompt token count the model saw on a turn is:

    prompt = input_tokens + cache_creation_input_tokens + cache_read_input_tokens

That sum is the *entire* context the model received - system prompt, tool
schemas, skills, memory, and the full conversation. It is not an estimate; it
is what the API metered and billed.

The most recent assistant turn's prompt total is therefore the context length
as of that turn. The turn being generated *right now* is not in the transcript
yet, so this reading lags by exactly one turn; `estimated_next_prompt` adds the
last assistant output (which carries into the next prompt) as a tight lower
bound for what the next turn will see.

Compaction needs no special handling: each turn's usage reflects the real
prompt for that turn, so once a compaction has happened the latest usage
already shows the smaller, post-compaction context. `peak_prompt` is reported
alongside so a drop from peak makes a compaction visible.

Run this via the Bash tool and its stdout lands in the context window - that
is the "import" path: the model reads its own size from the tool result.

Session targeting
------------------
A context reading only means something if it is the *caller's own* session.
This tool identifies the session explicitly - it never picks a transcript by
file mtime, because any other concurrently-running Claude session (a second
agent loop, an interactive session) would then silently win that guess.

    context_length.py [SESSION_ID] [--window N] [--project DIR] [--json]

  - SESSION_ID given  -> reads ~/.claude/projects/*/<SESSION_ID>.jsonl.
  - SESSION_ID absent -> inferred from $CLAUDE_CODE_SESSION_ID, which Claude
    Code exports into every Bash-tool subprocess, so a bare invocation
    measures exactly the caller that ran it.
  - --transcript PATH -> escape hatch: read an explicit transcript file.

If no session can be determined, the tool errors out rather than report a
number that might belong to a different session.
"""
import argparse
import glob
import json
import os
import sys

# claude-opus-4-7[1m] runs a 1M-token window. The transcript records the model
# as "claude-opus-4-7" without the [1m] tier suffix, so the window cannot be
# read back from it - default to 1M and let --window override for 200k tiers.
DEFAULT_WINDOW = 1_000_000


def transcript_for_session(session_id, project):
    """Resolve a Claude Code session id to its transcript .jsonl.

    A session's transcript lives at ~/.claude/projects/<proj>/<session_id>.jsonl.
    Sub-agent transcripts live under a <session>/subagents/ subdirectory with a
    different naming scheme, so they never collide with a session-id lookup.
    """
    if project:
        roots = [os.path.expanduser(f"~/.claude/projects/{project}")]
    else:
        roots = glob.glob(os.path.expanduser("~/.claude/projects/*"))
    matches = [
        cand for cand in (
            os.path.join(root, f"{session_id}.jsonl") for root in roots
        ) if os.path.isfile(cand)
    ]
    if not matches:
        sys.exit(f"no transcript for session {session_id} under "
                 f"~/.claude/projects/ - session not started yet, or wrong id")
    # A session id is unique; if it somehow resolves under multiple project
    # dirs, the freshest is the live one.
    return max(matches, key=os.path.getmtime)


def find_transcript(explicit, session_id, project):
    """Locate the transcript to read, identifying the session explicitly."""
    if explicit:
        if not os.path.isfile(explicit):
            sys.exit(f"transcript not found: {explicit}")
        return explicit
    if not session_id:
        session_id = os.environ.get("CLAUDE_CODE_SESSION_ID", "").strip()
    if not session_id:
        sys.exit("cannot determine the session: pass SESSION_ID explicitly, or "
                 "run inside a Claude Code session so $CLAUDE_CODE_SESSION_ID "
                 "is set. This tool will not guess a transcript by mtime - a "
                 "wrong session's number is worse than no number.")
    return transcript_for_session(session_id, project)


def scan(path):
    """Return (last_usage_record, peak_prompt) from a transcript JSONL."""
    last = None
    peak = 0
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg = rec.get("message")
            if not isinstance(msg, dict) or msg.get("role") != "assistant":
                continue
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            prompt = (
                usage.get("input_tokens", 0)
                + usage.get("cache_creation_input_tokens", 0)
                + usage.get("cache_read_input_tokens", 0)
            )
            peak = max(peak, prompt)
            last = {
                "timestamp": rec.get("timestamp"),
                "model": msg.get("model"),
                "input_tokens": usage.get("input_tokens", 0),
                "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0),
                "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
                "prompt_tokens": prompt,
            }
    if last is None:
        sys.exit(f"no assistant turn with a usage block in {path}")
    return last, peak


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session_id", nargs="?",
                    help="Claude Code session id (default: $CLAUDE_CODE_SESSION_ID)")
    ap.add_argument("--transcript", help="explicit transcript .jsonl path (escape hatch)")
    ap.add_argument("--window", type=int, default=DEFAULT_WINDOW,
                    help=f"context window size (default: {DEFAULT_WINDOW})")
    ap.add_argument("--project", help="project dir name under ~/.claude/projects/")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of a report")
    args = ap.parse_args()

    path = find_transcript(args.transcript, args.session_id, args.project)
    last, peak = scan(path)

    measured = last["prompt_tokens"]
    estimated_next = measured + last["output_tokens"]
    window = args.window
    used_pct = 100.0 * measured / window
    remaining = window - estimated_next

    if args.json:
        print(json.dumps({
            "transcript": path,
            "window": window,
            "measured_prompt_tokens": measured,
            "estimated_next_prompt_tokens": estimated_next,
            "peak_prompt_tokens": peak,
            "remaining_tokens": remaining,
            "used_pct": round(used_pct, 2),
            **last,
        }, indent=2))
        return

    bar_w = 40
    filled = min(bar_w, round(bar_w * measured / window))
    bar = "#" * filled + "-" * (bar_w - filled)
    print("=== Claude Code context length ===")
    print(f"transcript : {path}")
    print(f"last turn  : {last['timestamp']}  ({last['model']})")
    print(f"  input={last['input_tokens']}  "
          f"cache_creation={last['cache_creation_input_tokens']}  "
          f"cache_read={last['cache_read_input_tokens']}  "
          f"output={last['output_tokens']}")
    print()
    print(f"measured context   : {measured:>10,} tokens  (exact, last assistant turn)")
    print(f"est. next prompt   : {estimated_next:>10,} tokens  (+ last output, lower bound)")
    print(f"peak this session  : {peak:>10,} tokens")
    print(f"context window     : {window:>10,} tokens")
    print(f"remaining (est.)   : {remaining:>10,} tokens")
    print(f"[{bar}] {used_pct:.1f}% used")
    if peak - measured > 0.15 * window:
        print(f"note: context is {peak - measured:,} tokens below peak - "
              f"a compaction likely occurred.")


if __name__ == "__main__":
    main()
