// Verify download.ts using a stubbed fetch.
// Run: SLACK_APP_TOKEN=xapp-stub SLACK_BOT_TOKEN=xoxb-stub SLACK_SIGNING_SECRET=stub ANTHROPIC_API_KEY=stub npx tsx src/slack/download.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const origFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (typeof url !== "string") throw new Error("expected string URL");
  if (!url.startsWith("https://slack.test/")) throw new Error(`unexpected URL: ${url}`);
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (!headers.Authorization?.startsWith("Bearer xoxb-")) throw new Error("missing bot token");
  return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
}) as typeof fetch;

const { downloadFile } = await import("./download.js");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-dl-"));

  // Normal filename
  const rel = await downloadFile(
    { id: "F1", name: "report.pdf", url_private_download: "https://slack.test/F1" },
    tmp,
  );
  assert(rel === path.join("uploads", "report.pdf"), `unexpected rel: ${rel}`);
  const written = fs.readFileSync(path.join(tmp, rel));
  assert(written.length === 4 && written[0] === 1, "file contents corrupted");

  // Dangerous filename — sanitized
  const rel2 = await downloadFile(
    { id: "F2", name: "../etc/passwd", url_private_download: "https://slack.test/F2" },
    tmp,
  );
  assert(!rel2.includes(".."), `path traversal not sanitized: ${rel2}`);
  assert(fs.existsSync(path.join(tmp, rel2)), "sanitized file not written");

  globalThis.fetch = origFetch;
  console.log("✅ download verification passed");
}

main().catch((err) => {
  console.error("❌ download verification failed:", err);
  process.exit(1);
});
