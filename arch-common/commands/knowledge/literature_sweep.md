---
description: "Summarize papers into the knowledge base. Use when asked to read, summarize, or add a paper."
---

Summarize papers into a knowledge base YAML. Arguments: $ARGUMENTS

## Arguments

`$ARGUMENTS` = `<kb.yaml> [--steps <list>] <paper1>, <paper2>, ...`

- **kb.yaml** (required) — path to the knowledge base YAML file. Create with header `papers:` if missing.
- **--steps** (optional) — comma-separated subset of `1,2,3,4,5`. Default: all.
- **paper list** (required when step 1 runs) — comma-separated titles.

`<design-dir>` is the directory containing `<kb.yaml>`. `RAW = <design-dir>/papers/`. **All intermediate artifacts — stubs (`.yaml`), downloaded PDFs (`.pdf`), and any transient text (`.txt`) — are written to `RAW` only.** Outside `RAW`, only `<kb.yaml>` is written, and only by Step 5. `RAW` is a persistent archive: it is **not** deleted after Step 5 so that future runs can resume from it and so the downloaded PDFs remain for re-reading.

Print resolved arguments before starting.

## Slug and filename rule

`<slug>` for any title = lowercased title with non-alphanumerics replaced by `-`, runs collapsed, leading/trailing `-` trimmed.

Every file this command writes under `RAW` uses a per-paper random suffix: `<slug>-<rand>.<ext>`, where `<rand>` is an 8-char lowercase hex token **minted once per paper** and reused across that paper's pair (`<slug>-<rand>.yaml`, `<slug>-<rand>.pdf`). Mint with `python3 -c "import secrets; print(secrets.token_hex(4))"`. This lets repeated runs coexist without collision and keeps each paper's pair discoverable via the shared `<slug>-<rand>` prefix.

Within this document, `STEM = <slug>-<rand>`.

Stub-existence / duplication checks across steps must glob `RAW/<slug>-*.yaml` (not `RAW/<slug>.yaml`) so they see stubs regardless of suffix.

## Idempotency

**Every step is resumable — skip any work whose output artifact is already present.** A rerun after a partial failure (or a repeat invocation) must not redo completed work. Concretely:

- Step 1: skip any paper whose stub already exists (`RAW/<slug>-*.yaml`) or whose title is already in `<kb.yaml>`.
- Step 2: skip any stub whose PDF is already downloaded (`RAW/<STEM>.pdf` present and > 10 KB) or whose title is marked `[NOT ACCESSIBLE]`.
- Step 3: skip any stub whose descriptive fields are already populated, or whose title is marked `[NOT ACCESSIBLE]`.
- Step 4: skip any lineage title that already has a stub or a `<kb.yaml>` entry.
- Step 5: skip stubs whose title is already in `<kb.yaml>` (no duplicate merges).

Each step below restates its skip condition; treat the restatement and this section as the same rule.

## Step 1 — Create stubs

For each paper in the list:

1. Skip if its title already has an entry in `<kb.yaml>` OR a stub matching `RAW/<slug>-*.yaml` (case-insensitive substring match on `title`).
2. Otherwise mint `<rand>` for the paper and write `RAW/<STEM>.yaml` as a stub per [schema.md](../../templates/literature_sweep/schema.md) — every field empty except `title`.

Commit: `git add -A && git commit -m "literature_sweep: step 1 — stubs"`.

## Step 2 — Download PDFs (SUB AGENT per stub)

**Skip any stub that already has `RAW/<STEM>.pdf` (> 10 KB) or is marked `[NOT ACCESSIBLE]` — do not re-download.** For each remaining stub, spawn a sub-agent with the prompt in [download.md](../../templates/literature_sweep/download.md). Pass `STUB`, `STEM`, and `RAW` as inputs.

The sub-agent locates and downloads the PDF to `RAW/<STEM>.pdf`. Full procedure and fallbacks are in `download.md`.

Run 2–3 sub-agents in parallel. Collect `OK` / `NOT_ACCESSIBLE` results.

Commit: `git add -A && git commit -m "literature_sweep: step 2 — downloads"`.

## Step 3 — Summarize (SUB AGENT per stub)

**Skip any stub that is marked `[NOT ACCESSIBLE]` or already has its descriptive fields populated — do not re-summarize.** For each remaining stub, spawn a sub-agent with the prompt in [summarize.md](../../templates/literature_sweep/summarize.md). Pass `STUB`, `PAPER_PDF` (= `RAW/<STEM>.pdf`), `KB`, and `SCHEMA` (= [schema.md](../../templates/literature_sweep/schema.md)).

**Exactly one sub-agent writes to each stub.** The sub-agent reads the PDF directly via the Read tool. Run 2–3 in parallel.

Commit: `git add -A && git commit -m "literature_sweep: step 3 — summaries"`.

## Step 4 — Recurse lineage (SUB AGENT per new title)

Collect every title in `prior_work` and `follow_on_work` across all stubs matching `RAW/*.yaml` and all entries in `<kb.yaml>`. Drop titles that already have a stub (match any `RAW/<slug>-*.yaml`) or a KB entry (case-insensitive substring match).

For each remaining title, spawn a sub-agent that invokes this command on that title with `--steps 1,2,3,4` and the same `<kb.yaml>`. That recursive invocation runs its own steps 1–4, which expands further lineage. Run 2–3 sub-agents in parallel.

Repeat the collection-and-spawn pass until no new titles remain (fixed point).

Commit: `git add -A && git commit -m "literature_sweep: step 4 — lineage"`.

## Step 5 — Consolidate

Main agent only (skip if invoked with `--steps` excluding 5).

1. Read every stub matching `RAW/*-*.yaml`. Drop stubs whose descriptive fields are all empty (should not occur; if any, report them).
2. Merge stub entries into `<kb.yaml>` under `papers:`. Do not duplicate titles already present.
3. Sort all entries by `year` ascending, then `venue` alphabetically.
4. For each title added that supersedes a prior `state_of_the_art: true` entry in `<kb.yaml>`, flip that old entry to `false` and add the new title to its `follow_on_work` if missing.
5. **Do not delete `RAW/`.** The stubs and PDFs persist there as a re-runnable archive — future invocations resume from `RAW` and re-reads of the PDFs stay local. Idempotency (`<kb.yaml>` entry check) prevents duplicate merges on re-runs.

Commit: `git add -A && git commit -m "literature_sweep: step 5 — consolidate"`.

## On completion

Report: papers added, papers marked not accessible, any new tags introduced, and each lineage chain discovered, formatted as:

```
[seminal] Title A (YYYY) → Title B (YYYY) → Title C (YYYY) [state_of_the_art]
```
