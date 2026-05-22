// Verify the sub-agent gating in classifyCall: parent-state mutators are
// hard-denied for sub-agents, read-only and Slack-post tools stay allowed,
// destructive Bash still routes through `ask` regardless of caller.
import { classifyCall } from "./canUseTool.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const SUB = "sub_agent_42";

// Sub-agent: blocked mutators → deny.
for (const t of [
  "mcp__workdir__set_workdir",
  "mcp__workdir__reset_workdir",
  "mcp__cron__cron_add",
  "mcp__cron__cron_remove",
]) {
  const d = classifyCall(t, {}, SUB);
  assert(d.kind === "deny", `sub-agent ${t} must deny, got ${d.kind}`);
}

// Main agent (no agentID): same mutators → allow.
for (const t of [
  "mcp__workdir__set_workdir",
  "mcp__cron__cron_add",
]) {
  const d = classifyCall(t, {}, undefined);
  assert(d.kind === "allow", `main-agent ${t} must allow, got ${d.kind}`);
}

// Sub-agent read-only / post tools still allowed.
for (const t of [
  "mcp__workdir__get_workdir",
  "mcp__cron__cron_list",
  "mcp__slack__slack_post_message",
  "mcp__slack__slack_post_file",
]) {
  const d = classifyCall(t, {}, SUB);
  assert(d.kind === "allow", `sub-agent ${t} must allow, got ${d.kind}`);
}

// Destructive Bash → ask, regardless of caller.
{
  const dMain = classifyCall("Bash", { command: "rm -rf node_modules" }, undefined);
  assert(dMain.kind === "ask", `main-agent rm must ask, got ${dMain.kind}`);
  const dSub = classifyCall("Bash", { command: "rm -rf node_modules" }, SUB);
  assert(dSub.kind === "ask", `sub-agent rm must ask, got ${dSub.kind}`);
}

// Safe Bash → allow.
{
  const d = classifyCall("Bash", { command: "ls -la" }, SUB);
  assert(d.kind === "allow", `safe bash must allow, got ${d.kind}`);
}

// Native Agent/Task → deny with a message pointing the model at spawn.
// Fires at every layer (main agent AND sub-agent), so this is the harness's
// single enforcement point for the spawn-only policy.
for (const agentId of [undefined, SUB]) {
  for (const t of ["Agent", "Task"]) {
    const d = classifyCall(t, { prompt: "do something" }, agentId);
    assert(
      d.kind === "deny",
      `${t} (agentID=${agentId ?? "main"}) must deny, got ${d.kind}`,
    );
    assert(
      d.kind === "deny" && d.reason.includes("mcp__spawn__spawn"),
      `${t} deny message must mention mcp__spawn__spawn, got: ${d.kind === "deny" ? d.reason : ""}`,
    );
  }
}

// AskUserQuestion → deny with a redirect to plain-text questions. Without
// this gate, the CLI returns an empty answer under bypassPermissions and
// the model loops forever waiting for input that the harness cannot
// deliver — the "main slack agent asks for input" death-loop bug.
for (const agentId of [undefined, SUB]) {
  const d = classifyCall("AskUserQuestion", { questions: [] }, agentId);
  assert(
    d.kind === "deny",
    `AskUserQuestion (agentID=${agentId ?? "main"}) must deny, got ${d.kind}`,
  );
  assert(
    d.kind === "deny" && /plain text/i.test(d.reason),
    `AskUserQuestion deny must redirect to plain text, got: ${d.kind === "deny" ? d.reason : ""}`,
  );
}

console.log("✅ canUseTool gating verified");
