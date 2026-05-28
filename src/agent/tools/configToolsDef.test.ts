// Verify the macro/alias management tools (macro_set/remove/list,
// alias_set/remove/list) and the underlying store write methods, using
// tmp-file stores so the real data/*.json is never touched.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MacroStore } from "../macroStore.js";
import { AliasStore } from "../aliasStore.js";
import {
  macroSetDef,
  macroRemoveDef,
  macroListDef,
  aliasSetDef,
  aliasRemoveDef,
  aliasListDef,
} from "./configToolsDef.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfgtools-"));
  const macrosFile = path.join(tmp, "macros.json");
  const aliasesFile = path.join(tmp, "aliases.json");
  const macros = new MacroStore(macrosFile);
  const aliases = new AliasStore(aliasesFile);

  // ============ store write methods (persistence) ============
  {
    macros.set("swd", "set working dir");
    assert(macros.all().swd === "set working dir", "macro set in cache");
    assert(new MacroStore(macrosFile).all().swd === "set working dir", "macro persisted to file");
    assert(macros.remove("swd") === true, "macro remove returns true");
    assert(macros.remove("swd") === false, "macro remove absent → false");
    assert(new MacroStore(macrosFile).all().swd === undefined, "macro removal persisted");
    let threw = false;
    try {
      macros.set("has space", "x");
    } catch {
      threw = true;
    }
    assert(threw, "invalid macro name rejected");

    aliases.set("custom_claude", { runtime: "claude", model: "claude-opus-4-7", effort: "high" });
    const reread = new AliasStore(aliasesFile).get("custom_claude");
    assert(reread?.runtime === "claude" && reread.model === "claude-opus-4-7", "alias persisted");
    assert(aliases.remove("custom_claude") === true, "alias remove");
    let threw2 = false;
    try {
      // @ts-expect-error invalid runtime at runtime
      aliases.set("bad", { runtime: "gpt" });
    } catch {
      threw2 = true;
    }
    assert(threw2, "invalid alias def rejected");
  }

  // ============ macro tools ============
  {
    const m = new MacroStore(path.join(tmp, "m2.json"));
    const setRes = await macroSetDef(m).handler({ name: "rev", expansion: "review the diff" });
    assert(setRes.isError !== true && setRes.content[0].text.includes("rev"), `macro_set: ${JSON.stringify(setRes)}`);
    assert(m.all().rev === "review the diff", "macro_set wrote through");

    const list = await macroListDef(m).handler({});
    assert(list.content[0].text.includes("rev") && list.content[0].text.includes("review the diff"), "macro_list shows it");

    const badName = await macroSetDef(m).handler({ name: "no good", expansion: "x" });
    assert(badName.isError === true, "macro_set rejects whitespace name");

    const rm = await macroRemoveDef(m).handler({ name: "rev" });
    assert(rm.isError !== true && rm.content[0].text.includes("Removed"), "macro_remove");
    const rmMiss = await macroRemoveDef(m).handler({ name: "nope" });
    assert(rmMiss.isError === true, "macro_remove missing → error");

    const empty = await macroListDef(m).handler({});
    assert(empty.content[0].text.includes("No macros"), "empty list message");
  }

  // ============ alias tools ============
  {
    const a = new AliasStore(path.join(tmp, "a2.json"));
    const setRes = await aliasSetDef(a).handler({
      name: "custom_codex",
      runtime: "codex",
      model: "gpt-5",
      effort: "medium",
      codexArgs: ["-c", "x=y"],
    } as never);
    assert(setRes.isError !== true && setRes.content[0].text.includes("custom_codex"), `alias_set: ${JSON.stringify(setRes)}`);
    const def = a.get("custom_codex");
    assert(def?.runtime === "codex" && def.model === "gpt-5" && def.effort === "medium", "alias_set wrote fields");
    assert(JSON.stringify(def?.codexArgs) === JSON.stringify(["-c", "x=y"]), "codexArgs written");

    // claudeArgs path
    await aliasSetDef(a).handler({
      name: "custom_claude",
      runtime: "claude",
      claudeArgs: { "fallback-model": "claude-sonnet-4-6", verbose: null },
    } as never);
    const cc = a.get("custom_claude");
    assert(cc?.claudeArgs?.["fallback-model"] === "claude-sonnet-4-6" && cc.claudeArgs.verbose === null, "claudeArgs written");

    const list = await aliasListDef(a).handler({});
    assert(list.content[0].text.includes("custom_codex") && list.content[0].text.includes("runtime: codex"), "alias_list");

    const rm = await aliasRemoveDef(a).handler({ name: "custom_codex" });
    assert(rm.isError !== true && rm.content[0].text.includes("Removed"), "alias_remove");
    const rmMiss = await aliasRemoveDef(a).handler({ name: "ghost" });
    assert(rmMiss.isError === true, "alias_remove missing → error");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    "✅ configToolsDef verified — store set/remove persistence + macro_* and alias_* tool handlers (set/list/remove, validation, codexArgs/claudeArgs)",
  );
}

main().catch((err) => {
  console.error("❌ configToolsDef verification failed:", err);
  process.exit(1);
});
