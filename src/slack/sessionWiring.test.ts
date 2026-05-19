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

  // 3. The file passes `onTaskEvent: <value>` and `<value>` is backed by
  //    buildTaskEventPoster — either inline (`onTaskEvent:
  //    buildTaskEventPoster(...)`) or via a hoisted local
  //    (`const x = buildTaskEventPoster(...); ... onTaskEvent: x`). Both
  //    patterns wire the same callback through and both ship in this
  //    repo, so we accept either. Without a TS parser this is regex-based
  //    and permissive — the goal is catching the regression where the
  //    hook is dropped entirely or pointed at a different factory.
  // Prefer the inline-call alternative first so a name like
  // `buildTaskEventPosterFoo` can't slip past the strict prefix check
  // below.
  const onTaskRe = /onTaskEvent\s*:\s*(buildTaskEventPoster\s*\(|[A-Za-z_$][\w$]*)/g;
  const matches = [...src.matchAll(onTaskRe)];
  assert(
    matches.length > 0,
    `${site.label}: \`.send(...)\` must pass an \`onTaskEvent:\` hook. ` +
      `Regression risk: refactors have repeatedly dropped this hook, silently breaking background-task completion posts.`,
  );
  for (const m of matches) {
    const rhs = m[1];
    // Inline-call alternative ALWAYS includes the trailing `(` — strict
    // prefix match defends against `buildTaskEventPosterButDifferent(...)`.
    if (rhs.startsWith("buildTaskEventPoster(") || rhs.startsWith("buildTaskEventPoster (")) continue;
    // Hoisted identifier: require a binder `(const|let|var) <rhs> = buildTaskEventPoster(`.
    const escaped = rhs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const binderRe = new RegExp(
      `\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*buildTaskEventPoster\\s*\\(`,
    );
    assert(
      binderRe.test(src),
      `${site.label}: \`onTaskEvent: ${rhs}\` references identifier \`${rhs}\` but no \`const ${rhs} = buildTaskEventPoster(...)\` binder appears in the same file. ` +
        `If this hook is wired to a different factory, background sub-agent lifecycle events will not reach the Slack thread.`,
    );
  }
}

console.log(`✅ session wiring verified — onTaskEvent passed through at ${SITES.length} call sites`);
