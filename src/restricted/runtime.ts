import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Binding, ContinuityStore } from "../agent/continuityStore.js";
import { ProviderError } from "../agent/providerError.js";
import type { Runtime, SessionInput, SessionOutput, StreamHooks } from "../agent/runtime/types.js";
import { ensureContainer, workerProcess } from "./docker.js";
import { workerIdentity } from "./identity.js";

type Gateway = (tool: string, args: Record<string, unknown>) => Promise<string>;
type Pending = { resolve: (value: any) => void; reject: (e: Error) => void; hooks?: StreamHooks };
/** Host-side adapter: there is deliberately no local runtime fallback. */
export class ContainerRuntime implements Runtime {
  readonly name: "claude" | "codex";
  workdir: string;
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<string, Pending>();
  private failure?: Error;
  private stderr = "";
  private activeAuthorAt?: number;
  private taskAuthors = new Map<string, number | undefined>();
  private gatewayPending = 0;
  onGateway: Gateway = async () => { throw new Error("Gateway not connected"); };
  onWake: (prompt: string, userMessageAt?: number) => void = () => {};
  constructor(readonly binding: Binding, private store: ContinuityStore) {
    if (!binding.execution || binding.execution.kind !== "docker") throw new Error("Missing restricted execution binding");
    this.name = binding.runtime; this.workdir = binding.workdir;
  }
  get conversationId(): string | null { return this.binding.sessionId; }
  private fail(error: Error): void {
    this.failure = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  private write(value: unknown): void {
    if (this.failure) throw this.failure;
    if (!this.child?.stdin.writable) throw new Error("Restricted worker is unavailable");
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  private async receive(msg: any): Promise<void> {
    const p = this.pending.get(msg.id);
    switch (msg.type) {
      case "identity": {
        const i = workerIdentity(msg.identity, this.name);
        this.store.saveIdentity(this.binding.key, i);
        Object.assign(this.binding, i); this.workdir = i.workdir; return;
      }
      case "text": if (typeof msg.text === "string") p?.hooks?.onText?.(msg.text); return;
      case "final": if (typeof msg.text === "string") p?.hooks?.onFinal?.(msg.text); return;
      case "tool_start": p?.hooks?.onToolStart?.(msg.toolId, msg.name, {}); return;
      case "tool_end": p?.hooks?.onToolEnd?.(msg.toolId, msg.ok); return;
      case "task": {
        if (msg.event?.kind === "started" && this.activeAuthorAt !== undefined && typeof msg.event.taskId === "string" && msg.event.taskId.length <= 200 && !this.taskAuthors.has(msg.event.taskId)) {
          if (this.taskAuthors.size >= 256) this.taskAuthors.delete(this.taskAuthors.keys().next().value!);
          // Authorization comes from the real human input sent by the gateway, not worker metadata.
          this.taskAuthors.set(msg.event.taskId, this.activeAuthorAt);
        }
        return;
      }
      case "wake": {
        if (typeof msg.prompt === "string" && this.taskAuthors.has(msg.taskId)) {
          const author = this.taskAuthors.get(msg.taskId);
          this.taskAuthors.delete(msg.taskId);
          setImmediate(() => this.onWake(msg.prompt.slice(0, 8192), author));
        }
        return;
      }
      case "gateway": {
        if (this.gatewayPending >= 8) { this.write({ op: "gateway_result", id: msg.id, error: "Too many pending gateway requests; retry after earlier requests complete" }); return; }
        this.gatewayPending++;
        try {
          const text = await this.onGateway(msg.tool, msg.args ?? {});
          this.write({ op: "gateway_result", id: msg.id, text });
        } catch (e) { this.write({ op: "gateway_result", id: msg.id, error: e instanceof Error ? e.message : String(e) }); }
        finally { this.gatewayPending--; }
        return;
      }
      case "result": if (p) { this.pending.delete(msg.id); p.resolve(msg.value); } return;
      case "error": if (p) { this.pending.delete(msg.id); p.reject(msg.failure ? new ProviderError(msg.failure) : new Error(msg.message ?? "Container worker failed")); } return;
      default: throw new Error("Invalid restricted worker event");
    }
  }
  private request(op: string, values: Record<string, unknown> = {}, hooks?: StreamHooks): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, hooks });
      try { this.write({ id, op, ...values }); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }
  private async start(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      await ensureContainer(this.binding.execution!.user);
      this.child = workerProcess(this.binding.execution!.user);
      this.child.on("error", e => this.fail(e));
      this.child.stdin.on("error", e => this.fail(e));
      this.child.stderr.on("data", b => { this.stderr = (this.stderr + b.toString()).slice(-16384); });
      this.child.on("close", code => this.fail(new Error(`Restricted worker exited (${code}). ${this.stderr}`)));
      let buffered = "", rejected = false;
      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk: string) => {
        if (rejected) return;
        buffered += chunk;
        let end: number;
        while ((end = buffered.indexOf("\n")) !== -1) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          if (line.length > 4 * 1024 * 1024) { rejected = true; this.fail(new Error("Restricted worker event exceeded limit")); this.child?.stdin.end(); return; }
          try { void this.receive(JSON.parse(line)).catch(e => { rejected = true; this.fail(e); this.child?.stdin.end(); }); }
          catch { rejected = true; this.fail(new Error("Malformed restricted worker event")); this.child?.stdin.end(); return; }
        }
        if (buffered.length > 4 * 1024 * 1024) { rejected = true; buffered = ""; this.fail(new Error("Restricted worker event exceeded limit")); this.child?.stdin.end(); }
      });
      await this.request("init", { binding: this.binding });
    })();
    try { await this.starting; }
    catch (e) { this.fail(e instanceof Error ? e : new Error(String(e))); this.child?.stdin.end(); throw e; }
  }
  async prepare(): Promise<void> { await this.start(); }
  async send(input: SessionInput, hooks: StreamHooks = {}): Promise<SessionOutput> {
    await ensureContainer(this.binding.execution!.user);
    await this.start();
    this.activeAuthorAt = input.userMessageAt;
    try { return await this.request("send", { input }, hooks); }
    finally { this.activeAuthorAt = undefined; }
  }
  async interrupt(): Promise<boolean> { return this.child && !this.failure ? this.request("interrupt") : false; }
  setWorkdir(): void { throw new Error("Workdir changes must execute inside the restricted worker"); }
  resetConversation(): void { throw new Error("End the restricted session before starting a new conversation"); }
  async close(): Promise<void> {
    if (this.child && !this.failure) await this.request("drain");
    this.child?.stdin.end();
  }
}
