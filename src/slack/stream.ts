import type { WebClient } from "@slack/web-api";
import { toMrkdwn } from "./formatter.js";

const MIN_EDIT_INTERVAL_MS = 1000;
const PLACEHOLDER = "_thinking…_";

/**
 * Streams an assistant reply into a single Slack message, throttled to one
 * chat.update per second (Slack tier-3 cap is ~50/min/channel).
 *
 * Usage:
 *   const s = new SlackStreamer(client, channel, thread_ts);
 *   await s.open();
 *   s.appendText("hello "); s.appendText("world");
 *   s.toolStart("Bash"); s.toolEnd("Bash", true);
 *   await s.finalize();
 */
export class SlackStreamer {
  private readonly client: WebClient;
  private readonly channel: string;
  private readonly threadTs: string;

  private messageTs: string | null = null;
  private textBuffer = "";
  private toolLines: string[] = [];
  private lastEditAt = 0;
  private pendingTimer: NodeJS.Timeout | null = null;
  private closed = false;

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
    this.messageTs = res.ts ?? null;
  }

  appendText(chunk: string): void {
    this.textBuffer += chunk;
    this.scheduleFlush();
  }

  toolStart(name: string): void {
    this.toolLines.push(`_🔧 ${name}…_`);
    this.scheduleFlush();
  }

  toolEnd(name: string, ok: boolean): void {
    // Replace the most recent matching line, if any
    const marker = `_🔧 ${name}…_`;
    const idx = this.toolLines.lastIndexOf(marker);
    const replacement = ok ? `_✅ ${name}_` : `_❌ ${name}_`;
    if (idx >= 0) this.toolLines[idx] = replacement;
    else this.toolLines.push(replacement);
    this.scheduleFlush();
  }

  /** Force a final flush (no throttling) and disable further edits. */
  async finalize(): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    await this.flushNow();
  }

  /** Replace the message with an error, no streaming format. */
  async fail(err: unknown): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    if (!this.messageTs) return;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.messageTs,
        text: `:warning: ${msg}`,
      });
    } catch {
      /* swallow */
    }
  }

  private render(): string {
    const body = toMrkdwn(this.textBuffer);
    const tools = this.toolLines.join("\n");
    const parts = [body, tools].filter(Boolean);
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
    if (!this.messageTs) return;
    const text = this.render();
    this.lastEditAt = Date.now();
    try {
      await this.client.chat.update({
        channel: this.channel,
        ts: this.messageTs,
        text,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[stream] chat.update failed: ${msg}`);
    }
  }
}
