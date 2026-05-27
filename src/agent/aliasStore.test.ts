// Verify launch aliases: AliasStore (defs), ActiveAliasStore (per-thread
// selection), parseAliasInvocation (tokenization), launchConfigOf, and the
// pure decideLaunch resolution. No singletons / no real Claude or codex.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AliasStore,
  ActiveAliasStore,
  parseAliasInvocation,
  launchConfigOf,
  type AliasDef,
} from "./aliasStore.js";
import { decideLaunch } from "./manager.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "alias-"));

  // ============ AliasStore (definitions) ============

  // --- (1) valid defs load; fields parsed ---
  {
    const f = path.join(tmp, "aliases.json");
    fs.writeFileSync(
      f,
      JSON.stringify({
        custom_claude: { runtime: "claude", model: "claude-opus-4-7", effort: "high" },
        custom_codex: { runtime: "codex", model: "gpt-5", effort: "medium", args: ["-c", "x=y"] },
      }),
    );
    const s = new AliasStore(f);
    const cc = s.get("custom_claude");
    assert(cc?.runtime === "claude" && cc.model === "claude-opus-4-7" && cc.effort === "high", "claude def");
    const cx = s.get("custom_codex");
    assert(cx?.runtime === "codex" && JSON.stringify(cx.args) === JSON.stringify(["-c", "x=y"]), "codex def + args");
    assert(s.names().sort().join(",") === "custom_claude,custom_codex", "names()");
  }

  // --- (2) invalid entries dropped: bad runtime, bad effort, bad name, non-object ---
  {
    const f = path.join(tmp, "bad.json");
    fs.writeFileSync(
      f,
      JSON.stringify({
        ok: { runtime: "claude" },
        badruntime: { runtime: "gpt" },
        nornt: { model: "x" },
        bare: 42,
        "has space": { runtime: "codex" },
        bordeffort: { runtime: "claude", effort: "ultra" }, // invalid effort dropped, def kept
      }),
    );
    const s = new AliasStore(f);
    assert(s.get("ok")?.runtime === "claude", "valid kept");
    assert(s.get("badruntime") === undefined, "bad runtime dropped");
    assert(s.get("nornt") === undefined, "missing runtime dropped");
    assert(s.get("bare") === undefined, "non-object dropped");
    assert(s.get("has space") === undefined, "whitespace name dropped");
    const be = s.get("bordeffort");
    assert(be?.runtime === "claude" && be.effort === undefined, "invalid effort dropped but def kept");
  }

  // --- (3) missing file → no aliases; malformed → no aliases ---
  {
    assert(new AliasStore(path.join(tmp, "nope.json")).names().length === 0, "missing → empty");
    const bad = path.join(tmp, "malformed.json");
    fs.writeFileSync(bad, "{ not json");
    assert(new AliasStore(bad).names().length === 0, "malformed → empty");
  }

  // --- (4) mtime reload ---
  {
    const f = path.join(tmp, "live.json");
    fs.writeFileSync(f, JSON.stringify({ a: { runtime: "claude" } }));
    const s = new AliasStore(f);
    assert(s.get("a") !== undefined && s.get("b") === undefined, "initial");
    fs.writeFileSync(f, JSON.stringify({ a: { runtime: "claude" }, b: { runtime: "codex" } }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(f, future, future);
    assert(s.get("b")?.runtime === "codex", "reloaded new alias after mtime bump");
  }

  // ============ ActiveAliasStore (per-thread) ============
  {
    const f = path.join(tmp, "thread-aliases.json");
    const s = new ActiveAliasStore(f);
    s.set("C:T1", "custom_claude");
    assert(s.get("C:T1") === "custom_claude", "set/get");
    assert(new ActiveAliasStore(f).get("C:T1") === "custom_claude", "persisted across instances");
    assert(s.remove("C:T1") === true && s.get("C:T1") === undefined, "remove");
    assert(s.remove("C:T1") === false, "remove absent → false");
  }

  // ============ parseAliasInvocation ============
  {
    const names = new Set(["custom_claude", "custom_codex"]);

    // alias alone
    let r = parseAliasInvocation("custom_claude", names);
    assert(r?.alias === "custom_claude" && r.workdirArg === null && r.prompt === "", "alias alone");

    // alias + workdir
    r = parseAliasInvocation("custom_claude ~/code/M5CacheRE", names);
    assert(r?.workdirArg === "~/code/M5CacheRE" && r.prompt === "", "alias + workdir");

    // alias + workdir + prompt
    r = parseAliasInvocation("custom_claude ~/code/api review the readme", names);
    assert(r?.alias === "custom_claude" && r.workdirArg === "~/code/api" && r.prompt === "review the readme", "alias + wd + prompt");

    // leading whitespace tolerated
    r = parseAliasInvocation("   custom_codex /tmp hi", names);
    assert(r?.alias === "custom_codex" && r.workdirArg === "/tmp" && r.prompt === "hi", "leading ws");

    // non-alias first token → null
    assert(parseAliasInvocation("hello world", names) === null, "non-alias → null");
    assert(parseAliasInvocation("", names) === null, "empty → null");
    // alias name only as a substring of a larger token → null
    assert(parseAliasInvocation("custom_claudex foo", names) === null, "substring first token → null");
  }

  // ============ launchConfigOf ============
  {
    const def: AliasDef = { runtime: "codex", model: "gpt-5", effort: "high", args: ["-c", "a=b"] };
    const lc = launchConfigOf(def);
    assert(lc.model === "gpt-5" && lc.effort === "high" && JSON.stringify(lc.args) === JSON.stringify(["-c", "a=b"]), "launchConfigOf maps fields");
    assert(!("runtime" in lc), "launch config excludes runtime");
  }

  // ============ decideLaunch (pure resolution) ============
  {
    // live alias wins → its runtime + launch
    const def: AliasDef = { runtime: "codex", model: "gpt-5", effort: "low" };
    let d = decideLaunch({ aliasName: "x", aliasDef: def, runtimeOverride: "claude", defaultRuntime: "claude" });
    assert(d.runtime === "codex" && d.launch?.model === "gpt-5", "live alias wins");

    // dangling alias (name but no def) → fall through to override
    d = decideLaunch({ aliasName: "gone", aliasDef: undefined, runtimeOverride: "codex", defaultRuntime: "claude" });
    assert(d.runtime === "codex" && d.launch === undefined, "dangling alias → override, no launch");

    // no alias → override
    d = decideLaunch({ aliasName: undefined, aliasDef: undefined, runtimeOverride: "codex", defaultRuntime: "claude" });
    assert(d.runtime === "codex" && d.launch === undefined, "no alias → override");

    // no alias, no override → default
    d = decideLaunch({ aliasName: undefined, aliasDef: undefined, runtimeOverride: undefined, defaultRuntime: "claude" });
    assert(d.runtime === "claude", "→ default");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    "✅ aliasStore verified — defs load/validate/mtime, active store persist, parseAliasInvocation, launchConfigOf, decideLaunch",
  );
}

main().catch((err) => {
  console.error("❌ aliasStore verification failed:", err);
  process.exit(1);
});
