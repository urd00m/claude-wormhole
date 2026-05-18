// Static-analysis regression guard: confirms that every site that opens a
// Session and calls .send() actually wires onTaskEvent through
// buildTaskEventPoster. We have broken this wiring during past refactors;
// without it, background sub-agent completions never reach the Slack thread.
//
// This test reads the relevant source files as strings and asserts on import
// + call patterns. It's intentionally a shallow check — the real
// onTaskEvent behavior is covered by sessionStream.test.ts and
// taskEvents.test.ts; here we just guard the glue.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoSrc = path.resolve(__dirname, "..");

type Site = {
  path: string;
  label: string;
  /** Expected relative import path for buildTaskEventPoster (the spec the file uses). */
  expectedImport: string;
};

const SITES: Site[] = [
  {
    path: path.join(repoSrc, "slack", "handlers.ts"),
    label: "Slack message handler",
    expectedImport: "./taskEvents.js",
  },
  {
    path: path.join(repoSrc, "scheduler", "runner.ts"),
    label: "Scheduler cron runner",
    expectedImport: "../slack/taskEvents.js",
  },
];

for (const site of SITES) {
  const src = readFileSync(site.path, "utf8");

  // 1. Imports buildTaskEventPoster from the taskEvents module.
  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\bbuildTaskEventPoster\\b[^}]*\\}\\s*from\\s*["']${site.expectedImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
  );
  assert(
    importRe.test(src),
    `${site.label} (${site.path}) must \`import { buildTaskEventPoster } from "${site.expectedImport}"\`. ` +
      `Without this, background sub-agent lifecycle events never reach the Slack thread.`,
  );

  // 2. The file calls session.send() somewhere.
  assert(
    /\.session\.send\s*\(/.test(src),
    `${site.label}: expected a \`.session.send(...)\` call`,
  );

  // 3. That .send() call passes an onTaskEvent hook backed by
  //    buildTaskEventPoster. We're not parsing TS, so use a permissive
  //    regex spanning multiple lines.
  const onTaskRe = /onTaskEvent\s*:\s*buildTaskEventPoster\s*\(/;
  assert(
    onTaskRe.test(src),
    `${site.label}: \`.send(...)\` must pass \`onTaskEvent: buildTaskEventPoster(...)\`. ` +
      `Regression risk: refactors have repeatedly dropped this hook, silently breaking background-task completion posts.`,
  );

  // 4. The onTaskEvent line should appear inside (or just after) the
  // hooks object that follows the session.send call. Sanity-check that
  // buildTaskEventPoster appears AFTER the send call — guards against a
  // dangling import with no use site.
  const sendIdx = src.search(/\.session\.send\s*\(/);
  const posterIdx = src.search(/buildTaskEventPoster\s*\(/);
  assert(
    posterIdx > sendIdx,
    `${site.label}: buildTaskEventPoster(...) call must appear at/after the session.send call (got send @${sendIdx}, poster @${posterIdx})`,
  );
}

console.log(`✅ session wiring verified — onTaskEvent passed through at ${SITES.length} call sites`);
