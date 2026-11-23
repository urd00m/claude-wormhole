import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RecoveryRequiredError, type Binding } from "./continuityStore.js";

/** Validate an exact identity; never infer one from a shared cwd or --last. */
export function validateNativeSession(binding: Binding): void {
  if (!binding.started) return;
  if (!fs.existsSync(binding.workdir) || !fs.statSync(binding.workdir).isDirectory()) throw new RecoveryRequiredError(`Original working directory is missing for ${binding.sessionId}.`);
  if (!binding.sessionId) throw new RecoveryRequiredError("A started conversation has no native session ID.");
  if (binding.runtime === "codex") {
    const dbPath = path.join(binding.providerHome, "state_5.sqlite");
    if (!fs.existsSync(dbPath)) throw new RecoveryRequiredError(`Codex history index is missing for ${binding.sessionId}.`);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT cwd,rollout_path FROM threads WHERE id=?").get(binding.sessionId) as { cwd: string; rollout_path: string } | undefined;
      if (!row || path.resolve(row.cwd) !== path.resolve(binding.workdir) || !fs.existsSync(row.rollout_path)) {
        throw new RecoveryRequiredError(`Saved Codex session ${binding.sessionId} could not be verified in its original working directory.`);
      }
    } finally { db.close(); }
  } else {
    const projectDir = path.join(binding.providerHome, "projects", binding.workdir.replace(/[^a-zA-Z0-9]/g, "-"));
    if (!fs.existsSync(path.join(projectDir, binding.sessionId + ".jsonl"))) {
      throw new RecoveryRequiredError(`Saved Claude transcript ${binding.sessionId} is missing from its original configuration directory.`);
    }
  }
}
