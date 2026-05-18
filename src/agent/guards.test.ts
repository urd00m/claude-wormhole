// Verify destructive-command classifier.
import { classifyBash } from "./guards.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const DESTRUCTIVE = [
  "rm -rf node_modules",
  "rm foo.txt",
  "rmdir mydir",
  "sudo rm foo",
  "git reset --hard HEAD~1",
  "git clean -fd",
  "git push --force origin main",
  "git push -f",
  "git branch -D feature",
  "git checkout -- file.ts",
  "dd if=/dev/zero of=/dev/sda",
  "mkfs.ext4 /dev/sda1",
  "kill -9 1234",
  "shred secrets.txt",
  "find . -name '*.log' -delete",
  "mv -f a b",
  "echo hi > /etc/hosts",
];

const SAFE = [
  "ls -la",
  "cat README.md",
  "npm install",
  "git status",
  "git log --oneline",
  "echo hi >> log.txt",
  "grep -r foo .",
  "node script.js",
  "git push origin feature", // non-force push allowed
  "mv a b", // non-force mv allowed
];

for (const c of DESTRUCTIVE) {
  const r = classifyBash(c);
  assert(r !== null, `should flag as destructive: ${c}`);
}
for (const c of SAFE) {
  const r = classifyBash(c);
  assert(r === null, `should NOT flag: ${c} (got: ${r})`);
}

console.log(`✅ classifier verified: ${DESTRUCTIVE.length} destructive, ${SAFE.length} safe`);
