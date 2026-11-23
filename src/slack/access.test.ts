// Exercise the real Slack event/action handlers using a fake Slack client.
import assert from "node:assert/strict";
import type { App } from "@slack/bolt";
import { env, parseConfig } from "../config.js";
import { registerHandlers } from "./handlers.js";
import { registerInteractions } from "./interactions.js";
import { askConsent, resolveConsent, tryResolveByReply } from "./consent.js";
import { isAllowedSlackUser } from "./access.js";

type Callback = (args: any) => Promise<void>;
const events = new Map<string, Callback>();
const actions = new Map<string, Callback>();
const app = {
  event: (name: string, callback: Callback) => events.set(name, callback),
  action: (name: string, callback: Callback) => actions.set(name, callback),
} as unknown as App;
const posts: any[] = [];
const updates: any[] = [];
const client = {
  chat: {
    postMessage: async (args: any) => {
      posts.push(args);
      return { ok: true, ts: `post${posts.length}` };
    },
    update: async (args: any) => {
      updates.push(args);
      return { ok: true };
    },
  },
};

async function main() {
  const initialIds = env.SLACK_ALLOWED_USER_IDS;
  const initialChannels = env.SLACK_UNMENTIONED_CHANNEL_IDS;
  env.SLACK_ALLOWED_USER_IDS = ["U1"];
  env.SLACK_UNMENTIONED_CHANNEL_IDS = ["CTEST"];
  try {
    const base = { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test", SLACK_SIGNING_SECRET: "test" };
    assert.deepEqual(parseConfig(base).SLACK_ALLOWED_USER_IDS, []);
    assert.deepEqual(parseConfig({ ...base, SLACK_ALLOWED_USER_IDS: " U1, U2,U1,, " }).SLACK_ALLOWED_USER_IDS, ["U1", "U2"]);
    for (const invalid of ["*", "@Alan", "U1,not-an-id"]) {
      assert.throws(() => parseConfig({ ...base, SLACK_ALLOWED_USER_IDS: invalid }));
    }
    assert.equal(isAllowedSlackUser("U1"), true);
    assert.equal(isAllowedSlackUser("U2"), false);
    assert.equal(isAllowedSlackUser(undefined), false);
    assert.equal(isAllowedSlackUser(""), false);
    registerHandlers(app);
    registerInteractions(app);

    // Denied users must not reach control commands, session creation or file downloads.
    for (const name of ["message", "app_mention"]) {
      const previousPosts = posts.length;
      for (const text of ["ctrl+c", "switch to codex", "Please read the attached file", "yes", "no"]) {
        await events.get(name)!({ client, event: {
          channel: "CTEST", user: "U2", ts: `${name}-${text}`, thread_ts: "TTEST",
          text, files: [{ id: "untrusted-file" }],
        } });
      }
      assert.equal(posts.length, previousPosts);
      assert.equal(updates.length, 0);
      // Allowed owner reaches the harmless interrupt path in both event handlers.
      await events.get(name)!({ client, event: {
        channel: "CTEST", user: "U1", ts: `${name}-owner`, text: "ctrl+c",
      } });
    }
    assert.equal(posts.length, 2);
    assert(posts.every((post) => post.text === "Nothing is running in this thread — nothing to interrupt."));

    const pending = askConsent({ client: client as never, channel: "CTEST", threadTs: "TTEST",
      toolName: "Test", command: "harmless operation", reason: "test" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const consentId = posts.at(-1).blocks.find((block: any) => block.type === "actions").elements[0].value;
    let ackCount = 0;
    for (const name of ["consent_approve", "consent_deny"]) {
      for (const user of ["U2", undefined]) {
        await actions.get(name)!({ client, ack: async () => { ackCount++; }, body: {
          user: user ? { id: user } : undefined, actions: [{ value: consentId }],
        } });
      }
    }
    assert.equal(ackCount, 4, "unauthorized button requests must still be acknowledged");
    assert.equal(updates.length, 0);
    assert.equal(await resolveConsent(client as never, consentId, true, "U2"), false);
    assert.equal(await tryResolveByReply(client as never, "CTEST", "TTEST", "yes", "U2"), false);
    assert.equal(await tryResolveByReply(client as never, "CTEST", "TTEST", "no", "U2"), false);
    assert.equal(updates.length, 0);
    await actions.get("consent_approve")!({ client, ack: async () => {}, body: {
      user: { id: "U1" }, actions: [{ value: consentId }],
    } });
    assert.equal(await pending, true, "unauthorized actions must leave the owner's approval pending");
    assert.equal(updates.length, 1);

    env.SLACK_ALLOWED_USER_IDS = [];
    const postCount = posts.length;
    for (const name of ["message", "app_mention"]) {
      await events.get(name)!({ client, event: { channel: "CTEST", user: "U1", ts: `${name}-empty`, text: "ctrl+c" } });
    }
    assert.equal(posts.length, postCount, "missing allowlist must block all users");
    assert.equal(isAllowedSlackUser("U1"), false);
    console.log("✅ Slack access: allowed owner, denied users, both event paths, approvals/replies, missing identity and empty configuration");
  } finally {
    env.SLACK_ALLOWED_USER_IDS = initialIds;
    env.SLACK_UNMENTIONED_CHANNEL_IDS = initialChannels;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
