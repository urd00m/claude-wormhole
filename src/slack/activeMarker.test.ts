// Verify clearAllOnBoot:
//  - Dedupes the index.
//  - Drops entries whose reaction was removed.
//  - Drops entries that fail with "no_reaction" or other permanent shapes.
//  - KEEPS entries whose removal failed transiently, so the next boot retries.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

// INDEX_FILE in activeMarker is `path.join(process.cwd(), "data", ...)` and is
// captured at module-eval time, so chdir must happen BEFORE the dynamic import.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "activeMarker-test-"));
const origCwd = process.cwd();
process.chdir(tmp);

const indexPath = path.join(tmp, "data", "active-sessions.json");
async function writeIndex(entries: Array<{ channel: string; threadTs: string }>) {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2));
}
async function readIndexRaw(): Promise<Array<{ channel: string; threadTs: string }>> {
  const raw = await fs.readFile(indexPath, "utf8");
  return JSON.parse(raw);
}

type RemoveArgs = { channel: string; timestamp: string; name: string };
function makeClient(behavior: (a: RemoveArgs) => Promise<void>) {
  const calls: RemoveArgs[] = [];
  const client = {
    reactions: {
      remove: async (a: RemoveArgs) => {
        calls.push(a);
        await behavior(a);
        return { ok: true };
      },
    },
  } as never;
  return { client, calls };
}

const { clearAllOnBoot } = await import("./activeMarker.js");

try {
  // --- Case 1: all succeed → index wiped ----------------------------------
  {
    await writeIndex([
      { channel: "C1", threadTs: "1.0" },
      { channel: "C1", threadTs: "2.0" },
    ]);
    const { client, calls } = makeClient(async () => {});
    await clearAllOnBoot(client);
    assert(calls.length === 2, `case1: expected 2 remove calls, got ${calls.length}`);
    const remaining = await readIndexRaw();
    assert(remaining.length === 0, `case1: expected empty index, got ${JSON.stringify(remaining)}`);
  }

  // --- Case 2: dedupe identical entries before removing -------------------
  {
    await writeIndex([
      { channel: "C2", threadTs: "9.0" },
      { channel: "C2", threadTs: "9.0" }, // dupe
      { channel: "C2", threadTs: "9.0" }, // dupe
    ]);
    const { client, calls } = makeClient(async () => {});
    await clearAllOnBoot(client);
    assert(calls.length === 1, `case2: expected 1 remove call after dedupe, got ${calls.length}`);
    const remaining = await readIndexRaw();
    assert(remaining.length === 0, `case2: expected empty index`);
  }

  // --- Case 3: no_reaction is treated as already-clean → drop -------------
  {
    await writeIndex([{ channel: "C3", threadTs: "3.0" }]);
    const { client } = makeClient(async () => {
      throw new Error("no_reaction");
    });
    await clearAllOnBoot(client);
    const remaining = await readIndexRaw();
    assert(remaining.length === 0, `case3: no_reaction should drop entry`);
  }

  // --- Case 4: permanent error (message_not_found) → drop -----------------
  {
    await writeIndex([{ channel: "C4", threadTs: "4.0" }]);
    const { client } = makeClient(async () => {
      throw new Error("message_not_found");
    });
    await clearAllOnBoot(client);
    const remaining = await readIndexRaw();
    assert(remaining.length === 0, `case4: message_not_found should drop entry`);
  }

  // --- Case 5: transient error → retain for next boot --------------------
  {
    await writeIndex([
      { channel: "C5a", threadTs: "5.0" },
      { channel: "C5b", threadTs: "6.0" },
    ]);
    const { client } = makeClient(async (a) => {
      if (a.channel === "C5a") throw new Error("ratelimited");
      // C5b succeeds
    });
    await clearAllOnBoot(client);
    const remaining = await readIndexRaw();
    assert(
      remaining.length === 1 && remaining[0].channel === "C5a",
      `case5: expected to retain C5a, got ${JSON.stringify(remaining)}`,
    );
  }

  // --- Case 6: mix succeed + transient + permanent ------------------------
  {
    await writeIndex([
      { channel: "Cok", threadTs: "1" },
      { channel: "Ctransient", threadTs: "2" },
      { channel: "Cperm", threadTs: "3" },
      { channel: "Cnoreact", threadTs: "4" },
    ]);
    const { client } = makeClient(async (a) => {
      if (a.channel === "Ctransient") throw new Error("internal_error");
      if (a.channel === "Cperm") throw new Error("channel_not_found");
      if (a.channel === "Cnoreact") throw new Error("no_reaction");
    });
    await clearAllOnBoot(client);
    const remaining = await readIndexRaw();
    assert(
      remaining.length === 1 && remaining[0].channel === "Ctransient",
      `case6: expected only Ctransient retained, got ${JSON.stringify(remaining)}`,
    );
  }

  console.log("activeMarker.test.ts: PASS (6 cases)");
} finally {
  process.chdir(origCwd);
  await fs.rm(tmp, { recursive: true, force: true });
}
