// Direct verification of slackPostDef — the runtime-neutral tool defs.
// Phase 2 split slack_post_message / slack_post_file out of slackPost.ts into
// pure handler logic; this suite exercises that logic without going through
// the Claude SDK MCP wrapper. Same surface a future Codex stdio MCP shim
// will consume.

import type { WebClient } from "@slack/web-api";
import {
  slackPostMessageDef,
  slackPostFileDef,
  slackDeleteMessageDef,
  slackToolDefs,
} from "./slackPostDef.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type Post = { channel: string; thread_ts: string; text: string };
type Delete = { channel: string; ts: string };

function makeClient(posts: Post[], deletes: Delete[] = [], failTs: Set<string> = new Set()): WebClient {
  return {
    chat: {
      postMessage: async (args: Post) => {
        posts.push(args);
        return { ts: `t${posts.length}` };
      },
      delete: async (args: Delete) => {
        if (failTs.has(args.ts)) throw new Error("cant_delete_message");
        deletes.push(args);
        return { ok: true };
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
    // Summary now surfaces the posted ts so the agent can delete it later.
    assert(result.content[0].text === "posted (ts t1)", `summary: ${result.content[0].text}`);
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
    // Multi-part summary reports the part count AND every posted ts.
    assert(
      result.content[0].text.startsWith(`posted (${posts.length} parts; ts `),
      `summary: ${result.content[0].text}`,
    );
    for (let i = 1; i <= posts.length; i++) {
      assert(result.content[0].text.includes(`t${i}`), `summary missing ts t${i}`);
    }
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
    assert(defs.length === 3, `expected 3 defs, got ${defs.length}`);
    assert(defs[0].name === "slack_post_message", "0th is post_message");
    assert(defs[1].name === "slack_post_file", "1st is post_file");
    assert(defs[2].name === "slack_delete_message", "2nd is delete_message");
  }

  // --- (7) slack_delete_message def shape ---
  {
    const def = slackDeleteMessageDef({
      client: makeClient([]),
      channel: "C1",
      threadTs: "T1",
      workdir: "/tmp",
    });
    assert(def.name === "slack_delete_message", `name: ${def.name}`);
    assert(typeof def.description === "string" && def.description.length > 0, "description");
    assert(typeof def.schema.ts !== "undefined", "schema.ts");
  }

  // --- (8) round-trip: post returns ts, delete removes those exact ts ---
  // This is the debug-cleanup workflow: the agent posts (capturing the ts in
  // the summary), then deletes by ts. Deletion is scoped to ctx.channel.
  {
    const posts: Post[] = [];
    const deletes: Delete[] = [];
    const client = makeClient(posts, deletes);
    const ctx = { client, channel: "C1", threadTs: "T1", workdir: "/tmp" };
    const postRes = await slackPostMessageDef(ctx).handler({ text: "noise to clean up" });
    assert(postRes.content[0].text === "posted (ts t1)", `post summary: ${postRes.content[0].text}`);

    const delRes = await slackDeleteMessageDef(ctx).handler({ ts: ["t1"] });
    assert(delRes.isError !== true, `delete should succeed: ${delRes.content[0].text}`);
    assert(deletes.length === 1, `expected 1 delete, got ${deletes.length}`);
    assert(deletes[0].ts === "t1", "deleted the posted ts");
    assert(deletes[0].channel === "C1", "delete scoped to ctx.channel");
    assert(delRes.content[0].text.includes("deleted 1"), `summary: ${delRes.content[0].text}`);
  }

  // --- (9) delete reports partial failures and flags isError ---
  // Slack rejects deleting another author's / a missing message; the handler
  // must surface which ts failed rather than silently dropping them.
  {
    const deletes: Delete[] = [];
    const client = makeClient([], deletes, new Set(["bad.ts"]));
    const ctx = { client, channel: "C1", threadTs: "T1", workdir: "/tmp" };
    const res = await slackDeleteMessageDef(ctx).handler({ ts: ["good.ts", "bad.ts"] });
    assert(res.isError === true, "partial failure must flag isError");
    assert(deletes.length === 1 && deletes[0].ts === "good.ts", "good ts still deleted");
    assert(res.content[0].text.includes("deleted 1"), `summary missing success: ${res.content[0].text}`);
    assert(res.content[0].text.includes("bad.ts"), `summary missing failed ts: ${res.content[0].text}`);
  }

  // --- (10) delete with empty ts list → error, no API calls ---
  {
    const deletes: Delete[] = [];
    const ctx = { client: makeClient([], deletes), channel: "C1", threadTs: "T1", workdir: "/tmp" };
    const res = await slackDeleteMessageDef(ctx).handler({ ts: [] });
    assert(res.isError === true, "empty ts list must error");
    assert(deletes.length === 0, "no delete calls for empty list");
  }

  console.log(
    "✅ slackPostDef verified — handler dispatch, ts-returning post, delete round-trip + partial-failure, path escape guard",
  );
}

main().catch((err) => {
  console.error("❌ slackPostDef verification failed:", err);
  process.exit(1);
});
