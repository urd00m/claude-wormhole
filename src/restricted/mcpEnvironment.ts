/** Codex deliberately filters MCP child environments. Preserve only worker-local settings. */
export function restrictedMcpEnvironment(name: string): string[] {
  if (process.env.WORMHOLE_WORKER !== "1") return [];
  const keys = ["WORMHOLE_WORKER", "WORMHOLE_STATE_DIR", "WORMHOLE_BRIDGE_SOCKET", "WORMHOLE_SPAWN_DEPTH", "WORMHOLE_SPAWN_MAX_DEPTH", "WORMHOLE_SPAWN_TSX", "WORMHOLE_SPAWN_SERVER", "WORMHOLE_SPAWN_WORKDIR", "WORMHOLE_SPAWN_CLAUDE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_MODEL", "ANTHROPIC_MODEL"];
  return ["-c", `mcp_servers.${name}.env_vars=${JSON.stringify(keys)}`];
}
