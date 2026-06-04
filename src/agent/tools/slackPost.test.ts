// Verify postSlackMessage chunks long text so no single chat.postMessage
// payload exceeds Slack's 40k cap, and that the full original content
// survives the split.
// Run: SLACK_APP_TOKEN=xapp-stub SLACK_BOT_TOKEN=xoxb-stub SLACK_SIGNING_SECRET=stub ANTHROPIC_API_KEY=stub npx tsx src/agent/tools/slackPost.test.ts
import type { WebClient } from "@slack/web-api";
import { postSlackMessage } from "./slackPost.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Post = { channel: string; thread_ts: string; text: string };

function makeClient(posts: Post[]): WebClient {
  return {
    chat: {
      postMessage: async (args: Post) => {
        posts.push(args);
        return { ts: `t${posts.length}` };
      },
    },
  } as unknown as WebClient;
}

async function testShortMessageStaysOne() {
  const posts: Post[] = [];
  const n = (await postSlackMessage(makeClient(posts), "C1", "T1", "hello world")).length;
  assert(n === 1, `short message should be 1 part, got ${n}`);
  assert(posts.length === 1, `expected 1 post, got ${posts.length}`);
  assert(posts[0].text === "hello world", "text passed through unchanged");
  assert(posts[0].channel === "C1" && posts[0].thread_ts === "T1", "channel/thread propagated");
}

async function testLongMessageSplitsAndPreservesContent() {
  const posts: Post[] = [];
  const head = "BEGIN_MARKER\n\n";
  const body = ("Paragraph with some words.\n\n".repeat(2000));
  const tail = "TAIL_MARKER";
  const huge = head + body + tail;

  const n = (await postSlackMessage(makeClient(posts), "C1", "T1", huge)).length;
  assert(n >= 2, `expected ≥2 parts, got ${n}`);
  assert(posts.length === n, `posts (${posts.length}) should match parts (${n})`);

  for (const p of posts) {
    assert(p.text.length <= 40_000, `post exceeded Slack limit: ${p.text.length}`);
    assert(p.channel === "C1" && p.thread_ts === "T1", "channel/thread propagated");
  }

  const all = posts.map((p) => p.text).join("\n");
  assert(all.includes("BEGIN_MARKER"), "head marker missing");
  assert(all.includes("TAIL_MARKER"), "tail marker dropped — bug not fixed");
}

async function testLongCodeBlockKeepsFencesBalanced() {
  const posts: Post[] = [];
  const prose = "Here is some output:\n\n";
  const code = "```ts\n" + "x".repeat(80_000) + "\n```\n";
  const tail = "\n\nDone.";
  const n = (await postSlackMessage(makeClient(posts), "C1", "T1", prose + code + tail)).length;

  assert(n >= 2, `expected split, got ${n} parts`);
  for (const p of posts) {
    const fences = (p.text.match(/```/g) || []).length;
    assert(fences % 2 === 0, `unbalanced fences in part:\n${p.text.slice(0, 200)}…`);
  }
}

async function main() {
  await testShortMessageStaysOne();
  await testLongMessageSplitsAndPreservesContent();
  await testLongCodeBlockKeepsFencesBalanced();
  console.log("✅ slack_post_message splitting verification passed");
}

main().catch((err) => {
  console.error("❌ slack_post_message splitting verification failed:", err);
  process.exit(1);
});
