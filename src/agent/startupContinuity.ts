import fs from "node:fs/promises";
import path from "node:path";
import { RecoveryRequiredError, type ContinuityStore } from "./continuityStore.js";

/** The first rollout must import every old marker before boot clears it. */
export async function verifyIndexedThreads(root: string, store: ContinuityStore): Promise<void> {
  let entries: unknown;
  try { entries = JSON.parse(await fs.readFile(path.join(root, "data/active-sessions.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new RecoveryRequiredError("Cannot verify the old active-thread index; deployment must wait.");
  }
  if (!Array.isArray(entries)) throw new RecoveryRequiredError("The old active-thread index is invalid; deployment must wait.");
  const missing: string[] = [];
  for (const e of entries) {
    if (typeof e?.channel !== "string" || typeof e?.threadTs !== "string") throw new RecoveryRequiredError("An indexed thread has invalid identity fields.");
    const key = `${e.channel}:${e.threadTs}`;
    const binding = store.get(key);
    if (!binding) missing.push(key);
  }
  if (missing.length) throw new RecoveryRequiredError(`Migration required before startup. Missing verified bindings: ${missing.join(", ")}`);
}
