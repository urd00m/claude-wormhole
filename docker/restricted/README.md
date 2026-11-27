# Restricted-user Docker workers

Jonathan (`U0BSR15ENTS`) and Misk (`U0CM8FWDZD4`) may use the bot only in
`C0CLV5JTS87`. They are not members of the unrestricted allowlist. Restricted
status takes precedence if an ID is accidentally added to that list.

The host Slack gateway dispatches their messages before watchdog, host shell,
consent, aliases, or global configuration paths. Each user has one persistent
container, with distinct conversations keyed by user/channel/thread. The host
registry records Docker ownership. Agent processes, MCP servers, workers and
`!` commands execute inside Docker. Unavailable or misconfigured containers
produce errors, never a local-runtime fallback.

Per-user limits (shared by every thread/child): 3 GiB RAM, no swap, 2 CPU
equivalents, 256 processes and a dedicated 15 GiB ext4 storage image. The image
reserves its full host capacity and its filesystem enforces the storage cap.
Container root is read-only; `/tmp` is a 256 MiB tmpfs and `/run` a 16 MiB tmpfs,
both charged against RAM. Docker logs are rotated at 3 x 10 MiB. The shared
worker image and read-only DB do not consume the user's writable allowance.

`/scratch/aires-db` is mounted read-only at the same path. `/user` contains
workspaces, provider homes, scripts, downloads, outputs and session state. No
host home, SSH keys, Slack credentials, Docker socket or other user volumes are
mounted. Only model authentication files and model-selection settings are
seeded, without overwriting already refreshed credentials. Host plugins, hooks,
MCP servers and project trust settings are not copied. Worker configuration is
parsed without Slack credentials.

Containers run as UID/GID 1000, with no capabilities, no privilege escalation,
private PID/IPC/mount namespaces, no published ports and default Docker seccomp.
Separate bridge networks allow general internet use; firewall rules block host
connections and private/link-local destinations. No host networking or access to
other containers is granted.

Slack uploads/downloads cross the boundary as bounded byte buffers. The gateway
does not open container-supplied host paths. The bridge permits only posts/files
in the originating thread and an Alan alert. It cannot execute host commands,
change global settings, or choose another channel. Container workdir changes and
runtime switches remain inside the same user's container. Host cron/config
management tools are not exposed; existing records attributed to restricted
users are checked and routed through the restricted handler.
Transfers are limited to 20 MiB each, with at most four gateway transfers/posts
pending per user, so container requests cannot accumulate unbounded host buffers.
Background completions retain the originating human turn's authorization and
cannot borrow a newer message's timestamp or select a different execution realm.

Every session/worker receives the sandbox instruction. `notify_alan` mentions
Alan in the current thread for identified escape attempts. Reporting is an agent
instruction, not host-based detection; `!` commands bypass agent inspection.
Docker remains the enforcement boundary. There is no topic restriction.

## Operator workflow

Build in an isolated checkout matching the live baseline, following
`skills/deploy.md`:

```sh
npm run build
sg docker -c 'docker build -f docker/restricted/Dockerfile -t wormhole-restricted:v1 .'
WORMHOLE_LIVE_ROOT=/home/alan/claude-wormhole node dist/restricted/provision.js
```

Provisioning is idempotent and never reformats existing images or replaces
existing containers. It uses short-lived operator helpers to attach loop devices,
initialize the dedicated volumes, and apply firewall rules. Only the loop-device
setup helper is privileged; restricted agents never get these privileges.
Image/profile changes require an explicit operator rollout, with workers drained
before container replacement and persistent volumes preserved.

After renewing model authentication, drain the affected workers and rerun
provisioning with `--refresh-model-auth` to replace only the seeded model auth
files. Ordinary boot/provisioning never overwrites refreshed credentials.

Install the provided user service and dependency drop-in during the staged
rollout. It restores loop attachments, networks and containers on boot before
Wormhole starts. It is a Wants dependency: a provisioning failure does not grant
host access or prevent the unrestricted gateway from starting. After restarting
Docker separately, rerun the provisioning service to restore firewall rules.

State is under `~/.local/state/claude-wormhole/restricted/disks`. Back up storage
images only while their containers are stopped or using a consistent filesystem
snapshot. Do not delete images, volumes, provider homes or host conversation
bindings during updates. Removing a container does not require clearing history.

Run the normal test suite and the opt-in Docker integration check before rollout.
Production Slack messages and model calls are not needed for the isolation check.
