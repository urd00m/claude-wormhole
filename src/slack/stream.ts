import type { WebClient } from "@slack/web-api";
import { toMrkdwn } from "./formatter.js";

const MIN_EDIT_INTERVAL_MS = 1000;
const PLACEHOLDER = "_thinking…_";
// CRITICAL: Slack's two write methods have very different `text` limits:
//   - chat.postMessage accepts up to 40,000 chars (truncates above that).
//   - chat.update accepts only ~4,000 chars and ERRORS ("msg_too_long")
//     above it — verified empirically against the live API.
// The streamer EDITS its messages with chat.update on every flush (the first
// message and every continuation), so EVERY part must stay under the 4k
// update limit, not the 40k post limit. Using 38k here was the real
// "long messages get cut off" bug: once a reply passed ~4k, every chat.update
// was rejected, the error was swallowed, and the message froze at its last
// successful sub-4k state. Cap at 3,800 to leave headroom for the
// tools-status line and the ```fence``` reopen prefix/suffix splitForSlack
// injects across boundaries (≈30 chars), keeping each part safely < 4,000.
// (postSlackMessage / the slack_post_message MCP tool use chat.postMessage,
// so their separate 38k cap is correct and stays as-is.)
const MAX_PART_CHARS = 3800;

type ToolStatus = "running" | "ok" | "err";
type ToolCall = { id: string; name: string; status: ToolStatus };

/**
 * Streams an assistant reply into Slack, throttled to one chat.update per
 * second (Slack tier-3 cap is ~50/min/channel).
 *
 * For long replies that exceed Slack's per-message ceiling, the streamer
 * automatically spans multiple thread messages, preserving code fences across
 * splits so the reader never sees a truncated answer.
 *
 * Layout (first message):
 *   _✅ Bash · ✅ Read · 🔧 Edit_   ← single collapsed status line (if any tool calls)
 *
 *   <agent's actual text here>
 *
 * Tool calls are keyed by tool_use_id so completions update the right entry
 * even when many tools run in parallel.
 */
export class SlackStreamer {
  private readonly client: WebClient;
  private readonly channel: string;
  private readonly threadTs: string;

  private readonly messageTsList: string[] = [];
  private textBuffer = "";
  private readonly toolsByOrder: ToolCall[] = [];
  private readonly toolsById = new Map<string, ToolCall>();
  private lastEditAt = 0;
  private pendingTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private flushing = false;
  private flushAgain = false;
  /**
   * Tracks the currently-running flush so `finalize` can await it (and the
   * follow-up flush triggered by `flushAgain`) before declaring the stream
   * closed. Without this, the final `setText` issued by `onFinal` could be
   * lost when its `flushAgain` got dropped by the do-while's `!this.closed`
   * gate firing on a closed-during-flush state.
   */
  private currentFlush: Promise<void> | null = null;

  constructor(client: WebClient, channel: string, threadTs: string) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
  }

  async open(): Promise<void> {
    const res = await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: PLACEHOLDER,
    });
    if (res.ts) this.messageTsList.push(res.ts);
  }

  appendText(chunk: string): void {
    this.textBuffer += chunk;
    this.scheduleFlush();
  }

  /** Replace the entire buffered text with the canonical final response. */
  setText(text: string): void {
    this.textBuffer = text;
    this.scheduleFlush();
  }

  toolStart(id: string, name: string): void {
    if (this.toolsById.has(id)) return;
    const call: ToolCall = { id, name, status: "running" };
    this.toolsById.set(id, call);
    this.toolsByOrder.push(call);
    this.scheduleFlush();
  }

  toolEnd(id: string, ok: boolean): void {
    const call = this.toolsById.get(id);
    if (call) {
      call.status = ok ? "ok" : "err";
    } else {
      const placeholder: ToolCall = { id, name: "?", status: ok ? "ok" : "err" };
      this.toolsById.set(id, placeholder);
      this.toolsByOrder.push(placeholder);
    }
    this.scheduleFlush();
  }

  async finalize(): Promise<void> {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    // Drain any in-flight flush BEFORE marking closed. If a flush is in
    // progress and `setText`/`appendText` ran while it was awaiting (e.g.
    // the SDK's onFinal hook firing during an in-flight chat.update), the
    // queued `flushAgain` would be silently dropped by the do-while gate
    // once `closed` flips true — causing the final buffer to never reach
    // Slack and the user to see only an earlier, shorter version of the
    // reply (which reads as "long messages cut off").
    while (this.currentFlush) {
      const cur = this.currentFlush;
      await cur;
      // If a new flush was scheduled while we awaited (cur was reassigned),
      // loop and await that one too.
      if (this.currentFlush === cur) break;
    }
    // Now do one final flush of the latest buffer state. This catches any
    // setText that landed AFTER the last flushOnce captured render().
    await this.flushNow();
    this.closed = true;
  }

  async fail(err: unknown): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (this.messageTsList.length === 0) return;
    const msg = err instanceof Error ? err.message : String(err);
    // Split the error text the same way normal output is split — stack
    // traces and SDK error bodies can run past Slack's 40k cap and would
    // otherwise be silently truncated by the API.
    const text = `:warning: ${msg}`;
    const parts = splitForSlack(text, MAX_PART_CHARS);
    for (let i = 0; i < parts.length; i++) {
      try {
        if (i < this.messageTsList.length) {
          await this.client.chat.update({
            channel: this.channel,
            ts: this.messageTsList[i],
            text: parts[i],
          });
        } else {
          const res = await this.client.chat.postMessage({
            channel: this.channel,
            thread_ts: this.threadTs,
            text: parts[i],
          });
          if (res.ts) this.messageTsList.push(res.ts);
        }
      } catch {
        /* best-effort */
      }
    }
  }

  private renderToolsLine(): string {
    if (this.toolsByOrder.length === 0) return "";
    const parts = this.toolsByOrder.map((c) => `${iconFor(c.status)} ${c.name}`);
    return `_${parts.join(" · ")}_`;
  }

  private render(): string {
    const tools = this.renderToolsLine();
    const body = toMrkdwn(this.textBuffer);
    const parts = [tools, body].filter(Boolean);
    return parts.join("\n\n") || PLACEHOLDER;
  }

  private scheduleFlush(): void {
    if (this.closed) return;
    const now = Date.now();
    const since = now - this.lastEditAt;
    if (since >= MIN_EDIT_INTERVAL_MS) {
      void this.flushNow();
      return;
    }
    if (this.pendingTimer) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flushNow();
    }, MIN_EDIT_INTERVAL_MS - since);
  }

  private async flushNow(): Promise<void> {
    if (this.messageTsList.length === 0) return;
    // Serialize concurrent flushes so we don't double-post continuation
    // messages while the previous flush is still awaiting postMessage. A
    // newer scheduleFlush during an in-flight flush sets flushAgain so the
    // current flusher loops once it returns from chat.update/postMessage.
    if (this.flushing) {
      this.flushAgain = true;
      // Surface the in-flight flush so finalize can await it.
      if (this.currentFlush) await this.currentFlush;
      return;
    }
    this.flushing = true;
    const work = (async () => {
      try {
        do {
          this.flushAgain = false;
          await this.flushOnce();
          // NOTE: previously this gated on `!this.closed`, which dropped a
          // flushAgain set during the final in-flight flush — finalize's
          // setText would never reach Slack. closed is now flipped after
          // finalize has drained everything, so the bare flushAgain check
          // is sufficient.
        } while (this.flushAgain);
      } finally {
        this.flushing = false;
        this.currentFlush = null;
      }
    })();
    this.currentFlush = work;
    await work;
  }

  private async flushOnce(): Promise<void> {
    const text = this.render();
    const parts = splitForSlack(text, MAX_PART_CHARS);
    this.lastEditAt = Date.now();

    for (let i = 0; i < parts.length; i++) {
      const partText = parts[i];
      if (i < this.messageTsList.length) {
        try {
          await this.client.chat.update({
            channel: this.channel,
            ts: this.messageTsList[i],
            text: partText,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[stream] chat.update failed: ${msg}`);
        }
      } else {
        try {
          const res = await this.client.chat.postMessage({
            channel: this.channel,
            thread_ts: this.threadTs,
            text: partText,
          });
          if (res.ts) this.messageTsList.push(res.ts);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[stream] chat.postMessage (continuation) failed: ${msg}`);
        }
      }
    }
  }
}

/**
 * Split text into Slack-message-sized chunks, preserving code fences across
 * boundaries. If we cut while inside a fenced code block, we close the fence
 * at the end of the chunk and reopen it at the start of the next.
 *
 * Boundary preference: blank line > newline > word boundary (space) > hard
 * cut. The word-boundary step keeps the splitter from slicing through the
 * middle of a word at the size cap (e.g. "…banner l" | "ines…"); it only
 * falls back to a mid-token hard cut when there's no space in the back half
 * of the window (a single unbroken run longer than maxChars/2).
 */
export function splitForSlack(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const parts: string[] = [];
  let remaining = text;
  let openFenceLang = ""; // empty = not inside a fence

  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const half = Math.floor(maxChars / 2);
    // "nl" = cut at a line break (blank line or newline); "space" = cut at a
    // word boundary; "hard" = mid-token cut (last resort). The kind decides
    // which leading separator to drop from the continuation below.
    let cut = window.lastIndexOf("\n\n");
    let cutKind: "nl" | "space" | "hard" = "nl";
    if (cut < half) cut = window.lastIndexOf("\n");
    if (cut < half) {
      const sp = window.lastIndexOf(" ");
      if (sp >= half) {
        cut = sp;
        cutKind = "space";
      } else {
        cut = maxChars;
        cutKind = "hard";
      }
    }

    const chunk = remaining.slice(0, cut);
    // Drop the boundary separator so it doesn't surface as leading whitespace
    // on the next chunk: line breaks for an "nl" cut, the single space for a
    // word break. A hard mid-token cut keeps every character (lossless).
    const rest =
      cutKind === "space"
        ? remaining.slice(cut).replace(/^ +/, "")
        : remaining.slice(cut).replace(/^\n+/, "");

    let chunkPrefix = "";
    if (openFenceLang) chunkPrefix = "```" + openFenceLang + "\n";

    const nextOpen = trackFences(chunk, openFenceLang);

    let chunkSuffix = "";
    if (nextOpen) chunkSuffix = "\n```";

    parts.push(chunkPrefix + chunk + chunkSuffix);
    openFenceLang = nextOpen;
    remaining = rest;
  }

  if (remaining.length > 0) {
    const prefix = openFenceLang ? "```" + openFenceLang + "\n" : "";
    parts.push(prefix + remaining);
  }

  return parts;
}

/**
 * Given the fence-state at the start of `chunk` (empty string = closed,
 * non-empty = inside a fence with that language tag), scan triple-backtick
 * occurrences and return the fence-state at the end of `chunk`.
 */
function trackFences(chunk: string, startOpenLang: string): string {
  let openLang = startOpenLang;
  const re = /```([^\n`]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunk)) !== null) {
    if (openLang) {
      openLang = "";
    } else {
      openLang = (m[1] ?? "").trim();
    }
  }
  return openLang;
}

function iconFor(status: ToolStatus): string {
  switch (status) {
    case "running":
      return "🔧";
    case "ok":
      return "✅";
    case "err":
      return "❌";
  }
}
