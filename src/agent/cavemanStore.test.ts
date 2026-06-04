// Verify CavemanStore: default off, level setting, persistence, validation,
// mtime-cached reload across instances.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CavemanStore, isCavemanLevel } from "./cavemanStore.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function main() {
  // --- isCavemanLevel: validation
  assert(isCavemanLevel("off"), "off is valid");
  assert(isCavemanLevel("lite"), "lite is valid");
  assert(isCavemanLevel("full"), "full is valid");
  assert(isCavemanLevel("ultra"), "ultra is valid");
  assert(isCavemanLevel("wenyan"), "wenyan is valid");
  assert(isCavemanLevel("wenyan-ultra"), "wenyan-ultra is valid");
  assert(!isCavemanLevel("nope"), "junk is invalid");
  assert(!isCavemanLevel(""), "empty is invalid");
  assert(!isCavemanLevel(undefined), "undefined is invalid");
  assert(!isCavemanLevel(123), "number is invalid");

  // --- fresh store: default off when file absent ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cavemanStore-"));
  const f = path.join(tmp, "cavemanState.json");
  {
    const s = new CavemanStore(f);
    assert(s.get() === "off", `default off, got ${s.get()}`);
  }

  // --- set persists ---
  {
    const s = new CavemanStore(f);
    s.set("full");
    assert(s.get() === "full", "set full immediate");
    // New instance reads from disk
    const s2 = new CavemanStore(f);
    assert(s2.get() === "full", `persisted full across instance: ${s2.get()}`);
  }

  // --- subsequent set overwrites ---
  {
    const s = new CavemanStore(f);
    s.set("ultra");
    const s2 = new CavemanStore(f);
    assert(s2.get() === "ultra", "set overwrites");
  }

  // --- off transitions back ---
  {
    const s = new CavemanStore(f);
    s.set("off");
    const s2 = new CavemanStore(f);
    assert(s2.get() === "off", "set off persists");
  }

  // --- invalid level rejected ---
  {
    const s = new CavemanStore(f);
    let threw = false;
    try {
      // @ts-expect-error testing runtime rejection
      s.set("bogus");
    } catch {
      threw = true;
    }
    assert(threw, "invalid level rejected");
    assert(s.get() === "off", "level unchanged after rejection");
  }

  // --- mtime reload: external edit picked up on next get() ---
  {
    const s = new CavemanStore(f);
    assert(s.get() === "off", "starts off");
    // Simulate an external edit (different process changes the file).
    // Force a mtime that's strictly newer than what we just cached, so
    // reloadIfChanged actually re-parses regardless of FS mtime resolution.
    fs.writeFileSync(f, JSON.stringify({ level: "wenyan-full" }));
    const before = fs.statSync(f).mtimeMs;
    fs.utimesSync(f, new Date(), new Date(before + 1000));
    assert(s.get() === "wenyan-full", `picked up external edit, got ${s.get()}`);
  }

  // --- malformed json falls back gracefully ---
  {
    const f2 = path.join(tmp, "bad.json");
    fs.writeFileSync(f2, "{ not json");
    const s = new CavemanStore(f2);
    assert(s.get() === "off", "malformed → off default");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✅ CavemanStore verified — default off, set/get, persistence, validation, mtime reload, malformed fallback");
}

main();
