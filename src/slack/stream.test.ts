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

  // Tool indicators
  const edits2: Edit[] = [];
  const posts2: { ts: string }[] = [];
  const s2 = new SlackStreamer(makeClient(edits2, posts2), "C1", "T1");
  await s2.open();
  s2.toolStart("Bash");
  await new Promise((r) => setTimeout(r, 1100));
  s2.toolEnd("Bash", true);
  await s2.finalize();
  const final = edits2[edits2.length - 1].text;
  assert(final.includes("✅ Bash"), `expected ✅ Bash in: ${final}`);

  console.log("✅ stream verification passed");
}

main().catch((err) => {
  console.error("❌ stream verification failed:", err);
  process.exit(1);
});
