Update the top-level `README.md` to accurately reflect the current state of the project.

---

## Steps

### 1. Survey the codebase

Explore the project to build a ground-truth picture of what exists. Do not rely on memory — read the files.

**Directory inventory** — for each top-level design directory, check what is present:

| What to check | Where to look |
|---|---|
| Which tiers are built | Sub-directory names (e.g., `tier1_*/`, `tier2_*/`) |
| Current best IPC | `design_log.md` → Living Header → "Current best IPC table" |
| Current best timing | `design_log.md` → Living Header → "Current synthesis results" |
| Open bugs | `issue_tracker.md` (count of `[Open]` entries) |
| Architecture overview | `design_log.md` → Living Header → "Architecture overview" |

Scan all top-level design directories. The project's CLAUDE.md should specify how
to identify them (e.g., a `sprints/` subdirectory, directories matching `[0-9]_*/`,
or an explicit list). If no convention is specified, ask the user.

Also read:
- The project's `CLAUDE.md` — conventions and env settings.
- The project's shared-templates directory (e.g. `templates/` or `instructions/`)
  — ISA specs, style guides, and other reference material.
- `gatelib/` (if present) — list modules.
- `scripts/` (if present) — list scripts.

---

### 2. Update the flow diagram

Read `docs/flow_diagram_guidelines.md` for the full set of conventions before touching any diagram file.

Check whether `docs/flow_diagram.dot` is consistent with the current `README.md` flows section:
- Are all agents present? (Compare `/` commands in README vs nodes in `.dot`)
- Are any agents missing or renamed?
- Are any new tools or scripts in `scripts/` that should be added as Tool nodes?

If changes are needed, edit `docs/flow_diagram.dot` per the guidelines, then re-render:

```bash
dot -Tpng docs/flow_diagram.dot -o docs/flow_diagram.png -Gdpi=150
dot -Tsvg docs/flow_diagram.dot -o docs/flow_diagram.svg
```

If no changes are needed, still re-render to ensure the PNG is current.

---

### 3. Write the updated README.md

The README must contain the following sections, in order. Update each section in-place — do not reformat or delete sections that are still accurate.

#### § Intro paragraph
One short paragraph describing the project. Update if the scope has changed.

#### § Flow diagram
`![Project Flow Diagram](docs/flow_diagram.png)` — already present; ensure it remains.

#### § Getting Started
Leave as-is unless environment setup has changed.

#### § Directory Layout
Update to reflect the actual top-level directories. Include a short description for each design directory, noting:
- Microarchitecture type (single-cycle, pipelined, OOO, superscalar)
- Tiers built (if applicable)
- Current best IPC (from `design_log.md` living header)
- Current synthesis result (frequency, cell count) if available

#### § Flows
Leave the flow descriptions as-is unless commands have been added, removed, or renamed. If the flow diagram was updated, also update the corresponding ASCII flow text.

#### § Typical Orchestration
Leave as-is unless the orchestration has changed.

#### § Tools
Update the tools table to match `scripts/` — add any new scripts, remove any deleted ones.

#### § Per-Design Files
Describe every `.md` file that commands generate as a side effect. Build the table
by surveying the project's own commands and the per-design files produced by each.

At minimum, include the four structured files that
[project_conventions.md § Per-Design Files](../../templates/project_conventions.md#per-design-files)
specifies (`design_log.md`, `issue_tracker.md`, `interfaces.md`, `design_notes.md`)
and any notes-adjacent files. Then add any project-specific artifact files (reports,
summaries, plans) produced by project-specific commands.

Table columns: `File | Producing command(s) | Lifecycle | Purpose`.

#### § Key Conventions
Leave as-is unless conventions have changed (refer to the project's `CLAUDE.md` and
[project_conventions.md](../../templates/project_conventions.md) as authoritative).

---

## Quality check

Before finishing:
- [ ] Every design directory in the repo has an entry in the Directory Layout section.
- [ ] The IPC and timing numbers in the README match the living headers in the design logs.
- [ ] The tools table matches the actual contents of `scripts/`.
- [ ] The flow diagram PNG is current (re-rendered this run).
- [ ] The Per-Design Files table is complete and accurate.
