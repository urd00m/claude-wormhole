/** Runs only in the container. Host never opens paths supplied by a worker. */
import fs from "node:fs/promises";
import path from "node:path";
const chunks: Buffer[] = [];
for await (const b of process.stdin) chunks.push(b);
try {
  const input = JSON.parse(Buffer.concat(chunks).toString());
  if (input.op === "put") {
    if (!/^\/user\/sessions\/[A-Za-z0-9_-]+$/.test(input.workdir) || !/^[A-Za-z0-9_.-]+$/.test(input.name)) throw new Error("Invalid upload destination");
    const bytes = Buffer.from(input.data, "base64");
    if (bytes.length > 20 * 1024 * 1024) throw new Error("Attachment exceeds 20 MiB");
    const target = path.join(input.workdir, "uploads", input.name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Symlinks are evaluated only inside this container's mount namespace.
    await fs.writeFile(target, bytes);
    process.stdout.write(JSON.stringify({ path: "uploads/" + input.name }));
  } else if (input.op === "get") {
    const name = path.resolve(input.workdir, input.path);
    const stat = await fs.stat(name);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error("Output must be a file no larger than 20 MiB");
    const data = await fs.readFile(name);
    if (data.length > 20 * 1024 * 1024) throw new Error("Output exceeds 20 MiB");
    process.stdout.write(JSON.stringify({ name: path.basename(name), data: data.toString("base64") }));
  } else throw new Error("Invalid file operation");
} catch (e) { process.stderr.write(String(e)); process.exitCode = 1; }
