import type { WebClient } from "@slack/web-api";
import { createHash } from "node:crypto";
import { getContinuityStore, type Binding } from "../agent/continuityStore.js";
import { Session } from "../agent/session.js";
import { env } from "../config.js";
import { SlackStreamer } from "../slack/stream.js";
import { Heartbeat } from "../slack/heartbeat.js";
import { detectBangCommand } from "../slack/bangPrefix.js";
import { formatShellResultForSlack } from "../slack/shellExec.js";
import { isInterruptPhrase } from "../slack/interruptMatcher.js";
import { isEndSessionPhrase } from "../slack/endSessionMatcher.js";
import { detectRuntimeSwitch, detectRuntimeOpener } from "../slack/runtimeMatcher.js";
import { containerHelper } from "./docker.js";
import { ContainerRuntime } from "./runtime.js";
import { ALERT_USER, restrictedAccess, restrictedKey, sessionDirectory, containerName } from "./policy.js";
import type { SlackFileRef } from "../slack/download.js";

export type RestrictedMessage = { user: string; channel: string; ts: string; thread_ts?: string; text: string; files?: SlackFileRef[]; userMessageAt?: number };
type Entry = { runtime: ContainerRuntime; session: Session; tail: Promise<void>; queued: number; busy: boolean };
const entries = new Map<string, Entry>();
let draining = false;
const gatewayOperations = new Map<string, number>();
async function gatewaySlot<T>(user: string, work: () => Promise<T>): Promise<T> {
  const active = gatewayOperations.get(user) ?? 0;
  if (active >= 4) throw new Error("Four gateway transfers/posts are already pending for your container; retry when one completes");
  gatewayOperations.set(user, active + 1);
  try { return await work(); }
  finally { gatewayOperations.set(user, (gatewayOperations.get(user) ?? 1) - 1); }
}
function enqueue<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
  entry.queued++;
  const result = entry.tail.then(async () => { entry.busy = true; try { return await work(); } finally { entry.busy = false; entry.queued--; } });
  entry.tail = result.then(() => {}, () => {}); return result;
}
function getEntry(msg: RestrictedMessage): Entry {
  const key = restrictedKey(msg.user, msg.channel, msg.thread_ts ?? msg.ts);
  const existing = entries.get(key); if (existing) return existing;
  const store = getContinuityStore();
  let binding = store.get(key);
  if (binding && (binding.execution?.kind !== "docker" || binding.execution.user !== msg.user || binding.execution.container !== containerName(msg.user) || binding.execution.channel !== msg.channel || binding.execution.thread !== (msg.thread_ts ?? msg.ts))) throw new Error("Restricted session ownership mismatch");
  if (!binding || binding.state === "closed") {
    const opener = detectRuntimeOpener(msg.text);
    const runtime = opener?.runtime ?? env.DEFAULT_RUNTIME;
    binding = { key, runtime, workdir: sessionDirectory(key), providerHome: `/user/${runtime}`, sessionId: null, started: false, state: "ready",
      execution: { kind: "docker", user: msg.user, container: containerName(msg.user), channel: msg.channel, thread: msg.thread_ts ?? msg.ts } };
    store.put(binding);
  }
  const runtime = new ContainerRuntime(binding, store);
  const session = new Session({ threadKey: key, runtime }); session.attachContinuity(store, key);
  const entry: Entry = { runtime, session, tail: Promise.resolve(), queued: 0, busy: false };
  entries.set(key, entry); return entry;
}
function cleanText(text: unknown, max: number): string {
  if (typeof text !== "string" || text.length > max) throw new Error("Invalid gateway text"); return text;
}
async function gatewayRequest(client: WebClient, msg: RestrictedMessage, tool: string, args: Record<string, unknown>): Promise<string> {
  if (!restrictedAccess(msg.user, msg.channel)) throw new Error("Restricted channel access denied");
  const thread_ts = msg.thread_ts ?? msg.ts;
  if (tool === "notify_alan") {
    const details = cleanText(args.details, 4000).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    await client.chat.postMessage({ channel: msg.channel, thread_ts, text: `<@${ALERT_USER}> Sandbox alert for <@${msg.user}>: ${details}` }); return "Alan notified";
  }
  if (tool === "slack_post_message") {
    await client.chat.postMessage({ channel: msg.channel, thread_ts, text: cleanText(args.text, 38000) }); return "Posted";
  }
  if (tool === "slack_post_file") {
    const file = await containerHelper(msg.user, "files", { op: "get", workdir: cleanText(args.workdir, 4096), path: cleanText(args.path, 4096) });
    const bytes = Buffer.from(file.data, "base64");
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Output exceeds 20 MiB");
    await client.filesUploadV2({ channel_id: msg.channel, thread_ts, file: bytes, filename: String(file.name).replace(/[/\\]/g, "_"), title: args.title === undefined ? file.name : cleanText(args.title, 200) });
    return "Uploaded";
  }
  throw new Error("Gateway operation is not available to restricted sessions");
}
async function ingestFile(msg: RestrictedMessage, file: SlackFileRef): Promise<string> {
  const url = new URL(file.url_private_download ?? file.url_private ?? "");
  if (url.protocol !== "https:" || !["files.slack.com", "files-origin.slack.com"].includes(url.hostname)) throw new Error("Attachment URL is not a Slack file");
  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
  if (!response.ok || !response.body) throw new Error(`Attachment download failed (${response.status})`);
  const parts: Uint8Array[] = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 20 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error("Attachment exceeds 20 MiB"); } parts.push(part); }
  const name = (file.id + "-" + (file.name ?? "attachment")).replace(/[^A-Za-z0-9_.-]/g, "_");
  // Always ingest into the thread's own workspace, regardless of the agent's cwd.
  const result = await containerHelper(msg.user, "files", { op: "put", workdir: sessionDirectory(restrictedKey(msg.user, msg.channel, msg.thread_ts ?? msg.ts)), name, data: Buffer.concat(parts).toString("base64") });
  return sessionDirectory(restrictedKey(msg.user, msg.channel, msg.thread_ts ?? msg.ts)) + "/" + result.path;
}
export async function handleRestricted(client: WebClient, msg: RestrictedMessage): Promise<string | undefined> {
  if (!restrictedAccess(msg.user, msg.channel)) return;
  if (draining) throw new Error("Restricted sessions are draining");
  const key = restrictedKey(msg.user, msg.channel, msg.thread_ts ?? msg.ts);
  const store = getContinuityStore();
  const reply = async (text: string) => { await client.chat.postMessage({ channel: msg.channel, thread_ts: msg.thread_ts ?? msg.ts, text }); };
  if (isInterruptPhrase(msg.text)) { await reply(await entries.get(key)?.runtime.interrupt() ? "Interrupted your container session." : "Nothing is running in your container session."); return; }
  const current = entries.get(key);
  const switchTo = detectRuntimeSwitch(msg.text);
  if (isEndSessionPhrase(msg.text) || switchTo) {
    if (current?.queued) { await reply("Interrupt the active turn and wait for queued work before changing this session."); return; }
    if (current) current.runtime.onWake = () => {};
    await current?.runtime.close(); entries.delete(key);
    const old = store.get(key);
    if (old) store.end(key);
    if (switchTo) {
      const next: Binding = { key, runtime: switchTo, workdir: old?.workdir ?? sessionDirectory(key), providerHome: `/user/${switchTo}`, sessionId: null, started: false, state: "ready", execution: { kind: "docker", user: msg.user, container: containerName(msg.user), channel: msg.channel, thread: msg.thread_ts ?? msg.ts } };
      store.put(next);
    }
    await reply(switchTo ? `Your next message will use ${switchTo} inside your container.` : "Your session ended. The next message starts fresh inside your container."); return;
  }
  const entry = getEntry(msg);
  return enqueue(entry, async () => {
    const bang = detectBangCommand(msg.text);
    if (bang) {
      const result = await containerHelper(msg.user, "shell", { command: bang.command, cwd: entry.runtime.workdir });
      await reply(formatShellResultForSlack(bang.command, result, entry.runtime.workdir)); return;
    }
    const heartbeat = new Heartbeat({ client, channel: msg.channel, ts: msg.ts });
    const stream = new SlackStreamer(client, msg.channel, msg.thread_ts ?? msg.ts);
    await heartbeat.start(); await stream.open();
    let error: string | undefined;
    try {
      entry.runtime.onGateway = (tool, args) => gatewaySlot(msg.user, () => gatewayRequest(client, msg, tool, args));
      entry.runtime.onWake = (prompt, userMessageAt) => {
        if (draining) return;
        const id = `restricted-wake:${key}:${createHash("sha256").update(prompt).digest("hex")}`;
        const followup = { ...msg, text: prompt, files: undefined, userMessageAt: userMessageAt ?? 0 };
        if (!store.acceptDelivery(id, key, followup) || !store.claimDelivery(id)) return;
        void handleRestricted(client, followup).then(err => store.finishDelivery(id, err), e => store.finishDelivery(id, String(e)));
      };
      const attachments: string[] = [];
      for (const file of msg.files ?? []) attachments.push(await gatewaySlot(msg.user, () => ingestFile(msg, file)));
      const opener = !entry.runtime.conversationId ? detectRuntimeOpener(msg.text) : null;
      await entry.runtime.prepare();
      await entry.session.send({ text: opener?.prompt ?? msg.text, attachments, userMessageAt: msg.userMessageAt ?? Number(msg.ts) * 1000 }, {
        onText: text => stream.appendText(text), onFinal: text => stream.setText(text),
        onToolStart: (id, name) => stream.toolStart(id, name), onToolEnd: (id, ok) => stream.toolEnd(id, ok),
      });
      await stream.finalize();
    } catch (e) { error = e instanceof Error ? e.message : String(e); await stream.fail(e); }
    finally { await heartbeat.stop(error ? "error" : "success"); }
    return error;
  });
}
export async function drainRestricted(): Promise<void> {
  draining = true;
  await Promise.all([...entries.values()].map(e => e.tail));
  await Promise.all([...entries.values()].map(e => e.runtime.close()));
}
