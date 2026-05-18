import fs from "node:fs";
import path from "node:path";
import type { WebClient } from "@slack/web-api";

export async function uploadFile(
  client: WebClient,
  channel: string,
  threadTs: string,
  filePath: string,
  title?: string,
): Promise<void> {
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error(`not a file: ${filePath}`);
  await client.filesUploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    file: fs.createReadStream(filePath),
    filename: path.basename(filePath),
    title: title ?? path.basename(filePath),
  });
}
