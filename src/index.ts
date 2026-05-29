import { app } from "./slack/app.js";
import { env } from "./config.js";
import { registerHandlers, setSchedulerForHandlers } from "./slack/handlers.js";
import { registerInteractions } from "./slack/interactions.js";
import { detectAuth, describeAuth } from "./auth.js";
import { getCronStore } from "./scheduler/store.js";
import { Scheduler } from "./scheduler/scheduler.js";
import { makeRunner } from "./scheduler/runner.js";
import { clearAllOnBoot } from "./slack/activeMarker.js";
import { ensureCommandsLinked } from "./skillsLink.js";

/**
 * Bump the bundled Claude CLI's "task killer" timers to 2 h before any
 * SDK call spawns it. The SDK launches the CLI as a subprocess that
 * inherits this process.env, so setting these here propagates to it.
 *   - MCP_TOOL_TIMEOUT: default 60s hard wall clock on every MCP tool call.
 *     Without this, mcp__spawn__spawn (and any other MCP tool) aborts
 *     mid-flight if its handler takes longer than 60s.
 *   - MCP_TIMEOUT: sibling 60s default for non-tool MCP requests.
 *   - CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: 10-min idle watchdog. Long
 *     waits on background bash + ScheduleWakeup trip this even though the
 *     worker is doing useful work.
 * User-provided values win — we only set the var when it's missing.
 */
const LONG_TASK_TIMEOUT_MS = "7200000"; // 2 h
function applyLongTaskTimers(): void {
  if (!process.env.MCP_TOOL_TIMEOUT) process.env.MCP_TOOL_TIMEOUT = LONG_TASK_TIMEOUT_MS;
  if (!process.env.MCP_TIMEOUT) process.env.MCP_TIMEOUT = LONG_TASK_TIMEOUT_MS;
  if (!process.env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS) {
    process.env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS = LONG_TASK_TIMEOUT_MS;
  }
}

async function main() {
  applyLongTaskTimers();
  const auth = detectAuth();
  if (auth.kind === "none") {
    console.error(
      "❌ No Claude auth configured.\n" +
        "   Either set ANTHROPIC_API_KEY in .env, or authenticate your Claude\n" +
        "   subscription account by running:  npm run login",
    );
    process.exit(1);
  }
  console.log(`🔐 Claude auth: ${describeAuth(auth)}`);

  // Make the vendored arch-common command library available in every session
  // (symlink into ~/.claude/commands). Best-effort: a failure here never
  // blocks startup.
  try {
    const link = ensureCommandsLinked();
    const icon = link.status === "linked" || link.status === "ok" ? "📚" : "⚠️";
    console.log(`${icon} arch-common commands: ${link.message}`);
  } catch (err) {
    console.warn(
      `[boot] ensureCommandsLinked failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Build the scheduler. Use a lazy getter for the cron MCP tool so a job
  // firing right at boot still sees the right Scheduler instance.
  let scheduler: Scheduler | null = null;
  const runner = makeRunner(app.client, () => {
    if (!scheduler) throw new Error("scheduler not initialized");
    return scheduler;
  });
  scheduler = new Scheduler(getCronStore(), runner);
  setSchedulerForHandlers(scheduler);

  try {
    await clearAllOnBoot(app.client);
  } catch (err) {
    console.warn(
      `[boot] clearAllOnBoot failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  registerHandlers(app);
  registerInteractions(app);

  scheduler.start();
  const cronCount = scheduler.list().length;
  if (cronCount > 0) {
    console.log(`⏰ Scheduler active: ${cronCount} cron${cronCount === 1 ? "" : "s"} loaded`);
  }

  const shutdown = async () => {
    console.log("\nshutting down…");
    scheduler?.stopAll();
    try {
      await app.stop();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.start();
  console.log(`⚡️ Bolt app running (model=${env.ANTHROPIC_MODEL})`);
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
