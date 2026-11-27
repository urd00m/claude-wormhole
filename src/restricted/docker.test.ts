import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { validateContainer, shellQuote } from "./docker.js";
import { RESTRICTED_USERS, PROFILE, IMAGE, LIMITS, networkName, volumeName } from "./policy.js";
const user = RESTRICTED_USERS[0];
const valid = {
  State: { Running: true },
  Config: { Image: IMAGE, User: "1000:1000", Labels: { "wormhole.profile": PROFILE, "wormhole.user": user } },
  HostConfig: { ReadonlyRootfs: true, Privileged: false, IpcMode: "private", NetworkMode: networkName(user), Memory: LIMITS.memory, MemorySwap: LIMITS.memory, NanoCpus: LIMITS.cpus * 1e9, PidsLimit: LIMITS.pids, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/tmp": "size=268435456", "/run": "size=16777216" }, LogConfig: { Type: "local", Config: { "max-size": "10m", "max-file": "3" } } },
  NetworkSettings: { Networks: { [networkName(user)]: {} } },
  Mounts: [{ Type: "bind", Source: "/scratch/aires-db", Destination: "/scratch/aires-db", RW: false, Propagation: "rprivate" }, { Type: "volume", Name: volumeName(user), Destination: "/user", RW: true }],
};
validateContainer(user, valid);
const reject = (modify: (c: any) => void) => { const c = structuredClone(valid); modify(c); assert.throws(() => validateContainer(user, c)); };
reject(c => c.State.Running = false);
reject(c => c.Config.User = "0:0");
reject(c => c.Config.Labels["wormhole.user"] = RESTRICTED_USERS[1]);
reject(c => c.HostConfig.Privileged = true);
reject(c => c.HostConfig.ReadonlyRootfs = false);
reject(c => c.HostConfig.Memory = 0);
reject(c => c.HostConfig.MemorySwap = -1);
reject(c => c.HostConfig.PidsLimit = -1);
reject(c => c.HostConfig.NetworkMode = "host");
reject(c => c.NetworkSettings.Networks.other = {});
reject(c => c.HostConfig.LogConfig.Type = "json-file");
reject(c => c.HostConfig.PidMode = "host");
reject(c => c.HostConfig.CapAdd = ["SYS_ADMIN"]);
reject(c => c.HostConfig.SecurityOpt.push("seccomp=unconfined"));
reject(c => c.HostConfig.Devices = [{ PathOnHost: "/dev/sda" }]);
reject(c => c.HostConfig.PortBindings = { "80/tcp": [] });
reject(c => c.Mounts[0].RW = true);
reject(c => c.Mounts[1].Name = volumeName(RESTRICTED_USERS[1]));
reject(c => c.Mounts.push({ Source: "/", Destination: "/host" }));
reject(c => c.HostConfig.Tmpfs["/other"] = "size=15g");
for (const input of ["simple", "a'b", "$(printf BAD)", "`printf BAD`", "x\ny", "; printf BAD"]) {
  assert.equal(execFileSync("sh", ["-c", "printf %s " + shellQuote(input)], { encoding: "utf8" }), input);
}
console.log("✅ Restricted container validation: ownership, mounts, privileges, networking, resource ceilings and safe Docker arguments");
