// Verify UsageStore: cache parse + freshness + maybeRefresh spawning the
// helper script. We point the store at a tmp cache file and a fake
// "script" (a bash one-liner that just writes JSON) so nothing real runs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageStore } from "./usageStore.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "usagestore-"));
  const cachePath = path.join(tmp, "usage.json");

  // ============ read: nothing → null ============
  {
    const s = new UsageStore({ cachePath, scriptPath: "/bin/true", ttlMs: 1000 });
    assert(s.read() === null, "missing cache → null");
    assert(!s.isFresh(), "missing cache is not fresh");
  }

  // ============ parse OK doc ============
  {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        status: "ok",
        fetched_at: now,
        five_hour_pct: 42.7,
        weekly_pct: 18,
        resets_at: "2026-05-28T12:00:00Z",
      }),
    );
    const s = new UsageStore({ cachePath, scriptPath: "/bin/true", ttlMs: 60_000 });
    const snap = s.read();
    assert(snap !== null && snap.status === "ok", "OK snapshot parsed");
    assert(snap!.fiveHourPct === 42.7, `5h pct: ${snap!.fiveHourPct}`);
    assert(snap!.weeklyPct === 18, `weekly pct: ${snap!.weeklyPct}`);
    assert(snap!.resetsAt === "2026-05-28T12:00:00Z", "resetsAt parsed");
    assert(s.isFresh(), "young cache is fresh");
  }

  // ============ parse error doc ============
  {
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      cachePath,
      JSON.stringify({
        status: "error",
        fetched_at: now,
        reason: "credentials file not found",
        five_hour_pct: null,
        weekly_pct: null,
      }),
    );
    const s = new UsageStore({ cachePath, scriptPath: "/bin/true", ttlMs: 60_000 });
    const snap = s.read();
    assert(snap !== null && snap.status === "error", "error snapshot parsed");
    assert(snap!.fiveHourPct === undefined, "null pct → undefined");
    assert(snap!.reason === "credentials file not found", "reason preserved");
  }

  // ============ ttl: old cache is not fresh ============
  {
    const old = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    fs.writeFileSync(cachePath, JSON.stringify({ status: "ok", fetched_at: old, five_hour_pct: 10, weekly_pct: 5 }));
    const s = new UsageStore({ cachePath, scriptPath: "/bin/true", ttlMs: 60_000 });
    assert(!s.isFresh(), "10-min-old cache not fresh under 1-min ttl");
    assert(s.read() !== null, "still readable when stale");
  }

  // ============ malformed JSON → null ============
  {
    fs.writeFileSync(cachePath, "{not json");
    const s = new UsageStore({ cachePath, scriptPath: "/bin/true", ttlMs: 60_000 });
    assert(s.read() === null, "garbage → null");
  }

  // ============ maybeRefresh: stale cache triggers script spawn ============
  // We craft a "script" that just writes a fresh JSON to a side file, so we
  // can prove the store spawned it without touching the real fetch path.
  {
    const sentinelOut = path.join(tmp, "spawned.json");
    const fakeScript = path.join(tmp, "fake-fetch.sh");
    fs.writeFileSync(
      fakeScript,
      `#!/usr/bin/env bash\nprintf '{"status":"ok","fetched_at":%d,"five_hour_pct":77,"weekly_pct":11}\\n' "$(date +%s)" > '${sentinelOut}'\ncp '${sentinelOut}' '${cachePath}'\n`,
    );
    fs.chmodSync(fakeScript, 0o755);

    // Force the cache to be stale.
    const old = Math.floor(Date.now() / 1000) - 600;
    fs.writeFileSync(cachePath, JSON.stringify({ status: "ok", fetched_at: old, five_hour_pct: 1, weekly_pct: 1 }));

    const s = new UsageStore({ cachePath, scriptPath: fakeScript, ttlMs: 60_000 });
    const stale = s.maybeRefresh();
    assert(stale && stale.fiveHourPct === 1, "returns stale snapshot immediately");

    // Wait for the spawn to complete and rewrite the cache.
    for (let i = 0; i < 30 && !fs.existsSync(sentinelOut); i++) await sleep(50);
    assert(fs.existsSync(sentinelOut), "fake script ran");

    // Re-read picks up the fresh value.
    const fresh = s.read();
    assert(fresh!.fiveHourPct === 77, `refresh wrote new value: ${fresh!.fiveHourPct}`);
    assert(s.isFresh(), "refreshed cache is fresh");
  }

  // ============ maybeRefresh on fresh cache: no spawn ============
  {
    const sentinel = path.join(tmp, "should-not-run");
    const noOpScript = path.join(tmp, "blow-up.sh");
    fs.writeFileSync(noOpScript, `#!/usr/bin/env bash\necho ran > '${sentinel}'\n`);
    fs.chmodSync(noOpScript, 0o755);
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(cachePath, JSON.stringify({ status: "ok", fetched_at: now, five_hour_pct: 50, weekly_pct: 25 }));

    const s = new UsageStore({ cachePath, scriptPath: noOpScript, ttlMs: 60_000 });
    const snap = s.maybeRefresh();
    assert(snap!.fiveHourPct === 50, "returns fresh snapshot");

    // Give the spawn a chance — but it shouldn't happen.
    await sleep(200);
    assert(!fs.existsSync(sentinel), "fresh cache → no script spawn");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    "✅ UsageStore verified — parse OK/error/garbage, ttl freshness, stale-triggers-spawn, fresh-no-spawn",
  );
}

main().catch((err) => {
  console.error("❌ UsageStore verification failed:", err);
  process.exit(1);
});
