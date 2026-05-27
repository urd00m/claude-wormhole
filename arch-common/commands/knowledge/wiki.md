---
description: "Build and maintain an LLM-readable wiki from markdown sources, Karpathy-style. Use when asked to compile sources into a wiki, ingest new sources, or lint/maintain an existing wiki."
---

Build and maintain a Karpathy-style LLM-readable wiki from markdown sources. Arguments: $ARGUMENTS

## Arguments

`$ARGUMENTS` = `<wiki-dir> <mode> [<source-md> ...]`

- **wiki-dir** (required) — path to the wiki root. Created by `init`.
- **mode** (required) — `init`, `ingest`, or `lint`.
- **source-md** (required for `ingest`; ignored otherwise) — one or more `.md` files to ingest. Each file is one source.

This command expects sources to already be markdown. For papers starting as PDFs, run `/arch-common:knowledge:literature_sweep` first (it uses `marker` to produce `.md`). This command does not download, convert, or re-summarize PDFs.

Print resolved arguments before starting.

## Wiki layout

`<wiki-dir>/` contains:

| Path | Role | Writer |
|---|---|---|
| `schema.md` | Conventions — page format, tagging, cross-ref rules | User-editable after `init` |
| `index.md` | Catalog of pages and sources with 1-line summaries | Agent |
| `log.md` | Append-only record of every ingest and lint | Agent |
| `sources/<source-slug>.md` | Immutable copy of each ingested raw markdown | Agent (write-once) |
| `pages/<topic-slug>.md` | Synthesized, cross-linked topic pages | Agent |
| `scratch/` | Ingest intermediates; deleted at end of each ingest | Agent (ephemeral) |

Pages cross-link via `[text](other-page.md)` within `pages/`, and cite sources via `[text](../sources/<source-slug>.md)`.

## Slug rule

`<slug>` = lowercased name with non-alphanumerics replaced by `-`, runs collapsed, leading/trailing `-` trimmed.

- `source-slug` = slug of the source filename without extension.
- `topic-slug` = slug of the topic name chosen during ingest.

---

## Mode: init

Refuse if `<wiki-dir>/schema.md` already exists.

1. `mkdir -p <wiki-dir>/sources <wiki-dir>/pages`.
2. Copy [templates/wiki/schema_template.md](../../templates/wiki/schema_template.md) → `<wiki-dir>/schema.md`.
3. Write `<wiki-dir>/index.md` with headers only (see schema); zero entries.
4. Write `<wiki-dir>/log.md` with a seed entry: `## <YYYY-MM-DD>: init — wiki created at <wiki-dir>`.
5. Commit: `git add -A && git commit -m "wiki: init at <wiki-dir>"`.

Tell the user: the schema is now theirs to customize. Edit `<wiki-dir>/schema.md` to adjust page format, tag vocabulary, or cross-ref rules before the first ingest.

---

## Mode: ingest

Refuse if `<wiki-dir>/schema.md` does not exist (user must run `init` first).

### Stage 1 — Copy sources

For each `<source-md>` argument:

1. Derive `source-slug` from the filename (without extension).
2. If `<wiki-dir>/sources/<source-slug>.md` already exists, skip with notice and do not re-ingest.
3. Otherwise copy `<source-md>` → `<wiki-dir>/sources/<source-slug>.md`. This copy is immutable thereafter.

Collect the list of newly staged slugs as `NEW_SLUGS`. If `NEW_SLUGS` is empty, stop and report nothing to do.

`mkdir -p <wiki-dir>/scratch`.

Commit: `git add -A && git commit -m "wiki: stage <N> sources"`.

### Stage 2 — Extract (SUB AGENT per source, parallel)

For each slug `S` in `NEW_SLUGS`, spawn a sub-agent with the prompt in [templates/wiki/extract.md](../../templates/wiki/extract.md). Pass:

- `SOURCE` = `<wiki-dir>/sources/S.md`
- `SCRATCH` = `<wiki-dir>/scratch/S.md`
- `SCHEMA` = `<wiki-dir>/schema.md`
- `EXISTING_PAGES` = comma-separated list of existing page slugs (glob `<wiki-dir>/pages/*.md`, strip extension). Empty if none.

Run 2–3 sub-agents in parallel. Collect `OK` / `SKIP` results.

Commit: `git add -A && git commit -m "wiki: extract <N> sources"`.

### Stage 3 — Merge (main agent, serial)

The main agent reads every scratch file and merges into the wiki.

1. **Plan pages.** Group scratch `### Page:` blocks by target slug. For each target:
   - If slug matches an existing page → extend that page.
   - If slug is new → create a new page from the schema's page template.
2. **Write pages.** For each target page, update or create it per the schema. Integrate contributions from each source; add the source to the page's "Sources" section with its one-line contribution note.
3. **Add cross-refs.** For each proposed cross-ref in the scratches, ensure both endpoints link to each other (add backlinks where missing).
4. **Update `index.md`.** Add new pages and new sources with one-line summaries. Revise summaries of pages that changed substantially.
5. **Append to `log.md`** under a `## <YYYY-MM-DD>: ingest` entry:

   | Field | Content |
   |---|---|
   | **Sources added** | list of slugs |
   | **Pages created** | list of slugs |
   | **Pages updated** | list of slugs |
   | **Cross-refs added** | `page-a ↔ page-b` per line |
   | **New concepts / tags** | any vocabulary introduced (per schema rule) |
   | **Skipped** | any `SKIP <slug> <reason>` from Stage 2 |

6. `rm -rf <wiki-dir>/scratch/`.

Commit: `git add -A && git commit -m "wiki: ingest <N> sources — <M> pages touched"`.

---

## Mode: lint

Refuse if `<wiki-dir>/schema.md` does not exist.

Read `schema.md`, `index.md`, `log.md`, and every file under `pages/`. Do **not** re-read files under `sources/` (expensive and unnecessary for the checks below).

Checks and actions:

| Issue | Detection | Action |
|---|---|---|
| Broken cross-ref | `[text](path)` where `path` does not resolve under `pages/` or `sources/` | Auto-fix: relocate if file moved, remove link if target deleted. |
| Missing cross-ref | Page A mentions a concept whose slug is an existing page, without linking | Auto-fix: add the link on first mention. |
| Orphan page | Page has zero inbound links from `index.md` or other pages | Flag — propose adding inbound links or deleting. |
| Page-size bloat | Page > 1000 lines | Flag — propose a split boundary. |
| Contradiction | Two pages assert opposing claims on the same fact | Flag with both quotes and page paths; propose resolution. |
| Stale superseded claim | Page asserts "X is current" but a later-ingested page or source overrides | Flag — propose revision. |

Append a `## <YYYY-MM-DD>: lint` entry to `log.md`:

| Field | Content |
|---|---|
| **Auto-fixed** | count + one-line per fix (type, page, before→after summary) |
| **Flagged** | one block per flagged issue: type, page(s), excerpt, proposed resolution |

Commit: `git add -A && git commit -m "wiki: lint — <N> fixed, <M> flagged"`.

---

## On completion

Report:

- Mode executed and resolved arguments.
- For `ingest`: sources added, pages created/updated, cross-refs added, any skips.
- For `lint`: auto-fix count, flag count, and the path to the log entry.
- For `init`: the path to `<wiki-dir>/schema.md` and a one-line reminder to customize before first ingest.

---

## Why this structure (Karpathy LLM-wiki)

A synthesized markdown wiki replaces vector-RAG retrieval for small/medium corpora (up to ~100 pages / ~400k words). The LLM reads the whole wiki via `index.md` and page links — no embeddings, no retrieval noise. The human curates sources; the agent handles synthesis, cross-refs, and bookkeeping. Periodic `lint` keeps the wiki coherent as it grows.
