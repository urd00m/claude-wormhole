// Verify detectCavemanAction: bot-mention stripping, level recognition,
// off/status routing, polite-prefix tolerance, prose rejection.

import { detectCavemanAction } from "./cavemanMatcher.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function main() {
  // --- bare "caveman" → on at full ---
  {
    const a = detectCavemanAction("caveman");
    assert(a && a.kind === "set" && a.level === "full", `bare caveman → full: ${JSON.stringify(a)}`);
  }
  {
    const a = detectCavemanAction("caveman on");
    assert(a && a.kind === "set" && a.level === "full", `caveman on → full: ${JSON.stringify(a)}`);
  }
  {
    const a = detectCavemanAction("enable caveman");
    assert(a && a.kind === "set" && a.level === "full", `enable caveman → full`);
  }

  // --- level words ---
  {
    const lite = detectCavemanAction("caveman lite");
    assert(lite && lite.kind === "set" && lite.level === "lite", `lite`);
    const ultra = detectCavemanAction("caveman ultra");
    assert(ultra && ultra.kind === "set" && ultra.level === "ultra", `ultra`);
    const wenyan = detectCavemanAction("caveman wenyan");
    assert(wenyan && wenyan.kind === "set" && wenyan.level === "wenyan", `wenyan`);
    const wenyan2 = detectCavemanAction("caveman wenyan-ultra");
    assert(wenyan2 && wenyan2.kind === "set" && wenyan2.level === "wenyan-ultra", `wenyan-ultra`);
  }

  // --- reversed order: "<level> caveman" ---
  {
    const a = detectCavemanAction("ultra caveman");
    assert(a && a.kind === "set" && a.level === "ultra", `reversed`);
  }

  // --- off variants ---
  {
    for (const phrase of [
      "caveman off",
      "disable caveman",
      "no caveman",
      "stop caveman",
      "turn off caveman",
      "turn caveman off",
    ]) {
      const a = detectCavemanAction(phrase);
      assert(a && a.kind === "set" && a.level === "off", `off variant "${phrase}": ${JSON.stringify(a)}`);
    }
  }

  // --- status ---
  {
    const a = detectCavemanAction("caveman status");
    assert(a && a.kind === "status", `caveman status → status`);
    const b = detectCavemanAction("status caveman");
    assert(b && b.kind === "status", `status caveman → status`);
  }

  // --- bot mention stripping ---
  {
    const a = detectCavemanAction("<@U123ABC> caveman on");
    assert(a && a.kind === "set" && a.level === "full", `mention stripped`);
  }

  // --- trailing punctuation ---
  {
    const a = detectCavemanAction("caveman on!");
    assert(a && a.kind === "set" && a.level === "full", `trailing !`);
    const b = detectCavemanAction("caveman ultra.");
    assert(b && b.kind === "set" && b.level === "ultra", `trailing .`);
  }

  // --- polite prefixes ---
  {
    const a = detectCavemanAction("please caveman on");
    assert(a && a.kind === "set" && a.level === "full", `please`);
    const b = detectCavemanAction("pls caveman lite");
    assert(b && b.kind === "set" && b.level === "lite", `pls`);
  }

  // --- prose rejection ---
  {
    for (const phrase of [
      "I think caveman is cool",
      "what does caveman mean",
      "tell me about cavemen",
      "Hi, can you turn on caveman mode for me", // multi-clause prose
      "",
      "    ",
      "hello",
    ]) {
      assert(detectCavemanAction(phrase) === null, `prose rejected "${phrase}"`);
    }
  }

  // --- unknown level falls through ---
  {
    assert(detectCavemanAction("caveman fast") === null, `unknown level → null`);
    assert(detectCavemanAction("caveman 9000") === null, `numeric level → null`);
  }

  // --- bad input types ---
  {
    assert(detectCavemanAction(undefined) === null, `undefined → null`);
    assert(detectCavemanAction(null) === null, `null → null`);
  }

  console.log(
    "✅ detectCavemanAction verified — set/level/off/status, mention/punctuation/polite tolerance, prose rejection",
  );
}

main();
