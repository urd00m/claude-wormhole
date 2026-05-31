// Verify shellExec: ok run, non-zero exit, stderr capture, timeout-kill,
// output cap, formatShellResultForSlack rendering.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellExec, formatShellResultForSlack } from "./shellExec.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shellexec-"));
  fs.writeFileSync(path.join(tmp, "hello.txt"), "world\n");

  // --- ok run: stdout captured, exit 0, no truncation ---
  {
    const r = await shellExec("cat hello.txt", { cwd: tmp });
    assert(r.exitCode === 0, `exit 0: ${r.exitCode}`);
    assert(r.stdout === "world\n", `stdout: ${JSON.stringify(r.stdout)}`);
    assert(r.stderr === "", `stderr: ${JSON.stringify(r.stderr)}`);
    assert(r.timedOut === false, "not timed out");
    assert(r.truncated === false, "not truncated");
    assert(r.durationMs >= 0, "duration set");
  }

  // --- non-zero exit + stderr ---
  {
    const r = await shellExec("ls /definitely/does/not/exist/path", { cwd: tmp });
    assert(r.exitCode !== 0, `nonzero exit: ${r.exitCode}`);
    assert(r.stderr.length > 0, "stderr populated");
  }

  // --- cwd respected ---
  {
    const r = await shellExec("pwd", { cwd: tmp });
    assert(r.exitCode === 0, "pwd ok");
    assert(r.stdout.trim() === fs.realpathSync(tmp), `pwd cwd: ${r.stdout.trim()} vs ${tmp}`);
  }

  // --- shell syntax (pipes, env, redirects) works via bash -lc ---
  {
    const r = await shellExec("echo a b c | wc -w", { cwd: tmp });
    assert(r.exitCode === 0, "pipe ok");
    assert(r.stdout.trim() === "3", `pipe result: ${r.stdout}`);
  }

  // --- output cap: produce > cap bytes, expect truncation ---
  {
    // 4096 chars > 1024 byte cap; we use yes head'd to keep it bounded.
    const r = await shellExec("yes hello | head -c 4096", { cwd: tmp, maxOutputBytes: 1024 });
    assert(r.truncated === true, "truncated when over cap");
    assert(r.stdout.length <= 1024, `truncated stdout ≤ cap: ${r.stdout.length}`);
  }

  // --- timeout kills the process ---
  {
    const t0 = Date.now();
    const r = await shellExec("sleep 30", { cwd: tmp, timeoutMs: 300 });
    const dt = Date.now() - t0;
    assert(r.timedOut === true, "marked timed out");
    assert(dt < 3000, `actually killed quickly (${dt}ms)`);
  }

  // --- formatShellResultForSlack happy path ---
  {
    const result = await shellExec("echo hi", { cwd: tmp });
    const out = formatShellResultForSlack("echo hi", result, tmp);
    assert(out.includes("`!echo hi`"), `command echo: ${out}`);
    assert(out.includes("```"), "stdout fenced");
    assert(out.includes("hi"), "stdout content present");
    assert(out.includes(tmp), "footer mentions cwd");
    assert(!out.includes("exit "), "exit footer omitted on success");
  }

  // --- formatShellResultForSlack: failure + timeout footers ---
  {
    const result = await shellExec("exit 7", { cwd: tmp });
    const out = formatShellResultForSlack("exit 7", result, tmp);
    assert(out.includes("exit 7"), `exit footer: ${out}`);
    assert(out.includes("_(no output)_"), "no-output marker present");
  }

  // --- formatShellResultForSlack: stderr-only run ---
  {
    const result = await shellExec("printf 'oops\\n' >&2", { cwd: tmp });
    const out = formatShellResultForSlack("printf 'oops' >&2", result, tmp);
    assert(out.includes("_stderr:_"), `stderr labeled: ${out}`);
    assert(out.includes("oops"), "stderr body present");
  }

  // --- formatShellResultForSlack: timed-out marker ---
  {
    const result = await shellExec("sleep 10", { cwd: tmp, timeoutMs: 200 });
    const out = formatShellResultForSlack("sleep 10", result, tmp);
    assert(out.includes("timed out"), `timeout footer: ${out}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(
    "✅ shellExec verified — ok run, nonzero exit + stderr, cwd, pipe via bash -lc, output cap, timeout kill, format (success/failure/stderr-only/timeout)",
  );
}

main().catch((err) => {
  console.error("❌ shellExec verification failed:", err);
  process.exit(1);
});
