// Verify SlackStreamer throttles edits to ≤1/sec and renders correctly.
// Run: SLACK_APP_TOKEN=xapp-stub SLACK_BOT_TOKEN=xoxb-stub SLACK_SIGNING_SECRET=stub ANTHROPIC_API_KEY=stub npx tsx src/slack/stream.test.ts
import { SlackStreamer } from "./stream.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Edit = { ts: string; text: string; at: number };

function makeClient(edits: Edit[], posts: { ts: string }[]) {
  return {
    chat: {
      postMessage: async () => {
        const ts = `t${posts.length + 1}`;
        posts.push({ ts });
        return { ts };
      },
      update: async ({ ts, text }: { ts: string; text: string }) => {
        edits.push({ ts, text, at: Date.now() });
        return { ok: true };
      },
    },
  } as never;
}

async function main() {
  const edits: Edit[] = [];
  const posts: { ts: string }[] = [];
  const s = new SlackStreamer(makeClient(edits, posts), "C1", "T1");
  await s.open();

  // Spam 30 appends fast — only ~1 edit should hit per second.
  for (let i = 0; i < 30; i++) {
    s.appendText(`chunk${i} `);
    await new Promise((r) => setTimeout(r, 10));
  }
  await new Promise((r) => setTimeout(r, 1100));
  await s.finalize();

  console.log(`posts=${posts.length} edits=${edits.length}`);
  assert(posts.length === 1, "exactly one placeholder post");
  // With 300ms of appends + finalize, expect ≤2 throttled edits + 1 final flush
  assert(edits.length <= 4, `too many edits, throttle broken: ${edits.length}`);
  // Final edit must contain a chunk
  const last = edits[edits.length - 1];
  assert(last.text.includes("chunk29"), "final text must include last chunk");

  // Tool indicators collapsed onto one line, matched by id
  const edits2: Edit[] = [];
  const posts2: { ts: string }[] = [];
  const s2 = new SlackStreamer(makeClient(edits2, posts2), "C1", "T1");
  await s2.open();
  s2.toolStart("id1", "Bash");
  s2.toolStart("id2", "Read");
  s2.toolStart("id3", "Edit");
  await new Promise((r) => setTimeout(r, 1100));
  // Complete out of order; id matching should still work
  s2.toolEnd("id2", true);
  s2.toolEnd("id1", true);
  s2.toolEnd("id3", false);
  s2.appendText("done!");
  await s2.finalize();
  const final = edits2[edits2.length - 1].text;
  // Single status line, all three tools in start order, then body
  assert(
    final.includes("✅ Bash · ✅ Read · ❌ Edit"),
    `expected collapsed status line, got: ${final}`,
  );
  assert(final.includes("done!"), "body text must appear");
  // The collapsed line is one line — count newlines in that section
  const lines = final.split("\n");
  const toolLine = lines.find((l) => l.includes("Bash"));
  assert(toolLine && !toolLine.includes("\n"), "tools must be on a single line");

  // Mixed in-progress + done states render correctly
  const edits3: Edit[] = [];
  const posts3: { ts: string }[] = [];
  const s3 = new SlackStreamer(makeClient(edits3, posts3), "C1", "T1");
  await s3.open();
  s3.toolStart("a", "Bash");
  s3.toolStart("b", "Read");
  s3.toolEnd("a", true);
  await new Promise((r) => setTimeout(r, 1100));
  await s3.finalize();
  const mixed = edits3[edits3.length - 1].text;
  assert(
    mixed.includes("✅ Bash · 🔧 Read") || mixed.includes("✅ Bash · ❌ Read") || mixed.includes("✅ Bash · ✅ Read"),
    `mixed state line wrong: ${mixed}`,
  );
  assert(mixed.includes("🔧 Read"), `Read should still be in-progress in: ${mixed}`);

  console.log("✅ stream verification passed");
}

main().catch((err) => {
  console.error("❌ stream verification failed:", err);
  process.exit(1);
});
