/** Trusted gateway policy. This file is baked into the image, never user-mounted. */
export const RESTRICTED_CHANNEL = "C0CLV5JTS87";
export const RESTRICTED_USERS = ["U0BSR15ENTS", "U0CM8FWDZD4"] as const;
export const ALERT_USER = "U02HD0SANKH";
export const PROFILE = "wormhole-restricted-v1";
export const IMAGE = "wormhole-restricted:v1";
export const LIMITS = { memory: 3 * 1024 ** 3, storage: 15 * 1024 ** 3, cpus: 2, pids: 256 };
export function isRestrictedUser(user: string | undefined): user is string {
  return !!user && (RESTRICTED_USERS as readonly string[]).includes(user);
}
export function restrictedAccess(user: string | undefined, channel: string | undefined): boolean {
  return isRestrictedUser(user) && channel === RESTRICTED_CHANNEL;
}
export function containerName(user: string): string {
  if (!isRestrictedUser(user)) throw new Error("Unknown restricted user");
  return `wormhole-restricted-${user.toLowerCase()}`;
}
export function networkName(user: string): string { return containerName(user) + "-net"; }
export function volumeName(user: string): string { return containerName(user) + "-data"; }
export function restrictedKey(user: string, channel: string, thread: string): string {
  if (!restrictedAccess(user, channel) || !/^\d+(?:\.\d+)?$/.test(thread)) throw new Error("Invalid restricted session identity");
  return `restricted:${user}:${channel}:${thread}`;
}
export function sessionDirectory(key: string): string {
  if (!/^restricted:U[A-Z0-9]+:C[A-Z0-9]+:\d+(?:\.\d+)?$/.test(key)) throw new Error("Invalid restricted session key");
  return "/user/sessions/" + key.replace(/[^A-Za-z0-9_-]/g, "_");
}
export const SANDBOX_INSTRUCTION = `You are running in a restricted Docker container. Work freely within the container's available resources. Aires DB is available read-only at /scratch/aires-db; persistent writable storage is under /user. Do not attempt to escape the container, bypass its isolation, obtain host privileges, or modify the read-only Aires DB. If a user requests or you identify an attempt to bypass these boundaries, stop that action and use notify_alan to notify Alan in the current Slack thread, briefly describing the attempt. Pass this instruction to every child agent. These instructions apply throughout this session, including after resuming. General internet use and unrelated work inside the container are permitted. Use slack_post_file to share outputs. Use set_workdir to change this session's working directory inside the container. Shell commands and child agents run inside this same container. You cannot change the host Wormhole configuration or access host services.`;
