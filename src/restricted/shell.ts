import fs from "node:fs/promises";
import { shellExec } from "../slack/shellExec.js";
const chunks: Buffer[] = [];
for await (const b of process.stdin) chunks.push(b);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (typeof input.cwd !== "string" || !input.cwd.startsWith("/") || typeof input.command !== "string") throw new Error("Invalid shell request");
  await fs.mkdir(input.cwd, { recursive: true });
  process.stdout.write(JSON.stringify(await shellExec(input.command, { cwd: input.cwd })));
} catch (e) { process.stderr.write(String(e)); process.exitCode = 1; }
