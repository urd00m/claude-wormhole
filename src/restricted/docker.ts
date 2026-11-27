import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { containerName, networkName, volumeName, LIMITS, PROFILE, IMAGE } from "./policy.js";

/** sg refreshes Alan's existing docker membership; user input is never shell code here. */
export function shellQuote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
export function dockerProcess(args: string[]): ChildProcessWithoutNullStreams {
  return spawn("/usr/bin/sg", ["docker", "-c", "exec /usr/bin/docker --host unix:///var/run/docker.sock " + args.map(shellQuote).join(" ")], {
    stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/home/alan" },
  });
}
export async function docker(args: string[], input?: string, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const child = dockerProcess(args);
  return new Promise((resolve, reject) => {
    const output: Buffer[] = [], errors: Buffer[] = [];
    let size = 0, errorSize = 0, failed = false;
    const fail = (error: Error) => { if (!failed) { failed = true; child.kill(); reject(error); } };
    child.on("error", fail);
    child.stdout.on("data", (b: Buffer) => { size += b.length; if (size > maxBytes) fail(new Error("Docker response exceeded limit")); else output.push(b); });
    child.stderr.on("data", (b: Buffer) => { if (errorSize < 16384) { errors.push(b); errorSize += b.length; } });
    child.on("close", code => {
      if (failed) return;
      if (code !== 0) reject(new Error(`Docker operation failed (${code}): ${Buffer.concat(errors).toString().slice(-16384)}`));
      else resolve(Buffer.concat(output).toString());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Fail closed on changed/misprovisioned containers, not just missing containers. */
export function validateContainer(user: string, item: any): void {
  const h = item.HostConfig, c = item.Config;
  const bad = (reason: string): never => { throw new Error(`Restricted container rejected: ${reason}`); };
  if (!item.State?.Running) bad("container is not running; ask Alan to provision it");
  if (c?.Image !== IMAGE || c?.Labels?.["wormhole.profile"] !== PROFILE || c?.Labels?.["wormhole.user"] !== user) bad("identity/profile mismatch");
  if (c?.User !== "1000:1000" || !h?.ReadonlyRootfs || h.Privileged || h.PidMode === "host" || !["private", ""].includes(h.IpcMode)) bad("unsafe isolation settings");
  if (h.NetworkMode !== networkName(user) || h.PublishAllPorts || Object.keys(h.PortBindings ?? {}).length) bad("unsafe network settings");
  const networks = Object.keys(item.NetworkSettings?.Networks ?? {});
  if (networks.length !== 1 || networks[0] !== networkName(user)) bad("unexpected network attachment");
  if (h.LogConfig?.Type !== "local" || h.LogConfig.Config?.["max-size"] !== "10m" || h.LogConfig.Config?.["max-file"] !== "3") bad("unbounded container logs");
  if (h.Memory !== LIMITS.memory || h.MemorySwap !== LIMITS.memory || h.NanoCpus !== LIMITS.cpus * 1e9 || h.PidsLimit !== LIMITS.pids) bad("resource limits changed");
  if (!h.CapDrop?.some((x: string) => x.toUpperCase() === "ALL") || h.CapAdd?.length || !h.SecurityOpt?.some((x: string) => x === "no-new-privileges" || x === "no-new-privileges:true") || h.SecurityOpt?.some((x: string) => /unconfined/.test(x))) bad("unsafe privileges");
  if (h.Devices?.length || h.DeviceRequests?.length || h.DeviceCgroupRules?.length || h.VolumesFrom?.length) bad("unexpected device/volume access");
  const mounts = item.Mounts ?? [];
  if (mounts.length !== 2) bad("unexpected mounts");
  const db = mounts.find((m: any) => m.Destination === "/scratch/aires-db");
  const data = mounts.find((m: any) => m.Destination === "/user");
  if (db?.Type !== "bind" || db.Source !== "/scratch/aires-db" || db.RW || db.Propagation !== "rprivate") bad("database must be read-only");
  if (data?.Type !== "volume" || data.Name !== volumeName(user) || !data.RW) bad("user storage mismatch");
  if (Object.keys(h.Tmpfs ?? {}).some(p => !["/tmp", "/run"].includes(p))) bad("unexpected writable filesystem");
}
export async function ensureContainer(user: string): Promise<void> {
  const items = JSON.parse(await docker(["inspect", containerName(user)]));
  if (!Array.isArray(items) || items.length !== 1) throw new Error("Restricted container is unavailable");
  validateContainer(user, items[0]);
  const image = JSON.parse(await docker(["image", "inspect", IMAGE]))[0];
  if (items[0].Image !== image.Id) throw new Error("Restricted container uses a different worker image; operator rollout is required");
  const volume = JSON.parse(await docker(["volume", "inspect", volumeName(user)]))[0];
  if (volume.Labels?.["wormhole.profile"] !== PROFILE || volume.Labels?.["wormhole.user"] !== user || volume.Labels?.["wormhole.bytes"] !== String(LIMITS.storage) || volume.Options?.type !== "ext4" || !/^\/dev\/loop\d+$/.test(volume.Options?.device ?? "")) throw new Error("Restricted storage profile mismatch");
}
export function workerProcess(user: string, action = "worker"): ChildProcessWithoutNullStreams {
  if (!["worker", "files", "shell"].includes(action)) throw new Error("Invalid container helper");
  return dockerProcess(["exec", "-i", "--user", "1000:1000", containerName(user), "node", `/opt/wormhole/dist/restricted/${action}.js`]);
}
export async function containerHelper(user: string, action: "files" | "shell", request: unknown, maxBytes = 30 * 1024 * 1024): Promise<any> {
  await ensureContainer(user);
  return JSON.parse(await docker(["exec", "-i", "--user", "1000:1000", containerName(user), "node", `/opt/wormhole/dist/restricted/${action}.js`], JSON.stringify(request), maxBytes));
}
