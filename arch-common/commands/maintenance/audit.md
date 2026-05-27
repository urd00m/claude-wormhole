Audit the following file(s) for quality: $ARGUMENTS

Do **not** edit any files.  Report findings and await instruction.

---

## Ignores

Ignore/skip files under `/old` and `/templates` unless specifically named in
`$ARGUMENTS`.

---

## Instructions

Read the target file(s).  For each file, check every category below that
applies.  Produce a per-file finding list grouped by category.  For each
finding, quote the relevant passage(s) and name the files/lines involved.

When checking cross-file issues, also read sibling files (same directory) and
any files the target links to or is linked from.  Also read common reference
files (the project's `CLAUDE.md` and any shared references directory it points
at — for arch-common consumers, that means `templates/*.md` in the installed
plugin) to check for cross-file redundancy, contract divergence, or
inconsistent naming between the target and those shared files — not to suggest
adding them as required reads unless they are actually relevant to the
command's purpose.

At the end of each file's section, list items you considered but determined are
**not** findings, with a one-line reason.

After all per-file sections, produce a summary table (see Output format).

---

## Categories

Categories marked **(commands only)** apply only to `.claude/commands/*.md`
files.  Skip deprecated commands (those whose body only redirects to another
command) for command-only categories.

### Redundancy & verbosity

#### 1. Internal redundancy

The same fact is stated more than once **within a single file**.

#### 2. Cross-file redundancy

Substantial content (≥ 3 lines or ≥ 1 complete concept) is duplicated between
two files with no factoring into a shared reference.

#### 3. Verbose but not redundant

Passages that could be shorter without losing information.  Only flag cases
where the saving is ≥ 2 lines or ≥ 20% of the passage.

### References & naming

#### 4. Missing reference

The file refers to another file, directory, or concept that does not exist.

#### 5. Inconsistent referencing

Within a single file or across files, the same file/directory/concept is
referenced in inconsistent ways (e.g., different paths or names for the same
entity).

#### 6. Cross-file contract divergence

Multiple files share a contract (e.g., model identifiers like M0–M6, tagged line formats, figure naming conventions) where one file defines the contract and others consume it. The definition and consumption have diverged.

#### 7. Semantic inconsistency

A reference is semantically wrong for its context (e.g., a simulation-based testing section references `scripts/run_formal.py` instead of `scripts/run_test.py`).

#### 8. Naming inconsistency

A concept is defined as X but later referred to as something other than X.

#### 9. Stale definition

A name or concept is defined but never referenced anywhere else.

#### 10. Deprecation staleness

References a file, command, or convention that no longer exists or has been
renamed.

### Structure

#### 11. Structural inconsistency

Instruction files should follow a consistent template.  Flag files that deviate
from the pattern of their siblings without explanation (e.g., most instruction
files have Testing + Formal sections but one is missing a section).

#### 12. Per-design file template compliance

Check per-design files against the templates defined in
[project_conventions.md § Per-Design Files](../../templates/project_conventions.md#per-design-files).
For each file type, verify that the required structure is present:

- **`design_log.md`**: Must have a living header (Section 1) with architecture
  overview, current best IPC table, current synthesis results, and known open
  issues.  Must have an append-only changelog (Section 2) where each entry
  includes Status, Category, Motivation, Change, Results, and Timestamp.
- **`issue_tracker.md`**: Each entry's `##` header must include a status tag
  (`[Open]` or `[Resolved]`).  Each entry must include Summary, How it
  manifests, Steps to reproduce, Affected module(s), and Status fields.
- **`interfaces.md`**: Must have a pipeline/architecture overview and
  per-module sections with Responsibility, Parameters, Ports, and Behavioral
  contract.
- **`design_notes.md`** (and other `*notes*.md`): Must contain reference
  knowledge, not chronological entries (those belong in `design_log.md`) or
  bugs (those belong in `issue_tracker.md`).

Flag missing sections, missing required fields, and content that belongs in a
different per-design file.

### Command quality (commands only)

#### 13. Generality — hardcoded specifics

Flag any **project-specific name, path, or constant** written literally instead
of being derived from arguments or context.

Acceptable:
- A value derived from `$ARGUMENTS` (e.g., an output filename constructed
  from an input argument).
- A value in an **example** that is clearly framed as such and whose
  surrounding text describes the **concept**, not just the instance.

Not acceptable:
- A literal path like `sprints/2_trisc_sail/` used as if it were the only valid input.
- A literal design name like `TR32CoreTop` used outside an example block.
- A literal tool flag or filename that should be parameterized.

#### 14. Parameterization

The command accepts `$ARGUMENTS` and the arguments need to be sufficient to drive the
command without implicit assumptions about working directory, project layout, or
design name.

Flag commands that:
- Take no arguments but operate on files/designs that could vary.
- Assume a directory structure beyond what `$ARGUMENTS` provides.
- Derive important values from conventions never stated in the command.

#### 15. Self-containedness

The command provides enough context for execution.

Flag commands that:
- Reference a file, script, or instruction doc without verifying it exists or
  explaining what to do if it doesn't.
- Assume knowledge not stated in the command, its arguments, or a referenced
  file.
- Use jargon or shorthand without a brief inline definition or link.

Do **not** flag references to well-known tools (Yosys, SymbiYosys, Sail,
iverilog, etc.) or standard programming concepts.

#### 16. Project-conventions compliance

Check against [project_conventions.md](../../templates/project_conventions.md):

- **Style/GateLib**: if the command creates or modifies `.sv` files, it
  includes a step to run `/arch-common:maintenance:apply_sv_styleguide` and
  `/arch-common:maintenance:gatelib_use`.
- **No file duplication**: does not instruct copying a file to a new location.
- **On-completion summary**: includes or defers to a completion/reporting step.
- **Heartbeat support**: if the command is long-running (multiple steps,
  sub-agent delegation, compilation/simulation/synthesis), it includes
  heartbeat provisions or defers to the heartbeat mechanism defined in
  project_conventions.md § Heartbeats.
- **Per-design file updates**: if the command operates in a design directory
  (creates/modifies HDL, runs tests, changes design parameters), it includes
  steps to update the relevant per-design files (`design_log.md`,
  `issue_tracker.md`, `interfaces.md`, `design_notes.md`).
- **Design directory argument**: if the command operates on a design, it
  requires the top-level design directory as an explicit argument — not
  guessed or hardcoded.

#### 17. Command overlap

When given more than one command: flag pairs of commands where:
- One could replace the other with minor argument changes.
- Both generate the same kind of artifact for the same purpose.

#### 17b. Producer–consumer interface consistency

When given more than one command and one command's output is clearly another
command's input (producer → consumer): verify that the data contract between
them is consistent.

Flag cases where:
- The producer emits artifacts (files, formats, field names, directory layouts)
  that the consumer does not expect or names differently.
- The consumer assumes inputs (structure, naming, content) that the producer
  does not guarantee or does not produce.
- Shared terminology, identifiers, or schemas have diverged between the two
  commands.

#### 18. Unreferenced command or registry inconsistency

A command or shared-reference file that is not referenced by any other command,
reference, or project file. Search all `.md` files in the project's commands
directory and shared-references directory for incoming references.

If the consuming project maintains a command/plan registry (e.g., a
`commands.md` file), also check consistency with it:

- **Missing registry entry**: a command file exists but has no corresponding
  entry in the registry.
- **Stale registry entry**: the registry lists a command that has no
  corresponding file.
- **Status mismatch**: the registry status (e.g., `Tested`) is inconsistent
  with the command's actual state (e.g., the file is clearly a rough draft).

Skip this check if the project does not maintain a registry.

#### 19. Context hygiene

Commands should not pull more data into the agent's context than necessary.

##### A. Explicit imports

For each file the command instructs the agent to read or import (`.md`,
`.svh`, `.sv`, data files, etc.):

- **Relevance**: Is the import clearly needed for the command's purpose?
  Flag imports that are tangential or only partially relevant.
- **Size**: Is the imported file large relative to what the command actually
  uses from it?  Flag cases where a targeted read (specific sections, grep)
  would suffice instead of reading the whole file.
- **Both**: Imports that are both low-relevance and large are the highest
  priority to flag.

Do not flag imports of small, tightly-scoped reference files (e.g., a header
listing module signatures) or files that the command is specifically auditing.

##### B. Unbounded / ambiguous reads

Flag steps where ambiguity in the command text may cause large, unbounded data
to be read into context without a fundamental need.  Common patterns:

- **Unbounded tool output**: A step runs a tool (compiler, simulator, synthesis)
  and does not specify whether to capture output, how much to capture, or
  whether to route it to a file instead of reading it inline.
- **Open-ended log/file reads**: A step says "read the log" or "check the
  output" without scoping what to look for (e.g., grep for errors vs. read the
  entire file).
- **Implicit large reads**: A step references a file that is likely large
  (build logs, waveform dumps, full synthesis reports) without restricting the
  read to relevant sections.

For each finding, suggest a concrete mitigation (e.g., "redirect output to a
file and grep for errors", "read only the summary section", "use `tail -n 20`").

#### 20. Required-reading scoping

Commands specify required reading (reference files, design docs, instruction
files).  When a command delegates work to sub-agents, each read should be
assigned to the agent that actually needs it.

Flag commands where:

- **Main-agent overload**: The main agent is instructed to read material it
  only passes through to a sub-agent and never uses itself.
- **Sub-agent underload**: A sub-agent performs work that requires context from
  a reference file, but the command does not instruct the sub-agent to read it
  — relying on the main agent having read it (sub-agents have no prior
  context).
- **Blanket reads**: The command says "read all of X" at the top level without
  scoping which files are needed by which agent.  Each agent should read only
  what is relevant to its specific sub-task.

For each finding, state which reads belong to which agent and why.

#### 21. Script extraction opportunities

Identify steps that perform mechanical/computational work inline — work that
could be moved into scripts to keep the command human-readable and the LLM
context lean.  Classify each step as:

- **Scriptable**: The step is purely mechanical given structured inputs
  (formulas, parsing, formatting, file I/O).  These should become scripts.
- **Hybrid**: The LLM gathers/produces structured inputs, then computation
  follows.  These should be split into: (a) command text describing what the
  LLM must provide (input contract), and (b) a script that consumes that
  input and produces output.
- **LLM-essential**: The step requires understanding code, making judgments,
  or producing prose.  These stay in the command — do not flag.

Flag scriptable and hybrid steps.  For each, describe what the script would
do and what its input/output contract would be.

---

## Output format

```
## <filename>

### 1. Internal redundancy
...

### 2. Cross-file redundancy
...

(continue for each applicable category)

### Not a finding (reviewed and kept)
- "<passage summary>" — <reason>
```

If a category has no findings, write "None."
If a category does not apply to the file type, omit it.

### Summary table

Order columns by importance tier, not by category number.

```
|                   |       High        |                                    Mid                                         |       Nice-to-have        |       |
| File              | 4 | 10 | 6 | 7 | 12 | 2 | 1 | 8 | 16 | 13 | 15 | 19 | 20 | 21 | 5 | 18 | 14 | 17 | 17b | 3 | 11 | 9 | Total |
|-------------------|---|----|----|---|----|----|---|---|----|----|----|----|----|----|----|----|----|----|----|----|----|----|
| <filename>        | 0 |  0 | 0 | 0 |  0 |  1 | 0 | 0 |  — |  — |  — |  — |  — |  — |  0 |  — |  — |  — | 0 |  0 | 0 |     1 |
| ...               |   |    |   |   |   |   |   |    |    |    |    |    |    |    |    |    |   |       |
```

Use `—` for categories that don't apply to a file type.
