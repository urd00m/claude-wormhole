// Verify ensureCommandsLinked: creates the symlink when absent, is idempotent,
// and never clobbers an existing real dir or a differently-targeted link.
// Uses tmp dirs so the real ~/.claude/commands is never touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureCommandsLinked } from "./skillsLink.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillslink-"));
  const source = path.join(tmp, "arch-common", "commands");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "demo.md"), "demo");

  // ---- fresh link (target absent, parent absent) ----
  const target = path.join(tmp, "home", ".claude", "commands");
  const r1 = ensureCommandsLinked({ source, target });
  assert(r1.status === "linked", `fresh → linked, got ${r1.status}`);
  assert(fs.lstatSync(target).isSymbolicLink(), "target is a symlink");
  assert(fs.readFileSync(path.join(target, "demo.md"), "utf8") === "demo", "link resolves to source files");

  // ---- idempotent (correct link already present) ----
  const r2 = ensureCommandsLinked({ source, target });
  assert(r2.status === "ok", `second run → ok, got ${r2.status}`);

  // ---- missing source ----
  const r3 = ensureCommandsLinked({ source: path.join(tmp, "nope"), target: path.join(tmp, "t3") });
  assert(r3.status === "missing-source", `absent source → missing-source, got ${r3.status}`);
  assert(!fs.existsSync(path.join(tmp, "t3")), "no link created for missing source");

  // ---- existing real directory is not clobbered ----
  const realDir = path.join(tmp, "real");
  fs.mkdirSync(realDir, { recursive: true });
  fs.writeFileSync(path.join(realDir, "mine.md"), "keep");
  const r4 = ensureCommandsLinked({ source, target: realDir });
  assert(r4.status === "skipped", `real dir → skipped, got ${r4.status}`);
  assert(fs.existsSync(path.join(realDir, "mine.md")), "existing dir untouched");

  // ---- symlink pointing elsewhere is not clobbered ----
  const other = path.join(tmp, "other");
  fs.mkdirSync(other, { recursive: true });
  const wrongLink = path.join(tmp, "wronglink");
  fs.symlinkSync(other, wrongLink);
  const r5 = ensureCommandsLinked({ source, target: wrongLink });
  assert(r5.status === "skipped", `foreign symlink → skipped, got ${r5.status}`);
  assert(path.resolve(fs.readlinkSync(wrongLink)) === path.resolve(other), "foreign symlink left intact");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✅ skillsLink verified — fresh link, idempotent, missing-source, no-clobber (real dir + foreign symlink)");
}

main();
