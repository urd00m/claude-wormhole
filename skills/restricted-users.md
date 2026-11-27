# Manage restricted users

Use to create restricted users or maintain their access, containers, resources,
and authentication. Follow the user's requested scope.

Read `src/restricted/policy.ts` for current policy and
`docker/restricted/README.md` for operations. Follow `skills/deploy.md`
for rollouts.

- Keep access channel-only. Agent tools, child agents, and `!` commands
  must execute in the owning user's container, with no host fallback.
- Preserve the read-only Aires DB mount, host isolation, separate user
  storage, and resource limits.
- Provision each new user separately. When revoking access, drain affected
  work and ensure removal cannot grant unrestricted access.
- Drain affected workers before container replacement or authentication
  refresh. Preserve volumes, disk images, histories, and session identities.
  Storage-limit changes require an explicit filesystem migration.
- Verify routing, denied channels/DMs, `!` containment, read-only DB access,
  and session continuity. Rerun provisioning after Docker restarts to
  restore network rules.
- Report changes, verification, and unresolved failures. Escape-attempt
  alerts are agent instructions; `!` commands bypass agent inspection.
