import type { App } from "@slack/bolt";
import { resolveConsent } from "./consent.js";

export function registerInteractions(app: App) {
  app.action("consent_approve", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const id = action?.value;
    const user = (body as { user?: { id?: string } }).user?.id ?? "someone";
    if (id) await resolveConsent(client, id, true, user);
  });

  app.action("consent_deny", async ({ ack, body, client }) => {
    await ack();
    const action = (body as { actions?: Array<{ value?: string }> }).actions?.[0];
    const id = action?.value;
    const user = (body as { user?: { id?: string } }).user?.id ?? "someone";
    if (id) await resolveConsent(client, id, false, user);
  });
}
