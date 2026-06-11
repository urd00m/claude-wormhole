// Verify the ctrl+c interrupt path end-to-end below the Slack layer:
//
//   (1) ClaudeRuntime.interrupt() — false when idle; mid-send it calls the
//       SDK Query's interrupt() control request, the interrupted send
//       settles with the text accumulated so far, and the interrupt target
//       is cleared once the stream drains.
//   (2) ClaudeRuntime with a queryFn that has NO interrupt method (older
//       fakes / degenerate streams) — interrupt() returns false, never throws.
//   (3) CodexRuntime.interrupt() — false when idle; mid-send it SIGTERMs the
//       subprocess and send() settles gracefully with "_(interrupted)_"
//       instead of throwing the non-zero-exit error.
//   (4) Session.interrupt() forwards to the runtime.
//   (5) SessionManager.peek() finds existing entries without creating, and
//       SessionEntry.busy reflects the queue's running state — the two
//       seams handlers.ts uses to route a ctrl+c around the per-thread queue.
//
// Like the other runtime suites, no real subprocess is spawned: fake
// queryFn / CodexProcessFactory seams drive hand-crafted streams.

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime, type QueryFn } from "./runtime/claude.js";
import { CodexRuntime } from "./runtime/codex.js";
import type { CodexProcess } from "./runtime/codexProcess.js";
import type { Runtime, SessionInput, SessionOutput } from "./runtime/types.js";
import { Session } from "./session.js";
import { SessionManager } from "./manager.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 5));

function mkAssistantText(text: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text }] },
  } as unknown as SDKMessage;
}

/**
 * A fake SDK Query: yields one assistant text block, then blocks until
 * interrupt() is called, then ends the stream the way the real CLI does
 * after an interrupt (a non-success result, no further assistant text).
 */
function interruptibleQuery() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let interruptCalls = 0;
  const q = {
    interrupt: async () => {
      interruptCalls += 1;
      release();
    },
    async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
      yield mkAssistantText("partial ");
      await gate;
      yield { type: "result", subtype: "error_during_execution" } as unknown as SDKMessage;
    },
  };
  return { q: q as AsyncIterable<SDKMessage>, interruptCalls: () => interruptCalls };
}

/**
 * A fake codex subprocess that emits its session id, then blocks until
 * kill() — at which point the stream ends and wait() resolves null
 * (killed-by-signal), mirroring the real spawnCodexProcess behavior.
 */
function blockingCodexProc() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let killedWith: string | null = null;
  const proc: CodexProcess = {
    lines: () =>
      (async function* () {
        yield JSON.stringify({ type: "thread.started", thread_id: "t-interrupt" });
        await gate;
      })(),
    stderr: async () => "",
    wait: async () => {
      await gate;
      return null;
    },
    kill: (signal) => {
      killedWith = signal ?? "SIGTERM";
      release();
    },
  };
  return { proc, killedWith: () => killedWith };
}

async function main() {
  // --- (1) ClaudeRuntime: idle → false; mid-send → true + Query.interrupt ---
  {
    const { q, interruptCalls } = interruptibleQuery();
    const queryFn: QueryFn = () => q;
    const rt = new ClaudeRuntime({ threadKey: "C1:1", workdir: "/tmp", queryFn });

    assert((await rt.interrupt()) === false, "(1) idle interrupt must be false");

    const texts: string[] = [];
    const sendP = rt.send({ text: "long task" }, { onText: (t) => texts.push(t) });
    await tick(); // let the stream reach the gate

    assert((await rt.interrupt()) === true, "(1) mid-send interrupt must be true");
    assert(interruptCalls() === 1, `(1) Query.interrupt called once, got ${interruptCalls()}`);

    const out = await sendP;
    assert(
      out.finalText === "partial ",
      `(1) interrupted send keeps accumulated text, got ${JSON.stringify(out.finalText)}`,
    );
    assert((await rt.interrupt()) === false, "(1) target cleared after stream drains");
  }

  // --- (2) ClaudeRuntime: queryFn without interrupt() → false, no throw ---
  {
    const queryFn: QueryFn = () =>
      (async function* (): AsyncGenerator<SDKMessage> {
        yield mkAssistantText("hi");
        await tick();
        yield { type: "result", subtype: "success", result: "hi" } as unknown as SDKMessage;
      })();
    const rt = new ClaudeRuntime({ threadKey: "C1:2", workdir: "/tmp", queryFn });
    const sendP = rt.send({ text: "x" });
    const sent = await rt.interrupt();
    assert(sent === false, "(2) no interrupt channel → false");
    const out = await sendP;
    assert(out.finalText === "hi", `(2) send unaffected, got ${JSON.stringify(out.finalText)}`);
  }

  // --- (3) CodexRuntime: idle → false; mid-send → SIGTERM + graceful settle ---
  {
    const tmp = path.join(os.tmpdir(), `wormhole-interrupt-test-${process.pid}`);
    await fs.mkdir(tmp, { recursive: true });
    const lastMsg = path.join(tmp, "last.txt");
    const { proc, killedWith } = blockingCodexProc();
    const rt = new CodexRuntime({
      threadKey: "C2:1",
      workdir: tmp,
      processFactory: () => proc,
      lastMessageFileFactory: () => lastMsg,
    });

    assert((await rt.interrupt()) === false, "(3) idle interrupt must be false");

    const sendP = rt.send({ text: "long task" });
    await tick(); // let the stream reach the gate

    assert((await rt.interrupt()) === true, "(3) mid-send interrupt must be true");
    assert(killedWith() === "SIGTERM", `(3) kill signal, got ${killedWith()}`);

    const out = await sendP; // must NOT throw despite the null exit code
    assert(
      out.finalText === "_(interrupted)_",
      `(3) graceful settle, got ${JSON.stringify(out.finalText)}`,
    );
    assert((await rt.interrupt()) === false, "(3) target cleared after settle");
    await fs.rm(tmp, { recursive: true, force: true });
  }

  // --- (4) Session forwards interrupt() to its runtime ---
  {
    let calls = 0;
    const fake: Runtime = {
      name: "claude",
      workdir: "/tmp",
      send: async (_i: SessionInput): Promise<SessionOutput> => ({ finalText: "" }),
      interrupt: async () => {
        calls += 1;
        return true;
      },
      setWorkdir: () => {},
      resetConversation: () => {},
    };
    const session = new Session({ threadKey: "C3:1", runtime: fake });
    assert((await session.interrupt()) === true, "(4) forwarded result");
    assert(calls === 1, `(4) runtime.interrupt called once, got ${calls}`);
  }

  // --- (5) SessionManager.peek + SessionEntry.busy ---
  {
    const mgr = new SessionManager();
    const key = "CPEEK:1";
    assert(mgr.peek(key) === undefined, "(5) peek must not create");
    assert(mgr.has(key) === false, "(5) still no entry after peek");

    const { entry } = await mgr.get(key);
    assert(mgr.peek(key) === entry, "(5) peek finds the created entry");
    const busyBefore: boolean = entry.busy;
    assert(busyBefore === false, "(5) idle entry is not busy");

    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const workP = entry.enqueue(() => gate);
    await tick();
    const busyDuring: boolean = entry.busy;
    assert(busyDuring === true, "(5) busy while queued work runs");
    release();
    await workP;
    const busyAfter: boolean = entry.busy;
    assert(busyAfter === false, "(5) idle again after the queue drains");
  }

  console.log(
    "✅ interrupt verified — Claude idle/mid-send/no-channel, Codex idle/mid-send graceful settle, " +
      "Session forwarding, manager peek/busy",
  );
}

main().catch((err) => {
  console.error("❌ interrupt verification failed:", err);
  process.exit(1);
});
