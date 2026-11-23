// Exercise real event handlers without starting an agent or contacting Slack.
import assert from "node:assert/strict";
import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { env, parseConfig } from "../config.js";
import { registerHandlers } from "./handlers.js";
import { askConsent, resolveConsent } from "./consent.js";

type Callback = (args: any) => Promise<void>;
const events = new Map<string, Callback>();
const app = {
  event: (name: string, callback: Callback) => events.set(name, callback),
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
} as unknown as WebClient;

let nextTs = 0;
async function send(name: string, fields: Record<string, unknown>) {
  await events.get(name)!({ client, context: { botUserId: "UBOT" }, event: {
    channel: "COTHER", channel_type: "channel", user: "U1",
    ts: `message${++nextTs}`, text: "ctrl+c", ...fields,
  } });
}

async function main() {
  const initialUsers = env.SLACK_ALLOWED_USER_IDS;
  const initialChannels = env.SLACK_UNMENTIONED_CHANNEL_IDS;
  const consentIds: string[] = [];
  env.SLACK_ALLOWED_USER_IDS = ["U1"];
  env.SLACK_UNMENTIONED_CHANNEL_IDS = ["CHOME"];
  try {
    const base = { SLACK_APP_TOKEN: "xapp-test", SLACK_BOT_TOKEN: "xoxb-test", SLACK_SIGNING_SECRET: "test" };
    assert.deepEqual(parseConfig(base).SLACK_UNMENTIONED_CHANNEL_IDS, []);
    assert.deepEqual(parseConfig({ ...base, SLACK_UNMENTIONED_CHANNEL_IDS: " CHOME, GPRIVATE,CHOME,, " }).SLACK_UNMENTIONED_CHANNEL_IDS, ["CHOME", "GPRIVATE"]);
    for (const invalid of ["*", "#nala-fob", "U1", "CHOME,not-an-id"]) {
      assert.throws(() => parseConfig({ ...base, SLACK_UNMENTIONED_CHANNEL_IDS: invalid }));
    }
    registerHandlers(app);

    // Public/private channels and existing threads stay silent without a mention.
    for (const channel of ["COTHER", "GPRIVATE"]) {
      for (const thread_ts of [undefined, "existing-thread"]) {
        for (const text of ["hello", "ctrl+c", "switch to codex", "!echo unexpected", "yes", "no", "<@UOTHER> ctrl+c", "<!here> ctrl+c", "nala ctrl+c"]) {
          await send("message", { channel, thread_ts, text });
        }
        await send("message", { channel, thread_ts, subtype: "file_share", text: "", files: [{ id: "never-download" }] });
      }
    }
    assert.equal(posts.length, 0, "unmentioned channel messages must not reach commands, agents or file downloads");

    // Message events handle mentions even without app_mentions:read.
    // The companion app_mention must not run the same command again.
    await send("message", { ts: "shared-mention", text: "<@UBOT> ctrl+c" });
    assert.equal(posts.length, 1);
    await send("app_mention", { ts: "shared-mention", text: "<@UBOT> ctrl+c" });
    assert.equal(posts.length, 1);
    await send("app_mention", { channel: "GPRIVATE", thread_ts: "existing-thread", text: "<@UBOT> ctrl+c" });
    assert.equal(posts.length, 2, "direct mentions work in both public and private channels, including threads");
    await send("app_mention", { user: "U2", text: "<@UBOT> ctrl+c" });
    assert.equal(posts.length, 2, "mentions must not bypass the user allowlist");

    for (const fields of [
      { channel: "CHOME" },
      { channel: "CHOME", thread_ts: "existing-thread" },
      { channel: "D1", channel_type: "im" },
      { channel: "D2", channel_type: undefined },
      { channel: "GDM", channel_type: "mpim" },
    ]) {
      await send("message", fields);
    }
    assert.equal(posts.length, 7, "home channel, DMs and group DMs work without mentions");
    assert(posts.every((post) => post.text === "Nothing is running in this thread — nothing to interrupt."));

    // Bare replies cannot consume approvals outside home; @Nala yes/no can.
    for (const [reply, expected] of [["yes", true], ["no", false]] as const) {
      const pending = askConsent({ client, channel: "COTHER", threadTs: "consent-thread",
        toolName: "Test", command: "harmless operation", reason: "test" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      consentIds.push(posts.at(-1).blocks.find((block: any) => block.type === "actions").elements[0].value);
      const beforeUpdates = updates.length;
      await send("message", { thread_ts: "consent-thread", text: reply });
      assert.equal(updates.length, beforeUpdates, "unmentioned approval must remain pending");
      await send("app_mention", { thread_ts: "consent-thread", text: `<@UBOT> ${reply}` });
      assert.equal(await pending, expected);
      assert.equal(updates.length, beforeUpdates + 1);
    }

    env.SLACK_UNMENTIONED_CHANNEL_IDS = [];
    const previousPosts = posts.length;
    await send("message", { channel: "CHOME" });
    assert.equal(posts.length, previousPosts, "empty configuration must require mentions in every channel");
    await send("message", { channel: "D1", channel_type: "im" });
    assert.equal(posts.length, previousPosts + 1, "DMs remain available without channel exceptions");

    const beforeFallback = posts.length;
    await send("message", { channel: "GPRIVATE", thread_ts: "existing-thread", text: "<@UBOT> ctrl+c" });
    assert.equal(posts.length, beforeFallback + 1, "private-channel thread mentions work through message events");
    await send("message", { user: "U2", text: "<@UBOT> ctrl+c" });
    await events.get("message")!({ client, context: {}, event: {
      channel: "COTHER", user: "U1", ts: "missing-bot-identity", text: "<@UBOT> ctrl+c",
    } });
    assert.equal(posts.length, beforeFallback + 1, "mentions still require an allowed sender and authenticated bot identity");
    await send("app_mention", { ts: "mention-first", text: "<@UBOT> ctrl+c" });
    await send("message", { ts: "mention-first", text: "<@UBOT> ctrl+c" });
    assert.equal(posts.length, beforeFallback + 2, "both event orders deliver a command once");

    const pending = askConsent({ client, channel: "COTHER", threadTs: "fallback-consent",
      toolName: "Test", command: "harmless operation", reason: "test" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    consentIds.push(posts.at(-1).blocks.find((block: any) => block.type === "actions").elements[0].value);
    await send("message", { thread_ts: "fallback-consent", text: "<@UBOT> yes" });
    assert.equal(await pending, true, "message-event mentions can resolve approvals");
    console.log("✅ Slack channel routing: home/DMs, mention-only channels/threads, commands/files, single mention delivery, allowed users and consent replies");
  } finally {
    for (const id of consentIds) await resolveConsent(client, id, false, "U1");
    env.SLACK_ALLOWED_USER_IDS = initialUsers;
    env.SLACK_UNMENTIONED_CHANNEL_IDS = initialChannels;
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
