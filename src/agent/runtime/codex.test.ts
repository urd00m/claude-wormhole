// Direct verification of CodexRuntime. We never spawn a real `codex`
// subprocess — instead a fake CodexProcessFactory yields synthesized
// JSONL lines and a fake exit code. Tests inject a predictable
// last-message file path and pre-write the "final agent text" to it so
// the runtime's `-o` read returns deterministic content.
//
// Event shape is the REAL `codex --json` stdout wire format, verified
// against codex v0.133.0:
//   {"type":"thread.started","thread_id":"..."}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{...}}
//   {"type":"error","message":"..."}                     (failures)
//   {"type":"turn.failed","error":{"message":"..."}}     (failures)
//
// This is DIFFERENT from the persisted rollout file shape (session_meta /
// event_msg / payload.type) — an early version of this test used the
// rollout format and the runtime accordingly, which broke against the
// real binary. If you're updating this file, run a smoke probe like
// `codex exec --json --skip-git-repo-check --cd /tmp -- "say hi"`
// to confirm the wire is still what we expect.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CodexRuntime } from "./codex.js";
import type { CodexProcess, CodexProcessOpts } from "./codexProcess.js";
import type { Runtime } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type CapturedSpawn = {
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

type FakeProcessConfig = {
  lines: string[];
  exitCode?: number;
  stderr?: string;
  /**
   * If provided, called with the args before the lines stream is consumed
   * — lets a test pre-populate the last-message file at the path the
   * runtime is about to read from.
   */
  beforeRun?: (args: string[]) => Promise<void>;
};

function makeFactory(
  captured: CapturedSpawn[],
  responses: FakeProcessConfig[],
): import("./codexProcess.js").CodexProcessFactory {
  let call = 0;
  return (opts: CodexProcessOpts): CodexProcess => {
    captured.push({ args: opts.args, cwd: opts.cwd, env: opts.env });
    const cfg = responses[call] ?? responses[responses.length - 1] ?? { lines: [] };
    call += 1;

    const exitCode = cfg.exitCode ?? 0;
    const stderr = cfg.stderr ?? "";

    const proc: CodexProcess = {
      lines: () => {
        const linesArray = cfg.lines;
        const beforeRun = cfg.beforeRun;
        const argsCopy = [...opts.args];
        return (async function* () {
          if (beforeRun) await beforeRun(argsCopy);
          for (const l of linesArray) yield l;
        })();
      },
      stderr: async () => stderr,
      wait: async () => exitCode,
      kill: () => {
        /* no-op in fake */
      },
    };
    return proc;
  };
}

const TMP_ROOT = path.join(os.tmpdir(), `wormhole-codex-test-${Date.now()}`);

async function ensureTmp(): Promise<void> {
  await fs.mkdir(TMP_ROOT, { recursive: true });
}

function lastMsgPathFor(label: string): string {
  return path.join(TMP_ROOT, `last-${label}-${Math.random().toString(36).slice(2)}.txt`);
}

/** thread.started — carries the session UUID we pin for resume. */
function metaLine(id: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: id });
}

/** item.completed with an agent_message item — the way Codex surfaces text. */
function agentMessageLine(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { id: `item_${Math.random().toString(36).slice(2, 8)}`, type: "agent_message", text },
  });
}

function turnStartedLine(): string {
  return JSON.stringify({ type: "turn.started" });
}

function turnCompletedLine(): string {
  return JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  });
}

/** turn.complete equivalent for the legacy helper name — kept for callers below. */
function taskCompleteLine(_text: string): string {
  return turnCompletedLine();
}

/** error event — carries the human-readable diagnostic on stdout. */
function errorLine(message: string): string {
  return JSON.stringify({ type: "error", message });
}

/** turn.failed event — same role as `error` but wraps in .error.message. */
function turnFailedLine(message: string): string {
  return JSON.stringify({ type: "turn.failed", error: { message } });
}

type Recorded = {
  text: string[];
  toolStarts: Array<{ id: string; name: string }>;
  toolEnds: Array<{ id: string; ok: boolean }>;
  finals: string[];
};

function emptyRecorded(): Recorded {
  return { text: [], toolStarts: [], toolEnds: [], finals: [] };
}

async function main() {
  await ensureTmp();

  // --- (1) Port contract ---
  // CodexRuntime must satisfy the Runtime interface: name, workdir, send,
  // setWorkdir, resetConversation. Structural assignment below; if the
  // port shape changes, this assignment fails to typecheck.
  {
    const rt: Runtime = new CodexRuntime({
      threadKey: "port:check",
      workdir: "/tmp",
      processFactory: makeFactory([], [{ lines: [] }]),
    });
    assert(rt.name === "codex", `name: ${rt.name}`);
    assert(rt.workdir === "/tmp", `workdir: ${rt.workdir}`);
    const initial: string = "/tmp";
    const next: string = "/var/tmp";
    rt.setWorkdir(next);
    assert(rt.workdir === next, "workdir reflects setWorkdir");
    rt.setWorkdir(initial); // back, just to keep state predictable
    rt.resetConversation(); // must not throw
  }

  // --- (2) Fresh send: spawns `codex exec`, NOT `codex exec resume` ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("fresh");
    const rt = new CodexRuntime({
      threadKey: "t1",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [
            metaLine("11111111-2222-3333-4444-555555555555"),
            agentMessageLine("hello from codex"),
            taskCompleteLine("hello from codex"),
          ],
          beforeRun: async () => {
            await fs.writeFile(lastFile, "hello from codex");
          },
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });

    const rec = emptyRecorded();
    const out = await rt.send(
      { text: "hi" },
      {
        onText: (t) => rec.text.push(t),
        onFinal: (t) => rec.finals.push(t),
      },
    );

    assert(captured.length === 1, "one spawn");
    const args = captured[0].args;
    assert(args[0] === "exec", "first arg is 'exec'");
    assert(args[1] !== "resume", "fresh send does NOT use 'resume'");
    assert(args.includes("--json"), "--json present");
    assert(args.includes("--skip-git-repo-check"), "--skip-git-repo-check present");
    assert(args.includes("--dangerously-bypass-approvals-and-sandbox"), "bypass flag present");
    assert(args.includes("--sandbox"), "fresh send includes --sandbox");
    const sandboxIdx = args.indexOf("--sandbox");
    assert(args[sandboxIdx + 1] === "workspace-write", "sandbox = workspace-write");
    assert(args.includes("--cd"), "--cd present");
    assert(args[args.indexOf("--cd") + 1] === TMP_ROOT, "cwd matches workdir");
    assert(args.includes("-o"), "-o present");
    assert(args[args.indexOf("-o") + 1] === lastFile, "-o file matches injected path");
    assert(args[args.length - 1] === "hi", "prompt is final positional");
    assert(args[args.length - 2] === "--", "-- separator before prompt");
    // Regression guard: when env.OPENAI_MODEL is blank (the default) we
    // must NOT pass `-m`. The tests run under scripts/test.sh which sets
    // ANTHROPIC_API_KEY=stub and leaves OPENAI_MODEL unset → the schema's
    // empty-string default applies.
    assert(!args.includes("-m"), `expected no -m flag when OPENAI_MODEL is blank, args: ${args.join(" ")}`);

    assert(rec.text.length === 1 && rec.text[0] === "hello from codex", `onText: ${JSON.stringify(rec.text)}`);
    assert(rec.finals.length === 1 && rec.finals[0] === "hello from codex", "final from -o");
    assert(out.finalText === "hello from codex", "returned finalText");
  }

  // --- (3) sessionId pinning: first send mints, second uses `exec resume` ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile1 = lastMsgPathFor("pin1");
    const lastFile2 = lastMsgPathFor("pin2");
    const SESSION = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const files = [lastFile1, lastFile2];
    let fileIdx = 0;

    const rt = new CodexRuntime({
      threadKey: "t2",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine(SESSION), agentMessageLine("turn 1"), taskCompleteLine("turn 1")],
          beforeRun: async () => fs.writeFile(lastFile1, "turn 1"),
        },
        {
          lines: [metaLine(SESSION), agentMessageLine("turn 2"), taskCompleteLine("turn 2")],
          beforeRun: async () => fs.writeFile(lastFile2, "turn 2"),
        },
      ]),
      lastMessageFileFactory: () => files[fileIdx++],
    });

    await rt.send({ text: "first" });
    await rt.send({ text: "second" });

    assert(captured.length === 2, "two spawns");
    const args2 = captured[1].args;
    assert(args2[0] === "exec" && args2[1] === "resume", "second send uses 'exec resume'");
    // The session UUID should appear as a positional argument before the
    // prompt separator. Find the index of `--` and check the arg right
    // before it is the prompt, and the one before that is the UUID.
    const sepIdx = args2.indexOf("--");
    assert(sepIdx > 0, "-- separator present");
    assert(args2[sepIdx - 1] === SESSION, `session UUID before --: ${args2[sepIdx - 1]}`);
    assert(args2[sepIdx + 1] === "second", "prompt after separator");
    // Resume args MUST NOT include --cd / --sandbox / --add-dir — `codex exec
    // resume` rejects these (the resumed session's rollout already pins
    // cwd/sandbox). Passing them anyway → "unexpected argument '--cd' found".
    // Regression guard for the production bug fixed in Phase 8.
    assert(!args2.includes("--cd"), "resume MUST omit --cd (regression: codex rejects it)");
    assert(!args2.includes("--sandbox"), "resume omits --sandbox (inherits from rollout)");
    assert(!args2.includes("--add-dir"), "resume omits --add-dir");
  }

  // --- (4) setWorkdir rotates: next send is fresh `exec`, not resume ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile1 = lastMsgPathFor("wd1");
    const lastFile2 = lastMsgPathFor("wd2");
    const files = [lastFile1, lastFile2];
    let fileIdx = 0;
    const SESSION = "ffffffff-aaaa-bbbb-cccc-dddddddddddd";

    const rt = new CodexRuntime({
      threadKey: "t3",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine(SESSION), agentMessageLine("old"), taskCompleteLine("old")],
          beforeRun: async () => fs.writeFile(lastFile1, "old"),
        },
        {
          lines: [
            metaLine("99999999-9999-9999-9999-999999999999"),
            agentMessageLine("new"),
            taskCompleteLine("new"),
          ],
          beforeRun: async () => fs.writeFile(lastFile2, "new"),
        },
      ]),
      lastMessageFileFactory: () => files[fileIdx++],
    });

    await rt.send({ text: "in old" });
    const newWorkdir = path.join(TMP_ROOT, "new-subdir");
    await fs.mkdir(newWorkdir, { recursive: true });
    rt.setWorkdir(newWorkdir);
    await rt.send({ text: "in new" });

    const args2 = captured[1].args;
    assert(args2[0] === "exec" && args2[1] !== "resume", "after setWorkdir, fresh exec (not resume)");
    assert(args2.includes("--cd"), "second send has --cd");
    assert(args2[args2.indexOf("--cd") + 1] === newWorkdir, "second send cwd is new workdir");
  }

  // --- (5) setWorkdir to same workdir is a no-op (still resumes) ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile1 = lastMsgPathFor("same1");
    const lastFile2 = lastMsgPathFor("same2");
    const files = [lastFile1, lastFile2];
    let fileIdx = 0;
    const SESSION = "12345678-1234-1234-1234-123456789012";

    const rt = new CodexRuntime({
      threadKey: "t-same",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine(SESSION), agentMessageLine("a"), taskCompleteLine("a")],
          beforeRun: async () => fs.writeFile(lastFile1, "a"),
        },
        {
          lines: [agentMessageLine("b"), taskCompleteLine("b")],
          beforeRun: async () => fs.writeFile(lastFile2, "b"),
        },
      ]),
      lastMessageFileFactory: () => files[fileIdx++],
    });

    await rt.send({ text: "1" });
    rt.setWorkdir(TMP_ROOT); // same path
    await rt.send({ text: "2" });

    const args2 = captured[1].args;
    assert(args2[1] === "resume", "no-op setWorkdir preserves resume");
  }

  // --- (6) resetConversation rotates without touching workdir ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile1 = lastMsgPathFor("reset1");
    const lastFile2 = lastMsgPathFor("reset2");
    const files = [lastFile1, lastFile2];
    let fileIdx = 0;

    const rt = new CodexRuntime({
      threadKey: "t-reset",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine("a"), agentMessageLine("1"), taskCompleteLine("1")],
          beforeRun: async () => fs.writeFile(lastFile1, "1"),
        },
        {
          lines: [metaLine("b"), agentMessageLine("2"), taskCompleteLine("2")],
          beforeRun: async () => fs.writeFile(lastFile2, "2"),
        },
      ]),
      lastMessageFileFactory: () => files[fileIdx++],
    });

    await rt.send({ text: "1" });
    rt.resetConversation();
    await rt.send({ text: "2" });

    const args2 = captured[1].args;
    assert(args2[1] !== "resume", "resetConversation forces fresh exec");
    assert(rt.workdir === TMP_ROOT, "workdir unchanged");
  }

  // --- (7) Non-zero exit code propagates as thrown error ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("err");
    const rt = new CodexRuntime({
      threadKey: "t-err",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        { lines: [metaLine("x")], exitCode: 1, stderr: "boom: model unavailable" },
      ]),
      lastMessageFileFactory: () => lastFile,
    });

    let threw = false;
    try {
      await rt.send({ text: "hi" });
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      assert(msg.includes("code 1"), `error msg should include exit code: ${msg}`);
      assert(msg.includes("boom"), `error msg should include stderr: ${msg}`);
    }
    assert(threw, "must throw on non-zero exit");
  }

  // --- (8) Dangling-rollout recovery: 2nd send fails → sessionId cleared ---
  // Scenario: turn 1 succeeds and pins SESSION_A. Then the user prunes
  // ~/.codex/sessions/. Turn 2's `exec resume` fails with a "session not
  // found" stderr; the runtime should throw, but also clear its pinned
  // UUID so turn 3 starts a fresh `exec` (not yet another doomed resume).
  {
    const captured: CapturedSpawn[] = [];
    const lastFile1 = lastMsgPathFor("d1");
    const lastFile2 = lastMsgPathFor("d2");
    const lastFile3 = lastMsgPathFor("d3");
    const files = [lastFile1, lastFile2, lastFile3];
    let fileIdx = 0;
    const SESSION_A = "deadbeef-dead-beef-dead-beefdeadbeef";

    const rt = new CodexRuntime({
      threadKey: "t-dangle",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine(SESSION_A), agentMessageLine("turn1"), taskCompleteLine("turn1")],
          beforeRun: async () => fs.writeFile(lastFile1, "turn1"),
        },
        {
          lines: [],
          exitCode: 1,
          stderr: "error: session not found: deadbeef-dead-beef-dead-beefdeadbeef",
        },
        {
          lines: [
            metaLine("11111111-1111-1111-1111-111111111111"),
            agentMessageLine("turn3"),
            taskCompleteLine("turn3"),
          ],
          beforeRun: async () => fs.writeFile(lastFile3, "turn3"),
        },
      ]),
      lastMessageFileFactory: () => files[fileIdx++],
    });

    await rt.send({ text: "1" });
    let threw = false;
    try {
      await rt.send({ text: "2" });
    } catch {
      threw = true;
    }
    assert(threw, "dangling resume must throw");

    // Turn 3 should now start fresh — `exec`, no `resume`.
    await rt.send({ text: "3" });
    const args3 = captured[2].args;
    assert(args3[1] !== "resume", "post-dangle send starts fresh");
  }

  // --- (9) Defensive parsing: garbage and unknown event types ignored ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("def");
    const rt = new CodexRuntime({
      threadKey: "t-def",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [
            "", // empty line
            "not json at all",
            JSON.stringify({ type: "future_event_we_dont_understand", payload: { x: 1 } }),
            metaLine("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"),
            agentMessageLine("ok"),
            JSON.stringify({ type: "event_msg", payload: { type: "token_count", input: 100 } }),
            taskCompleteLine("ok"),
            "trailing garbage",
          ],
          beforeRun: async () => fs.writeFile(lastFile, "ok"),
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });

    const rec = emptyRecorded();
    const out = await rt.send(
      { text: "hi" },
      {
        onText: (t) => rec.text.push(t),
        onFinal: (t) => rec.finals.push(t),
      },
    );
    assert(rec.text.join("") === "ok", `only valid agent text surfaces: ${JSON.stringify(rec.text)}`);
    assert(out.finalText === "ok", "final from -o");
  }

  // --- (9.5) Real-shape stdout error events surface as the thrown error ---
  // Regression for the production "Reading additional input from stdin..."
  // bug: codex's real errors come on stdout as `{type:"error", message:...}`
  // or `{type:"turn.failed", error:{message:...}}`. stderr only contains the
  // harmless stdin-mode log. The runtime must prefer the stdout diagnostic.
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("stdouterr");
    const innerErrJson = JSON.stringify({
      type: "error",
      status: 400,
      error: {
        type: "invalid_request_error",
        message: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    const rt = new CodexRuntime({
      threadKey: "t-stdouterr",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [
            metaLine("00000000-0000-0000-0000-000000000001"),
            turnStartedLine(),
            errorLine(innerErrJson),
            turnFailedLine(innerErrJson),
          ],
          exitCode: 1,
          stderr: "Reading additional input from stdin...",
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });

    let caught: string | null = null;
    try {
      await rt.send({ text: "hi" });
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err);
    }
    assert(caught !== null, "must throw");
    // Innermost human message is unwrapped from the nested OpenAI error JSON.
    assert(
      caught.includes("model is not supported"),
      `expected unwrapped model error in message, got: ${caught}`,
    );
    // Stderr must NOT be the leading diagnostic.
    assert(
      !caught.includes("Reading additional input"),
      `stderr leak: ${caught} (should prefer the stdout error event)`,
    );
  }

  // --- (9.6) turn.failed without preceding error event still surfaces ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("turnfailed-only");
    const rt = new CodexRuntime({
      threadKey: "t-turnfailed",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine("aaaa"), turnStartedLine(), turnFailedLine("rate limit hit")],
          exitCode: 1,
          stderr: "",
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });
    let caught: string | null = null;
    try {
      await rt.send({ text: "hi" });
    } catch (err) {
      caught = err instanceof Error ? err.message : String(err);
    }
    assert(caught !== null && caught.includes("rate limit hit"), `expected turn.failed message: ${caught}`);
  }

  // --- (10) Empty/missing -o file → sentinel final ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("empty");
    const rt = new CodexRuntime({
      threadKey: "t-empty",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine("z"), agentMessageLine("partial")],
          // Note: NO beforeRun → -o file is never written.
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });

    const rec = emptyRecorded();
    const out = await rt.send({ text: "hi" }, { onFinal: (t) => rec.finals.push(t) });
    assert(out.finalText === "_(no response)_", `sentinel: ${out.finalText}`);
    assert(rec.finals[0] === "_(no response)_", "onFinal fires with sentinel");
  }

  // --- (11) Attachments are surfaced in the prompt ---
  // Smoke check: when SessionInput.attachments is non-empty, the prompt
  // built into the CLI args mentions ./uploads/ and the filenames. Same
  // contract as ClaudeRuntime via buildPrompt.
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("att");
    const rt = new CodexRuntime({
      threadKey: "t-att",
      workdir: TMP_ROOT,
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine("att"), agentMessageLine("got it"), taskCompleteLine("got it")],
          beforeRun: async () => fs.writeFile(lastFile, "got it"),
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });

    await rt.send({ text: "please analyze", attachments: ["report.pdf", "image.png"] });
    const args = captured[0].args;
    const prompt = args[args.length - 1];
    assert(prompt.includes("./uploads/"), "prompt mentions uploads dir");
    assert(prompt.includes("report.pdf"), "prompt lists report.pdf");
    assert(prompt.includes("image.png"), "prompt lists image.png");
    assert(prompt.includes("please analyze"), "prompt includes user text");
  }

  // --- (12) launch config (alias) → -m model, effort, extra args in argv ---
  {
    const captured: CapturedSpawn[] = [];
    const lastFile = lastMsgPathFor("launch");
    const rt = new CodexRuntime({
      threadKey: "t-launch",
      workdir: TMP_ROOT,
      launch: { model: "gpt-5", effort: "high", args: ["-c", "sandbox_mode=read-only"] },
      processFactory: makeFactory(captured, [
        {
          lines: [metaLine("launch"), agentMessageLine("ok"), taskCompleteLine("ok")],
          beforeRun: async () => fs.writeFile(lastFile, "ok"),
        },
      ]),
      lastMessageFileFactory: () => lastFile,
    });
    await rt.send({ text: "hi" });
    const args = captured[0].args;
    // model
    assert(args.includes("-m") && args[args.indexOf("-m") + 1] === "gpt-5", "launch model → -m gpt-5");
    // effort → -c model_reasoning_effort=high
    assert(
      args.some((a, i) => a === "-c" && args[i + 1] === "model_reasoning_effort=high"),
      `effort → -c model_reasoning_effort=high: ${args.join(" ")}`,
    );
    // extra args present and BEFORE the -- separator
    const sep = args.indexOf("--");
    const sandboxIdx = args.findIndex((a, i) => a === "-c" && args[i + 1] === "sandbox_mode=read-only");
    assert(sandboxIdx > 0 && sandboxIdx < sep, `extra alias args spliced before --: ${args.join(" ")}`);
  }

  // Cleanup tmp tree.
  await fs.rm(TMP_ROOT, { recursive: true, force: true });

  console.log(
    "✅ CodexRuntime verified — port, fresh exec, exec resume pinning, workdir/reset rotation, " +
      "non-zero exit propagation, dangling rollout recovery, defensive parsing, sentinel final, attachments, launch-config",
  );
}

main().catch(async (err) => {
  console.error("❌ CodexRuntime verification failed:", err);
  try {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  process.exit(1);
});
