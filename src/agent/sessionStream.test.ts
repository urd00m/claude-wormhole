// Behavioral verification of Session.send()'s message-loop dispatch.
//
// We inject a fake `query()` that yields a hand-crafted sequence of SDK
// messages, then assert that the right hooks fire for each one. The bugs we
// are guarding against:
//
//   (d) Sub-agent assistant/user/stream_event messages (parent_tool_use_id
//       != null) MUST NOT leak into the parent thread's Slack stream — no
//       onText, no onToolStart, no onFinal capture for their content. This
//       was the original isolation bug.
//
//   (e/f) `system` messages with task_started/task_progress/task_notification
//       subtypes must fire onTaskEvent ONLY for tool_use_ids previously
//       tagged background (i.e. assistant emitted an Agent tool_use with
//       subagent_type "background-worker" for that id).
//
// The SDK's real `query()` opens a CLI subprocess — not viable in a unit
// test — so Session was refactored to accept a `queryFn` constructor option
// defaulting to the real import. Tests inject a fake here.

import { Session, type TaskEvent, BACKGROUND_WORKER_TYPE } from "./session.js";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type FakeQueryParams = { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> };

function fakeQuery(messages: SDKMessage[]) {
  return (_params: FakeQueryParams) => {
    return (async function* () {
      for (const m of messages) yield m;
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

function buildSession(messages: SDKMessage[]): Session {
  return new Session({
    threadKey: "test:thread",
    workdir: "/tmp",
    queryFn: fakeQuery(messages),
  });
}

async function run(messages: SDKMessage[]): Promise<Recorded> {
  const rec = emptyRecorded();
  const session = buildSession(messages);
  await session.send(
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
  // (a) Simple assistant text → onText (via stream_event) and onFinal fire.
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

  // (b) tool_use block → onToolStart fires with id+name+input.
  // (c) Matching user tool_result → onToolEnd fires.
  {
    const rec = await run([
      mkAssistant({
        toolUses: [{ id: "tu_bash_1", name: "Bash", input: { command: "ls" } }],
      }),
      mkUserToolResult({ toolUseId: "tu_bash_1", isError: false }),
      mkAssistant({ text: "done" }),
    ]);
    assert(rec.toolStarts.length === 1, `expected 1 tool start, got ${rec.toolStarts.length}`);
    assert(rec.toolStarts[0].id === "tu_bash_1", "tool start id wrong");
    assert(rec.toolStarts[0].name === "Bash", "tool start name wrong");
    assert(rec.toolStarts[0].input.command === "ls", "tool start input wrong");
    assert(rec.toolEnds.length === 1, `expected 1 tool end, got ${rec.toolEnds.length}`);
    assert(rec.toolEnds[0].id === "tu_bash_1", "tool end id wrong");
    assert(rec.toolEnds[0].ok === true, "tool end ok wrong");
    assert(rec.finals[0] === "done", "final text wrong");
  }

  // (d) Sub-agent isolation: messages with parent_tool_use_id != null MUST
  // NOT cause any text/tool-strip/final-text leakage into the parent stream.
  // We interleave parent and sub-agent messages so the test guards against
  // an "if isSubAgent break in switch, but tool tracking before the switch
  // also leaks" mis-fix.
  {
    const rec = await run([
      // Parent emits a tool_use that spawns a sub-agent (Agent tool).
      mkAssistant({
        toolUses: [
          { id: "tu_agent_1", name: "Agent", input: { subagent_type: "general-purpose", prompt: "go" } },
        ],
      }),
      // Sub-agent's own stream_event — must NOT show up in onText.
      mkStreamEventText("INTERNAL THOUGHT FROM SUB-AGENT", "tu_agent_1"),
      // Sub-agent's own assistant text — must NOT overwrite parent's final text.
      mkAssistant({ parentToolUseId: "tu_agent_1", text: "sub-agent internal text" }),
      // Sub-agent's own tool_use — must NOT show up in onToolStart.
      mkAssistant({
        parentToolUseId: "tu_agent_1",
        toolUses: [{ id: "tu_sub_bash", name: "Bash", input: { command: "whoami" } }],
      }),
      // Sub-agent's tool_result — must NOT show up in onToolEnd.
      mkUserToolResult({ parentToolUseId: "tu_agent_1", toolUseId: "tu_sub_bash" }),
      // Parent receives the synchronous tool_result for the Agent call — DOES surface.
      mkUserToolResult({ toolUseId: "tu_agent_1" }),
      // Parent's final assistant text.
      mkAssistant({ text: "final parent answer" }),
    ]);

    // onText must not include any sub-agent stream text.
    const joined = rec.text.join("");
    assert(
      !joined.includes("INTERNAL THOUGHT"),
      `sub-agent stream_event leaked into onText: ${JSON.stringify(rec.text)}`,
    );

    // onToolStart: exactly one — the parent's Agent call.
    assert(
      rec.toolStarts.length === 1 && rec.toolStarts[0].id === "tu_agent_1",
      `sub-agent tool_use leaked into onToolStart: ${JSON.stringify(rec.toolStarts)}`,
    );

    // onToolEnd: exactly one — the parent's Agent tool_result.
    assert(
      rec.toolEnds.length === 1 && rec.toolEnds[0].id === "tu_agent_1",
      `sub-agent tool_result leaked into onToolEnd: ${JSON.stringify(rec.toolEnds)}`,
    );

    // Final text reflects the parent's last assistant text only.
    assert(
      rec.finals.length === 1 && rec.finals[0] === "final parent answer",
      `sub-agent text leaked into final: ${JSON.stringify(rec.finals)}`,
    );
  }

  // (e) system task event for a tool_use_id NOT tagged background → no onTaskEvent.
  {
    const rec = await run([
      // Parent spawns a FOREGROUND agent (no background subagent_type).
      mkAssistant({
        toolUses: [
          { id: "tu_fg_1", name: "Agent", input: { subagent_type: "general-purpose", prompt: "fg" } },
        ],
      }),
      mkSystemTask({
        subtype: "task_started",
        task_id: "task_fg",
        tool_use_id: "tu_fg_1",
        description: "fg work",
        subagent_type: "general-purpose",
      }),
      mkSystemTask({
        subtype: "task_notification",
        task_id: "task_fg",
        tool_use_id: "tu_fg_1",
        status: "completed",
        summary: "did the fg thing",
      }),
      mkAssistant({ text: "done fg" }),
    ]);
    assert(
      rec.taskEvents.length === 0,
      `foreground task lifecycle leaked to onTaskEvent: ${JSON.stringify(rec.taskEvents)}`,
    );
  }

  // (f) Same but for an Agent call with subagent_type "background-worker" →
  // onTaskEvent fires for the matched tool_use_id.
  {
    const rec = await run([
      mkAssistant({
        toolUses: [
          {
            id: "tu_bg_1",
            name: "Agent",
            input: { subagent_type: BACKGROUND_WORKER_TYPE, prompt: "go bg" },
          },
        ],
      }),
      mkSystemTask({
        subtype: "task_started",
        task_id: "task_bg",
        tool_use_id: "tu_bg_1",
        description: "long bench",
        subagent_type: BACKGROUND_WORKER_TYPE,
      }),
      mkSystemTask({
        subtype: "task_progress",
        task_id: "task_bg",
        tool_use_id: "tu_bg_1",
        description: "halfway",
        summary: "5/10",
      }),
      mkSystemTask({
        subtype: "task_notification",
        task_id: "task_bg",
        tool_use_id: "tu_bg_1",
        status: "completed",
        summary: "results in out.csv",
      }),
      mkAssistant({ text: "kicked off bg" }),
    ]);
    assert(
      rec.taskEvents.length === 3,
      `expected 3 bg task events, got ${rec.taskEvents.length}: ${JSON.stringify(rec.taskEvents)}`,
    );
    assert(rec.taskEvents[0].kind === "started", "first event kind");
    assert(rec.taskEvents[1].kind === "progress", "second event kind");
    assert(rec.taskEvents[2].kind === "notification", "third event kind");
    if (rec.taskEvents[2].kind === "notification") {
      assert(rec.taskEvents[2].status === "completed", "notification status");
      assert(
        rec.taskEvents[2].summary.includes("out.csv"),
        `notification summary missing: ${rec.taskEvents[2].summary}`,
      );
    }
  }

  console.log("✅ Session.send stream dispatch verified (sub-agent isolation + task event gating)");
}

main().catch((err) => {
  console.error("❌ sessionStream verification failed:", err);
  process.exit(1);
});
