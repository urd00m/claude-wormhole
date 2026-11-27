/** Opt-in checks against the two provisioned containers. No real Slack/model calls. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { RESTRICTED_USERS, RESTRICTED_CHANNEL, LIMITS, restrictedKey, sessionDirectory, containerName, networkName } from "../restricted/policy.js";
import { docker, ensureContainer, containerHelper } from "../restricted/docker.js";

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "wormhole-restricted-it-"));
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_SIGNING_SECRET = "test";
process.env.WORMHOLE_STATE_DIR = temporary;
const { ContinuityStore } = await import("../agent/continuityStore.js");
const { ContainerRuntime } = await import("../restricted/runtime.js");
const { handleRestricted, drainRestricted } = await import("../restricted/handler.js");
const { registerHandlers } = await import("../slack/handlers.js");
const events = new Map<string, Function>();
registerHandlers({ event: (name: string, fn: Function) => events.set(name, fn) } as any);
const store = new ContinuityStore(path.join(temporary, "test.sqlite"));
const sentinel = path.join(temporary, "host-secret"); await fs.writeFile(sentinel, "host-only-sentinel");
const server = http.createServer((_req, res) => res.end("host-service-sentinel"));
await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
const port = (server.address() as { port: number }).port;
try {
  for (const user of RESTRICTED_USERS) {
    await ensureContainer(user);
    const check = `import os,json,errno,socket
db='/scratch/aires-db'
assert os.getuid()==1000
assert os.statvfs(db).f_flag & os.ST_RDONLY
assert os.listdir(db)
try:
 open(db+'/.wormhole-readonly-test','w')
 raise Exception('database was writable')
except OSError as e: assert e.errno==errno.EROFS
assert not os.path.exists(${JSON.stringify(sentinel)})
assert not os.path.exists('/var/run/docker.sock')
assert not os.path.exists('/home/alan/.ssh')
assert not any(k.startswith('SLACK_') for k in os.environ)
assert int(open('/sys/fs/cgroup/memory.max').read())==${LIMITS.memory}
assert int(open('/sys/fs/cgroup/memory.swap.max').read())==0
assert int(open('/sys/fs/cgroup/pids.max').read())==${LIMITS.pids}
quota,period=map(int,open('/sys/fs/cgroup/cpu.max').read().split()); assert quota/period==2
s=os.statvfs('/user'); assert 14*1024**3<s.f_blocks*s.f_frsize<=15*1024**3
assert os.statvfs('/').f_flag & os.ST_RDONLY
print('uid, DB, host files, credentials, RAM/swap/CPU/PIDs/storage limits: OK')`;
    console.log(user, (await docker(["exec", containerName(user), "python3", "-c", check])).trim());
    const network = JSON.parse(await docker(["network", "inspect", networkName(user)]))[0];
    const host = network.IPAM.Config[0].Gateway;
    const connectivity = `import socket,urllib.request
try:
 socket.create_connection((${JSON.stringify(host)},${port}),timeout=2)
 raise Exception('host connection was permitted')
except (TimeoutError,ConnectionRefusedError,OSError): pass
assert urllib.request.urlopen('https://example.com',timeout=20).status==200
print('general internet allowed, host service blocked: OK')`;
    console.log(user, (await docker(["exec", containerName(user), "python3", "-c", connectivity])).trim());
    const key = restrictedKey(user, RESTRICTED_CHANNEL, "1.234567");
    const workdir = sessionDirectory(key);
    const file = await containerHelper(user, "files", { op: "put", workdir, name: "roundtrip.txt", data: Buffer.from("container-file").toString("base64") });
    const exported = await containerHelper(user, "files", { op: "get", workdir, path: file.path });
    assert.equal(Buffer.from(exported.data, "base64").toString(), "container-file");
    await assert.rejects(() => containerHelper(user, "files", { op: "get", workdir, path: sentinel }));
    const shell = await containerHelper(user, "shell", { cwd: workdir, command: "pwd; printf container-shell" });
    assert.equal(shell.exitCode, 0); assert(shell.stdout.includes(workdir)); assert(shell.stdout.includes("container-shell"));
    for (const runtime of ["codex", "claude"] as const) {
      const binding = { key: key + ":" + runtime, runtime, workdir, providerHome: `/user/${runtime}`, sessionId: null, started: false, state: "ready" as const,
        execution: { kind: "docker" as const, user, container: containerName(user), channel: RESTRICTED_CHANNEL, thread: "1.234567" } };
      store.put(binding);
      const adapter = new ContainerRuntime(binding, store);
      await adapter.prepare();
      assert.equal(await adapter.interrupt(), false);
      await adapter.close();
      console.log(user, runtime, "container worker initialization/interrupt/drain: OK");
    }
    const posts: any[] = [];
    const fakeClient = { chat: { postMessage: async (p: any) => { posts.push(p); return { ts: "1.2" }; } } } as any;
    await handleRestricted(fakeClient, { user, channel: RESTRICTED_CHANNEL, ts: "1.234568", text: "!printf routed-through-container; pwd" });
    assert(posts.some(p => p.text.includes("routed-through-container") && p.text.includes("/user/sessions/")));
    const count = posts.length;
    await handleRestricted(fakeClient, { user, channel: "DOTHER", ts: "1.234569", text: "!pwd" });
    assert.equal(posts.length, count);
    const ts = user === RESTRICTED_USERS[0] ? "3.111111" : "3.222222";
    const event = { channel: RESTRICTED_CHANNEL, user, ts, text: "!printf full-dispatch-ok; pwd" };
    await events.get("message")!({ client: fakeClient, event });
    assert(posts.some(p => p.text.includes("full-dispatch-ok") && p.text.includes(user)));
    const delivered = posts.length;
    await events.get("app_mention")!({ client: fakeClient, event });
    assert.equal(posts.length, delivered, "Duplicate Slack event must not execute the command twice");
    console.log(user, "gateway ! routing and denied DM: OK");
  }
  console.log("✅ Real Docker isolation, resources, network, file transfer, worker lifecycle and restricted dispatch passed");
} finally {
  await drainRestricted(); store.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(temporary, { recursive: true, force: true });
}
