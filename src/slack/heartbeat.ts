import type { WebClient } from "@slack/web-api";

const ROTATION = [
  "eyes",
  "hourglass_flowing_sand",
  "thinking_face",
  "gear",
  "brain",
  "robot_face",
  "sparkles",
  "zap",
  "hammer_and_wrench",
  "mag",
];

const HEARTBEAT_MS = 30_000;
const SUCCESS_EMOJI = "+1";
const ERROR_EMOJI = "x";

type HeartbeatOpts = {
  client: WebClient;
  channel: string;
  ts: string;
  intervalMs?: number;
};

export class Heartbeat {
  private readonly client: WebClient;
  private readonly channel: string;
  private readonly ts: string;
  private readonly intervalMs: number;
  private readonly added: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private index = 0;
  private stopped = false;
  /** Most recently kicked-off addNext promise (or null if none in flight). */
  private inflight: Promise<void> | null = null;

  constructor(opts: HeartbeatOpts) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.ts = opts.ts;
    this.intervalMs = opts.intervalMs ?? HEARTBEAT_MS;
  }

  /** Add the first emoji immediately and start the periodic rotation. */
  async start(): Promise<void> {
    await this.kickAddNext();
    this.timer = setInterval(() => {
      void this.kickAddNext();
    }, this.intervalMs);
  }

  private kickAddNext(): Promise<void> {
    const p = this.addNext();
    this.inflight = p;
    return p;
  }

  private async addNext(): Promise<void> {
    if (this.stopped) return;
    const name = ROTATION[this.index % ROTATION.length];
    this.index += 1;
    try {
      await this.client.reactions.add({ channel: this.channel, timestamp: this.ts, name });
      this.added.push(name);
    } catch (err: unknown) {
      // already_reacted is fine — rotation will move past it next tick
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already_reacted")) {
        console.warn(`[heartbeat] reactions.add failed: ${msg}`);
      }
    }
  }

  /** Remove all heartbeat reactions and place a final status emoji. */
  async stop(outcome: "success" | "error"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any addNext currently mid-await so it can either (a) bail on
    // the post-await `this.stopped` check before pushing to `this.added`, or
    // (b) reach the push and then self-clean by removing the reaction it
    // just added. Without this, the in-flight tick would land its emoji
    // AFTER we iterated `this.added`, leaving an orphan reaction.
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* swallow — addNext already logs */
      }
      this.inflight = null;
    }
    for (const name of this.added) {
      try {
        await this.client.reactions.remove({ channel: this.channel, timestamp: this.ts, name });
      } catch (err) {
        // best-effort cleanup
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("no_reaction")) {
          console.warn(`[heartbeat] reactions.remove(${name}) failed: ${msg}`);
        }
      }
    }
    const final = outcome === "success" ? SUCCESS_EMOJI : ERROR_EMOJI;
    try {
      await this.client.reactions.add({ channel: this.channel, timestamp: this.ts, name: final });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[heartbeat] final reaction failed: ${msg}`);
    }
  }
}
