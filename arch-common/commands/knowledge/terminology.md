---
description: "Interactively review and refine a notation/terminology reference file (e.g., notation.md) entry-by-entry, applying a fixed set of content principles via a tight Question/Draft/Publish protocol."
---

Interactively review and refine a notation/terminology reference file entry-by-entry with the user, applying a fixed set of content principles. Arguments: $ARGUMENTS

## Arguments

`$ARGUMENTS` = `<file-path> [<section-selector>]`

- **file-path** (required) — path to a notation/terminology markdown file. Must exist.
- **section-selector** (optional) — start the review at a specific section (e.g., `§2`, `Polarity decoration`). Defaults to the top of the file.

Print the resolved file path and selected starting point before the first turn.

## Preflight

Refuse with a specific message if any of the following fails:

- `<file-path>` is not a file.
- `<file-path>` is not markdown (`.md`).
- `<section-selector>` (when given) does not match any heading in the file.

Read the entire file at the start so subsequent edits can be made without re-reading. State the file's section structure back to the user as a sanity check.

---

## Content principles

Apply these to every entry under review. State which principle a change reflects when it isn't obvious.

1. **Concrete over vague.** Replace vague phrasing with concrete definitions — give the math, not the gloss ("$\mathrm{succ}(x) = x+1$", not "interpreted unary function").
2. **Plain language over jargon.** Use simple language; drop unnecessary jargon ("stand-in" over "metavariable", "shorthand" over "syntactic sugar").
3. **Honest scope (no over-claiming).** Qualify scope precisely — don't claim broader applicability than the source supports.
4. **Define before use.** Every symbol must be defined before it appears in another entry's body. Spot pre-use violations and fix them by reordering or adding upstream definitions.
5. **Basic → specialized.** Order entries from broadly-understood to specialized as the reader moves down.
6. **No forward references.** Cross-references go in the later entry pointing back, or are omitted. A primary explanation never forward-refs a later entry.
7. **No premature concepts.** Don't invoke concepts that haven't been introduced in the document yet.
8. **Primary first, reference later.** When two entries share an idea, put the primary explanation in the first occurrence; later entries reference back instead of repeating.
9. **Verify citations.** Spot-check each citation against the source paper; drop spurious ones; add missing ones when a claim is genuinely paper-derived.
10. **Most general setting that holds.** Frame concepts in the most general setting where they hold; specialize only where the document's scope actually narrows. Don't artificially narrow a general result, and don't artificially generalize a narrow one.
11. **No unnecessary nesting.** Prefer flat sections and subheadings over lists within lists. Use nesting only when it reflects real conceptual hierarchy.
12. **One concept, one representation.** Give each concept a distinct name, glyph, style, or convention. Avoid aliases that make two different concepts look interchangeable.
13. **Special glyphs imply structure.** Every special glyph, including a font change, capitalization change, subscript, superscript, or glyph modifier, implies a structural change to the reader. Do not add style unless it makes real structure explicit.
14. **Declare interpretation rules.** If context determines meaning, state which context matters and what must already be declared before the notation or term can be interpreted.
15. **Use examples sparingly.** Give one or two representative examples, then generalize in prose. Avoid exhaustive example lists unless the list is itself the definition.
16. **Prefer recognizable domain names.** Use familiar domain names for concrete cases; reserve abstract symbols for generic cases.
17. **Localize conventions.** Put concept-specific notation with the concept's definition. Keep global convention sections structural and reusable.
18. **State negative cases.** Say what a term or notation does not imply when readers might otherwise infer extra structure.
19. **Make ordering explicit.** If order matters, it must be visible from the notation or declared in text. Do not let an unordered label accidentally imply sequence.

These principles are file-agnostic — they apply to any notation or terminology reference.

---

## Interaction protocol

The session is a tight turn-by-turn loop with the user. Four state transitions control the session; the three command transitions have short aliases:

- **Question (no keyword).** When the user asks a question or makes an observation without a keyword, give a direct answer. **Do not draft text.** Do not push to the file.
- **`Draft` / `D`.** Write a draft of the text under discussion (the proposed new entry, paragraph, or fix). Show it in the chat as a markdown block. Do not push to the file.
- **`Publish` / `P`.** Push the most recent draft to the file. If no draft is on the table, refuse with a specific message ("no draft to publish; ask for `Draft`/`D` first or use `Draft and Publish`/`DP`").
- **`Draft and Publish` / `DP`.** Do both in one turn — show the draft AND push it.

Additional rules:

- After publishing, briefly confirm what changed (one sentence) and prompt for the next item.
- Never apply principles silently — when an edit goes beyond the user's literal request (e.g., the user asks to fix wording but applying principle 4 reveals a pre-use violation that also needs fixing), call that out explicitly so the user can accept or reject the broader change.
- Track per-entry state across turns: which entry you are currently discussing, what the most recent draft is, what changes are pending. If the user pivots to a different entry mid-discussion, drop the pending draft and confirm the switch.

---

## Walk modes

Two walk styles, chosen by the user:

- **Linear walk.** Start at the top (or `<section-selector>`); after each entry is settled, prompt "next?" and move to the next entry in document order.
- **Targeted.** User names specific entries to revisit. No traversal; you address each in isolation.

Default: linear walk from the top.

---

## File-edit hygiene

- Every edit goes through the `Edit` or `Write` tool with the file already read into context.
- Preserve markdown formatting and citation link forms exactly — do not reformat link URLs or section headings unless the change is the point.
- When renumbering sections (e.g., inserting a new §1 shifts everything down), update every in-file cross-reference (`see §N`, `(§N)` parentheticals, top-of-file headers) in the same edit. Run a final grep for `§\d+` to catch references the user may have added that you missed.
- When moving an entry between sections or between files, the canonical definition lives at the destination; replace the source with either a deletion or a back-reference, never a duplicated definition.

---

## On completion

When the user signals the session is done, summarize:

- Entries touched (count + brief list).
- Principles most frequently invoked (which signals where the file needed the most cleanup).
- Open items: anything flagged but not resolved (e.g., symbol collisions, citation gaps, sections deferred).
- File hygiene status: any cross-references or numbering that need a follow-up sweep.

Do not commit. Leave the user to inspect the diff and commit when ready.

---

## Why this structure

Notation files decay in characteristic ways: vague definitions accrete, entries forward-reference each other, citations drift from sources, and section order stops matching the conceptual hierarchy. A single editing pass by one agent typically misses these because the agent is simultaneously interpreting, drafting, and applying principles. The fix is to externalize the principles into a fixed checklist, externalize the protocol so state transitions are explicit and small (the 4 keywords), and put the user in the loop on every change — the user has the domain context the agent does not, and the protocol keeps each turn cheap.
