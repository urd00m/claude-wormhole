import assert from "node:assert/strict";
import { RESTRICTED_USERS, RESTRICTED_CHANNEL, restrictedAccess, restrictedKey, sessionDirectory, containerName } from "./policy.js";
import { env } from "../config.js";
import { isAllowedSlackUser } from "../slack/access.js";
import { registerHandlers } from "../slack/handlers.js";

for (const user of RESTRICTED_USERS) {
  assert(restrictedAccess(user, RESTRICTED_CHANNEL));
  for (const channel of ["DOTHER", "COTHER", undefined]) assert(!restrictedAccess(user, channel));
  assert(!isAllowedSlackUser(user));
  const saved = env.SLACK_ALLOWED_USER_IDS;
  env.SLACK_ALLOWED_USER_IDS = [user];
  assert(!isAllowedSlackUser(user), "restricted status must override accidental global grants");
  env.SLACK_ALLOWED_USER_IDS = saved;
}
assert.notEqual(containerName(RESTRICTED_USERS[0]), containerName(RESTRICTED_USERS[1]));
assert.notEqual(restrictedKey(RESTRICTED_USERS[0], RESTRICTED_CHANNEL, "1.2"), restrictedKey(RESTRICTED_USERS[1], RESTRICTED_CHANNEL, "1.2"));
assert.throws(() => restrictedKey(RESTRICTED_USERS[0], "COTHER", "1.2"));
assert.throws(() => restrictedKey(RESTRICTED_USERS[0], RESTRICTED_CHANNEL, "../../host"));
assert(sessionDirectory(restrictedKey(RESTRICTED_USERS[0], RESTRICTED_CHANNEL, "1.2")).startsWith("/user/sessions/"));
assert.throws(() => containerName("UUNKNOWN"));

const events = new Map<string, Function>(); let requests = 0;
registerHandlers({ event: (name: string, fn: Function) => events.set(name, fn) } as any, { allowed: () => true, run: async () => { requests++; return "unexpected"; } });
for (const user of RESTRICTED_USERS) {
  for (const name of ["message", "app_mention"]) for (const channel of ["DOTHER", "COTHER"]) {
    await events.get(name)!({ client: { chat: { postMessage: async () => { requests++; } } }, event: { channel, channel_type: "im", user, ts: "1.2", text: "!pwd" } });
  }
}
assert.equal(requests, 0, "restricted users must be denied before watchdog or host command paths, even when another grant exists");
console.log("✅ Restricted identity: channel-only, isolated session keys, global-grant precedence, both Slack event paths");
