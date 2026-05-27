---
description: "Refine an existing wiki for expert-level insight, consistent LaTeX notation, and conciseness via a multi-agent pipeline. Use when an existing wiki reads as stream-of-consciousness or lacks editorial synthesis."
---

Refine an existing markdown wiki via a staged multi-agent pipeline. Arguments: $ARGUMENTS

Companion to `/arch-common:knowledge:wiki` (which builds the wiki). This command does not ingest new sources; it improves the synthesis quality of an existing wiki. It **respects the wiki's own `schema.md`** — section structure of `pages/*.md` is governed by the schema, not by this command.

## Arguments

`$ARGUMENTS` = `<wiki-dir> [<selector> ...]`

- **wiki-dir** (required) — path to a wiki root containing `schema.md`, `index.md`, `log.md`, `pages/`, `sources/`. Must already exist.
- **selector** (zero or more) — restricts the run; default is to run all phases and all agents in order.
  - `phase:N` — run every agent in phase $N \in \{0, 1, 2\}$.
  - `agent:<name>` — run a single agent by name (catalog below).
  - `page:<slug>` — restrict per-page agents to one page (repeatable).
  - `profile:<name>` — opt into an additional page contract (see below). Currently `formal-math`. Default: schema-only.
  - `dry-run` — agents emit reports and write to a working tree only; no in-place edits to `pages/`, `index.md`, `notation.md`, `concept-graph.*`, or `log.md`.

Print resolved arguments, the resolved profile, and the selected agent set before starting.

## Preflight

Refuse with a specific message if any of the following fails:

- `<wiki-dir>` is not a directory.
- `<wiki-dir>/schema.md`, `<wiki-dir>/index.md`, `<wiki-dir>/log.md` do not exist.
- `<wiki-dir>/pages/` or `<wiki-dir>/sources/` are missing or empty.
- A `page:<slug>` selector names a slug with no matching `pages/<slug>.md`.
- A non-foundation agent is selected but its required upstream artifact is absent (table below).
- The git worktree containing `<wiki-dir>` has uncommitted changes outside `<wiki-dir>` and the run is non-dry-run. (See *Git hygiene*.)
- `<wiki-dir>` is not inside a git repo and the run is non-dry-run. Allowed for dry-run.
- **Editor / IDE auto-commit hooks are enabled in the user's session.** Mid-run autosaves (e.g. an editor plugin that periodically commits "Update knowledge refinement state") interleave with refine commits and fragment history into half-state snapshots that don't align with run-id boundaries. Warn the user to disable auto-commits for the duration of the run, or use a dedicated git worktree.

| Selected agent | Required upstream artifact |
|---|---|
| `concept-graph` | `notation.md` (or `working/notation.md` on dry-run) |
| `compressor` | `notation.md` |
| `insight-miner` | `proposals/<slug>.md` from `compressor`, `concept-graph.json`, `notation.md` |
| `skeptic` | `proposals/<slug>.md` from `insight-miner` |
| `reconciler` | `proposals/<slug>.md`, `reports/skeptic/<slug>.md` |
| `notation-auditor` | `notation.md` |
| `synthesis-curator` | `concept-graph.json` |
| `quality-gate` | `notation.md`, `baseline.json` (or a prior `SUMMARY.md`) |
| `cleanup` | `reports/quality-gate.md` (must show `fail` verdict) |

After preflight passes and before any agent runs, the orchestrator writes `<wiki-dir>/refine/<run-id>/baseline.json` containing per-page metrics (per *Ground truth and non-regression* §3) computed from the current `pages/*.md`. This snapshot is the floor that `quality-gate` checks the post-run state against.

## Page contract

Section structure of `pages/*.md` is **defined by `<wiki-dir>/schema.md`**, not by this command. The default schema (see `templates/wiki/schema_template.md`) uses *Summary*, *Key ideas*, *Tradeoffs / caveats*, *Open questions*, *Related pages*, *Sources*. The refine command preserves this structure unless overridden.

The `profile:formal-math` selector additionally requires three sections, inserted after *Summary*:

1. **Definition** — formal statement in LaTeX.
2. **Worked micro-example** — one concrete instance with every symbol expanded.
3. **Where it breaks** — failure modes and edge conditions.

Use this profile only when the wiki is mathematics-heavy and the schema has not been customized. If the schema specifies a different structure, the schema wins; the profile contributes only sections that are absent.

## Audience and notation contract

These rules apply universally and do not conflict with section structure.

1. **LaTeX rendering for math, scoped.** Math content uses `$...$` (inline) or `$$...$$` (display). ASCII pseudo-math (`forall x. P(x)`, `=>`, `<=`, `!=`) is forbidden in **prose** where a LaTeX rendering exists. Exemptions, never converted by any agent: fenced code blocks, inline backtick code, content quoted from sources, filenames, URLs, command-line snippets, and quoted text inside skeptic-issue blocks. The notation-auditor must skip these regions.
2. **Dual audience.** Primary reader: domain expert. Secondary reader: someone with a college lower-division mathematics background only. Notation matches field convention as closely as possible *but never sloppily*. Anything the field omits by convention — implicit quantifiers, dropped type subscripts, untyped equality across sorts, "reachable-state" implicit ranges, point-free operator overloading — is made explicit at first use on each page **and** documented in `notation.md`.
3. **Earn density.** Be as concise as possible without information loss. Prefer one precise theorem statement over a paragraph of prose. Banned filler: "foundational," "seminal," "it is well known that," gratuitous historical preamble.
4. **Cite with real markdown links, not text tags.** Every non-trivial claim outside *Summary* ends with a link to its source.
   - **Single source.** `...is decidable [[bgv-pe](../sources/long-name.md)].` Outer `[ ]` mark the citation; the inner `[text](url)` is the clickable link.
   - **Multi-source derivation.** `...follows immediately (derived from [[a](URL_a)] and [[b](URL_b)]).` The derivation must be stated on the page.
   - **Folklore / closest representative.** `...is well known (cf. [[a](URL)]).`
   - **Conjecture** (no source). `[conjecture]` — the only non-link form. Skeptic must acknowledge each one.

   **Slug resolution accepts page-local aliases.** A slug is valid if `sources/<slug>.md` exists *or* if `<slug>` appears as link text in any same-page `[<slug>](../sources/<long-name>.md)` reference. Pages may use short editorial aliases (`bd`, `clu`, `rpeuf`) while every reference stays clickable.

   Bullet-end `Sources: [a](URL), [b](URL).` lines on *Key ideas* bullets stay as plain links (no outer brackets — the `Sources:` prefix signals the citation context). Same for the page-level *Sources* table.

   Bare-text tags from prior conventions (`[paper:slug]`, `[derived:from:a,b]`, `[folklore:cf:slug]` with no `(URL)` after them) are a defect; convert to the link form. Links whose target file does not exist (after alias resolution) are hard failures.

## Ground truth and non-regression

The papers in `<wiki-dir>/sources/*.md` are the **single source of truth** for every fact in the wiki. They are immutable per the wiki schema; pages in `pages/` are derived artifacts. When a page conflicts with a source, the source wins.

This implies three working rules every agent must obey:

1. **Look up, don't recall.** When uncertain about a fact, definition, theorem statement, complexity bound, or empirical result, the agent consults the cited source excerpt rather than relying on memorized "field knowledge." Anything an agent introduces that cannot be traced to a source is `[conjecture]`.
2. **Every claim traces back.** Per the provenance grammar above, every non-trivial claim resolves — directly via `[paper:<slug>]`, transitively via `[derived:from:<slug>(,<slug>)*]`, or by-proximity via `[folklore:cf:<slug>]` — to one or more papers in `sources/`. `[conjecture]` is the only escape valve and is counted, not hidden.
3. **Information must not degrade across runs.** At run start, the orchestrator snapshots `<wiki-dir>/refine/<run-id>/baseline.json` recording per-page metrics derived from the current `pages/*.md` *before* any agent edits: `paper_tag_count`, `derived_tag_count`, `folklore_tag_count`, `conjecture_count`, `cited_slug_set`, `provenance_coverage`, `claim_count`. The `quality-gate` compares the post-run state against (a) the most recent prior `SUMMARY.md` if one exists, otherwise (b) `baseline.json`. Any of the following is a **hard failure** unless the reconciler logged an explicit justification:
   - `cited_slug_set` for a page shrinks (a previously-cited paper is dropped).
   - `paper_tag_count` for a page drops by more than $10\%$.
   - `conjecture_count` rises without a matching `skeptic` acknowledgement.
   - `provenance_coverage` on the page decreases.

Reconciler deletions of any paper-traceable claim (`[paper:*]`, `[derived:from:*]`, `[folklore:cf:*]`) must be recorded in `reports/reconciler/<slug>.md` under a *Deletions* heading with: the deleted text, the source(s) it cited, and a one-sentence reason (e.g., "duplicate of claim X already cited on the page", "skeptic must-fix: cited excerpt does not support the claim"). Deletions without a *Deletions* entry are flagged by the quality-gate as hard failures and the page is reverted from `working/` rather than promoted.

## Output layout

Each invocation creates a run directory:

`<wiki-dir>/refine/<run-id>/` where `run-id` $=$ `YYYY-MM-DD-HHMMSS-<6hex>`. If the directory exists, refuse and ask the user to retry (collisions indicate a bug or a re-run within the same second).

| Path | Role |
|---|---|
| `baseline.json` | Per-page metrics snapshotted at run start from `pages/*.md` *before* any edits. Used by `quality-gate` for non-regression checks when no prior `SUMMARY.md` exists. |
| `metrics.json` | Per-page metrics computed by `quality-gate` after edits. Becomes the next run's comparison baseline. |
| `working/` | Dry-run shadow tree: `working/notation.md`, `working/concept-graph.json`, `working/pages/<slug>.md`, etc. Always written; downstream agents prefer `working/` if present (so dry-run is composable). |
| `reports/<agent>.md` or `reports/<agent>/<page-slug>.md` | Per-agent, per-target reports. |
| `proposals/<page-slug>.md` | In-flight Phase 1 drafts; only the reconciler promotes them to `pages/`. |
| `SUMMARY.md` | Top-level run summary; links `metrics.json` so future runs can locate the baseline. |

Reports are first-class outputs even on a full run; they are also the canonical outputs when an agent runs in isolation under a selector.

---

## Phase 0 — Foundation

Idempotent — if `notation.md` and `concept-graph.json` already exist, agents update rather than recreate.

### Agent: `notation-registry`

**Reads:** every `pages/*.md`; existing `notation.md` if any. Reads `sources/*.md` only on demand: when a symbol's canonical form is contested across pages, fetch only the relevant excerpts (one or two paragraphs) from the cited source(s) to break the tie.
**Writes:** `<wiki-dir>/notation.md` (or `working/notation.md` on dry-run). **Report:** `reports/notation-registry.md`.

Procedure:
1. Extract every distinct mathematical symbol, operator, predicate, and named structure used across all pages.
2. Cluster synonyms — e.g., $\preceq$, `\sqsubseteq`, `<=` referring to the same refinement order.
3. Pick one canonical LaTeX form per concept, preferring the form most used in the field's primary literature. **Papers are the tiebreaker**: when pages disagree on notation, consult the cited source excerpts and adopt the paper-attested form. Cite the establishing paper as `[paper:<slug>]` in the entry.
4. For each entry, record:
   - **Canonical LaTeX** (e.g., `$\sigma \models \varphi$`).
   - **Plain-language gloss** for the secondary reader.
   - **Field convention** being followed (`[paper:<slug>]` if any).
   - **Omissions made explicit** — every variable, quantifier, or type the field drops by convention but the wiki will state on first use per page.
5. Organize `notation.md` into sections appropriate to the corpus and end with a *Meta-conventions* section listing every omission.

The report describes clusters merged, conventions chosen, sources consulted, and any conflicts surfaced.

### Agent: `concept-graph`

**Reads:** every `pages/*.md`, `notation.md`. Does **not** read `sources/*.md`.
**Writes:** `<wiki-dir>/concept-graph.json` plus a human-readable `concept-graph.md` (or `working/` copies on dry-run). **Report:** `reports/concept-graph.md`.

Procedure:
1. Each page is a node tagged with its declared concept(s).
2. Emit typed edges: `extends`, `decides`, `dual-to`, `subsumes`, `contrasts-with`, `fails-where`, `instance-of`. Each edge cites the page or paper that justifies it.
3. Identify weakly-connected components, orphans, and *near-merges* (concepts under different names that may collapse).
4. The report flags isolates and surprising near-merges as candidates for the synthesis-curator.

---

## Phase 1 — Per-page rewrite

For each page slug $P$ in scope (every page, or those named by `page:<slug>`), run the four-agent chain. Pages run in parallel up to 3 at a time. Within a page, agents run serially; each agent reads the previous agent's output. All four append to `proposals/<slug>.md`.

### Agent: `compressor`

**Reads:** `pages/<slug>.md`, `notation.md`, `schema.md`. With `profile:formal-math`, also reads the profile's section list.
**Writes:** `proposals/<slug>.md` (initial draft). **Report:** `reports/compressor/<slug>.md`.

Mechanical rewrite only — **no new ideas, no new claims, no information loss**. Apply notation registry, delete redundancy, restate every claim in the tightest mathematically-precise form, and preserve the schema's section structure. If a profile is active, insert empty stubs for any missing profile sections (the insight-miner fills them). Word-count guidance from the schema (the default schema flags > $1000$ lines as a split candidate); **do not delete information to hit a budget**.

**Paper-traceable claims are preserved verbatim in substance.** Any `[paper:*]`, `[derived:from:*]`, or `[folklore:cf:*]` tag on the input page must appear on the output page (or be recorded under *Deletions* in the report with a justification). Compression rephrases prose; it does not drop facts.

The report records: word count before/after, every prose deletion, every paper-traceable tag preserved or deleted (with reason), and any ambiguous sentences flagged for the insight-miner.

### Agent: `insight-miner`

**Reads:** `proposals/<slug>.md`, `concept-graph.json`, neighbor-page summaries from the graph, `notation.md`. Reads only the **specific cited section(s)** of `sources/<slug>.md` files referenced in the draft — never whole sources.
**Writes:** appends a *Connections* subsection (placement governed by schema's *Key ideas* / *Related pages* convention) and fills profile sections if active. **Report:** `reports/insight-miner/<slug>.md`.

Add 1–3 *non-obvious* connections — dualities, hidden equivalences, shared failure modes, technique reuse across superficially-different methods. **Every connection must trace to a paper.** Use `[paper:<slug>]` when a single source supports it; `[derived:from:<slug>(,<slug>)*]` when the connection is a derivation from cited papers (the derivation must be stated on the page); `[folklore:cf:<slug>]` when the field treats it as common knowledge but the closest applicable paper is named; `[conjecture]` only when the miner cannot find a paper trace — and then the report must justify why a conjecture is worth proposing. Banned: clichés, restating the abstract, "this is foundational." The report lists every connection added, its provenance tag, the cited excerpt(s), and a one-sentence rationale.

### Agent: `skeptic`

**Reads:** `proposals/<slug>.md`, `notation.md`. For every `[paper:<slug>]`, `[derived:from:<slug>...]`, and `[folklore:cf:<slug>]` tag, reads the **specific cited excerpt** of each `sources/<slug>.md` (e.g., the section the draft links to), not the whole file. Resolves "specific excerpt" by following any anchor in the link, otherwise reading $\le$ 200 lines around the most likely supporting passage and reporting the range used.
**Writes:** `reports/skeptic/<slug>.md`. **Does not edit the draft.**

**Primary duty: ground-truth verification.** For every paper-traceable claim, check that the cited excerpt actually supports the claim. A claim that overstates, misattributes, or contradicts its cited excerpt is `must-fix`. The skeptic must also acknowledge every `[conjecture]` on the page: either confirm the wiki is right to leave it as a conjecture, or propose a paper that would convert it to `[paper:*]`.

Red-team every claim. For each issue, emit a block:

```
### Issue <n>: <one-line summary>
**Severity:** must-fix | should-fix | nit
**Claim:** "<exact quote from the draft>"
**Why suspect:** <1–3 sentences>
**Proposed fix:** <concrete revision or "delete">
**Sources consulted:** <slug:line-range, ...>
```

Categories to hunt for:
- Claim overstates, misattributes, or contradicts its cited excerpt.
- `[derived:from:*]` whose stated derivation does not actually follow from the cited papers.
- `[folklore:cf:*]` whose cited paper is not in fact the closest representative.
- Untagged claim that should be tagged (or that the miner ought to have looked up).
- Missing quantifiers; untyped equality across sorts; implicit reachability assumptions.
- Hand-waved induction; "by inspection"; "obviously."
- Tautological "insights" (claims that reduce to a definition).
- Hallucinated cross-references.
- Notation drift from `notation.md`.
- (Profile only) worked example that does not exercise the definition.
- Conjectured connections that contradict cited sources.

End with a top-line verdict on the page: `READY` / `REVISE` / `REJECT`.

### Agent: `reconciler`

**Reads:** `proposals/<slug>.md`, `reports/skeptic/<slug>.md`, `notation.md`, `schema.md`.
**Writes:** updated `proposals/<slug>.md`; on non-dry-run, overwrites `pages/<slug>.md`. On dry-run, writes `working/pages/<slug>.md`. **Report:** `reports/reconciler/<slug>.md`.

Apply each `must-fix` and `should-fix` from the skeptic. For any rejection, document the reason in the report (this is the only place skeptic findings may be overruled).

**Deletions of paper-traceable claims** (any sentence with `[paper:*]`, `[derived:from:*]`, or `[folklore:cf:*]`) are recorded under a *Deletions* heading in the reconciler's report, listing the deleted text, the source slug(s) it cited, and a one-sentence reason. Quality-gate hard-fails the run if such a deletion is not logged.

Confirm zero notation drift against `notation.md`. Final pass: enforce LaTeX-in-prose, exempt regions per *Audience and notation contract* §1, and ensure every non-trivial claim carries a provenance tag.

---

## Phase 2 — Cross-page consistency

### Agent: `notation-auditor`

**Reads:** every `pages/*.md`, `notation.md`.
**Writes:** in-place edits (non-dry-run) or `working/pages/*.md` (dry-run). **Report:** `reports/notation-auditor.md`.

Mechanical pass only, scoped to **prose regions only**. Skip and never modify: fenced code blocks (` ``` ` and indented), inline backtick code, link targets and URLs, table cells inside a column tagged "code" by convention, content inside skeptic-issue `Claim:` quotes, and any region between `<!-- noaudit:start -->` / `<!-- noaudit:end -->` markers (introduced for source quotes).

In prose regions: replace any non-canonical symbol with the registry form, convert `\(...\)` to `$...$`, convert ASCII pseudo-math to LaTeX, insert missing sort annotations on first use per page. Reports every substitution with file path, line, and before/after.

### Agent: `synthesis-curator`

**Reads:** every `pages/*.md`, `index.md`, `concept-graph.json`.
**Writes:** `index.md` (non-dry-run) or `working/index.md` (dry-run). **Report:** `reports/synthesis-curator.md`.

Identify, with concrete evidence:
- Orphaned insights (covered in one page that should appear in the index narrative).
- Pages that should split (multi-topic) or merge (overlapping concept).
- Missing thematic axes the index should expose (e.g. "lazy vs eager" as a recurring axis).

Apply only changes to `index.md` itself. Page-level changes (splits, merges, large rewrites) are emitted as `proposed:` items in the report; applying them requires a follow-up `agent:reconciler page:<slug>` invocation.

### Agent: `axes-mapper`

Wikis curated to a single research lineage accumulate competing techniques that solve the same underlying problem with different design choices. Survey pages typically present each technique as a complete unit, and contrasts between any two collapse many independent choices into a single "differs by methodology" line. The reader cannot see, without their own analytical pass, that two techniques may agree on every choice but one (where the differing implementation is a swap candidate), or that one technique's choice on a given concern strictly dominates the rest (where the others' cells become migration targets). Whole-to-whole comparison hides the per-axis structure that makes novel combinations of existing techniques visible.

`axes-mapper` performs that analytical pass. It re-projects a family of competing techniques along the orthogonal axes those techniques implement differently — the *separation of concerns* across the family — writing the result as a methodology × axis matrix in a new wiki page. The matrix turns whole-to-whole comparison into per-concern comparison, surfacing **combination opportunities** (where two techniques agree on every axis but one) and **convergence patterns** (axes universally addressed, axes systematically left blank, axes where one technique strictly dominates) that the survey page's narrative cannot expose. Companion to `synthesis-curator`: where the curator reorganises document structure, `axes-mapper` decomposes the techniques themselves into the design choices they make.

**Reads:** every `pages/*.md` in the cluster named by `domain:<name>` (must have $\geq 4$ competing-technique pages); `notation.md`; `concept-graph.json`; cited source excerpts on demand.
**Writes:** `pages/<domain>-design-axes.md` (or `working/pages/...` on dry-run); backlink bullets in each subject page's *Related pages*; inbound concept-graph edges (`instance-of` for techniques, `extends` for survey hubs). **Report:** `reports/axes-mapper.md`.

Procedure:

1. Identify $5$–$10$ axes such that every (or nearly every) technique makes a choice on each, and at least two techniques choose differently. Fewer is editorial under-decomposition; more is unmaintainable.
2. Build the matrix. Each cell is one short claim with the cell-level citation embedded.
3. Enumerate combinations $C_1, \ldots, C_n$: for each pair agreeing on every axis but one, the differing implementation is a swap candidate. Mark `[conjecture]` until paper-traced; for each, record (a) axes swapped, (b) substrate properties preserved, (c) what the combination does *not* address.
4. Write the page using the formal-math profile. *Definition* lists the axes; *Worked micro-example* walks through one $C_k$ in full; *Where it breaks* enumerates non-orthogonal axis pairs, axes whose implementations live at different stack levels, and `n/a` rows for cluster-edge techniques.
5. Add backlinks: one bullet per subject page summarising that page's row across all axes; inbound concept-graph edges so the relationship is symmetric for graph tooling.

**Failure modes to guard against** (each has caused real defects in past runs):

- *Author-collision conflation.* Two papers by the same author line treating distinct methodologies (e.g., Lahiri-Bryant indexed-PA CAV'04 vs deductive-OoO ladder CAV'03) get separate rows; cells must distinguish the methods.
- *Numerical self-consistency.* Before writing, count matrix rows and verify every "$k$ of $N$" prose claim matches.
- *Bare-Unicode notation drift.* Always `$\forall$` / `$\exists$` / `$\lambda$`; never bare Unicode in prose.
- *Coupling presented as orthogonality.* If axis A constrains axis B (e.g., correctness shape ↔ liveness mechanism), say so in *Where it breaks*, not silently in *Definition*.
- *Substrate-overlap over-reach.* Same logic $\neq$ same discharge structure (one validity check vs a fixpoint loop). Distinguish in conjecture text.
- *Silently dropped `n/a` rows.* Cluster-edge techniques get an `n/a`-marked row, not exclusion; the omission is itself a per-axis observation.
- *Missing backlinks.* A run that produces only the new page is incomplete; the matrix is otherwise reachable only via `index.md`.

**Pipeline placement:** Phase 2, after `concept-graph` and `notation-auditor`, before `quality-gate`. Opt-in via `agent:axes-mapper domain:<cluster>`; not part of every refine run. Strongest available model. Spawn `skeptic` + `reconciler` on the new page per the standard chain after `axes-mapper` completes.

### Agent: `quality-gate`

**Reads:** every `pages/*.md`, `notation.md`, `<wiki-dir>/schema.md`, `<wiki-dir>/refine/<run-id>/baseline.json`, the most recent prior `refine/*/SUMMARY.md` if any, and every `reports/reconciler/<slug>.md` from this run (to read *Deletions* logs).
**Writes:** `reports/quality-gate.md` and `<wiki-dir>/refine/<run-id>/metrics.json` (per-page metrics for future runs to compare against). Sets a non-zero status that suppresses the run-summary's commit step on hard failure.

Provenance grammar (used by every check below):
- A *non-trivial claim* is a sentence outside *Summary* that asserts a fact about a method, theorem, complexity, equivalence, or empirical result. Connective sentences ("Stage 1 walks through normalization."), formula introductions ("Take $\varphi:$..."), navigation prose, and content inside fenced code or `$$...$$` math blocks are NOT claims.
- **Reference parser.** Use `templates/wiki/compute_metrics.py` so every quality-gate run computes the same numbers. Inventing a regex per run is a known footgun (over-strict counts can flip a `warn` into a spurious `fail`).
- A *paper-traceable citation* is a markdown link to a `sources/*.md` file in any of the forms in §4 of *Audience and notation contract*. `[conjecture]` is not paper-traceable.
- A *valid slug* resolves either to `sources/<slug>.md` directly or via a same-page alias (link text in any `[<slug>](../sources/<long>.md)` reference).
- *Per-page metrics* in `metrics.json`: `paper_link_count`, `derived_count`, `folklore_count`, `conjecture_count`, `cited_slug_set`, `claim_count`, `provenance_coverage` (= cited-claim-count / claim-count).

Hard failures (block commit):

| Metric | Bound |
|---|---|
| Broken cross-refs in `pages/` and `index.md` | $0$ |
| Tags whose `<slug>` is missing in `sources/` | $0$ |
| Notation drift from `notation.md` (after auditor) | $0$ |
| Pages missing schema-required sections | $0$ |
| Pages missing profile-required sections (when a profile is active) | $0$ |
| Per page: `cited_slug_set` shrinks vs baseline (paper dropped without justification) | $0$ |
| Per page: `paper_link_count` drops more than $10\%$ vs baseline without a logged *Deletions* entry | $0$ |
| Per page: `provenance_coverage` decreases vs baseline | $0$ |
| Per page: `conjecture_count` increases without a matching skeptic acknowledgement | $0$ |
| Reconciler deletion of a paper-traceable claim with no *Deletions* entry | $0$ |

Warnings (do not block):

| Metric | Bound |
|---|---|
| Page line count vs schema split rule (default `> 1000` lines) | warn over |
| LaTeX rendering errors via `pandoc --from=gfm --to=html` if `pandoc` is on `PATH` | warn |
| Provenance-tag coverage $< 100\%$ on non-trivial claims | warn |
| Empty profile section stubs left by the compressor and not filled | warn |
| Per page: `conjecture_count` non-zero | warn (informational — surfaces unresolved gaps) |

Baseline resolution: when a prior `SUMMARY.md` exists, its recorded `metrics.json` is the comparison baseline. Otherwise `<wiki-dir>/refine/<run-id>/baseline.json` (snapshotted at run start from the pre-edit `pages/*.md`) is used. The report lists every failure and warning with file:line and a one-line rationale.

---

## Phase 3 — Cleanup (post-fail-verdict)

When `quality-gate` returns `fail`, the natural recovery is a targeted cleanup pass — *not* a full Phase 1 re-run. Spawn one cleanup sub-agent per affected page (cap 5 parallel; the work is mechanical).

### Agent: `cleanup`

**Reads:** `pages/<slug>.md` (or `working/pages/<slug>.md` on dry-run), the most recent `quality-gate` report, the page's own Sources alias map.
**Writes:** in-place edits to `pages/<slug>.md` (or `working/pages/<slug>.md`); report at `reports/cleanup/<slug>.md`.

The cleanup agent fixes only what the quality-gate listed for its page:
- broken cross-refs (link target does not exist),
- bare-text or back-ticked tag references (e.g. `[paper:slug]`, `` `[slug]` ``) that must become `[[slug](URL)]` links,
- residual sentences in formal-math sections that lack inline citations,
- aliases that need declaration in the Sources table.

**Mechanical fixes go through scripts, not sub-agents.** Ship `templates/wiki/tags_to_links.py`, `wrap_inline_links.py`, `fix_bare_brackets.py` (the regex-driven slug → URL substitution and bracket-wrapping passes that take seconds and zero LLM tokens). Sub-agents are only needed for the per-sentence judgment work — *which paper supports this sentence?*

After all cleanup work finishes, re-run `quality-gate`. Verdict transition `fail → warn` is the success criterion. A residual `fail` means the cleanup needed more passes or the issues are structural (split candidates, missing source files).

---

## Cost

Print this estimate to the user **before** spawning anything:

| Phase | Per-page cost (opus) | Per-page cost (sonnet) |
|---|---|---|
| Phase 0 (global, fixed)   | ~150–300K total | ~80–150K total |
| Phase 1 (per page, 4-stage chain) | ~150–200K | ~50–80K |
| Phase 2 (global, fixed)   | ~100–200K total | ~50–100K total |
| Phase 3 cleanup (per page, sonnet) | n/a | ~30–50K |

A 30-page wiki at full opus is ~5M sub-agent tokens plus ~30 minutes wall on cap-3 parallelism. **Recommend `dry-run` first for any wiki > 10 pages** so the user can inspect the working tree before authorizing in-place edits and a commit.

---

## Selector semantics and truth table

- No selectors → run Phase 0, Phase 1 (every page), Phase 2, in order. Phase 3 runs only on demand or when `quality-gate` returns `fail`.
- `phase:N` → run only that phase's agents in declared order ($N \in \{0, 1, 2, 3\}$).
- `agent:<name>` → run only that agent. Refuse if its required upstream artifact (preflight table) is absent; the message names the missing artifact and the upstream agent that produces it.
- `page:<slug>` → restricts per-page agents to that page only. Ignored by global agents (`notation-registry`, `concept-graph`, `notation-auditor`, `synthesis-curator`, `quality-gate`); the report records that the selector was ignored.
- `profile:<name>` → adds the profile's section requirements; orthogonal to phase/agent/page selectors.
- `dry-run` → agents emit reports and write the full `working/` shadow tree; no in-place edits to `pages/`, `index.md`, `notation.md`, `concept-graph.*`, `log.md`. Subsequent agents in the same run prefer `working/` artifacts.
- Multiple selectors compose by intersection (e.g., `agent:skeptic page:foo page:bar` runs the skeptic on those two pages only).

Composition truth table:

| Combination | Effect |
|---|---|
| `agent:reconciler` (no `page:`) | requires every page to have its proposal + skeptic report; refuses otherwise. |
| `agent:reconciler page:<slug>` | runs only on `<slug>`. Requires that slug's upstream artifacts. |
| `agent:<global> page:<slug>` | page selector ignored; warning logged. |
| `phase:1 page:<slug>` | runs the four-agent chain on `<slug>` only. |
| `dry-run` + `agent:notation-auditor` | writes `working/pages/*.md`, leaves `pages/` untouched. |
| `quality-gate` not selected | the run-summary commit step still calls `quality-gate` first. To skip, use `dry-run` (which suppresses commit unconditionally). |

Running `agent:skeptic` over a whole wiki is an audit pass that produces one `reports/skeptic/<slug>.md` per page and applies no edits — a useful subset run on its own.

## Execution model (sub-agent spawning)

**Every agent runs as a sub-agent.** Reading 30+ pages in the main context exhausts the budget; running notation-registry, concept-graph, notation-auditor, synthesis-curator, and quality-gate as sub-agents keeps the main context lean. Each global agent gets a focused brief and writes its global artifact directly.

For each page $P$ in scope (Phase 1):

- **SUB AGENT per page, parallel (cap 3 by default; cap 5 for cleanup-only or notation-auditor-only passes since the work is lighter)**: spawn one sub-agent that owns the four-stage chain for $P$. The sub-agent invokes the four agent prompts serially against the same proposal file. Only this sub-agent writes to `proposals/<slug>.md` and `reports/{compressor,insight-miner,skeptic,reconciler}/<slug>.md`.
- The main agent collects each sub-agent's terminal status (`OK` / `SKIP <reason>` / `FAIL <reason>`) and aggregates into `SUMMARY.md`.

To save dispatch tokens, write the per-page brief once to `<run-dir>/scripts/page-pipeline-brief.md` and have each sub-agent prompt say "Execute the brief for slug X" rather than embedding the full multi-stage instructions in every dispatch.

Failures in a sub-agent are non-fatal: the page is reported as `FAIL` and the run continues. The quality-gate then reflects unfilled pages as warnings.

## Git hygiene

- Refuse a non-dry-run if the worktree has uncommitted changes outside `<wiki-dir>` (use `git status --porcelain -- :!<wiki-dir>` and abort if non-empty). Tell the user to commit or stash.
- Refuse a non-dry-run if `<wiki-dir>` is not inside a git repo. (Dry-run is allowed; nothing is committed.)
- Stage only:
  - `<wiki-dir>/refine/<run-id>/`
  - `<wiki-dir>/notation.md`, `<wiki-dir>/concept-graph.json`, `<wiki-dir>/concept-graph.md` (when modified by Phase 0)
  - `<wiki-dir>/pages/<slug>.md` (only the slugs the reconciler touched)
  - `<wiki-dir>/index.md` (only when curator ran)
  - `<wiki-dir>/log.md`

  Use explicit paths, never `git add -A` or `git add .`.

## Model assignment guidance

- Cheap fast model (e.g. `claude-haiku-4-5`): `notation-auditor`, `quality-gate`. Mechanical.
- Strongest available (e.g. `claude-opus-4-7`): `insight-miner`, `skeptic`, `synthesis-curator`, `concept-graph`. Cross-document reasoning.
- Middle tier (e.g. `claude-sonnet-4-6`): `notation-registry`, `compressor`, `reconciler`, `cleanup`.

The harness selects per-agent for global agents (Phase 0, Phase 2, Phase 3). For Phase 1, the per-page sub-agent runs all four stages serially and **cannot switch models mid-chain**. Two options:

- **(a) one sub-agent per page, single model for the whole chain** — simpler orchestration; pays the strongest stage's model for the cheap stages too. Default: `opus` for high-stakes ground-truth verification, `sonnet` for routine refines.
- **(b) four sub-agents per page (one per stage), each with its own model** — minimum cost but 4× the orchestration messages. Use only for very large wikis (50+ pages) where the savings dominate dispatch overhead.

Each report's header records the model that produced it.

## On completion

Always write `<wiki-dir>/refine/<run-id>/SUMMARY.md`:

| Field | Content |
|---|---|
| **Run id** | `YYYY-MM-DD-HHMMSS-<6hex>` |
| **Selectors** | resolved list including `profile:` |
| **Agents run** | ordered list with model used per agent |
| **Pages touched** | slugs (Phase 1) |
| **Edits applied** | count + per-file before/after line deltas |
| **Reports** | links to every `reports/*.md` written |
| **Quality-gate** | `pass` / `warn` / `fail` plus link to its report |
| **Metrics** | link to `metrics.json` (per-page baseline for the next run) and a one-line per-page delta vs `baseline.json` (`paper_tag_count` / `cited_slug_set` / `provenance_coverage`). |
| **Open issues** | every unresolved skeptic finding, every `proposed:` curator item, every quality-gate warning |

On non-dry-run, append a one-line entry to `<wiki-dir>/log.md`:
`## <YYYY-MM-DD>: refine — <agents> over <N> pages, <K> reports, <run-id>`

Commit on non-dry-run only if quality-gate is `pass` or `warn` (not `fail`):

```
git add <explicit paths from "Git hygiene">
git commit -m "wiki: refine <run-id> — <summary>"
```

---

## Why this structure

Stream-of-consciousness wiki prose typically arises when one agent does inferential work and writing simultaneously, with no adversary. The fix is *separation of concerns*:

- A **single notation registry** prevents per-page drift and gives the secondary (college-math) reader a recoverable Rosetta stone for field shorthand.
- A **concept graph** is the substrate on which "surprising synthesis" is even possible — without it, each page is islanded and synthesis devolves into vibes.
- The **insight-miner / skeptic split** prevents the failure mode where one agent invents a duality and then fails to challenge itself. The skeptic sees only the draft and the cited excerpts, not the miner's reasoning.
- **Reports as first-class outputs** make every subset run independently useful; running just `agent:skeptic` over the whole wiki is a valuable audit pass on its own.
- A **mechanical quality gate** with explicit, grammar-defined provenance tags creates a reproducible regression signal.
- **Papers as ground truth + non-regression baselining** prevents quality decay across runs. The wiki is a derived artifact; every fact must trace back to a source, and per-page provenance metrics are snapshotted and checked against each refine pass so that no run can quietly delete information without logging the deletion.
- **Schema deference** keeps refine compatible with the `wiki ingest` build path and any project-specific conventions the user has put in `schema.md`.

This command is the editorial layer. The wiki-build command (`/arch-common:knowledge:wiki ingest`) remains the source-of-truth ingestion path.
