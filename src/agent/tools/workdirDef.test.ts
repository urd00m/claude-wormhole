// Direct verification of workdirDef — the runtime-neutral tool defs for
// set_workdir / get_workdir / reset_workdir. Uses an injected fake session
// and an isolated WorkdirStore file (via WORKDIRS_FILE override) so the
// test does NOT touch the real data/workdirs.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// IMPORTANT: override WORKDIRS_FILE BEFORE importing modules that read it
// at top level. config.ts resolves the path once at import time; the
// workdirStore singleton consumes it lazily, but resolveWorkdir / def files
// import from config too — so we point everything at a tmp file early.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "wormhole-workdir-test-"));
process.env.WORKDIRS_FILE_OVERRIDE = path.join(TMP_DIR, "workdirs.json");

// We can't override WORKDIRS_FILE through env (config.ts hardcodes the
// path). Instead we snapshot+restore the real file so the test is safe to
// run against a developer's working directory.

import { setWorkdirDef, getWorkdirDef, resetWorkdirDef, workdirToolDefs } from "./workdirDef.js";
import type { WorkdirCapableSession } from "./workdirDef.js";
import { WORKDIRS_FILE } from "../../config.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

class FakeSession implements WorkdirCapableSession {
  workdir: string;
  setCalls: string[] = [];
  constructor(initial: string) {
    this.workdir = initial;
  }
  setWorkdir(p: string): void {
    this.setCalls.push(p);
    this.workdir = p;
  }
}

function snapshotWorkdirsFile(): { existed: boolean; contents: string | null } {
  if (!fs.existsSync(WORKDIRS_FILE)) return { existed: false, contents: null };
  return { existed: true, contents: fs.readFileSync(WORKDIRS_FILE, "utf8") };
}
function restoreWorkdirsFile(snap: { existed: boolean; contents: string | null }): void {
  if (!snap.existed) {
    if (fs.existsSync(WORKDIRS_FILE)) fs.unlinkSync(WORKDIRS_FILE);
    return;
  }
  fs.writeFileSync(WORKDIRS_FILE, snap.contents ?? "");
}

const TEST_THREAD_PREFIX = "test:workdir-def:";
function uniqKey(name: string): string {
  return `${TEST_THREAD_PREFIX}${name}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`;
}

async function main() {
  const snap = snapshotWorkdirsFile();

  try {
    // --- (1) def shapes ---
    {
      const session = new FakeSession("/initial");
      const ctx = { session, threadKey: uniqKey("shapes") };
      const setDef = setWorkdirDef(ctx);
      const getDef = getWorkdirDef(ctx);
      const resetDef = resetWorkdirDef(ctx);
      assert(setDef.name === "set_workdir", "set_workdir name");
      assert(getDef.name === "get_workdir", "get_workdir name");
      assert(resetDef.name === "reset_workdir", "reset_workdir name");
      assert(typeof setDef.schema.path !== "undefined", "set schema.path");
    }

    // --- (2) set_workdir: valid existing absolute dir → mutates session ---
    {
      const session = new FakeSession("/initial");
      const tk = uniqKey("setvalid");
      const def = setWorkdirDef({ session, threadKey: tk });
      const target = TMP_DIR; // exists, absolute
      const result = await def.handler({ path: target });
      assert(result.isError !== true, `expected success, got: ${JSON.stringify(result)}`);
      assert(session.setCalls.length === 1, "session.setWorkdir called once");
      assert(session.setCalls[0] === target, `setWorkdir arg: ${session.setCalls[0]}`);
      assert(session.workdir === target, "session.workdir mutated");
      assert(result.content[0].text.includes(target), "summary mentions target");
    }

    // --- (3) set_workdir: relative path → error, no mutation ---
    {
      const session = new FakeSession("/initial");
      const tk = uniqKey("setrel");
      const def = setWorkdirDef({ session, threadKey: tk });
      const result = await def.handler({ path: "relative/path" });
      assert(result.isError === true, "must flag as error");
      assert(session.setCalls.length === 0, "no session mutation on error");
      assert(session.workdir === "/initial", "workdir untouched on error");
    }

    // --- (4) set_workdir: non-existent path → error ---
    {
      const session = new FakeSession("/initial");
      const tk = uniqKey("setmissing");
      const def = setWorkdirDef({ session, threadKey: tk });
      const result = await def.handler({ path: "/this/path/should/not/exist/anywhere-xyz123" });
      assert(result.isError === true, "non-existent path must error");
      assert(session.setCalls.length === 0, "no mutation");
    }

    // --- (5) get_workdir: reads from session ---
    {
      const session = new FakeSession("/some/dir");
      const def = getWorkdirDef({ session, threadKey: uniqKey("get") });
      const result = await def.handler({});
      assert(result.isError !== true, "no error");
      assert(result.content[0].text.includes("/some/dir"), `text: ${result.content[0].text}`);
    }

    // --- (6) reset_workdir: clears override + rotates session to default sandbox
    {
      const session = new FakeSession("/some/override");
      const tk = uniqKey("reset");
      // First, set an override so reset has something to clear.
      const setDef = setWorkdirDef({ session, threadKey: tk });
      await setDef.handler({ path: TMP_DIR });
      session.setCalls = []; // reset for cleaner assertion below

      const resetDef = resetWorkdirDef({ session, threadKey: tk });
      const result = await resetDef.handler({});
      assert(result.isError !== true, "reset success");
      assert(result.content[0].text.includes("override cleared"), `text: ${result.content[0].text}`);
      assert(session.setCalls.length === 1, "session.setWorkdir called to rotate to default");
      // The default sandbox path includes "sessions/" and the safe thread key.
      const safe = tk.replace(/[^A-Za-z0-9_-]/g, "_");
      assert(session.setCalls[0].includes(safe), `default sandbox path uses safe key: ${session.setCalls[0]}`);
    }

    // --- (7) reset_workdir: when no override is set, reports as such ---
    {
      const session = new FakeSession("/already-default");
      const tk = uniqKey("resetnoop");
      const def = resetWorkdirDef({ session, threadKey: tk });
      const result = await def.handler({});
      assert(result.isError !== true, "reset still success");
      assert(
        result.content[0].text.includes("No override") || result.content[0].text.includes("already"),
        `noop wording: ${result.content[0].text}`,
      );
    }

    // --- (8) workdirToolDefs: stable order ---
    {
      const session = new FakeSession("/x");
      const defs = workdirToolDefs({ session, threadKey: uniqKey("collect") });
      assert(defs.length === 3, `expected 3 defs, got ${defs.length}`);
      assert(defs[0].name === "set_workdir", "0=set");
      assert(defs[1].name === "get_workdir", "1=get");
      assert(defs[2].name === "reset_workdir", "2=reset");
    }

    console.log(
      "✅ workdirDef verified — set/get/reset dispatch, path validation, default-sandbox rotation",
    );
  } finally {
    restoreWorkdirsFile(snap);
    try {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

main().catch((err) => {
  console.error("❌ workdirDef verification failed:", err);
  process.exit(1);
});
