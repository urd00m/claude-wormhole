import bolt from "@slack/bolt";
import { env } from "../config.js";

const { App, LogLevel } = bolt;

export const app = new App({
  token: env.SLACK_BOT_TOKEN,
  appToken: env.SLACK_APP_TOKEN,
  signingSecret: env.SLACK_SIGNING_SECRET,
  socketMode: true,
  logLevel: env.LOG_LEVEL === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
});

export type SlackApp = typeof app;
