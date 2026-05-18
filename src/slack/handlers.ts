import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { sessions, threadKeyOf } from "../agent/manager.js";
import { Heartbeat } from "./heartbeat.js";
import { SlackStreamer } from "./stream.js";
import { downloadFile, type SlackFileRef } from "./download.js";
import { buildSlackMcp } from "../agent/tools/slackPost.js";
import { buildCanUseTool } from "../agent/canUseTool.js";
import { tryResolveByReply } from "./consent.js";

type Common = {
  channel: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFileRef[];
};

export function registerHandlers(app: App) {
  app.event("message", async ({ event, client }) => {
    const e = event as Partial<Common> & { subtype?: string; bot_id?: string };
    if (e.subtype && e.subtype !== "file_share") return;
    if (e.bot_id) return;
    if (!e.channel || !e.ts || !e.user) return;
    // Allow empty text when files are attached
    if (!e.text && !(e.files && e.files.length > 0)) return;
    // If this is a thread reply to a pending consent prompt, consume it.
    if (e.thread_ts && e.text) {
      const consumed = await tryResolveByReply(client, e.channel, e.thread_ts, e.text, e.user);
      if (consumed) return;
    }
    await handleIncoming(client, {
      channel: e.channel,
      user: e.user,
      text: e.text ?? "",
      ts: e.ts,
      thread_ts: e.thread_ts,
      files: e.files,
    });
  });

  app.event("app_mention", async ({ event, client }) => {
    const e = event as typeof event & { files?: SlackFileRef[] };
    await handleIncoming(client, {
      channel: event.channel,
      user: event.user ?? "unknown",
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
      files: e.files,
    });
  });
}

const inFlight = new Set<string>();

async function handleIncoming(client: WebClient, msg: Common): Promise<void> {
  const dedupeKey = `${msg.channel}:${msg.ts}`;
  if (inFlight.has(dedupeKey)) return;
  inFlight.add(dedupeKey);

  const replyThreadTs = msg.thread_ts ?? msg.ts;
  const key = threadKeyOf(msg.channel, replyThreadTs);
  const entry = await sessions.get(key);

  await entry.enqueue(async () => {
    const heartbeat = new Heartbeat({ client, channel: msg.channel, ts: msg.ts });
    await heartbeat.start();

    const streamer = new SlackStreamer(client, msg.channel, replyThreadTs);
    await streamer.open();

    let outcome: "success" | "error" = "success";
    try {
      // Download any attachments into the per-thread workdir
      const attachments: string[] = [];
      if (msg.files && msg.files.length > 0) {
        for (const f of msg.files) {
          const rel = await downloadFile(f, entry.session.workdir);
          attachments.push(rel);
        }
      }

      // Wire per-thread MCP server + consent gate
      entry.session.setMcpServers({
        slack: buildSlackMcp({
          client,
          channel: msg.channel,
          threadTs: replyThreadTs,
          workdir: entry.session.workdir,
        }),
      });
      entry.session.setCanUseTool(
        buildCanUseTool({ client, channel: msg.channel, threadTs: replyThreadTs }),
      );

      await entry.session.send(
        { text: msg.text, attachments },
        {
          onText: (chunk) => streamer.appendText(chunk),
          onToolStart: (tool) => streamer.toolStart(tool),
          onToolEnd: (tool, ok) => streamer.toolEnd(tool, ok),
        },
      );
      await streamer.finalize();
    } catch (err) {
      outcome = "error";
      await streamer.fail(err);
    } finally {
      await heartbeat.stop(outcome);
      inFlight.delete(dedupeKey);
    }
  });
}
