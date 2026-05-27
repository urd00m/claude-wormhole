---
description: "Bootstrap an interactive study session for a paper. Given a paper title and a registry path that helps locate its markdown form, loads the full text and presents a schema-style summary so the user can ask focused follow-ups. Use when the user says they want to study, read, or work through a paper."
---

Bootstrap an interactive Q&A study session over a single paper. Arguments: $ARGUMENTS

## Arguments

`$ARGUMENTS` = `<paper-title> <registry-path>`

Both are required.

- **paper-title** — the paper to study, free text. Used to locate the right entry inside `<registry-path>`.
- **registry-path** — path (absolute or relative to cwd) to a markdown index of papers, e.g. `formal_verification/papers.md`. Sections in this file link out to the markdown version of each paper.

Print both resolved arguments before starting.

## Procedure

1. Read the file at `<registry-path>`. It is expected to be a markdown index of papers (sections per paper with author, venue, links).
2. Locate the section matching `<paper-title>` (case-insensitive substring). If multiple sections match, list the candidates back to the user and ask which one.
3. Within the chosen section, find a link to a `.md` version of the paper itself — the converted full text, **not** the publisher DOI/HTML link. Conventionally appears as `[notes](<relative-path>.md)`; accept any link whose target ends in `.md`.
4. If no such `.md` link is present, **ask the user for guidance** (a direct path to the paper's `.md`, or confirmation that the paper has not yet been converted — in which case stop and report).
5. Resolve the `.md` link relative to the registry file's directory and `Read` the entire file (no `offset`/`limit`).
6. Proceed to **§ Summarize**.

## Summarize

Generate a study-prep summary covering the per-paper fields defined in [../../templates/literature_sweep/schema.md](../../templates/literature_sweep/schema.md) — see that file for each field's meaning and quality bar.

Qualifications for this command (where it departs from the schema):

- **Output is chat, not a file.** Present as readable markdown prose, not a YAML entry, and **do not write it to disk** — it is the bootstrap for a live study session.
- **`follow_on_work`** — include only extensions the paper itself names. Do **not** WebSearch (the schema sources this field from WebSearch; this command does not).
- **Collapse** title / authors / year / venue onto one line.
- **Omit** `tags` and `state_of_the_art` — they serve the KB index, not a study session.

Keep prose tight; favor specific terms from the paper over generic restatement.

## Bootstrap the Q&A session

After presenting the summary, end with a short menu (3–5 options) of follow-up directions tailored to what the paper actually contains. Examples: worked-example walkthrough, theorem/proof probe, mechanism mechanics, complexity/heuristic, evaluation deep-dive, free-form Q&A. A purely theoretical paper has no "implementation" thread; an empirical paper deserves an "evaluation" thread — pick what fits this paper.

After the menu, **stop and wait for the user's choice.** This command is a bootstrap, not an autopilot.

## On completion

Report (one line): `OK <resolved-paper-md-path>` — paper loaded and summary presented — or `BLOCKED <reason>`.
