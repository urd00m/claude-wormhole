#!/usr/bin/env bash
# Run every verification script in src/**/*.test.ts. Stubbed env vars satisfy
# zod schema; no real Slack/Anthropic credentials needed.
set -euo pipefail
cd "$(dirname "$0")/.."

export SLACK_APP_TOKEN=xapp-stub
export SLACK_BOT_TOKEN=xoxb-stub
export SLACK_SIGNING_SECRET=stub
export ANTHROPIC_API_KEY=stub

TESTS=(
  src/agent/guards.test.ts
  src/agent/canUseTool.test.ts
  src/agent/subagentDepth.test.ts
  src/agent/recursiveAgents.test.ts
  src/agent/spawnMcp.test.ts
  src/agent/spawnBackground.test.ts
  src/agent/spawnCodexWorker.test.ts
  src/agent/runtime/residentWorker.test.ts
  src/agent/residentWorkerRegistry.test.ts
  src/agent/spawnResident.test.ts
  src/agent/sessionIsolation.test.ts
  src/agent/spawnFlow.test.ts
  src/agent/sessionStream.test.ts
  src/agent/runtime/claude.test.ts
  src/agent/runtime/codex.test.ts
  src/agent/runtime/codexWireFormat.test.ts
  src/mcp/codexSpawnServer.test.ts
  src/slack/heartbeat.test.ts
  src/slack/contextIndicator.test.ts
  src/agent/manager.test.ts
  src/slack/stream.test.ts
  src/slack/streamOverflow.test.ts
  src/slack/taskEvents.test.ts
  src/slack/sessionWiring.test.ts
  src/slack/download.test.ts
  src/slack/consent.test.ts
  src/slack/endSessionMatcher.test.ts
  src/slack/activeMarker.test.ts
  src/scheduler/scheduler.test.ts
  src/agent/workdirStore.test.ts
  src/agent/runtimeStore.test.ts
  src/agent/macroStore.test.ts
  src/agent/aliasStore.test.ts
  src/agent/managerRuntime.test.ts
  src/slack/runtimeMatcher.test.ts
  src/agent/tools/slackPost.test.ts
  src/agent/tools/claudeMcp.test.ts
  src/agent/tools/slackPostDef.test.ts
  src/agent/tools/workdirDef.test.ts
  src/agent/tools/cronDef.test.ts
  src/agent/tools/configToolsDef.test.ts
  src/configCodex.test.ts
  src/skillsLink.test.ts
  src/usageStore.test.ts
  src/agent/tools/spawn.envTimers.test.ts
  src/slack/bangPrefix.test.ts
  src/slack/shellExec.test.ts
  src/agent/cavemanStore.test.ts
  src/slack/cavemanMatcher.test.ts
  src/cavemanLink.test.ts
)

for t in "${TESTS[@]}"; do
  npx tsx "$t"
done
