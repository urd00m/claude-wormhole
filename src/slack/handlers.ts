import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { sessions, threadKeyOf } from "../agent/manager.js";
import { Heartbeat } from "./heartbeat.js";
import { SlackStreamer } from "./stream.js";
import { downloadFile, type SlackFileRef } from "./download.js";
import { buildSlackMcp } from "../agent/tools/slackPost.js";
import { buildCronMcp } from "../agent/tools/cron.js";
import { buildWorkdirMcp } from "../agent/tools/workdir.js";
import { buildSpawnMcp } from "../agent/tools/spawn.js";
import { buildCanUseTool } from "../agent/canUseTool.js";
import { tryResolveByReply } from "./consent.js";
import { buildTaskEventPoster } from "./taskEvents.js";
import { markActive, unmarkActive } from "./activeMarker.js";
import { isEndSessionPhrase } from "./endSessionMatcher.js";
import type { Scheduler } from "../scheduler/scheduler.js";

let _scheduler: Scheduler | null = null;
export function setSchedulerForHandlers(s: Scheduler): void {
  _scheduler = s;
}

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

  // Control phrase: explicit end-session. Short-circuits BEFORE sessions.get
  // so we never spin up (and then have to tear down) a fresh session — and
  // never race a just-added :satellite_antenna: against its own removal.
  if (isEndSessionPhrase(msg.text)) {
    inFlight.delete(dedupeKey);
    const had = sessions.close(key);
    // Always clear the reaction — it can persist in Slack even when there's
    // no in-memory session (e.g. after a bot restart where the index was
    // already wiped but the Slack reaction removal failed transiently).
    await unmarkActive(client, msg.channel, replyThreadTs);
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: replyThreadTs,
      text: had
        ? "Session ended. The next message in this thread will start a fresh one."
        : "No active session in this thread (reaction cleared if present).",
    });
    return;
  }

  let entry: Awaited<ReturnType<typeof sessions.get>>["entry"];
  let created: boolean;
  try {
    ({ entry, created } = await sessions.get(key));
  } catch (err) {
    // If session creation throws (e.g. disk full, EACCES on mkdir), the
    // enqueue's finally — which is normally responsible for clearing
    // dedupeKey — never runs. Without this catch the key stays in
    // `inFlight` forever and every Slack retry of this same event ts is
    // silently dropped.
    inFlight.delete(dedupeKey);
    throw err;
  }
  if (created) {
    void markActive(client, msg.channel, replyThreadTs);
  }

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

      // Wire per-thread MCP servers + consent gate
      const taskEventPoster = buildTaskEventPoster(client, msg.channel, replyThreadTs);
      const slackCtx = {
        client,
        channel: msg.channel,
        threadTs: replyThreadTs,
        workdir: entry.session.workdir,
      };
      const canUseToolCtx = { client, channel: msg.channel, threadTs: replyThreadTs };

      const mcpServers: Record<string, ReturnType<typeof buildSlackMcp>> = {
        slack: buildSlackMcp(slackCtx),
        workdir: buildWorkdirMcp({ session: entry.session, threadKey: key }),
        // spawn MCP — workaround for the CLI's hardcoded Agent/Task strip
        // on sub-agents. Workers spawned via this tool get the full
        // surface (including a recursive spawn MCP one level deeper).
        spawn: buildSpawnMcp({
          workdir: entry.session.workdir,
          depth: 0,
          buildSlackMcp: () => buildSlackMcp(slackCtx),
          buildCanUseTool: () => buildCanUseTool(canUseToolCtx),
          onTaskEvent: taskEventPoster,
        }),
      };
      if (_scheduler) {
        mcpServers.cron = buildCronMcp({
          scheduler: _scheduler,
          currentChannel: msg.channel,
          createdBy: msg.user,
        });
      }
      entry.session.setMcpServers(mcpServers);
      entry.session.setCanUseTool(buildCanUseTool(canUseToolCtx));

      await entry.session.send(
        { text: msg.text, attachments },
        {
          onText: (chunk) => streamer.appendText(chunk),
          onToolStart: (id, name) => streamer.toolStart(id, name),
          onToolEnd: (id, ok) => streamer.toolEnd(id, ok),
          // Replace the streamed buffer with the SDK's canonical final text.
          // This is the authoritative response and works even if no token
          // deltas were emitted.
          onFinal: (text) => streamer.setText(text),
          onTaskEvent: taskEventPoster,
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
