import type { WebClient } from "@slack/web-api";
import { Heartbeat } from "../slack/heartbeat.js";
import { SlackStreamer } from "../slack/stream.js";
import { sessions, threadKeyOf } from "../agent/manager.js";
import { buildSlackMcp } from "../agent/tools/slackPost.js";
import { buildCronMcp } from "../agent/tools/cron.js";
import { buildWorkdirMcp } from "../agent/tools/workdir.js";
import { buildCanUseTool } from "../agent/canUseTool.js";
import type { CronEntry } from "./store.js";
import type { Scheduler } from "./scheduler.js";

/**
 * Fire handler: when a cron triggers, open a fresh thread in the target
 * channel, then run the stored prompt through the agent pipeline so it
 * behaves like a user-initiated conversation.
 */
export function makeRunner(client: WebClient, getScheduler: () => Scheduler) {
  return async (entry: CronEntry) => {
    const placeholder = await client.chat.postMessage({
      channel: entry.channel,
      text: `🕒 scheduled run: ${entry.description ?? entry.prompt.slice(0, 80)}`,
    });
    const ts = placeholder.ts;
    if (!ts) {
      console.error(`[cron] could not post placeholder for ${entry.id}`);
      return;
    }

    const threadTs = ts;
    const key = threadKeyOf(entry.channel, threadTs);
    const sessionEntry = await sessions.get(key);

    await sessionEntry.enqueue(async () => {
      const heartbeat = new Heartbeat({ client, channel: entry.channel, ts });
      await heartbeat.start();

      const streamer = new SlackStreamer(client, entry.channel, threadTs);
      await streamer.open();

      let outcome: "success" | "error" = "success";
      try {
        sessionEntry.session.setMcpServers({
          slack: buildSlackMcp({
            client,
            channel: entry.channel,
            threadTs,
            workdir: sessionEntry.session.workdir,
          }),
          cron: buildCronMcp({
            scheduler: getScheduler(),
            currentChannel: entry.channel,
            createdBy: `cron:${entry.id}`,
          }),
          workdir: buildWorkdirMcp({ session: sessionEntry.session, threadKey: key }),
        });
        sessionEntry.session.setCanUseTool(
          buildCanUseTool({ client, channel: entry.channel, threadTs }),
        );

        await sessionEntry.session.send(
          { text: entry.prompt },
          {
            onText: (chunk) => streamer.appendText(chunk),
            onToolStart: (id, name) => streamer.toolStart(id, name),
            onToolEnd: (id, ok) => streamer.toolEnd(id, ok),
            onFinal: (text) => streamer.setText(text),
          },
        );
        await streamer.finalize();
      } catch (err) {
        outcome = "error";
        await streamer.fail(err);
      } finally {
        await heartbeat.stop(outcome);
      }
    });
  };
}
