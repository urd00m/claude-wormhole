// Verify SlackStreamer spans long responses across multiple thread messages
// and that splitForSlack preserves code fences across boundaries.
// Run: SLACK_APP_TOKEN=xapp-stub SLACK_BOT_TOKEN=xoxb-stub SLACK_SIGNING_SECRET=stub ANTHROPIC_API_KEY=stub npx tsx src/slack/streamOverflow.test.ts
import { SlackStreamer, splitForSlack } from "./stream.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Edit = { ts: string; text: string };
type Post = { ts: string; text: string };

function makeClient(edits: Edit[], posts: Post[]) {
  return {
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        const ts = `t${posts.length + 1}`;
        posts.push({ ts, text });
        return { ts };
      },
      update: async ({ ts, text }: { ts: string; text: string }) => {
        edits.push({ ts, text });
        return { ok: true };
      },
    },
  } as never;
}

async function testSplitterPlain() {
  const big = "a".repeat(100_000);
  const parts = splitForSlack(big, 38_000);
  assert(parts.length >= 3, `expected ≥3 parts, got ${parts.length}`);
  assert(
    parts.every((p) => p.length <= 38_000),
    "no part may exceed limit",
  );
  // Reconstruct (no fence rewrites for plain text).
  assert(parts.join("") === big, "plain-text reassembly must equal original");
}

async function testSplitterPreservesCodeFence() {
  const head = "Here is some prose.\n\n";
  const code = "```ts\n" + "x".repeat(80_000) + "\n```\n";
  const tail = "\n\nAnd a trailing note.";
  const full = head + code + tail;
  const parts = splitForSlack(full, 38_000);

  assert(parts.length >= 2, `expected split, got ${parts.length} parts`);
  // Every part should have balanced fences when read on its own.
  for (const p of parts) {
    const fences = (p.match(/```/g) || []).length;
    assert(fences % 2 === 0, `unbalanced fences in chunk:\n${p.slice(0, 200)}…`);
  }
  // The middle chunks (inside the long code block) must start with a fence
  // re-open so Slack renders them as code, not prose.
  assert(parts[1].startsWith("```"), "continuation inside fence must re-open it");
}

async function testStreamerSpansMessages() {
  const edits: Edit[] = [];
  const posts: Post[] = [];
  const s = new SlackStreamer(makeClient(edits, posts), "C1", "T1");
  await s.open();
  assert(posts.length === 1, "initial placeholder post");

  // Single huge final response — simulate onFinal with very long text.
  const huge = ("Paragraph with some words.\n\n".repeat(2000)) + "TAIL_MARKER";
  s.setText(huge);
  await s.finalize();

  // We should have created continuation messages.
  assert(posts.length >= 2, `expected ≥2 messages, got ${posts.length}`);

  // Every emitted message body (the last text on each ts) must stay within
  // Slack's per-message ceiling.
  const lastByTs = new Map<string, string>();
  for (const p of posts) lastByTs.set(p.ts, p.text);
  for (const e of edits) lastByTs.set(e.ts, e.text);
  for (const [ts, text] of lastByTs) {
    assert(text.length <= 40_000, `${ts} exceeded Slack limit: ${text.length}`);
  }

  // The TAIL_MARKER must appear in one of the messages — nothing got dropped.
  const allText = [...lastByTs.values()].join("\n");
  assert(allText.includes("TAIL_MARKER"), "tail of long message was dropped");
}

// Regression: finalize must drain any in-flight flush AND its queued
// flushAgain before declaring closed — otherwise a setText issued by the
// SDK's onFinal hook (which fires the moment streaming ends, while a
// previous flush triggered by the last token-delta is still awaiting
// chat.update) gets silently dropped, and the user sees an earlier shorter
// version of the reply ("long messages cut off").
async function testFinalizeWaitsForInFlightFlushAndCapturesLatestSetText() {
  const edits: Edit[] = [];
  const posts: Post[] = [];

  // chat.update returns slowly so a flush is genuinely in-flight when the
  // next setText / finalize fires. Use a real microtask delay (setTimeout
  // 50ms) — Promise.resolve() chains would resolve in the same tick and
  // race wouldn't materialize.
  const slowClient = {
    chat: {
      postMessage: async ({ text }: { text: string }) => {
        const ts = `t${posts.length + 1}`;
        posts.push({ ts, text });
        return { ts };
      },
      update: async ({ ts, text }: { ts: string; text: string }) => {
        await new Promise((r) => setTimeout(r, 50));
        edits.push({ ts, text });
        return { ok: true };
      },
    },
  } as never;

  const s = new SlackStreamer(slowClient, "C1", "T1");
  await s.open();

  // Simulate streaming: first an appendText that triggers a flush (which
  // will be slow), then the SDK's onFinal hook setting the canonical full
  // text right after, then finalize. Without the drain fix, the FINAL
  // marker would only appear in textBuffer but never reach Slack.
  s.appendText("STREAMED_INTERIM");
  // Yield to let the in-flight flush kick off chat.update (which sleeps 50ms).
  await new Promise((r) => setTimeout(r, 10));
  s.setText("CANONICAL_FINAL_REPLY_WITH_TAIL_MARKER");
  await s.finalize();

  // Find the latest text written to message[0].
  const updatesForFirstMsg = edits.filter((e) => e.ts === "t1");
  assert(updatesForFirstMsg.length > 0, "expected at least one update for message[0]");
  const latest = updatesForFirstMsg[updatesForFirstMsg.length - 1].text;
  assert(
    latest.includes("TAIL_MARKER"),
    `finalize dropped the post-flush setText; last text on message[0] was:\n${latest}`,
  );
}

async function main() {
  await testSplitterPlain();
  await testSplitterPreservesCodeFence();
  await testStreamerSpansMessages();
  await testFinalizeWaitsForInFlightFlushAndCapturesLatestSetText();
  console.log("✅ stream overflow verification passed");
}

main().catch((err) => {
  console.error("❌ stream overflow verification failed:", err);
  process.exit(1);
});
