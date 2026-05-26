// Fixture-driven contract test for CodexRuntime.
//
// Unlike codex.test.ts (which synthesizes JSONL the runtime is supposed to
// handle), this test feeds the runtime *real* bytes captured from a live
// `codex exec --json` invocation (see ./fixtures/codex/). The captured
// bytes are the contract: if codex changes its wire format, this test
// fails before a Slack user does.
//
// This test exists because the previous test suite had ~30 cases that all
// passed against the WRONG wire shape (the persisted-rollout format, not
// the stdout-stream format). The fixture pin makes "tests pass" mean
// "the parser handles real codex output" rather than "the parser handles
// my assumptions about codex output."
//
// To refresh fixtures when codex updates, see ./fixtures/codex/README.md.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex.js";
import type { CodexProcess, CodexProcessOpts } from "./codexProcess.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, "fixtures", "codex");

async function readLines(fixturePath: string): Promise<string[]> {
  const raw = await fs.readFile(fixturePath, "utf8");
  return raw.split("\n").filter((l) => l.length > 0);
}

async function readText(fixturePath: string): Promise<string> {
  return fs.readFile(fixturePath, "utf8");
}

function makeFactoryFromFixture(
  captured: Array<{ args: string[]; cwd: string }>,
  lines: string[],
  exitCode: number,
  stderr: string,
  lastMessageContent: string | null,
  lastMessageFile: string,
): import("./codexProcess.js").CodexProcessFactory {
  return (opts: CodexProcessOpts): CodexProcess => {
    captured.push({ args: opts.args, cwd: opts.cwd });
    return {
      lines: () =>
        (async function* () {
          // Mirror real codex behavior: `-o <file>` is written at the
          // end-of-turn boundary. We honor that order so the runtime's
          // final-text read returns what codex actually wrote.
          for (const l of lines) yield l;
          if (lastMessageContent !== null) {
            await fs.writeFile(lastMessageFile, lastMessageContent);
          }
        })(),
      stderr: async () => stderr,
      wait: async () => exitCode,
      kill: () => {
        /* no-op */
      },
    };
  };
}

async function main() {
  const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "wormhole-codex-wire-"));

  try {
    // ============================================================
    // Contract 1: success-path fixture
    // ============================================================
    // The bytes in exec-success.stdout.jsonl are what codex actually
    // emitted for `codex exec --json -- "respond with 'pong'"`. If the
    // runtime parses them correctly we get: pinned thread_id, streamed
    // text "pong", final text from -o file. If codex changes its wire
    // format, this case fails — and that's the alarm.
    {
      const successLines = await readLines(path.join(FIXTURES_DIR, "exec-success.stdout.jsonl"));
      const successStderr = await readText(path.join(FIXTURES_DIR, "exec-success.stderr.txt"));
      const successLastMsg = await readText(path.join(FIXTURES_DIR, "exec-success.last-message.txt"));

      // Sanity: confirm the fixture itself looks like what we expect.
      // If someone edits the fixture in a way that drops thread.started,
      // we want to fail HERE rather than have downstream asserts fail
      // mysteriously.
      assert(successLines.length >= 4, `fixture has at least 4 events, got ${successLines.length}`);
      assert(
        successLines[0].includes('"type":"thread.started"'),
        `first event must be thread.started: ${successLines[0]}`,
      );
      assert(
        successLines.some((l) => l.includes('"type":"item.completed"')),
        "fixture must contain an item.completed event",
      );
      assert(
        successLines.some((l) => l.includes('"type":"turn.completed"')),
        "fixture must end with turn.completed",
      );

      const captured: Array<{ args: string[]; cwd: string }> = [];
      const lastFile = path.join(TMP_ROOT, "last-success.txt");
      const rt = new CodexRuntime({
        threadKey: "fixture:success",
        workdir: TMP_ROOT,
        processFactory: makeFactoryFromFixture(
          captured,
          successLines,
          0,
          successStderr,
          successLastMsg,
          lastFile,
        ),
        lastMessageFileFactory: () => lastFile,
      });

      const textChunks: string[] = [];
      const finals: string[] = [];
      const out = await rt.send(
        { text: "respond with exactly the single word 'pong'" },
        {
          onText: (t) => textChunks.push(t),
          onFinal: (t) => finals.push(t),
        },
      );

      // The runtime must stream the assistant text from item.completed.
      assert(
        textChunks.length === 1 && textChunks[0] === "pong",
        `streamed text from item.completed: ${JSON.stringify(textChunks)}`,
      );
      // Final text comes from the -o file, which holds the authoritative end-of-turn message.
      assert(
        out.finalText === successLastMsg.trim(),
        `final text matches -o file content: got '${out.finalText}', want '${successLastMsg.trim()}'`,
      );
      assert(finals.length === 1 && finals[0] === out.finalText, "onFinal fired with same text");

      // Session id pinned from thread.started — verify by triggering a
      // second send and asserting it uses `exec resume <uuid>`.
      const expectedThreadId = JSON.parse(successLines[0]).thread_id as string;
      const secondLines = [
        JSON.stringify({ type: "thread.started", thread_id: expectedThreadId }),
        JSON.stringify({
          type: "item.completed",
          item: { id: "item_0", type: "agent_message", text: "second turn" },
        }),
        JSON.stringify({ type: "turn.completed", usage: {} }),
      ];
      const lastFile2 = path.join(TMP_ROOT, "last-success-2.txt");
      const rt2Capture: Array<{ args: string[]; cwd: string }> = captured; // share, we'll inspect the 2nd entry
      // Re-arm the runtime's process factory for the 2nd send by mutating
      // — easier to just use a new runtime and re-set the session id via
      // a hand-built first send. Simpler: build a fresh runtime, send
      // twice using a factory that returns different responses on each
      // call.
      void rt2Capture;
      const dualCaptured: Array<{ args: string[]; cwd: string }> = [];
      const dualLast1 = path.join(TMP_ROOT, "dual-last-1.txt");
      const dualLast2 = path.join(TMP_ROOT, "dual-last-2.txt");
      const dualFiles = [dualLast1, dualLast2];
      let dualIdx = 0;
      let call = 0;
      const dualFactory = (opts: CodexProcessOpts): CodexProcess => {
        dualCaptured.push({ args: opts.args, cwd: opts.cwd });
        const lines = call === 0 ? successLines : secondLines;
        const lastMsg = call === 0 ? successLastMsg : "second turn";
        const file = call === 0 ? dualLast1 : dualLast2;
        call += 1;
        return {
          lines: () =>
            (async function* () {
              for (const l of lines) yield l;
              await fs.writeFile(file, lastMsg);
            })(),
          stderr: async () => "",
          wait: async () => 0,
          kill: () => {},
        };
      };
      const dualRt = new CodexRuntime({
        threadKey: "fixture:dual",
        workdir: TMP_ROOT,
        processFactory: dualFactory,
        lastMessageFileFactory: () => dualFiles[dualIdx++],
      });
      await dualRt.send({ text: "first" });
      await dualRt.send({ text: "second" });
      assert(dualCaptured[1].args[0] === "exec" && dualCaptured[1].args[1] === "resume", "resume on 2nd");
      const sepIdx = dualCaptured[1].args.indexOf("--");
      assert(
        dualCaptured[1].args[sepIdx - 1] === expectedThreadId,
        `resume uses thread_id from thread.started: got ${dualCaptured[1].args[sepIdx - 1]}, want ${expectedThreadId}`,
      );

      // Regression for the production bug — resume must NOT have --cd.
      assert(
        !dualCaptured[1].args.includes("--cd"),
        `resume MUST NOT pass --cd (codex rejects it): ${dualCaptured[1].args.join(" ")}`,
      );
    }

    // ============================================================
    // Contract 2: error-path fixture
    // ============================================================
    // Bytes from a turn that failed because `-m gpt-5-codex` was rejected
    // under ChatGPT-subscription auth. The runtime must:
    //   (a) Throw on non-zero exit.
    //   (b) Surface the *stdout* `error.message` (the human-readable
    //       diagnostic), NOT stderr's harmless "Reading additional
    //       input from stdin..." log.
    //   (c) Unwrap the nested OpenAI 4xx JSON to surface the inner
    //       error.message ("The 'gpt-5-codex' model is not supported...").
    {
      const errLines = await readLines(path.join(FIXTURES_DIR, "exec-error-model.stdout.jsonl"));
      const errStderr = await readText(path.join(FIXTURES_DIR, "exec-error-model.stderr.txt"));

      // Fixture sanity — must contain both error AND turn.failed events.
      assert(
        errLines.some((l) => l.includes('"type":"error"')),
        "error fixture must contain {type:error}",
      );
      assert(
        errLines.some((l) => l.includes('"type":"turn.failed"')),
        "error fixture must contain {type:turn.failed}",
      );
      // Stderr is the harmless stdin log — confirms our "prefer stdout" guard.
      assert(
        errStderr.includes("Reading additional input from stdin"),
        "stderr fixture is the harmless stdin log",
      );

      const captured: Array<{ args: string[]; cwd: string }> = [];
      const lastFile = path.join(TMP_ROOT, "last-err.txt");
      const rt = new CodexRuntime({
        threadKey: "fixture:err",
        workdir: TMP_ROOT,
        processFactory: makeFactoryFromFixture(captured, errLines, 1, errStderr, null, lastFile),
        lastMessageFileFactory: () => lastFile,
      });

      let caught: string | null = null;
      try {
        await rt.send({ text: "anything" });
      } catch (err) {
        caught = err instanceof Error ? err.message : String(err);
      }
      assert(caught !== null, "must throw on non-zero exit");
      // The unwrapped inner OpenAI 4xx message must surface.
      assert(
        caught.includes("model is not supported"),
        `unwrapped inner error must surface: ${caught}`,
      );
      // The harmless stderr log must NOT be the leading diagnostic.
      assert(
        !caught.includes("Reading additional input"),
        `stderr leaked into error message — should prefer stdout event: ${caught}`,
      );
      // The wrapping JSON shouldn't be left in (test the unwrap actually unwrapped).
      assert(
        !caught.includes('"type":"error"'),
        `JSON wrapper leaked — unwrap should have peeled it: ${caught}`,
      );
    }

    console.log(
      "✅ CodexRuntime wire-format contract verified against real codex --json fixtures " +
        "(success: stream + final + thread_id pin + resume args; error: stdout-prefer + JSON unwrap)",
    );
  } finally {
    await fs.rm(TMP_ROOT, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("❌ CodexRuntime wire-format contract failed:", err);
  process.exit(1);
});
