// Verify that each Session pins its own SDK session_id (UUID) and uses it
// via `sessionId` (first send) / `resume` (subsequent sends), NOT the
// cwd-based `continue: true`. Also verify that setWorkdir rotates the
// session_id so the SDK doesn't try to resume the old workdir's
// conversation under a different cwd.
//
// This is THE regression test for the cross-thread-binding bug: two
// Slack threads pointing at the same workdir would, with `continue:
// true`, resume each other's most-recent conversation. With session_id
// pinning, they're isolated.
import { Session, type QueryFn } from "./session.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

type CapturedOptions = Record<string, unknown>;

function makeFakeQuery(captured: CapturedOptions[]): QueryFn {
  return (params) => {
    captured.push(params.options ?? {});
    return (async function* () {
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
      } as never;
    })();
  };
}

async function main() {
  // --- Two sessions on the SAME workdir get DIFFERENT session_ids. ---
  // This is the core isolation guarantee.
  {
    const capturedA: CapturedOptions[] = [];
    const capturedB: CapturedOptions[] = [];
    const sessionA = new Session({
      threadKey: "thread_A",
      workdir: "/shared/workdir",
      queryFn: makeFakeQuery(capturedA),
    });
    const sessionB = new Session({
      threadKey: "thread_B",
      workdir: "/shared/workdir",
      queryFn: makeFakeQuery(capturedB),
    });

    await sessionA.send({ text: "hi from A" });
    await sessionB.send({ text: "hi from B" });

    const idA = capturedA[0].sessionId as string;
    const idB = capturedB[0].sessionId as string;
    assert(typeof idA === "string" && idA.length > 0, "session A sent sessionId on first call");
    assert(typeof idB === "string" && idB.length > 0, "session B sent sessionId on first call");
    assert(idA !== idB, `sessions on same workdir MUST have distinct session_ids (got ${idA} === ${idB})`);
    // Critical: neither used `continue` (the cwd-based bleed source).
    assert(capturedA[0].continue === undefined, "session A must NOT use continue");
    assert(capturedB[0].continue === undefined, "session B must NOT use continue");
  }

  // --- First send uses `sessionId`; subsequent sends use `resume`. ---
  {
    const captured: CapturedOptions[] = [];
    const session = new Session({
      threadKey: "thread_seq",
      workdir: "/some/dir",
      queryFn: makeFakeQuery(captured),
    });

    await session.send({ text: "first" });
    await session.send({ text: "second" });
    await session.send({ text: "third" });

    assert(typeof captured[0].sessionId === "string", "first call sets sessionId");
    assert(captured[0].resume === undefined, "first call does NOT set resume");

    for (let i = 1; i < captured.length; i++) {
      assert(typeof captured[i].resume === "string", `call ${i + 1} sets resume`);
      assert(captured[i].sessionId === undefined, `call ${i + 1} does NOT set sessionId`);
      // The resume id MUST match the original sessionId.
      assert(
        captured[i].resume === captured[0].sessionId,
        `call ${i + 1}'s resume must equal first call's sessionId`,
      );
    }
  }

  // --- setWorkdir rotates the session_id. ---
  // Otherwise, after `set_workdir /new/path`, we'd resume the OLD
  // conversation under a different cwd, which is confusing for the SDK
  // and the user (CLAUDE.md / project context changed).
  {
    const captured: CapturedOptions[] = [];
    const session = new Session({
      threadKey: "thread_rotate",
      workdir: "/old/dir",
      queryFn: makeFakeQuery(captured),
    });

    await session.send({ text: "first in old dir" });
    const oldId = captured[0].sessionId as string;

    session.setWorkdir("/new/dir");
    await session.send({ text: "first in new dir" });

    const newId = captured[1].sessionId as string;
    assert(typeof newId === "string", "after workdir change, first send sets sessionId again (not resume)");
    assert(captured[1].resume === undefined, "after workdir change, no resume");
    assert(newId !== oldId, `setWorkdir must rotate the session id (got ${oldId} === ${newId})`);
    assert(captured[1].cwd === "/new/dir", "new send runs in new cwd");
  }

  // --- resetConversation() also rotates without changing workdir. ---
  {
    const captured: CapturedOptions[] = [];
    const session = new Session({
      threadKey: "thread_reset",
      workdir: "/same/dir",
      queryFn: makeFakeQuery(captured),
    });
    await session.send({ text: "first" });
    const idBefore = captured[0].sessionId as string;
    session.resetConversation();
    await session.send({ text: "after reset" });
    const idAfter = captured[1].sessionId as string;
    assert(typeof idAfter === "string", "resetConversation forces fresh sessionId on next send");
    assert(idAfter !== idBefore, "resetConversation rotates the id");
  }

  // --- REGRESSION: setWorkdir called mid-send must not corrupt session state. ---
  // Scenario: the agent invokes the `set_workdir` MCP tool DURING a send.
  // The tool calls session.setWorkdir(...) which rotates `sessionId` and
  // sets `hasStarted=false`. The currently-streaming send continues with
  // the OLD sessionId. The bug was: end-of-send unconditionally set
  // `hasStarted=true`, so the next send would `{ resume: <rotated UUID> }`
  // — but that UUID was never used to start a conversation, and the CLI
  // would reject it with "No conversation found with session ID: …".
  //
  // After the fix, the next send must start a fresh `{ sessionId: … }`,
  // matching the post-rotation UUID, NOT resume it.
  {
    const captured: CapturedOptions[] = [];
    let sessionRef: Session | null = null;
    // Use a custom queryFn that triggers the mid-send rotation by calling
    // setWorkdir on the session while we're still inside the for-await
    // loop. That mirrors what the real `set_workdir` MCP tool does.
    const midSendQuery: QueryFn = (params) => {
      captured.push(params.options ?? {});
      return (async function* () {
        // Simulate the workdir tool firing mid-turn. The send loop hasn't
        // exited yet — `this.sessionId` will get rotated before we return.
        if (sessionRef && captured.length === 1) {
          sessionRef.setWorkdir("/post/rotation/dir");
        }
        yield {
          type: "result",
          subtype: "success",
          result: "ok",
        } as never;
      })();
    };

    const session = new Session({
      threadKey: "thread_midsend_rotate",
      workdir: "/pre/rotation/dir",
      queryFn: midSendQuery,
    });
    sessionRef = session;

    await session.send({ text: "first send rotates mid-turn" });
    const firstId = captured[0].sessionId as string;
    assert(typeof firstId === "string", "first send opens with sessionId");

    // Second send must NOT try to resume the rotated UUID (the bug). It
    // must start fresh with `{ sessionId: <rotated UUID> }` because no
    // JSONL exists for it yet.
    await session.send({ text: "second send after mid-turn rotation" });
    assert(
      captured[1].resume === undefined,
      `after mid-send rotation, next send must NOT resume (got resume=${captured[1].resume})`,
    );
    assert(
      typeof captured[1].sessionId === "string",
      "after mid-send rotation, next send MUST start with sessionId (fresh)",
    );
    assert(
      captured[1].sessionId !== firstId,
      "the rotated sessionId must differ from the first send's id",
    );
    assert(
      captured[1].cwd === "/post/rotation/dir",
      "next send runs in the post-rotation workdir",
    );

    // And the send after THAT should properly resume the rotated id.
    await session.send({ text: "third send" });
    assert(
      captured[2].resume === captured[1].sessionId,
      "third send resumes the rotated id (now safely started by send #2)",
    );
  }

  console.log("✅ session isolation verified — per-thread session_ids, no cwd-based continue");
}

main().catch((err) => {
  console.error("❌ session isolation verification failed:", err);
  process.exit(1);
});
