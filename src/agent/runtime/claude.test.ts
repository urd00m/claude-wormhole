// Direct verification of ClaudeRuntime — the Claude implementation of the
// Runtime port (src/agent/runtime/types.ts). Phase 1 extracted ClaudeRuntime
// out of the old monolithic Session.send; this suite exercises ClaudeRuntime
// in isolation (not through Session). Two layers of defense:
//
//   - The existing Session-level suites (sessionStream.test.ts,
//     sessionIsolation.test.ts) prove the Session wrapper delegates faithfully.
//   - This suite proves the extracted runtime body itself is correct, so a
//     future refactor that swaps out the wrapper can't silently break the
//     underlying behavior.
//
// We use a fake `queryFn` to feed hand-crafted SDK messages, the same seam
// the Session-level tests use. The real SDK `query` spawns a CLI subprocess
// which is not viable in a unit test.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRuntime, type QueryFn } from "./claude.js";
import { BACKGROUND_WORKER_TYPE } from "../subagentDepth.js";
import type { Runtime, TaskEvent } from "./types.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type FakeQueryParams = { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> };

function fakeQuery(messages: SDKMessage[]): QueryFn {
  return (_params: FakeQueryParams) => {
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

function capturingQuery(captured: Record<string, unknown>[], result = "ok"): QueryFn {
  return (params) => {
    captured.push(params.options ?? {});
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result,
      } as never;
    })();
  };
}

function mkAssistant(opts: {
  parentToolUseId?: string | null;
  text?: string;
  toolUses?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
}): SDKMessage {
  const content: Array<Record<string, unknown>> = [];
  if (opts.text != null) content.push({ type: "text", text: opts.text });
  for (const tu of opts.toolUses ?? []) {
    content.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
  }
  return {
    type: "assistant",
    parent_tool_use_id: opts.parentToolUseId ?? null,
    message: { content },
  } as unknown as SDKMessage;
}

function mkUserToolResult(opts: {
  parentToolUseId?: string | null;
  toolUseId: string;
  isError?: boolean;
}): SDKMessage {
  return {
    type: "user",
    parent_tool_use_id: opts.parentToolUseId ?? null,
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          is_error: opts.isError ?? false,
        },
      ],
    },
  } as unknown as SDKMessage;
}

function mkStreamEventText(text: string, parentToolUseId: string | null = null): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: parentToolUseId,
    event: {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage;
}

function mkSystemTask(opts: {
  subtype: "task_started" | "task_progress" | "task_notification";
  task_id: string;
  tool_use_id?: string;
  description?: string;
  subagent_type?: string;
  status?: "completed" | "failed" | "stopped";
  summary?: string;
}): SDKMessage {
  return { type: "system", ...opts } as unknown as SDKMessage;
}

type Recorded = {
  text: string[];
  toolStarts: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  toolEnds: Array<{ id: string; ok: boolean }>;
  finals: string[];
  taskEvents: TaskEvent[];
};

function emptyRecorded(): Recorded {
  return { text: [], toolStarts: [], toolEnds: [], finals: [], taskEvents: [] };
}

function buildRuntime(messages: SDKMessage[]): ClaudeRuntime {
  return new ClaudeRuntime({
    threadKey: "test:thread",
    workdir: "/tmp",
    queryFn: fakeQuery(messages),
  });
}

async function run(messages: SDKMessage[]): Promise<Recorded> {
  const rec = emptyRecorded();
  const rt = buildRuntime(messages);
  await rt.send(
    { text: "hi" },
    {
      onText: (t) => rec.text.push(t),
      onToolStart: (id, name, input) => rec.toolStarts.push({ id, name, input }),
      onToolEnd: (id, ok) => rec.toolEnds.push({ id, ok }),
      onFinal: (t) => rec.finals.push(t),
      onTaskEvent: (e) => rec.taskEvents.push(e),
    },
  );
  return rec;
}

async function main() {
  // --- (1) Runtime port contract ----------------------------------------
  // ClaudeRuntime must satisfy the Runtime interface: `name`, `workdir`,
  // `send`, `setWorkdir`, `resetConversation`. This is a structural check —
  // if the port shape changes, the assignment below fails to typecheck and
  // this test fails immediately.
  {
    const initialDir: string = "/initial/dir";
    const changedDir: string = "/changed/dir";
    const rt: Runtime = new ClaudeRuntime({
      threadKey: "port:check",
      workdir: initialDir,
      queryFn: capturingQuery([]),
    });
    assert(rt.name === "claude", `runtime.name must be 'claude', got ${rt.name}`);
    assert(rt.workdir === initialDir, `runtime.workdir must read through, got ${rt.workdir}`);
    rt.setWorkdir(changedDir);
    assert(rt.workdir === changedDir, "runtime.workdir must reflect setWorkdir");
    rt.resetConversation(); // must not throw
  }

  // --- (2) Stream parity: text deltas + final text ----------------------
  {
    const rec = await run([
      mkStreamEventText("hello "),
      mkStreamEventText("world"),
      mkAssistant({ text: "hello world" }),
    ]);
    assert(rec.text.join("") === "hello world", `onText concat mismatch: ${JSON.stringify(rec.text)}`);
    assert(rec.finals.length === 1, `expected 1 final, got ${rec.finals.length}`);
    assert(rec.finals[0] === "hello world", `final text wrong: ${rec.finals[0]}`);
  }

  // --- (3) tool_use start / matching tool_result end --------------------
  {
    const rec = await run([
      mkAssistant({ toolUses: [{ id: "tu_1", name: "Bash", input: { command: "ls" } }] }),
      mkUserToolResult({ toolUseId: "tu_1", isError: false }),
      mkAssistant({ text: "done" }),
    ]);
    assert(rec.toolStarts.length === 1 && rec.toolStarts[0].id === "tu_1", "tool start");
    assert(rec.toolStarts[0].name === "Bash", "tool name");
    assert(rec.toolStarts[0].input.command === "ls", "tool input");
    assert(rec.toolEnds.length === 1 && rec.toolEnds[0].ok === true, "tool end ok");
  }

  // --- (4) tool_result with is_error=true → onToolEnd ok=false ----------
  {
    const rec = await run([
      mkAssistant({ toolUses: [{ id: "tu_err", name: "Bash", input: { command: "false" } }] }),
      mkUserToolResult({ toolUseId: "tu_err", isError: true }),
      mkAssistant({ text: "failed" }),
    ]);
    assert(rec.toolEnds.length === 1, "one tool end");
    assert(rec.toolEnds[0].ok === false, "is_error must map to ok=false");
  }

  // --- (5) Sub-agent isolation (parent_tool_use_id != null is suppressed)
  {
    const rec = await run([
      mkAssistant({
        toolUses: [
          { id: "tu_agent", name: "Agent", input: { subagent_type: "general-purpose", prompt: "go" } },
        ],
      }),
      mkStreamEventText("LEAKED SUB STREAM", "tu_agent"),
      mkAssistant({ parentToolUseId: "tu_agent", text: "sub-agent internal text" }),
      mkAssistant({
        parentToolUseId: "tu_agent",
        toolUses: [{ id: "tu_sub_bash", name: "Bash", input: { command: "whoami" } }],
      }),
      mkUserToolResult({ parentToolUseId: "tu_agent", toolUseId: "tu_sub_bash" }),
      mkUserToolResult({ toolUseId: "tu_agent" }),
      mkAssistant({ text: "final parent answer" }),
    ]);
    assert(
      !rec.text.join("").includes("LEAKED"),
      `sub-agent stream leaked: ${JSON.stringify(rec.text)}`,
    );
    assert(
      rec.toolStarts.length === 1 && rec.toolStarts[0].id === "tu_agent",
      `sub-agent tool leaked into onToolStart: ${JSON.stringify(rec.toolStarts)}`,
    );
    assert(
      rec.toolEnds.length === 1 && rec.toolEnds[0].id === "tu_agent",
      `sub-agent tool_result leaked into onToolEnd: ${JSON.stringify(rec.toolEnds)}`,
    );
    assert(rec.finals[0] === "final parent answer", "sub-agent text overwrote final");
  }

  // --- (6) Foreground Agent task lifecycle is suppressed ----------------
  {
    const rec = await run([
      mkAssistant({
        toolUses: [
          { id: "tu_fg", name: "Agent", input: { subagent_type: "general-purpose", prompt: "fg" } },
        ],
      }),
      mkSystemTask({ subtype: "task_started", task_id: "task_fg", tool_use_id: "tu_fg", description: "fg" }),
      mkSystemTask({ subtype: "task_notification", task_id: "task_fg", tool_use_id: "tu_fg", status: "completed", summary: "done" }),
      mkAssistant({ text: "fg done" }),
    ]);
    assert(rec.taskEvents.length === 0, `foreground leaked into onTaskEvent: ${JSON.stringify(rec.taskEvents)}`);
  }

  // --- (7) Background-worker task lifecycle is surfaced -----------------
  {
    const rec = await run([
      mkAssistant({
        toolUses: [
          {
            id: "tu_bg",
            name: "Agent",
            input: { subagent_type: BACKGROUND_WORKER_TYPE, prompt: "go bg" },
          },
        ],
      }),
      mkSystemTask({
        subtype: "task_started",
        task_id: "task_bg",
        tool_use_id: "tu_bg",
        description: "bench",
        subagent_type: BACKGROUND_WORKER_TYPE,
      }),
      mkSystemTask({ subtype: "task_progress", task_id: "task_bg", tool_use_id: "tu_bg", description: "halfway" }),
      mkSystemTask({
        subtype: "task_notification",
        task_id: "task_bg",
        tool_use_id: "tu_bg",
        status: "completed",
        summary: "out.csv",
      }),
      mkAssistant({ text: "kicked off" }),
    ]);
    assert(rec.taskEvents.length === 3, `bg events: ${JSON.stringify(rec.taskEvents)}`);
    assert(rec.taskEvents[0].kind === "started", "first kind");
    assert(rec.taskEvents[1].kind === "progress", "second kind");
    assert(rec.taskEvents[2].kind === "notification", "third kind");
    if (rec.taskEvents[2].kind === "notification") {
      assert(rec.taskEvents[2].summary.includes("out.csv"), "summary");
    }
  }

  // --- (8) Per-thread sessionId pinning ---------------------------------
  // Same workdir, two runtimes → two distinct UUIDs. Neither uses `continue`.
  {
    const capturedA: Record<string, unknown>[] = [];
    const capturedB: Record<string, unknown>[] = [];
    const rtA = new ClaudeRuntime({
      threadKey: "thread_A",
      workdir: "/shared",
      queryFn: capturingQuery(capturedA),
    });
    const rtB = new ClaudeRuntime({
      threadKey: "thread_B",
      workdir: "/shared",
      queryFn: capturingQuery(capturedB),
    });
    await rtA.send({ text: "hi A" });
    await rtB.send({ text: "hi B" });
    const idA = capturedA[0].sessionId as string;
    const idB = capturedB[0].sessionId as string;
    assert(typeof idA === "string" && idA.length > 0, "A sessionId");
    assert(typeof idB === "string" && idB.length > 0, "B sessionId");
    assert(idA !== idB, `distinct sessionIds required: ${idA} === ${idB}`);
    assert(capturedA[0].continue === undefined, "A must not use continue");
    assert(capturedB[0].continue === undefined, "B must not use continue");
  }

  // --- (9) sessionId vs resume: first send sets sessionId, rest set resume
  {
    const captured: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      threadKey: "thread_seq",
      workdir: "/x",
      queryFn: capturingQuery(captured),
    });
    await rt.send({ text: "1" });
    await rt.send({ text: "2" });
    await rt.send({ text: "3" });
    assert(typeof captured[0].sessionId === "string", "1st sessionId");
    assert(captured[0].resume === undefined, "1st no resume");
    for (let i = 1; i < captured.length; i++) {
      assert(typeof captured[i].resume === "string", `call ${i + 1} resume`);
      assert(captured[i].sessionId === undefined, `call ${i + 1} no sessionId`);
      assert(captured[i].resume === captured[0].sessionId, `call ${i + 1} resume matches`);
    }
  }

  // --- (10) setWorkdir rotates sessionId and switches cwd ---------------
  {
    const captured: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      threadKey: "thread_rot",
      workdir: "/old",
      queryFn: capturingQuery(captured),
    });
    await rt.send({ text: "in old" });
    const oldId = captured[0].sessionId as string;
    rt.setWorkdir("/new");
    assert(rt.workdir === "/new", "workdir getter reflects change");
    await rt.send({ text: "in new" });
    const newId = captured[1].sessionId as string;
    assert(typeof newId === "string", "rotated 2nd send starts fresh");
    assert(captured[1].resume === undefined, "rotated 2nd has no resume");
    assert(newId !== oldId, `setWorkdir must rotate: ${oldId} === ${newId}`);
    assert(captured[1].cwd === "/new", "2nd send runs in new cwd");
  }

  // --- (11) setWorkdir to same workdir is a no-op ----------------------
  {
    const captured: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      threadKey: "thread_same",
      workdir: "/same",
      queryFn: capturingQuery(captured),
    });
    await rt.send({ text: "first" });
    const id1 = captured[0].sessionId as string;
    rt.setWorkdir("/same"); // same path — must not rotate
    await rt.send({ text: "second" });
    assert(captured[1].resume === id1, "same-workdir setWorkdir must NOT rotate (resume preserved)");
    assert(captured[1].sessionId === undefined, "same-workdir 2nd send is resume, not fresh start");
  }

  // --- (12) resetConversation rotates without changing workdir ---------
  {
    const captured: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      threadKey: "thread_reset",
      workdir: "/dir",
      queryFn: capturingQuery(captured),
    });
    await rt.send({ text: "1" });
    const idBefore = captured[0].sessionId as string;
    rt.resetConversation();
    await rt.send({ text: "2" });
    const idAfter = captured[1].sessionId as string;
    assert(typeof idAfter === "string", "resetConversation forces fresh sessionId");
    assert(idAfter !== idBefore, "resetConversation rotates id");
    assert(captured[1].cwd === "/dir", "workdir unchanged");
  }

  // --- (13) Mid-send setWorkdir does not corrupt session state ----------
  // The bug: end-of-send unconditionally set hasStarted=true, so the next
  // send would `{ resume: <rotated UUID> }` against a UUID that was never
  // used to open a conversation. The fix: only mark hasStarted if the
  // rotation didn't happen mid-turn.
  {
    const captured: Record<string, unknown>[] = [];
    let rtRef: ClaudeRuntime | null = null;
    const midSendQuery: QueryFn = (params) => {
      captured.push(params.options ?? {});
      return (async function* () {
        if (rtRef && captured.length === 1) {
          rtRef.setWorkdir("/post/rotation");
        }
        yield { type: "result", subtype: "success", result: "ok" } as never;
      })();
    };

    const rt = new ClaudeRuntime({
      threadKey: "thread_midsend",
      workdir: "/pre/rotation",
      queryFn: midSendQuery,
    });
    rtRef = rt;

    await rt.send({ text: "first — rotates mid-turn" });
    const firstId = captured[0].sessionId as string;
    assert(typeof firstId === "string", "first send opens with sessionId");

    await rt.send({ text: "second — must start fresh, not resume" });
    assert(
      captured[1].resume === undefined,
      `after mid-send rotation, next send must NOT resume (got resume=${captured[1].resume})`,
    );
    assert(typeof captured[1].sessionId === "string", "next send MUST start fresh");
    assert(captured[1].sessionId !== firstId, "rotated id must differ");
    assert(captured[1].cwd === "/post/rotation", "next send runs in post-rotation workdir");

    await rt.send({ text: "third — must now resume properly" });
    assert(
      captured[2].resume === captured[1].sessionId,
      "third send resumes the rotated id (now safely started by send #2)",
    );
  }

  // --- (14) Empty assistant text → final reads as `_(no response)_` ----
  // Guards the "_(no response)_" sentinel in send() so callers always get
  // SOMETHING to render in Slack rather than a blank message.
  {
    const rt = buildRuntime([]); // empty stream
    const finals: string[] = [];
    const out = await rt.send({ text: "hi" }, { onFinal: (t) => finals.push(t) });
    assert(out.finalText === "_(no response)_", `empty-stream final must be sentinel, got: ${out.finalText}`);
    assert(finals.length === 1 && finals[0] === "_(no response)_", "onFinal fires with sentinel");
  }

  // --- (15) `result` subtype=success overrides final text ---------------
  // The SDK's terminal `result` message is the authoritative final text and
  // beats whatever the last assistant text block was.
  {
    const rt = buildRuntime([
      mkAssistant({ text: "partial" }),
      { type: "result", subtype: "success", result: "AUTHORITATIVE" } as unknown as SDKMessage,
    ]);
    const finals: string[] = [];
    const out = await rt.send({ text: "hi" }, { onFinal: (t) => finals.push(t) });
    assert(out.finalText === "AUTHORITATIVE", `result.result must win, got: ${out.finalText}`);
    assert(finals[0] === "AUTHORITATIVE", "onFinal sees the authoritative text");
  }

  // --- (16) setMcpServers / setCanUseTool are pass-throughs (build only)
  // Smoke check that they exist and don't throw. The full canUseTool
  // wrapping (depth cap, spawn redirect) is exercised by spawnMcp.test.ts
  // and canUseTool.test.ts — not duplicated here.
  {
    const rt = new ClaudeRuntime({
      threadKey: "thread_cfg",
      workdir: "/x",
      queryFn: capturingQuery([]),
    });
    rt.setMcpServers({});
    rt.setCanUseTool(async () => ({ behavior: "allow", updatedInput: {} }));
  }

  // --- (17) launch config (alias) → model + effort in SDK options ---
  {
    const captured: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({
      threadKey: "thread_launch",
      workdir: "/x",
      launch: { model: "claude-opus-4-7", effort: "high", args: ["--ignored-by-sdk"] },
      queryFn: capturingQuery(captured),
    });
    await rt.send({ text: "hi" });
    assert(captured[0].model === "claude-opus-4-7", `launch model → options.model: ${captured[0].model}`);
    assert(captured[0].effort === "high", `launch effort → options.effort: ${captured[0].effort}`);
    // `args` are intentionally not applied to the SDK path — no raw CLI flag leaks in.
    assert(!("args" in captured[0]), "alias args not passed to SDK options");
  }

  // --- (18) no launch config → effort absent, model falls back to env ---
  {
    const captured: Record<string, unknown>[] = [];
    const rt = new ClaudeRuntime({ threadKey: "thread_nolaunch", workdir: "/x", queryFn: capturingQuery(captured) });
    await rt.send({ text: "hi" });
    assert(captured[0].effort === undefined, "no launch → no effort option");
    assert(typeof captured[0].model === "string" && (captured[0].model as string).length > 0, "model defaulted from env");
  }

  console.log(
    "✅ ClaudeRuntime verified — port contract, stream parity, sub-agent isolation, " +
      "task event gating, sessionId pinning, mid-send rotation, sentinel final, launch-config",
  );
}

main().catch((err) => {
  console.error("❌ ClaudeRuntime verification failed:", err);
  process.exit(1);
});
