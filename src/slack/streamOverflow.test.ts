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

async function main() {
  await testSplitterPlain();
  await testSplitterPreservesCodeFence();
  await testStreamerSpansMessages();
  console.log("✅ stream overflow verification passed");
}

main().catch((err) => {
  console.error("❌ stream overflow verification failed:", err);
  process.exit(1);
});
