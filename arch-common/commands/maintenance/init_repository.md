Initialize project-specific repository instruction files from arch-common stubs.

## Steps

1. Resolve `{{PROJECT_NAME}}` to the current directory's basename.
2. Check `./CLAUDE.md` and `./AGENTS.md`.
   - If both already exist, stop with no writes and report that repository instructions are already initialized.
   - If one already exists, leave it unchanged and create only the missing file.
   - Never overwrite an existing instruction file.
3. For each missing target, use the matching stub:
   - If `./CLAUDE.md` is missing, read `../arch-common/CLAUDE.md.stub`, substitute `{{PROJECT_NAME}}`, and write `./CLAUDE.md`.
   - If `./AGENTS.md` is missing, read `../arch-common/AGENTS.md.stub`, substitute `{{PROJECT_NAME}}`, and write `./AGENTS.md`.
4. Tell the user which files were created and which existing files were left unchanged.
5. Tell the user to fill in or delete the `{{VAR_NAME}}` / `{{Context description}}` example rows in the Env and Required Reads tables in newly-created files.
