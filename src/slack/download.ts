import fs from "node:fs";
import path from "node:path";
import { env } from "../config.js";

export type SlackFileRef = {
  id: string;
  name?: string;
  url_private_download?: string;
  url_private?: string;
  filetype?: string;
};

/**
 * Download a Slack file to {workdir}/uploads/{filename}.
 * Returns the filename relative to workdir (e.g., "uploads/report.pdf").
 */
export async function downloadFile(file: SlackFileRef, workdir: string): Promise<string> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) throw new Error(`file ${file.id} has no download URL`);
  const name = sanitizeName(file.name ?? `${file.id}.${file.filetype ?? "bin"}`);
  const dest = path.join(workdir, "uploads", name);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`download ${name} failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(dest, buf);
  return path.join("uploads", name);
}

function sanitizeName(name: string): string {
  return name.replace(/[/\\]/g, "_").replace(/^\.+/, "_");
}
