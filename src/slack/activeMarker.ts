import fs from "node:fs/promises";
import path from "node:path";
import type { WebClient } from "@slack/web-api";

export const MARKER = "satellite_antenna";

type IndexEntry = { channel: string; threadTs: string };

const INDEX_FILE = path.join(process.cwd(), "data", "active-sessions.json");

let writeChain: Promise<void> = Promise.resolve();

function queue(work: () => Promise<void>): Promise<void> {
  const next = writeChain.then(work, work);
  writeChain = next.catch(() => undefined);
  return next;
}

async function readIndex(): Promise<IndexEntry[]> {
  try {
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is IndexEntry =>
        !!x &&
        typeof x === "object" &&
        typeof (x as IndexEntry).channel === "string" &&
        typeof (x as IndexEntry).threadTs === "string",
    );
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    console.warn(
      `[activeMarker] failed to read ${INDEX_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

async function writeIndex(entries: IndexEntry[]): Promise<void> {
  try {
    await fs.mkdir(path.dirname(INDEX_FILE), { recursive: true });
    await fs.writeFile(INDEX_FILE, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.warn(
      `[activeMarker] failed to write ${INDEX_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function markActive(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    await client.reactions.add({ channel, timestamp: threadTs, name: MARKER });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already_reacted")) {
      console.warn(`[activeMarker] reactions.add failed: ${msg}`);
    }
  }
  await queue(async () => {
    const entries = await readIndex();
    if (!entries.some((e) => e.channel === channel && e.threadTs === threadTs)) {
      entries.push({ channel, threadTs });
      await writeIndex(entries);
    }
  });
}

export async function unmarkActive(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    await client.reactions.remove({ channel, timestamp: threadTs, name: MARKER });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no_reaction")) {
      console.warn(`[activeMarker] reactions.remove failed: ${msg}`);
    }
  }
  await queue(async () => {
    const entries = await readIndex();
    const filtered = entries.filter(
      (e) => !(e.channel === channel && e.threadTs === threadTs),
    );
    if (filtered.length !== entries.length) {
      await writeIndex(filtered);
    }
  });
}

export async function clearAllOnBoot(client: WebClient): Promise<void> {
  await queue(async () => {
    const entries = await readIndex();
    for (const e of entries) {
      try {
        await client.reactions.remove({
          channel: e.channel,
          timestamp: e.threadTs,
          name: MARKER,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("no_reaction")) {
          console.warn(`[activeMarker] clearAllOnBoot remove failed: ${msg}`);
        }
      }
    }
    await writeIndex([]);
  });
}
