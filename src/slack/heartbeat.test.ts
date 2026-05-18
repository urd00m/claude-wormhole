// Standalone verification — run with: npx tsx src/slack/heartbeat.test.ts
import { Heartbeat } from "./heartbeat.js";

type Call = { op: "add" | "remove"; name: string };

function makeMockClient(calls: Call[]) {
  return {
    reactions: {
      add: async ({ name }: { name: string }) => {
        calls.push({ op: "add", name });
        return { ok: true };
      },
      remove: async ({ name }: { name: string }) => {
        calls.push({ op: "remove", name });
        return { ok: true };
      },
    },
  } as never;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

async function main() {
  const calls: Call[] = [];
  const hb = new Heartbeat({
    client: makeMockClient(calls),
    channel: "C123",
    ts: "1.0",
    intervalMs: 50,
  });

  await hb.start();
  // Wait for ~3 ticks (start + 2 interval fires)
  await new Promise((r) => setTimeout(r, 130));
  await hb.stop("success");

  const adds = calls.filter((c) => c.op === "add");
  const removes = calls.filter((c) => c.op === "remove");

  console.log("calls:", calls);
  assert(adds.length >= 3, `expected ≥3 adds, got ${adds.length}`);
  assert(adds[0].name === "eyes", `first emoji must be 'eyes', got '${adds[0].name}'`);
  // last add is the success emoji
  assert(adds[adds.length - 1].name === "+1", `last add must be '+1', got '${adds[adds.length - 1].name}'`);
  // all heartbeat emojis (everything except the final +1) should be removed
  const heartbeatAdds = adds.slice(0, -1).map((c) => c.name);
  for (const name of heartbeatAdds) {
    assert(
      removes.some((r) => r.name === name),
      `heartbeat '${name}' should be removed before final`,
    );
  }

  // Error path
  const calls2: Call[] = [];
  const hb2 = new Heartbeat({
    client: makeMockClient(calls2),
    channel: "C123",
    ts: "2.0",
    intervalMs: 50,
  });
  await hb2.start();
  await new Promise((r) => setTimeout(r, 30));
  await hb2.stop("error");
  const adds2 = calls2.filter((c) => c.op === "add");
  assert(adds2[adds2.length - 1].name === "x", `error path final must be 'x'`);

  console.log("✅ heartbeat verification passed");
}

main().catch((err) => {
  console.error("❌ heartbeat verification failed:", err);
  process.exit(1);
});
