import { env } from "../config.js";

/** Slack user IDs are supplied by verified Slack events, never message text. */
export function isAllowedSlackUser(user: string | undefined): boolean {
  return !!user && env.SLACK_ALLOWED_USER_IDS.includes(user);
}
