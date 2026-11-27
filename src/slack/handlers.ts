import { isRestrictedUser, restrictedAccess, restrictedKey } from "../restricted/policy.js";
import { handleRestricted } from "../restricted/handler.js";
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
import { buildConfigMcp } from "../agent/tools/config.js";
import { buildCanUseTool } from "../agent/canUseTool.js";
import { tryResolveByReply } from "./consent.js";
import { buildTaskEventPoster } from "./taskEvents.js";
import { withCompletionWake } from "./completionWake.js";
import { markActive, unmarkActive } from "./activeMarker.js";
import { isEndSessionPhrase } from "./endSessionMatcher.js";
import { isInterruptPhrase } from "./interruptMatcher.js";
import { detectRuntimeSwitch, detectRuntimeOpener } from "./runtimeMatcher.js";
import { getRuntimeStore } from "../agent/runtimeStore.js";
import { resolveRuntimeName } from "../agent/manager.js";
import { getResidentWorkerRegistry } from "../agent/residentWorkerRegistry.js";
import { expandMacros, getMacroStore } from "../agent/macroStore.js";
import { parseAliasInvocation, getAliasStore, getActiveAliasStore } from "../agent/aliasStore.js";
import { getWorkdirStore, resolveWorkdir } from "../agent/workdirStore.js";
import { detectBangCommand } from "./bangPrefix.js";
import { shellExec, formatShellResultForSlack } from "./shellExec.js";
import os from "node:os";
import { detectCavemanAction } from "./cavemanMatcher.js";
import { getCavemanStore } from "../agent/cavemanStore.js";
import { formatContextFooter } from "./contextIndicator.js";
import { getUsageStore } from "../usageStore.js";
import { env } from "../config.js";
import { isAllowedSlackUser } from "./access.js";
import { parseWatchdogCommand, watchdogRoute, type WatchdogRoute } from "./watchdog.js";
import type { Scheduler } from "../scheduler/scheduler.js";
import { getContinuityStore } from "../agent/continuityStore.js";
import { createHash } from "node:crypto";

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

export function registerHandlers(app: App, watchdog: WatchdogRoute = watchdogRoute) {
  const durable = getContinuityStore();
  let activeDispatches = 0;
  const idleWaiters: (() => void)[] = [];
  // Slack can deliver both message and app_mention for the same post.
  // Remember completed posts too, since the second event may arrive later.
  const acceptedMessages = new Map<string, number>();
  async function dispatch(client: WebClient, msg: Common, replayId?: string) {
    if (isRestrictedUser(msg.user) && !restrictedAccess(msg.user, msg.channel)) return;
    const now = Date.now();
    for (const [key, expires] of acceptedMessages) {
      if (expires > now) break;
      acceptedMessages.delete(key);
    }
    const key = replayId ?? `${msg.channel}:${msg.ts}`;
    if (acceptedMessages.has(key)) return;
    const sessionKey = isRestrictedUser(msg.user) ? restrictedKey(msg.user, msg.channel, msg.thread_ts ?? msg.ts) : threadKeyOf(msg.channel, msg.thread_ts ?? msg.ts);
    if (!replayId && !durable.acceptDelivery(key, sessionKey, msg)) return;
    if (sessions.isDraining) return; // Stored before acknowledging; next process can dispatch it.
    if (!durable.claimDelivery(key)) return;
    activeDispatches++;
    if (acceptedMessages.size >= 10_000) {
      acceptedMessages.delete(acceptedMessages.keys().next().value!);
    }
    acceptedMessages.set(key, now + 5 * 60_000);
    try {
      if (isRestrictedUser(msg.user)) {
        const error = await handleRestricted(client, msg);
        durable.finishDelivery(key, error);
        return;
      }
      const report = parseWatchdogCommand(msg.text);
      if (report) {
        if (!watchdog.allowed(msg.user)) return;
        const output = report.error ?? await watchdog.run(report.args);
        await client.chat.postMessage({
          channel: msg.channel,
          thread_ts: msg.thread_ts ?? msg.ts,
          text: "```\n" + output.replace(/```/g, "`\u200b``") + "\n```",
        });
        return;
      }
      // Report-only users cannot enter consent, shell, control, or agent paths.
      if (!isAllowedSlackUser(msg.user)) return;
      if (msg.thread_ts && msg.text) {
        const consentText = msg.text.replace(/^\s*<@[^>]+>\s*/, "");
        if (await tryResolveByReply(client, msg.channel, msg.thread_ts, consentText, msg.user)) return;
      }
      const deliveryError = await handleIncoming(client, msg);
      durable.finishDelivery(key, deliveryError);
    } catch (error) {
      acceptedMessages.delete(key);
      durable.finishDelivery(key, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      durable.finishDelivery(key); // Also completes control/report-only early returns.
      activeDispatches--;
      if (activeDispatches === 0) idleWaiters.splice(0).forEach((resolve) => resolve());
    }
  }

  app.event("message", async ({ event, client, context }) => {
    const e = event as Partial<Common> & { subtype?: string; bot_id?: string; channel_type?: string };
    if (e.subtype && e.subtype !== "file_share") return;
    if (e.bot_id) return;
    if (!e.channel || !e.ts || !e.user) return;
    if (isRestrictedUser(e.user) ? !restrictedAccess(e.user, e.channel) : !isAllowedSlackUser(e.user) && !watchdog.allowed(e.user)) return;
    // Recognize our exact mention from message events as well, so channels
    // work even when the installed token lacks app_mentions:read.
    const isDirectMessage = e.channel_type === "im" || e.channel_type === "mpim" || e.channel.startsWith("D");
    const mentionsBot = !!context?.botUserId && !!e.text?.includes(`<@${context.botUserId}>`);
    if (!isDirectMessage && !restrictedAccess(e.user, e.channel) && !env.SLACK_UNMENTIONED_CHANNEL_IDS.includes(e.channel) && !mentionsBot) return;
    // Allow empty text when files are attached
    if (!e.text && !(e.files && e.files.length > 0)) return;
    await dispatch(client, {
      channel: e.channel,
      user: e.user,
      text: e.text ?? "",
      ts: e.ts,
      thread_ts: e.thread_ts,
      files: e.files,
    });
  });

  app.event("app_mention", async ({ event, client }) => {
    if (isRestrictedUser(event.user) ? !restrictedAccess(event.user, event.channel) : !isAllowedSlackUser(event.user) && !watchdog.allowed(event.user)) return;
    const e = event as typeof event & { files?: SlackFileRef[] };
    await dispatch(client, {
      channel: event.channel,
      user: event.user ?? "unknown",
      text: event.text,
      ts: event.ts,
      thread_ts: event.thread_ts,
      files: e.files,
    });
  });

  return {
    waitForIdle: (): Promise<void> => activeDispatches === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve)),
    replayPending: async (client: WebClient): Promise<void> => {
      for (const delivery of durable.deliveries("queued")) {
        const binding = durable.get(delivery.thread_key);
        if (binding?.state === "stopped" || binding?.state === "recovery_required") continue;
        const msg = JSON.parse(delivery.payload) as Common;
        if (isRestrictedUser(msg.user) ? !restrictedAccess(msg.user, msg.channel) : !isAllowedSlackUser(msg.user)) continue;
        await dispatch(client, msg, delivery.id);
      }
    },
  };
}

const inFlight = new Set<string>();

async function handleIncoming(client: WebClient, msg: Common): Promise<string | undefined> {
  const dedupeKey = `${msg.channel}:${msg.ts}`;
  if (inFlight.has(dedupeKey)) return;
  inFlight.add(dedupeKey);

  const replyThreadTs = msg.thread_ts ?? msg.ts;
  const key = threadKeyOf(msg.channel, replyThreadTs);

  // `!`-prefix shell passthrough. Runs the rest of the message verbatim
  // through `bash -lc` in the thread's workdir (or $HOME if unset), with
  // a 60s timeout and 32 KB output cap, posts the result back as a code
  // block. Bypasses the agent entirely — no MCP, no canUseTool, no
  // session creation. Checked FIRST so `!end session` is a literal
  // command, not the end-session control phrase.
  const bang = detectBangCommand(msg.text);
  if (bang) {
    inFlight.delete(dedupeKey);
    const workdir = getWorkdirStore().get(key) ?? os.homedir();
    const result = await shellExec(bang.command, { cwd: workdir });
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: replyThreadTs,
      text: formatShellResultForSlack(bang.command, result, workdir),
    });
    return;
  }

  // Control phrase: "ctrl+c" — interrupt the thread's in-flight turn, like
  // ctrl+c in a terminal. Deliberately BYPASSES the per-thread queue (an
  // enqueued interrupt would only run AFTER the very turn it's meant to
  // stop) and uses sessions.peek so it never creates a session. The
  // interrupted turn settles through its normal path: partial text stays
  // in the streamed message, and its heartbeat/streamer cleanup still runs.
  if (isInterruptPhrase(msg.text)) {
    inFlight.delete(dedupeKey);
    const entry = sessions.peek(key);
    if (!entry || !entry.busy) {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: replyThreadTs,
        text: "Nothing is running in this thread — nothing to interrupt.",
      });
      return;
    }
    const sent = await entry.session.interrupt();
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: replyThreadTs,
      text: sent
        ? ":octagonal_sign: Interrupt sent — stopping the current action."
        : "Couldn't interrupt — the turn may already be finishing. If it's stuck, `end session` tears it down.",
    });
    return;
  }

  // Control phrase: caveman compression toggle. Global (bot-wide) state;
  // applies to ALL threads on their next message. Existing resident
  // workers keep their startup level until kill+recreate — we flag any
  // alive at toggle time. Checked before end-session so `caveman off`
  // doesn't accidentally hit the end-session matcher.
  const cavemanAction = detectCavemanAction(msg.text);
  if (cavemanAction) {
    inFlight.delete(dedupeKey);
    const store = getCavemanStore();
    if (cavemanAction.kind === "status") {
      const level = store.get();
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: replyThreadTs,
        text: `Caveman: \`${level}\` (global).`,
      });
      return;
    }
    const newLevel = cavemanAction.level;
    store.set(newLevel);
    const residentCount = getResidentWorkerRegistry().size();
    const note =
      residentCount > 0
        ? ` Note: ${residentCount} existing resident worker(s) will keep their prior level until you kill + re-spawn them.`
        : "";
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: replyThreadTs,
      text:
        newLevel === "off"
          ? `Caveman off (global).${note}`
          : `Caveman set to \`${newLevel}\` (global). Applies to all threads + new sub-agents on their next message.${note}`,
    });
    return;
  }

  // Control phrase: explicit end-session. Short-circuits BEFORE sessions.get
  // so we never spin up (and then have to tear down) a fresh session — and
  // never race a just-added :satellite_antenna: against its own removal.
  if (isEndSessionPhrase(msg.text)) {
    inFlight.delete(dedupeKey);
    const had = sessions.end(key);
    // Ending the session also kills any resident sub-agent workers owned by
    // this thread — they're scoped to it and shouldn't outlive it.
    const killedWorkers = getResidentWorkerRegistry().killAllForThread(key);
    // Always clear the reaction — it can persist in Slack even when there's
    // no in-memory session (e.g. after a bot restart where the index was
    // already wiped but the Slack reaction removal failed transiently).
    await unmarkActive(client, msg.channel, replyThreadTs);
    const workerNote = killedWorkers > 0 ? ` (${killedWorkers} resident worker(s) killed)` : "";
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: replyThreadTs,
      text: had
        ? `Session ended${workerNote}. The next message in this thread will start a fresh one.`
        : `No active session in this thread (reaction cleared if present)${workerNote}.`,
    });
    return;
  }

  // Control phrase: runtime switch ("switch to codex", "use claude", etc).
  // Same short-circuit pattern as end-session: tear down the existing
  // in-memory session (so it doesn't keep streaming to Slack under the old
  // runtime), persist the new choice to data/runtimes.json, and let the
  // user's NEXT message spin up a session under the new runtime.
  //
  // Done before sessions.get to avoid the wasteful create-then-close that
  // would otherwise happen, and to keep the active-marker reaction in
  // sync (markActive only fires for newly-created sessions).
  const switchTo = detectRuntimeSwitch(msg.text);
  if (switchTo) {
    inFlight.delete(dedupeKey);
    const current = resolveRuntimeName(key);
    if (current === switchTo) {
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: replyThreadTs,
        text: `This thread is already on the \`${switchTo}\` runtime. Nothing changed.`,
      });
      return;
    }
    sessions.end(key);
    await unmarkActive(client, msg.channel, replyThreadTs);
    getActiveAliasStore().remove(key);
    getRuntimeStore().set(key, switchTo);
    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: replyThreadTs,
      text: `Runtime for this thread switched to \`${switchTo}\`. Your next message will run under it.`,
    });
    return;
  }

  // Runtime-opener prefix: "codex> <prompt>" or "claude> <prompt>".
  // Sets the runtime for this thread AND immediately runs the prompt —
  // one message to open a thread in a non-default runtime. Only fires
  // when no session exists yet (new thread), so it doesn't collide with
  // mid-conversation prose that happens to start with "codex:".
  if (!sessions.has(key)) {
    const opener = detectRuntimeOpener(msg.text);
    if (opener) {
      getRuntimeStore().set(key, opener.runtime);
      msg.text = opener.prompt;
      // Fall through to sessions.get() which will create a session
      // under the newly-set runtime override.
    }
  }

  // Launch-alias trigger: `<alias> [workdir] [prompt]`. If the first token
  // is a known alias, point this thread's session at that alias's runtime +
  // launch config, optionally in the given workdir, then run the (expanded)
  // prompt. Checked before generic macro expansion because the alias token
  // is a command, not prose — but the workdir arg + prompt ARE macro-expanded.
  const macros = getMacroStore().all();
  const aliasNames = new Set(getAliasStore().names());
  const aliasInvocation =
    aliasNames.size > 0 ? parseAliasInvocation(msg.text, aliasNames) : null;
  if (aliasInvocation) {
    // Optional workdir arg → macro-expand, validate, persist as the thread
    // override so the rebuilt session launches there (loads CLAUDE.md/AGENTS.md).
    let workdirNote = "";
    let nextWorkdir: string | undefined;
    if (aliasInvocation.workdirArg) {
      const expandedWd = expandMacros(aliasInvocation.workdirArg, macros).trim();
      try {
        const resolved = resolveWorkdir(expandedWd);
        nextWorkdir = resolved;
        workdirNote = ` in \`${resolved}\``;
      } catch (err) {
        inFlight.delete(dedupeKey);
        const m = err instanceof Error ? err.message : String(err);
        await client.chat.postMessage({
          channel: msg.channel,
          thread_ts: replyThreadTs,
          text: `Alias \`${aliasInvocation.alias}\`: invalid working directory — ${m}`,
        });
        return;
      }
    }
    // Pin the alias for the thread and tear down any existing session so the
    // next build picks up the alias's runtime + config + workdir.
    sessions.end(key);
    if (nextWorkdir) getWorkdirStore().set(key, nextWorkdir);
    getActiveAliasStore().set(key, aliasInvocation.alias);

    const expandedPrompt = expandMacros(aliasInvocation.prompt, macros);
    if (expandedPrompt.trim().length === 0) {
      // Bare launch — no prompt to run this turn.
      inFlight.delete(dedupeKey);
      await unmarkActive(client, msg.channel, replyThreadTs);
      await client.chat.postMessage({
        channel: msg.channel,
        thread_ts: replyThreadTs,
        text: `Launched \`${aliasInvocation.alias}\`${workdirNote}. Your next message will run under it.`,
      });
      return;
    }
    // Run the prompt this turn under the freshly-pinned alias.
    msg.text = expandedPrompt;
  } else {
    // User-defined macro expansion. Reserved control phrases above are
    // matched on the RAW text and win; everything else has its macro tokens
    // expanded here (pure text substitution) before the agent sees it.
    msg.text = expandMacros(msg.text, macros);
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

  let deliveryError: string | undefined;
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

      // Completion-wake (slack/completionWake.ts): a background task that
      // finishes while this session is idle must re-invoke the agent, not just
      // post a Slack message. `wakePoster` is assigned below (it needs
      // runWakeTurn, which needs the MCP servers), so the spawn MCP routes its
      // task events through a late-bound forwarder — wake then also covers
      // tasks spawned during this turn.
      let wakePoster = taskEventPoster;

      const mcpServers: Record<string, ReturnType<typeof buildSlackMcp>> = {
        slack: buildSlackMcp(slackCtx),
        workdir: buildWorkdirMcp({ session: entry.session, threadKey: key }),
        // spawn MCP — workaround for the CLI's hardcoded Agent/Task strip
        // on sub-agents. Workers spawned via this tool get the full
        // surface (including a recursive spawn MCP one level deeper).
        spawn: buildSpawnMcp({
          workdir: entry.session.workdir,
          depth: 0,
          threadKey: key,
          buildSlackMcp: () => buildSlackMcp(slackCtx),
          buildCanUseTool: () => buildCanUseTool(canUseToolCtx),
          onTaskEvent: (event) => wakePoster(event),
        }),
        // macro/alias management — lets the user add macros/aliases by
        // asking the bot, instead of hand-editing data/*.json.
        config: buildConfigMcp(),
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

      // One agent turn carrying a synthetic prompt — used to auto-wake the
      // agent on an idle background-task completion. Mirrors the human-message
      // turn below: fresh streamer, the same MCP servers, send(), finalize.
      const runWakeTurn = async (prompt: string): Promise<void> => {
        const durable = getContinuityStore();
        const id = `wake:${key}:${createHash("sha256").update(prompt).digest("hex")}`;
        if (!durable.acceptDelivery(id, key, { ...msg, text: prompt, files: undefined })) return;
        if (sessions.isDraining) return;
        try {
          durable.assertRunnable(key, Number(msg.ts) * 1000);
        } catch (error) {
          if (durable.claimDelivery(id)) durable.finishDelivery(id, error instanceof Error ? error.message : String(error));
          return;
        }
        if (!durable.claimDelivery(id)) return;
        await entry.enqueue(async () => {
          const wakeStreamer = new SlackStreamer(client, msg.channel, replyThreadTs);
          await wakeStreamer.open();
          try {
            await entry.session.send(
              { text: prompt, userMessageAt: Number(msg.ts) * 1000 },
              {
                onText: (chunk) => wakeStreamer.appendText(chunk),
                onToolStart: (id, name) => wakeStreamer.toolStart(id, name),
                onToolEnd: (id, ok) => wakeStreamer.toolEnd(id, ok),
                onFinal: (text) => wakeStreamer.setText(text),
                onTaskEvent: (event) => wakePoster(event),
              },
            );
            durable.finishDelivery(id);
            await wakeStreamer.finalize();
          } catch (error) {
            durable.finishDelivery(id, error instanceof Error ? error.message : String(error));
            await wakeStreamer.fail(error);
            throw error;
          }
        });
      };

      wakePoster = withCompletionWake(taskEventPoster, entry.session, runWakeTurn);

      await entry.session.send(
        { text: msg.text, attachments, userMessageAt: Number(msg.ts) * 1000 },
        {
          onText: (chunk) => streamer.appendText(chunk),
          onToolStart: (id, name) => streamer.toolStart(id, name),
          onToolEnd: (id, ok) => streamer.toolEnd(id, ok),
          // Replace the streamed buffer with the SDK's canonical final text.
          // This is the authoritative response and works even if no token
          // deltas were emitted.
          onFinal: (text) => streamer.setText(text),
          onTaskEvent: wakePoster,
        },
      );

      // Per-session context + usage footer (Claude threads only). Built from
      // the in-process usage snapshot (no transcript read), so it renders on
      // every turn. Appended after the canonical final text (onFinal above)
      // so it rides the same finalize() flush.
      //
      // For 5h/weekly %, the SDK's rate_limit_event is unreliable (server
      // omits utilization at low usage). We overlay the usage-cache snapshot
      // from scripts/fetch-usage.sh when present — it polls the same
      // /api/oauth/usage the CLI uses, so the numbers always populate once
      // the script has run. maybeRefresh() also kicks off a background
      // refresh when the cache is stale; we never block on it.
      if (env.CONTEXT_INDICATOR === "on") {
        const usage = entry.session.usageSnapshot();
        if (usage) {
          const cache = getUsageStore().maybeRefresh();
          const overlaid =
            cache && cache.status === "ok"
              ? {
                  ...usage,
                  fiveHourPct: cache.fiveHourPct ?? usage.fiveHourPct,
                  weeklyPct: cache.weeklyPct ?? usage.weeklyPct,
                }
              : usage;
          const footer = formatContextFooter(overlaid, env.CONTEXT_WINDOW_TOKENS);
          if (footer) streamer.appendText(`\n\n${footer}`);
        }
      }

      await streamer.finalize();
    } catch (err) {
      outcome = "error";
      deliveryError = err instanceof Error ? err.message : String(err);
      await streamer.fail(err);
    } finally {
      await heartbeat.stop(outcome);
      inFlight.delete(dedupeKey);
    }
  });
  return deliveryError;
}
