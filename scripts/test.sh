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
  src/agent/sessionIsolation.test.ts
  src/agent/spawnFlow.test.ts
  src/agent/sessionStream.test.ts
  src/slack/heartbeat.test.ts
  src/agent/manager.test.ts
  src/slack/stream.test.ts
  src/slack/taskEvents.test.ts
  src/slack/sessionWiring.test.ts
  src/slack/download.test.ts
  src/slack/consent.test.ts
  src/slack/endSessionMatcher.test.ts
  src/slack/activeMarker.test.ts
  src/scheduler/scheduler.test.ts
  src/agent/workdirStore.test.ts
)

for t in "${TESTS[@]}"; do
  npx tsx "$t"
done
