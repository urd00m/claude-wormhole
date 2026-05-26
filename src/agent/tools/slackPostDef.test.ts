// Direct verification of slackPostDef — the runtime-neutral tool defs.
// Phase 2 split slack_post_message / slack_post_file out of slackPost.ts into
// pure handler logic; this suite exercises that logic without going through
// the Claude SDK MCP wrapper. Same surface a future Codex stdio MCP shim
// will consume.

import type { WebClient } from "@slack/web-api";
import { slackPostMessageDef, slackPostFileDef, slackToolDefs } from "./slackPostDef.js";

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

async function main() {
  // --- (1) slack_post_message def shape ---
  {
    const posts: Post[] = [];
    const def = slackPostMessageDef({
      client: makeClient(posts),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp",
    });
    assert(def.name === "slack_post_message", `name: ${def.name}`);
    assert(typeof def.description === "string" && def.description.length > 0, "description");
    assert(typeof def.schema.text !== "undefined", "schema.text");
  }

  // --- (2) slack_post_message handler: short message → 1 post ---
  {
    const posts: Post[] = [];
    const def = slackPostMessageDef({
      client: makeClient(posts),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp",
    });
    const result = await def.handler({ text: "hello world" });
    assert(posts.length === 1, `expected 1 post, got ${posts.length}`);
    assert(posts[0].text === "hello world", "text passed through");
    assert(posts[0].channel === "C1", "channel propagated");
    assert(posts[0].thread_ts === "T1", "thread_ts propagated");
    assert(result.isError !== true, "no isError");
    assert(result.content[0].text === "posted", `summary: ${result.content[0].text}`);
  }

  // --- (3) slack_post_message handler: long message → split + n-part summary ---
  {
    const posts: Post[] = [];
    const def = slackPostMessageDef({
      client: makeClient(posts),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp",
    });
    const huge = "BEGIN\n\n" + "Paragraph.\n\n".repeat(4000) + "END";
    const result = await def.handler({ text: huge });
    assert(posts.length >= 2, `expected ≥2 posts, got ${posts.length}`);
    for (const p of posts) {
      assert(p.text.length <= 40_000, `Slack limit: ${p.text.length}`);
    }
    const all = posts.map((p) => p.text).join("\n");
    assert(all.includes("BEGIN") && all.includes("END"), "head/tail markers preserved");
    assert(
      result.content[0].text.startsWith("posted (") && result.content[0].text.endsWith(" parts)"),
      `summary: ${result.content[0].text}`,
    );
  }

  // --- (4) slack_post_file def shape ---
  {
    const def = slackPostFileDef({
      client: makeClient([]),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp",
    });
    assert(def.name === "slack_post_file", `name: ${def.name}`);
    assert(typeof def.schema.path !== "undefined", "schema.path");
    assert(typeof def.schema.title !== "undefined", "schema.title (optional)");
  }

  // --- (5) slack_post_file handler: relative path escapes workdir → error ---
  // The path-escape guard returns isError without invoking the uploadFile
  // helper. Important because the uploader would otherwise try to open
  // arbitrary filesystem paths.
  {
    const def = slackPostFileDef({
      client: makeClient([]),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp/wd-A",
    });
    // A relative path that, when joined, lives outside the workdir.
    const result = await def.handler({ path: "../wd-B/sneaky.png", title: undefined });
    assert(result.isError === true, "must flag as error");
    assert(result.content[0].text.includes("escapes workdir"), `msg: ${result.content[0].text}`);
  }

  // --- (6) slackToolDefs collects in order ---
  {
    const defs = slackToolDefs({
      client: makeClient([]),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp",
    });
    assert(defs.length === 2, `expected 2 defs, got ${defs.length}`);
    assert(defs[0].name === "slack_post_message", "0th is post_message");
    assert(defs[1].name === "slack_post_file", "1st is post_file");
  }

  console.log("✅ slackPostDef verified — handler dispatch, splitting summary, path escape guard");
}

main().catch((err) => {
  console.error("❌ slackPostDef verification failed:", err);
  process.exit(1);
});
