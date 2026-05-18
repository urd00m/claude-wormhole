import type { WebClient } from "@slack/web-api";
import { toMrkdwn } from "./formatter.js";

const MIN_EDIT_INTERVAL_MS = 1000;
const PLACEHOLDER = "_thinking…_";

type ToolStatus = "running" | "ok" | "err";
type ToolCall = { id: string; name: string; status: ToolStatus };

/**
 * Streams an assistant reply into a single Slack message, throttled to one
 * chat.update per second (Slack tier-3 cap is ~50/min/channel).
 *
 * Layout:
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

  private messageTs: string | null = null;
  private textBuffer = "";
  private readonly toolsByOrder: ToolCall[] = [];
  private readonly toolsById = new Map<string, ToolCall>();
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
      // tool_use_id wasn't seen on start (shouldn't happen normally); append
      // a placeholder so the result still surfaces.
      const placeholder: ToolCall = { id, name: "?", status: ok ? "ok" : "err" };
      this.toolsById.set(id, placeholder);
      this.toolsByOrder.push(placeholder);
    }
    this.scheduleFlush();
  }

  async finalize(): Promise<void> {
    this.closed = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    await this.flushNow();
  }

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
