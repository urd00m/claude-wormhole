// Verify WorkdirStore persistence + resolveWorkdir validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkdirStore, resolveWorkdir } from "./workdirStore.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wd-"));
  const file = path.join(tmp, "workdirs.json");

  // Persistence
  const s1 = new WorkdirStore(file);
  s1.set("C1:T1", tmp);
  assert(s1.get("C1:T1") === tmp, "round-trip");
  const s2 = new WorkdirStore(file);
  assert(s2.get("C1:T1") === tmp, "persisted across instances");
  assert(s2.remove("C1:T1"), "remove returns true when present");
  assert(s2.get("C1:T1") === undefined, "removed");
  assert(!s2.remove("C1:T1"), "remove returns false when absent");

  // resolveWorkdir: absolute valid path passes
  const realDir = resolveWorkdir(tmp);
  assert(realDir === path.resolve(tmp), "resolves to canonical absolute path");

  // ~ expansion
  const home = resolveWorkdir("~");
  assert(home === os.homedir(), `~ expands to ${os.homedir()}, got ${home}`);

  // Rejects relative
  let threw = false;
  try {
    resolveWorkdir("./relative/path");
  } catch (e) {
    threw = /absolute/.test((e as Error).message);
  }
  assert(threw, "relative path must be rejected");

  // Rejects nonexistent
  threw = false;
  try {
    resolveWorkdir("/this/path/definitely/does/not/exist/xyz123");
  } catch (e) {
    threw = /does not exist/.test((e as Error).message);
  }
  assert(threw, "nonexistent path must be rejected");

  // Rejects file (not directory)
  const filePath = path.join(tmp, "afile");
  fs.writeFileSync(filePath, "x");
  threw = false;
  try {
    resolveWorkdir(filePath);
  } catch (e) {
    threw = /not a directory/.test((e as Error).message);
  }
  assert(threw, "non-directory path must be rejected");

  // Rejects empty
  threw = false;
  try {
    resolveWorkdir("   ");
  } catch (e) {
    threw = /empty/.test((e as Error).message);
  }
  assert(threw, "empty path must be rejected");

  console.log("✅ workdirStore verification passed");
}

main().catch((err) => {
  console.error("❌ workdirStore verification failed:", err);
  process.exit(1);
});
