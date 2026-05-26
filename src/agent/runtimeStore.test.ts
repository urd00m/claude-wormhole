// Verify RuntimeStore persistence + RuntimeName validation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeStore } from "./runtimeStore.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
  const file = path.join(tmp, "runtimes.json");

  // --- (1) set / get round-trip ---
  const s1 = new RuntimeStore(file);
  s1.set("C1:T1", "codex");
  s1.set("C1:T2", "claude");
  assert(s1.get("C1:T1") === "codex", "set codex round-trip");
  assert(s1.get("C1:T2") === "claude", "set claude round-trip");
  assert(s1.get("C1:T3") === undefined, "missing key is undefined");

  // --- (2) Persistence across instances ---
  const s2 = new RuntimeStore(file);
  assert(s2.get("C1:T1") === "codex", "codex persisted");
  assert(s2.get("C1:T2") === "claude", "claude persisted");

  // --- (3) remove ---
  assert(s2.remove("C1:T1"), "remove returns true when present");
  assert(s2.get("C1:T1") === undefined, "removed");
  assert(!s2.remove("C1:T1"), "remove returns false when absent");

  // --- (4) On-disk JSON format ---
  // Belt-and-suspenders: external tooling (doctor.sh greps for "codex" in
  // this file) and any future cross-tool consumer expects flat key→string.
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert(typeof onDisk === "object" && onDisk !== null, "json object on disk");
  assert(onDisk["C1:T2"] === "claude", "on-disk key→value flat");

  // --- (5) Invalid runtime names in file are ignored on load ---
  // Defensive: a human editing the file shouldn't be able to install
  // "claud" or "gpt5" as a runtime — only the schema's enum is honored.
  const file2 = path.join(tmp, "runtimes-corrupt.json");
  fs.writeFileSync(
    file2,
    JSON.stringify({
      "good:thread": "codex",
      "bad:typo": "claud",
      "bad:gpt": "gpt5",
      "bad:int": 1,
    }),
  );
  const s3 = new RuntimeStore(file2);
  assert(s3.get("good:thread") === "codex", "valid name loads");
  assert(s3.get("bad:typo") === undefined, "typo dropped on load");
  assert(s3.get("bad:gpt") === undefined, "unknown name dropped");
  assert(s3.get("bad:int") === undefined, "non-string value dropped");

  // --- (6) entries() snapshot ---
  const entries = s3.entries();
  assert(entries.length === 1, `expected 1 entry, got ${entries.length}`);
  assert(entries[0][0] === "good:thread" && entries[0][1] === "codex", "entries[0]");

  // --- (7) Missing file at construction → empty store, no throw ---
  const file3 = path.join(tmp, "missing.json");
  const s4 = new RuntimeStore(file3);
  assert(s4.get("any") === undefined, "missing file yields empty store");
  s4.set("any", "codex");
  assert(fs.existsSync(file3), "first set creates the file");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✅ runtimeStore verification passed");
}

main().catch((err) => {
  console.error("❌ runtimeStore verification failed:", err);
  process.exit(1);
});
