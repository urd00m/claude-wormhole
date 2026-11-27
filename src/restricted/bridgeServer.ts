/** Codex's MCP child connects only to a Unix socket inside this same container. */
import net from "node:net";
import readline from "node:readline";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bridgeToolDefs } from "./bridgeTools.js";
const socket = process.env.WORMHOLE_BRIDGE_SOCKET;
if (!socket?.startsWith("/tmp/wormhole-")) throw new Error("Missing container bridge");
const server = new McpServer({ name: "wormhole_bridge", version: "1.0.0" });
for (const def of bridgeToolDefs((tool, args) => new Promise((resolve, reject) => {
  const client = net.createConnection(socket);
  const timer = setTimeout(() => { client.destroy(); reject(new Error("Slack bridge timed out")); }, 120000);
  client.on("error", e => { clearTimeout(timer); reject(e); });
  client.on("connect", () => client.write(JSON.stringify({ tool, args }) + "\n"));
  readline.createInterface({ input: client }).once("line", line => {
    clearTimeout(timer); client.end();
    try { const r = JSON.parse(line); r.error ? reject(new Error(r.error)) : resolve(r.text); } catch (e) { reject(e); }
  });
}))) server.tool(def.name, def.description, def.schema, def.handler as any);
await server.connect(new StdioServerTransport());
