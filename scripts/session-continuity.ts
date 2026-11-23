import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { inventoryThreads, validateManifest, importManifest, type MigrationManifest } from "../src/agent/continuityManifest.js";

const [command, ...args] = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const root = arg("--root");
if (!root || !["inventory", "validate", "import"].includes(command)) throw new Error("Usage: session-continuity.ts inventory|validate|import --root <legacy-root> [--manifest <file>] [--codex-home <dir>] [--claude-home <dir>] [--state-dir <dir> --apply --confirm-stopped]");
const inventory = inventoryThreads(root, path.resolve(arg("--codex-home") ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")), path.resolve(arg("--claude-home") ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")));
if (command === "inventory") console.log(JSON.stringify(inventory, null, 2));
else {
  const file = arg("--manifest");
  if (!file) throw new Error("An explicitly verified manifest is required.");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as MigrationManifest;
  if (command === "validate") console.log(JSON.stringify({ valid: true, bindings: validateManifest(manifest, inventory) }, null, 2));
  else {
    const dir = arg("--state-dir");
    if (!dir || !args.includes("--apply") || !args.includes("--confirm-stopped")) throw new Error("Import requires --state-dir, --apply and --confirm-stopped after deployment approval.");
    // The legacy bot has no durable ownership lease. Refuse to import while
    // its watcher or a node process in that checkout is still alive.
    for (const name of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      if (Number(name) === process.pid) continue;
      try {
        const cwd = fs.readlinkSync(`/proc/${name}/cwd`);
        const argv = fs.readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0");
        if (path.resolve(cwd) === path.resolve(root) && argv.some((s) => /(?:^|\/)node$/.test(s))) throw new Error(`Legacy node process ${name} is still running; import/deployment must wait.`);
        const nativeWorker = argv.slice(0, 3).some((s) => /(?:^|\/)(?:codex|claude|codex-code-mode-host)(?:\.js)?$/.test(s) || s.includes("claude-agent-sdk/cli.js"));
        if (nativeWorker && inventory.threads.some((t) => t.candidates.some((c) => path.resolve(c.workdir) === path.resolve(cwd)))) throw new Error(`Native worker ${name} is still running in a migrating conversation; deployment must wait.`);
      } catch (error) { if (error instanceof Error && /^(Legacy node|Native worker)/.test(error.message)) throw error; }
    }
    importManifest(manifest, inventory, path.join(path.resolve(dir), "sessions.sqlite"));
    console.log("Imported verified conversation identities. No provider requests were sent.");
  }
}
