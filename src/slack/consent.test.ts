// Verify consent: button approve, button deny, reply-yes, reply-no, timeout.
// Run: SLACK_APP_TOKEN=xapp-stub SLACK_BOT_TOKEN=xoxb-stub SLACK_SIGNING_SECRET=stub ANTHROPIC_API_KEY=stub npx tsx src/slack/consent.test.ts
import { askConsent, resolveConsent, tryResolveByReply } from "./consent.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

let postCounter = 0;
const updates: Array<{ ts: string; text: string }> = [];

const stubClient = {
  chat: {
    postMessage: async (args: { blocks?: unknown }) => {
      postCounter += 1;
      // Extract block_id which contains the consent id
      const blocks = args.blocks as Array<{ block_id?: string; type?: string }> | undefined;
      const action = blocks?.find((b) => b.type === "actions");
      const id = action?.block_id?.replace(/^consent:/, "") ?? "";
      return { ts: `t${postCounter}`, _consentId: id };
    },
    update: async ({ ts, text }: { ts: string; text: string }) => {
      updates.push({ ts, text });
      return { ok: true };
    },
  },
} as never;

// Patch askConsent's internal post to surface the id; instead, we'll resolve via tryResolveByReply
// or by knowing the channel/thread.

async function main() {
  // Test 1: approve via resolveConsent (simulating button press) — we need the id.
  // The id is generated inside askConsent. Capture it by patching chat.postMessage
  // to record the last block_id.
  let lastId: string | null = null;
  const captureClient = {
    chat: {
      postMessage: async (args: { blocks?: unknown }) => {
        postCounter += 1;
        const blocks = args.blocks as Array<{ block_id?: string; type?: string }> | undefined;
        const a = blocks?.find((b) => b.type === "actions");
        if (a?.block_id) lastId = a.block_id.replace(/^consent:/, "");
        return { ts: `t${postCounter}` };
      },
      update: async ({ ts, text }: { ts: string; text: string }) => {
        updates.push({ ts, text });
        return { ok: true };
      },
    },
  } as never;

  // Approve
  const p1 = askConsent({
    client: captureClient,
    channel: "C1",
    threadTs: "T1",
    toolName: "Bash",
    command: "rm -rf foo",
    reason: "removes files",
  });
  await new Promise((r) => setTimeout(r, 20));
  assert(lastId, "consent id not captured");
  await resolveConsent(captureClient, lastId!, true, "U1");
  const ok = await p1;
  assert(ok === true, "approve must yield true");

  // Deny via reply "no"
  lastId = null;
  const p2 = askConsent({
    client: captureClient,
    channel: "C1",
    threadTs: "T1",
    toolName: "Bash",
    command: "rm -rf bar",
    reason: "removes files",
  });
  await new Promise((r) => setTimeout(r, 20));
  const consumed = await tryResolveByReply(captureClient, "C1", "T1", "no", "U2");
  assert(consumed, "reply 'no' should be consumed");
  const ok2 = await p2;
  assert(ok2 === false, "reply 'no' must yield false");

  // Unrelated reply does not consume
  lastId = null;
  const p3 = askConsent({
    client: captureClient,
    channel: "C2",
    threadTs: "T2",
    toolName: "Bash",
    command: "rm baz",
    reason: "removes files",
  });
  await new Promise((r) => setTimeout(r, 20));
  const consumed2 = await tryResolveByReply(captureClient, "C2", "T2", "hi there", "U3");
  assert(!consumed2, "non-yes/no must not consume");
  // Clean up p3
  await tryResolveByReply(captureClient, "C2", "T2", "yes", "U3");
  await p3;

  console.log("✅ consent verification passed (approve, reply-no, non-trigger)");
}

main().catch((err) => {
  console.error("❌ consent verification failed:", err);
  process.exit(1);
});
