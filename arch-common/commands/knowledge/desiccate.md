---
description: "Study an external project for ideas with practical applications to the repos we're working on. Use when asked to analyze a repo, paper, or framework for adoptable techniques."
---

Mine an external source for ideas we can apply to a flow we already own. The bar is practical use. Example: for a repo managing swarms of agents, "let agents *vote* on what to keep in MEMORY" is a specific, applicable idea. Skip ideas with no such use, however interesting.

Input: `$ARGUMENTS` = `<source> [--focus <area>]`. **source** is a GitHub/paper/blog/docs URL or title. **--focus** optionally limits analysis to one area.

## Phase 1: Inventory our repos
Read each working dir's `CLAUDE.md` and command/plan registry. List the flows and stateful artifacts we own: commands, plans, logs, learnings, MEMORY, workqueue, benchmarks. Every idea must land on one of these.

## Phase 2: Ingest the source
Read it thoroughly. For a repo: READMEs, design docs, core source, tests, CI. For a paper: find the PDF and read it. For a URL: fetch it. Note what each component is, how it works, and any numbers.

## Phase 3: Extract ideas
Pull out discrete, transferable ideas — a mechanism, pattern, or policy. For each, capture:
- **Name** and **Mechanism** — how it works, implementable without the source.
- **Problem solved**.
- **Target flow** — the flow we own it applies to.
- **Application** — one sentence on what we'd change.
- **Origin** — original to the source, traced to an earlier cited source, or an unattributed known pattern.

Drop any idea with no target flow. Also try crossing the source's mechanisms with our artifacts — voting × MEMORY is one such pairing.

## Phase 4: Grade evidence
Grade each idea: **A** measured, **B** demonstrated, **C** reasoned, **D** claimed. Prefer A and B. Keep C only if cheap and compelling. Drop D.

## Phase 5: Report
Write to `output/desiccate_<slug>.md`. Sections:
- **Header** — source, date, focus, idea count.
- **Applications** (main deliverable) — one entry per idea, headlined `<idea> → <target flow>`. Give grade, current state of that flow, what to build, where it goes, effort, expected benefit, risks.
- **How it works upstream** — brief per-idea context: problem, mechanism, evidence.
- **Not Recommended** — ideas dropped, with why.
- **Summary** — one paragraph: the project, and the strongest changes it suggests for us.

Sort by expected value: strong evidence and a big gap rank high, high effort ranks low. Be concise. Three strong ideas beat fifteen weak ones.

## Phase 6: Accept & cite
Ask which ideas to adopt. For each, append a row to `WORK_CITED.md` (create it if absent): date, idea, attribution, source, report path.
