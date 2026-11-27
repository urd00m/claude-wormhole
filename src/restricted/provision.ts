/** Operator-only provisioning. Never imported by the Slack gateway or container worker. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { docker, ensureContainer } from "./docker.js";
import { RESTRICTED_USERS, LIMITS, IMAGE, PROFILE, SANDBOX_INSTRUCTION, containerName, networkName, volumeName } from "./policy.js";

const sourceRoot = process.env.WORMHOLE_LIVE_ROOT ?? "/home/alan/claude-wormhole";
const stateRoot = process.env.WORMHOLE_STATE_DIR ?? path.join(os.homedir(), ".local/state/claude-wormhole");
const disks = path.join(stateRoot, "restricted/disks");
const loopScript = `import os,sys,subprocess,json,stat,fcntl,errno
p='/disks/'+sys.argv[1]+'.img'
expected=sys.argv[2]
if not os.path.isfile(p) or os.path.getsize(p)!=15*1024**3: raise Exception('invalid storage image')
if expected:
 index=int(expected.replace('/dev/loop',''))
 control=os.open('/dev/loop-control',os.O_RDWR)
 try:
  try: fcntl.ioctl(control,0x4C80,index)
  except OSError as e:
   if e.errno!=errno.EEXIST: raise
 finally: os.close(control)
 if not os.path.exists(expected): os.mknod(expected,stat.S_IFBLK|0o600,os.makedev(7,int(expected.replace('/dev/loop',''))))
 r=subprocess.run(['losetup',expected],capture_output=True,text=True)
 if r.returncode==0:
  matches=subprocess.check_output(['losetup','-j',p,'--noheadings','--output','NAME'],text=True).split()
  if expected not in matches: raise Exception('loop device is in use by another filesystem')
 else: subprocess.run(['losetup',expected,p],check=True)
 print(expected)
else:
 matches=subprocess.check_output(['losetup','-j',p,'--noheadings','--output','NAME'],text=True).split()
 if matches: print(matches[0])
 else:
  dev=subprocess.check_output(['losetup','-f'],text=True).strip()
  if not os.path.exists(dev): os.mknod(dev,stat.S_IFBLK|0o600,os.makedev(7,int(dev.replace('/dev/loop',''))))
  subprocess.run(['losetup',dev,p],check=True)
  print(dev)
`;
const initScript = `const fs=require('node:fs');let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>{const a=JSON.parse(s);for(const d of ['home','sessions','auth','claude','codex','data','state']){fs.mkdirSync('/user/'+d,{recursive:true});fs.chownSync('/user/'+d,1000,1000);}for(const [p,v] of Object.entries(a.files)){const f='/user/'+p;const auth=['auth/runtime.json','codex/auth.json','claude/.credentials.json'].includes(p);if(!fs.existsSync(f)||(a.refreshAuth&&auth)){fs.writeFileSync(f,v,{mode:0o600});fs.chownSync(f,1000,1000);}}});`;
const firewallScript = `set -eu
bridge="$1"
iptables -w -C INPUT -i "$bridge" -j DROP 2>/dev/null || iptables -w -I INPUT 1 -i "$bridge" -j DROP
for range in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
 iptables -w -C DOCKER-USER -i "$bridge" -d "$range" -j DROP 2>/dev/null || iptables -w -I DOCKER-USER 1 -i "$bridge" -d "$range" -j DROP
done`;
async function readOptional(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
}
async function provisionUser(user: string, seeds: Record<string, string>): Promise<void> {
  const disk = path.join(disks, user + ".img");
  let created = false;
  try {
    const f = await fs.open(disk, "wx", 0o600); await f.close();
    // Reserve actual disk capacity rather than promise sparse space that can disappear.
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("fallocate", ["-l", String(LIMITS.storage), disk], e => e ? reject(e) : resolve())); created = true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  if ((await fs.stat(disk)).size !== LIMITS.storage) throw new Error("Unexpected storage image size; refusing to replace it");
  if (created) {
    try { await docker(["run", "--rm", "--network", "none", "--user", "0:0", "--mount", `type=bind,src=${disks},dst=/disks`, IMAGE, "mkfs.ext4", "-q", "-F", "-E", "nodiscard", "-m", "0", `/disks/${user}.img`]); }
    catch (e) { await fs.unlink(disk); throw e; } // Not attached or exposed to a user yet.
  }
  if ((await fs.stat(disk)).blocks * 512 < LIMITS.storage) {
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => execFile("fallocate", ["-l", String(LIMITS.storage), disk], e => e ? reject(e) : resolve()));
  }
  let volume: any;
  const volumes = (await docker(["volume", "ls", "--filter", `name=^${volumeName(user)}$`, "--format", "{{.Name}}"])).trim();
  if (volumes) volume = JSON.parse(await docker(["volume", "inspect", volumeName(user)]))[0];
  if (volume && (volume.Labels?.["wormhole.profile"] !== PROFILE || volume.Labels?.["wormhole.user"] !== user || !/^\/dev\/loop\d+$/.test(volume.Options?.device ?? ""))) throw new Error("Unexpected existing volume; refusing to replace it");
  // This short-lived operator helper attaches only the two dedicated image files.
  // The restricted containers themselves are NEVER privileged and have no Docker access.
  const reservedLoop = `/dev/loop${300 + (RESTRICTED_USERS as readonly string[]).indexOf(user)}`;
  const loop = (await docker(["run", "--rm", "--privileged", "--network", "none", "--user", "0:0", "--mount", "type=bind,src=/dev,dst=/dev", "--mount", `type=bind,src=${disks},dst=/disks`, IMAGE, "python3", "-c", loopScript, user, volume?.Options?.device ?? reservedLoop])).trim();
  if (!/^\/dev\/loop\d+$/.test(loop)) throw new Error("Invalid loop device response");
  if (!volume) await docker(["volume", "create", "--driver", "local", "--opt", "type=ext4", "--opt", `device=${loop}`, "--opt", "o=rw,nosuid,nodev", "--label", `wormhole.profile=${PROFILE}`, "--label", `wormhole.user=${user}`, "--label", `wormhole.bytes=${LIMITS.storage}`, volumeName(user)]);
  await docker(["run", "--rm", "-i", "--network", "none", "--user", "0:0", "--mount", `type=volume,src=${volumeName(user)},dst=/user`, IMAGE, "node", "-e", initScript], JSON.stringify({ files: seeds, refreshAuth: process.argv.includes("--refresh-model-auth") }));
  const bridge = "wh-" + user.toLowerCase().slice(-10);
  const networks = (await docker(["network", "ls", "--filter", `name=^${networkName(user)}$`, "--format", "{{.Name}}"])).trim();
  if (!networks) await docker(["network", "create", "--driver", "bridge", "--label", `wormhole.profile=${PROFILE}`, "--opt", "com.docker.network.bridge.enable_icc=false", "--opt", `com.docker.network.bridge.name=${bridge}`, networkName(user)]);
  const network = JSON.parse(await docker(["network", "inspect", networkName(user)]))[0];
  if (network.Labels?.["wormhole.profile"] !== PROFILE || network.Options?.["com.docker.network.bridge.name"] !== bridge || network.Options?.["com.docker.network.bridge.enable_icc"] !== "false" || network.EnableIPv6) throw new Error("Unexpected restricted network");
  await docker(["run", "--rm", "--network", "host", "--user", "0:0", "--cap-add", "NET_ADMIN", IMAGE, "sh", "-c", firewallScript, "firewall", bridge]);
  const existing = (await docker(["ps", "-a", "--filter", `name=^/${containerName(user)}$`, "--format", "{{.ID}}"])).trim();
  if (!existing) await docker(["create", "--name", containerName(user), "--label", `wormhole.profile=${PROFILE}`, "--label", `wormhole.user=${user}`, "--user", "1000:1000", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", String(LIMITS.memory), "--memory-swap", String(LIMITS.memory), "--cpus", String(LIMITS.cpus), "--pids-limit", String(LIMITS.pids), "--ipc", "private", "--network", networkName(user), "--mount", "type=bind,src=/scratch/aires-db,dst=/scratch/aires-db,readonly,bind-propagation=rprivate", "--mount", `type=volume,src=${volumeName(user)},dst=/user`, "--tmpfs", "/tmp:rw,nosuid,nodev,size=268435456", "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=16777216", "--log-driver", "local", "--log-opt", "max-size=10m", "--log-opt", "max-file=3", IMAGE]);
  const info = JSON.parse(await docker(["inspect", containerName(user)]))[0];
  if (!info.State.Running) await docker(["start", containerName(user)]);
  await ensureContainer(user);
  const storage = JSON.parse(await docker(["exec", containerName(user), "python3", "-c", "import os,json;s=os.statvfs('/user');print(json.dumps({'bytes':s.f_blocks*s.f_frsize}))"]));
  if (!(storage.bytes > 14 * 1024 ** 3 && storage.bytes <= LIMITS.storage)) throw new Error("User storage filesystem does not enforce the requested capacity");
  console.log(`${user}: ready, 3 GiB RAM, 15 GiB disk, 2 CPUs, 256 processes`);
}
export async function provision(): Promise<void> {
  await fs.mkdir(disks, { recursive: true, mode: 0o700 });
  const raw = { ...parse(await fs.readFile(path.join(sourceRoot, ".env"), "utf8")), ...process.env };
  const runtime: Record<string, string> = {};
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_MODEL", "OPENAI_MODEL"]) if (raw[key]) runtime[key] = raw[key];
  const seeds: Record<string, string> = { "auth/runtime.json": JSON.stringify(runtime) };
  const codexAuth = await readOptional(path.join(os.homedir(), ".codex/auth.json"));
  const credentialDirs = (raw.CLAUDE_CREDENTIAL_DIRS ?? "").split(",").map(s => s.trim().replace(/^~(?=\/|$)/, os.homedir())).filter(Boolean);
  credentialDirs.push(path.join(os.homedir(), ".claude"));
  let claudeAuth: string | undefined, expiresAt = -1;
  for (const dir of credentialDirs) {
    const candidate = await readOptional(path.join(dir, ".credentials.json"));
    if (!candidate) continue;
    const expiration = JSON.parse(candidate).claudeAiOauth?.expiresAt ?? 0;
    if (expiration > expiresAt) { claudeAuth = candidate; expiresAt = expiration; }
  }
  if (codexAuth) seeds["codex/auth.json"] = codexAuth;
  if (claudeAuth) seeds["claude/.credentials.json"] = claudeAuth;
  // Only model selection is copied; host plugins, MCP servers, hooks and project trust are excluded.
  const codexConfig = await readOptional(path.join(os.homedir(), ".codex/config.toml"));
  const model = codexConfig?.match(/^model\s*=\s*("[^"\n]+")/m)?.[1];
  seeds["codex/config.toml"] = (model ? `model = ${model}\n` : "") + `developer_instructions = ${JSON.stringify(SANDBOX_INSTRUCTION)}\n`;
  for (const user of RESTRICTED_USERS) await provisionUser(user, seeds);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await provision();
