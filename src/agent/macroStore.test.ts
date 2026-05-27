// Verify MacroStore loading/caching + the pure expandMacros substitution.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MacroStore, expandMacros } from "./macroStore.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "macros-"));
  const file = path.join(tmp, "macros.json");

  // ============ expandMacros (pure) ============
  const M = { swd: "set working dir", rev: "review the diff" };

  // --- single occurrence + trailing text (the spec example) ---
  assert(
    expandMacros("swd to M5CacheRE", M) === "set working dir to M5CacheRE",
    `spec example: ${expandMacros("swd to M5CacheRE", M)}`,
  );

  // --- bare macro, whole message ---
  assert(expandMacros("swd", M) === "set working dir", "bare macro");

  // --- multiple DIFFERENT macros in one message ---
  assert(
    expandMacros("swd then rev please", M) === "set working dir then review the diff please",
    `multi-macro: ${expandMacros("swd then rev please", M)}`,
  );

  // --- multiple occurrences of the SAME macro all expand ---
  assert(
    expandMacros("swd and again swd", M) === "set working dir and again set working dir",
    `repeat: ${expandMacros("swd and again swd", M)}`,
  );

  // --- case sensitive: SWD / Swd do NOT match ---
  assert(expandMacros("SWD", M) === "SWD", "uppercase no-match");
  assert(expandMacros("Swd", M) === "Swd", "titlecase no-match");

  // --- substring inside a word does NOT match (whole-token only) ---
  assert(expandMacros("swder swds myswd", M) === "swder swds myswd", "substring no-match");

  // --- punctuation-glued token does NOT match (documented limitation) ---
  assert(expandMacros("swd, please", M) === "swd, please", "punctuation-glued no-match");

  // --- non-macro tokens pass through; spacing preserved exactly ---
  assert(
    expandMacros("hello   world\ttab\nnewline", M) === "hello   world\ttab\nnewline",
    "spacing + non-macro passthrough preserved",
  );

  // --- empty / whitespace message ---
  assert(expandMacros("", M) === "", "empty");
  assert(expandMacros("   ", M) === "   ", "whitespace only");

  // --- no macros defined → unchanged ---
  assert(expandMacros("swd to foo", {}) === "swd to foo", "empty macro map → unchanged");

  // ============ MacroStore (file) ============

  // --- missing file → empty ---
  {
    const s = new MacroStore(file);
    assert(Object.keys(s.all()).length === 0, "missing file → no macros");
  }

  // --- valid file loads ---
  {
    fs.writeFileSync(file, JSON.stringify({ swd: "set working dir", rev: "review the diff" }));
    const s = new MacroStore(file);
    const all = s.all();
    assert(all.swd === "set working dir" && all.rev === "review the diff", "valid file loads");
  }

  // --- malformed JSON → empty (no crash) ---
  {
    const bad = path.join(tmp, "bad.json");
    fs.writeFileSync(bad, "{ not valid json ");
    const s = new MacroStore(bad);
    assert(Object.keys(s.all()).length === 0, "malformed → empty");
  }

  // --- non-string values + whitespace/empty names dropped ---
  {
    const mixed = path.join(tmp, "mixed.json");
    fs.writeFileSync(
      mixed,
      JSON.stringify({ good: "ok", num: 42, obj: { a: 1 }, "": "blankname", "has space": "spacey" }),
    );
    const s = new MacroStore(mixed);
    const all = s.all();
    assert(all.good === "ok", "string value kept");
    assert(!("num" in all), "number dropped");
    assert(!("obj" in all), "object dropped");
    assert(!("" in all), "empty name dropped");
    assert(!("has space" in all), "whitespace name dropped");
  }

  // --- array root → empty (not an object map) ---
  {
    const arr = path.join(tmp, "arr.json");
    fs.writeFileSync(arr, JSON.stringify(["swd", "rev"]));
    const s = new MacroStore(arr);
    assert(Object.keys(s.all()).length === 0, "array root → empty");
  }

  // --- mtime re-read: edit the file, store picks up changes ---
  {
    const live = path.join(tmp, "live.json");
    fs.writeFileSync(live, JSON.stringify({ a: "first" }));
    const s = new MacroStore(live);
    assert(s.all().a === "first", "initial load");

    // Rewrite with new content AND bump mtime to guarantee staleness is
    // detected even if the rewrite lands within the same mtime tick.
    fs.writeFileSync(live, JSON.stringify({ a: "second", b: "added" }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(live, future, future);

    const all = s.all();
    assert(all.a === "second", `mtime re-read updated value: ${all.a}`);
    assert(all.b === "added", "mtime re-read picked up new macro");
  }

  // --- end-to-end: store + expandMacros together ---
  {
    const e2e = path.join(tmp, "e2e.json");
    fs.writeFileSync(e2e, JSON.stringify({ swd: "set working dir to M5CacheRE" }));
    const s = new MacroStore(e2e);
    assert(
      expandMacros("swd and read the readme", s.all()) ===
        "set working dir to M5CacheRE and read the readme",
      "store + expand end-to-end",
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    "✅ macroStore verified — expandMacros (spec example, multi/repeat, case-sensitive, whole-token, spacing) + loader (missing/malformed/filtered/array/mtime-reload)",
  );
}

main().catch((err) => {
  console.error("❌ macroStore verification failed:", err);
  process.exit(1);
});
