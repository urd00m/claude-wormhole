// Direct verification of cronDef — runtime-neutral cron_add / cron_list /
// cron_remove handlers. Uses a fake CronCapableScheduler so the test never
// touches the real on-disk store or starts any node-cron timers.

import type { CronEntry } from "../../scheduler/store.js";
import {
  cronAddDef,
  cronListDef,
  cronRemoveDef,
  cronToolDefs,
  type CronCapableScheduler,
} from "./cronDef.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

class FakeScheduler implements CronCapableScheduler {
  entries: CronEntry[] = [];
  nextRunMap = new Map<string, Date | null>();
  removeIds: string[] = [];
  /** Set to a string to simulate scheduler.add throwing with that message. */
  addThrowsWith: string | null = null;
  private idCounter = 0;

  add(input: Omit<CronEntry, "id" | "createdAt"> & { id?: string }): CronEntry {
    if (this.addThrowsWith) throw new Error(this.addThrowsWith);
    const id = input.id ?? `cron_${(++this.idCounter).toString(36)}`;
    const entry: CronEntry = {
      id,
      createdAt: new Date(0).toISOString(),
      expression: input.expression,
      prompt: input.prompt,
      channel: input.channel,
      timezone: input.timezone,
      description: input.description,
      createdBy: input.createdBy,
    };
    this.entries.push(entry);
    return entry;
  }
  list(): CronEntry[] {
    return [...this.entries];
  }
  remove(id: string): boolean {
    this.removeIds.push(id);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    return this.entries.length < before;
  }
  nextRun(id: string): Date | null {
    return this.nextRunMap.get(id) ?? null;
  }
}

async function main() {
  // --- (1) def shapes ---
  {
    const sched = new FakeScheduler();
    const ctx = { scheduler: sched, currentChannel: "C_DEFAULT" };
    const addDef = cronAddDef(ctx);
    const listDef = cronListDef(ctx);
    const rmDef = cronRemoveDef(ctx);
    assert(addDef.name === "cron_add", "cron_add name");
    assert(listDef.name === "cron_list", "cron_list name");
    assert(rmDef.name === "cron_remove", "cron_remove name");
    assert(typeof addDef.schema.expression !== "undefined", "schema.expression");
    assert(typeof addDef.schema.prompt !== "undefined", "schema.prompt");
    assert(typeof rmDef.schema.id !== "undefined", "schema.id");
  }

  // --- (2) cron_add: invalid expression → error, no scheduler call ---
  {
    const sched = new FakeScheduler();
    const def = cronAddDef({ scheduler: sched, currentChannel: "C1" });
    const result = await def.handler({
      expression: "this is not a cron",
      prompt: "do thing",
      channel: undefined,
      timezone: undefined,
      description: undefined,
    });
    assert(result.isError === true, "invalid expression must error");
    assert(sched.entries.length === 0, "scheduler.add not called");
  }

  // --- (3) cron_add: valid expression + default channel ---
  {
    const sched = new FakeScheduler();
    sched.nextRunMap.set("cron_1", new Date("2026-06-01T09:00:00Z"));
    const def = cronAddDef({ scheduler: sched, currentChannel: "C_DEFAULT", createdBy: "U1" });
    const result = await def.handler({
      expression: "0 9 * * 1",
      prompt: "weekly summary",
      channel: undefined,
      timezone: undefined,
      description: undefined,
    });
    assert(result.isError !== true, `expected success: ${JSON.stringify(result)}`);
    assert(sched.entries.length === 1, "one entry");
    assert(sched.entries[0].channel === "C_DEFAULT", "default channel used");
    assert(sched.entries[0].createdBy === "U1", "createdBy propagated");
    assert(result.content[0].text.includes("0 9 * * 1"), "expression in summary");
    assert(result.content[0].text.includes("<#C_DEFAULT>"), "channel mention in summary");
    assert(result.content[0].text.includes("2026-06-01"), "next run in summary");
  }

  // --- (4) cron_add: explicit channel + tz + description override ---
  {
    const sched = new FakeScheduler();
    const def = cronAddDef({ scheduler: sched, currentChannel: "C_DEFAULT" });
    const result = await def.handler({
      expression: "*/15 * * * *",
      prompt: "every 15",
      channel: "C_OTHER",
      timezone: "America/Los_Angeles",
      description: "PR triage",
    });
    assert(result.isError !== true, "success");
    assert(sched.entries[0].channel === "C_OTHER", "explicit channel wins");
    assert(sched.entries[0].timezone === "America/Los_Angeles", "tz propagated");
    assert(sched.entries[0].description === "PR triage", "description propagated");
    assert(result.content[0].text.includes("(America/Los_Angeles)"), "tz in summary");
    assert(result.content[0].text.includes("PR triage"), "description in summary");
  }

  // --- (5) cron_add: scheduler.add throws → error result, no leak ---
  {
    const sched = new FakeScheduler();
    sched.addThrowsWith = "boom";
    const def = cronAddDef({ scheduler: sched, currentChannel: "C1" });
    const result = await def.handler({
      expression: "0 9 * * 1",
      prompt: "x",
      channel: undefined,
      timezone: undefined,
      description: undefined,
    });
    assert(result.isError === true, "thrown → error result");
    assert(result.content[0].text.includes("boom"), `err msg propagated: ${result.content[0].text}`);
  }

  // --- (6) cron_list: empty → "No scheduled jobs." ---
  {
    const sched = new FakeScheduler();
    const def = cronListDef({ scheduler: sched, currentChannel: "C1" });
    const result = await def.handler({});
    assert(result.content[0].text === "No scheduled jobs.", `empty list: ${result.content[0].text}`);
  }

  // --- (7) cron_list: populated, with long prompt truncation ---
  {
    const sched = new FakeScheduler();
    const longPrompt = "x".repeat(500);
    sched.add({ expression: "0 9 * * *", prompt: longPrompt, channel: "C2", description: "daily" });
    sched.add({ expression: "*/5 * * * *", prompt: "short prompt", channel: "C3" });
    const def = cronListDef({ scheduler: sched, currentChannel: "C1" });
    const result = await def.handler({});
    const text = result.content[0].text;
    assert(text.includes("`0 9 * * *`"), "expression 1");
    assert(text.includes("<#C2>"), "channel 1 mention");
    assert(text.includes("daily"), "description 1");
    assert(text.includes("…"), "long prompt truncated with ellipsis");
    assert(text.includes("short prompt"), "short prompt verbatim");
  }

  // --- (8) cron_remove: existing id → success ---
  {
    const sched = new FakeScheduler();
    sched.add({ expression: "0 9 * * *", prompt: "x", channel: "C1" });
    const def = cronRemoveDef({ scheduler: sched, currentChannel: "C1" });
    const result = await def.handler({ id: "cron_1" });
    assert(result.isError !== true, "removed → success");
    assert(sched.removeIds[0] === "cron_1", "remove called with id");
    assert(result.content[0].text.includes("Removed"), `text: ${result.content[0].text}`);
  }

  // --- (9) cron_remove: missing id → error result ---
  {
    const sched = new FakeScheduler();
    const def = cronRemoveDef({ scheduler: sched, currentChannel: "C1" });
    const result = await def.handler({ id: "cron_nope" });
    assert(result.isError === true, "missing → error");
    assert(result.content[0].text.includes("No cron"), `text: ${result.content[0].text}`);
  }

  // --- (10) cronToolDefs: stable order ---
  {
    const sched = new FakeScheduler();
    const defs = cronToolDefs({ scheduler: sched, currentChannel: "C1" });
    assert(defs.length === 3, `expected 3, got ${defs.length}`);
    assert(defs[0].name === "cron_add", "0=add");
    assert(defs[1].name === "cron_list", "1=list");
    assert(defs[2].name === "cron_remove", "2=remove");
  }

  console.log("✅ cronDef verified — add/list/remove dispatch, validation, channel/tz/desc plumbing");
}

main().catch((err) => {
  console.error("❌ cronDef verification failed:", err);
  process.exit(1);
});
