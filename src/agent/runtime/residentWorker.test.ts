// Verify ResidentWorker + InputChannel plumbing with a fake query() — no
// live Claude auth. The real context-retention property (one warm process
// remembering across pushes) is proven separately by the live spike in
// scripts/spike-resident.ts; here we verify the harness around it:
// turn demarcation, per-worker send serialization, kill semantics, and
// dead-generator detection.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { InputChannel, ResidentWorker } from "./residentWorker.js";
import type { QueryFn } from "./claude.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function assistant(text: string): SDKMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } } as unknown as SDKMessage;
}
function result(text: string): SDKMessage {
  return { type: "result", subtype: "success", result: text } as unknown as SDKMessage;
}

/**
 * Fake streaming-input query(). Consumes the InputChannel (the prompt) and,
 * for each pushed user message, emits an assistant + result turn whose text
 * echoes the prompt. This lets us assert turn demarcation and serialization
 * deterministically. `responder` maps an inbound prompt → reply text.
 */
function fakeStreamingQuery(responder: (prompt: string) => string): QueryFn {
  return (params) => {
    const input = params.prompt as AsyncIterable<{ message?: { content?: unknown } }>;
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for await (const userMsg of input) {
        const content = userMsg?.message?.content;
        const prompt = typeof content === "string" ? content : JSON.stringify(content);
        const reply = responder(prompt);
        yield assistant(reply);
        yield result(reply);
      }
    }
    return gen();
  };
}

async function main() {
  // --- (1) send() round-trips one turn's text ---
  {
    const worker = new ResidentWorker({
      name: "echo",
      ownerThread: "C:T",
      workdir: "/tmp",
      queryFn: fakeStreamingQuery((p) => `you said: ${p}`),
    });
    const r1 = await worker.send("hello");
    assert(r1 === "you said: hello", `turn 1 reply: ${r1}`);
    assert(worker.status === "idle", `status after send: ${worker.status}`);
    const r2 = await worker.send("again");
    assert(r2 === "you said: again", `turn 2 reply: ${r2}`);
    worker.kill();
  }

  // --- (2) The SAME worker handles multiple turns on one generator ---
  // (turn demarcation: each send reads exactly one result, leaves the
  // generator live — the bug the live spike caught.)
  {
    let turns = 0;
    const worker = new ResidentWorker({
      name: "counter",
      ownerThread: "C:T",
      workdir: "/tmp",
      queryFn: fakeStreamingQuery(() => `turn ${++turns}`),
    });
    assert((await worker.send("a")) === "turn 1", "first turn");
    assert((await worker.send("b")) === "turn 2", "second turn");
    assert((await worker.send("c")) === "turn 3", "third turn");
    worker.kill();
  }

  // --- (3) Concurrent sends serialize (per-worker queue) ---
  {
    const order: string[] = [];
    const worker = new ResidentWorker({
      name: "serial",
      ownerThread: "C:T",
      workdir: "/tmp",
      queryFn: (params) => {
        const input = params.prompt as AsyncIterable<{ message?: { content?: unknown } }>;
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          for await (const m of input) {
            const c = (m?.message?.content ?? "") as string;
            order.push(`start:${c}`);
            // simulate async work
            await new Promise((r) => setTimeout(r, c === "slow" ? 30 : 5));
            order.push(`end:${c}`);
            yield assistant(c);
            yield result(c);
          }
        }
        return gen();
      },
    });

    // Fire two sends without awaiting the first — they must not interleave.
    const p1 = worker.send("slow");
    const p2 = worker.send("fast");
    await Promise.all([p1, p2]);
    assert(
      JSON.stringify(order) === JSON.stringify(["start:slow", "end:slow", "start:fast", "end:fast"]),
      `sends must serialize, got: ${order.join(",")}`,
    );
    worker.kill();
  }

  // --- (4) kill() marks dead; subsequent send rejects ---
  {
    const worker = new ResidentWorker({
      name: "killme",
      ownerThread: "C:T",
      workdir: "/tmp",
      queryFn: fakeStreamingQuery((p) => p),
    });
    await worker.send("alive");
    worker.kill();
    assert(worker.status === "dead", "status dead after kill");
    let threw = false;
    try {
      await worker.send("after kill");
    } catch (err) {
      threw = true;
      assert((err as Error).message.includes("dead"), `reject message: ${(err as Error).message}`);
    }
    assert(threw, "send after kill must reject");
  }

  // --- (5) Generator ending mid-turn → worker marked dead, send rejects ---
  {
    const worker = new ResidentWorker({
      name: "diesmid",
      ownerThread: "C:T",
      workdir: "/tmp",
      queryFn: () => {
        // Generator that ends immediately without emitting a result —
        // simulates the underlying process exiting unexpectedly.
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          // yields nothing, returns → done on first next()
        }
        return gen();
      },
    });
    let threw = false;
    try {
      await worker.send("hello");
    } catch (err) {
      threw = true;
      assert(
        (err as Error).message.includes("ended unexpectedly"),
        `dead-generator message: ${(err as Error).message}`,
      );
    }
    assert(threw, "send must reject when generator ends mid-turn");
    assert(worker.status === "dead", "worker marked dead after generator end");
  }

  // --- (6) InputChannel basics: push before/after a waiting reader ---
  {
    const ch = new InputChannel();
    const it = ch[Symbol.asyncIterator]();
    // push-then-read
    ch.push("first");
    const a = await it.next();
    assert(!a.done && (a.value.message.content as string) === "first", "buffered push delivered");
    // read-then-push (reader waits)
    const pending = it.next();
    ch.push("second");
    const b = await pending;
    assert(!b.done && (b.value.message.content as string) === "second", "waiting reader resolved");
    // close ends iteration
    const pendingClose = it.next();
    ch.close();
    const c = await pendingClose;
    assert(c.done === true, "close ends the iterator");
    // push after close throws
    let threw = false;
    try {
      ch.push("nope");
    } catch {
      threw = true;
    }
    assert(threw, "push after close throws");
  }

  console.log(
    "✅ ResidentWorker verified — turn demarcation, send serialization, kill semantics, dead-generator detection, InputChannel",
  );
}

main().catch((err) => {
  console.error("❌ ResidentWorker verification failed:", err);
  process.exit(1);
});
