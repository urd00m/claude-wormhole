// Verify cavemanLink: settings-file generation, SKILL.md caching, codex
// preamble construction. Uses a tmp caveman dir so we don't touch the
// vendored repo files or data/ in this run.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexCavemanPreamble, ensureCavemanReadyAt } from "./cavemanLink.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function setupFakeCavemanDir(root: string) {
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "caveman"), { recursive: true });
  fs.writeFileSync(path.join(root, "hooks", "caveman-activate.js"), "// stub");
  fs.writeFileSync(path.join(root, "hooks", "caveman-mode-tracker.js"), "// stub");
  fs.writeFileSync(
    path.join(root, "skills", "caveman", "SKILL.md"),
    "---\nname: caveman\n---\n\nRespond terse like smart caveman.",
  );
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cavemanLink-"));
  const cavemanDir = path.join(tmp, "caveman");
  const outFile = path.join(tmp, "out", "wormhole-claude-settings.json");

  // --- missing source dir → null ---
  {
    const r = ensureCavemanReadyAt({ cavemanDir, outFile });
    assert(r === null, "missing source → null");
    assert(!fs.existsSync(outFile), "no output written when source missing");
  }

  // --- happy path: source present → settings written + skillText cached ---
  setupFakeCavemanDir(cavemanDir);
  {
    const r = ensureCavemanReadyAt({ cavemanDir, outFile });
    assert(r !== null, "happy path returns artifacts");
    assert(r!.settingsPath === outFile, "settings path returned");
    assert(r!.skillText.includes("terse like smart caveman"), "skillText loaded");
    assert(fs.existsSync(outFile), "settings file written");
    const parsed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    assert(parsed.hooks && parsed.hooks.SessionStart && parsed.hooks.UserPromptSubmit, "hook scaffold present");
    const sessionCmd = parsed.hooks.SessionStart[0].hooks[0].command;
    assert(sessionCmd.includes("caveman-activate.js"), `SessionStart points at activate: ${sessionCmd}`);
    const promptCmd = parsed.hooks.UserPromptSubmit[0].hooks[0].command;
    assert(promptCmd.includes("caveman-mode-tracker.js"), `UserPromptSubmit points at tracker: ${promptCmd}`);
    // Absolute paths so the file is portable across cwds
    assert(sessionCmd.includes(path.resolve(cavemanDir)), "uses absolute path");
  }

  // --- second call regenerates cleanly (idempotent across processes) ---
  {
    const r1 = ensureCavemanReadyAt({ cavemanDir, outFile });
    const before = fs.readFileSync(outFile, "utf8");
    const r2 = ensureCavemanReadyAt({ cavemanDir, outFile });
    const after = fs.readFileSync(outFile, "utf8");
    assert(r1 !== null && r2 !== null, "both calls returned");
    assert(before === after, "second generation produces identical bytes");
  }

  // --- buildCodexCavemanPreamble ---
  {
    const skill = "---\nname: caveman\n---\n\nRespond terse.";
    assert(buildCodexCavemanPreamble("off", skill) === "", "off → empty preamble");
    assert(buildCodexCavemanPreamble("full", "") === "", "empty skill text → empty preamble");
    const pre = buildCodexCavemanPreamble("ultra", skill);
    assert(pre.startsWith("[CAVEMAN MODE — level: ultra]"), `preamble header: ${pre.slice(0, 60)}`);
    assert(pre.includes("Respond terse."), "skill text embedded");
    assert(pre.endsWith("\n\n---\n\n"), "preamble ends with separator");
    // wenyan
    const pre2 = buildCodexCavemanPreamble("wenyan-ultra", skill);
    assert(pre2.includes("level: wenyan-ultra"), "wenyan-ultra labeled");
  }

  // --- shell-quoting: spaces in cavemanDir survive ---
  {
    const spaced = path.join(tmp, "dir with spaces");
    const spacedOut = path.join(tmp, "out2", "settings.json");
    setupFakeCavemanDir(spaced);
    const r = ensureCavemanReadyAt({ cavemanDir: spaced, outFile: spacedOut });
    assert(r !== null, "spaced dir generates");
    const parsed = JSON.parse(fs.readFileSync(spacedOut, "utf8"));
    const cmd = parsed.hooks.SessionStart[0].hooks[0].command;
    // Should be single-quoted so the shell doesn't split on the space
    assert(cmd.includes("'") && cmd.includes("dir with spaces"), `quoted spaced path: ${cmd}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("✅ cavemanLink verified — missing-source null, settings generation, idempotency, codex preamble, spaced paths");
}

main();
