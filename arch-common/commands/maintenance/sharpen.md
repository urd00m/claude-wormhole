---
description: "Make text maximally concise. Use when asked to tighten, shorten, or sharpen a document or command."
---

Rewrite `$ARGUMENTS` to be maximally concise and precise without losing semantic content.

## Arguments

`$ARGUMENTS` = `<file_path>`

- **file_path** (required) — file to sharpen (command, plan, or CLAUDE.md), absolute or repo-root-relative.

---

## Principles

1. **Preserve all semantic content.** Every instruction, constraint, edge case, and contract must survive.
2. **Verify every change.** For each deletion or rewrite, confirm the result still answers what, who, why, and where; otherwise keep the original text.
3. **Cut ruthlessly.** Remove filler, hedging, redundant restatements, unnecessary examples, verbose phrasing. Prefer imperatives and one sentence over one paragraph.
4. **Increase precision.** Replace vague language ("check the output") with specific actions ("grep stderr for `ERROR`", "assert exit code 0"). Replace ambiguous pronouns with their referents.
5. **Never make text more vague.** Every rewrite must be at least as specific as the original. If compression loses precision, leave the text unchanged.
6. **Preserve structure.** Keep the same section/step hierarchy. Merge or reorder steps only when steps are truly redundant.
7. **Don't add content.** Compression pass only — no new steps, constraints, or guidance.
8. **One path per task.** Every instruction must have exactly one execution path. Replace branching ("if X, do A; otherwise do B") with the correct single path.
9. **Every instruction needs a clear actor.** When user, main agent, or sub-agent could be confused, state the subject explicitly.
10. **Headings must describe content, not compression history.** Keep the extra line if merging would put unrelated content under a wrong heading.

---

## Execution model

Main agent coordinates; spawn each step below as its own sub-agent. Per step, pass only that step's contract (inputs + expected structured output) plus the file content it needs. Collect the sub-agent's result before launching the next step. Sub-agents must not spawn further sub-agents. Main agent performs the Step 5 write.

---

## Step 1: Read

Read `<file_path>` in full.

If it references shared files (e.g., `common_surrogate.md`), note them; read and modify only `<file_path>`.

---

## Step 2: Analyze

Tag every sentence:

| Tag | Meaning | Action |
|-----|---------|--------|
| **K** | Unique semantic content | Tighten if possible |
| **R** | Redundant with another sentence | Remove; cite duplicate |
| **V** | Same meaning in fewer words | Rewrite shorter |
| **I** | Vague or ambiguous | Rewrite with specifics |
| **F** | No actionable content | Remove |
| **A** | Multiple paths for one task | Collapse to one path |

Return counts per tag and estimated line reduction.

---

## Step 3: Rewrite

Apply all tags in one rewrite. Use:

- **Tables** for structured information (parameters, file layouts, contracts).
- **Inline constraints** instead of separate notes or callouts.
- **Collapsed sub-steps** for trivial sequences.
- **Standard shorthands**: `stdout`, `stderr`, `exit 0`, `iff`, `e.g.`, `i.e.`, `→`.

Return the rewritten file content.

---

## Step 4: Diff Review

Return before/after:

- **Line count**: original → rewritten (% reduction).
- **Deletions**: each removed passage with tag (R/F/A) and justification.
- **Rewrites**: old → new on one line for each V/I change.
- **Preserved**: K-sentence count.

If reduction < 10%, return verdict "already concise"; main agent skips Step 5.

---

## Step 5: Apply

Main agent writes the rewritten file to `<file_path>`.
