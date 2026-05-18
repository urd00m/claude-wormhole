import type { WebClient } from "@slack/web-api";

type Pending = {
  resolve: (allowed: boolean) => void;
  channel: string;
  threadTs: string;
  promptTs: string;
  timer: NodeJS.Timeout;
};

const pending = new Map<string, Pending>();

const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;

export type ConsentRequest = {
  client: WebClient;
  channel: string;
  threadTs: string;
  toolName: string;
  command: string;
  reason: string;
  /** If set, the request is coming from a sub-agent rather than the main agent. */
  agentID?: string;
};

export async function askConsent(req: ConsentRequest): Promise<boolean> {
  const { client, channel, threadTs, toolName, command, reason, agentID } = req;
  const id = `${channel}:${threadTs}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

  const who = agentID ? `Sub-agent (\`${agentID}\`)` : "Agent";
  const post = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `🛑 ${who} wants to run ${toolName}: \`${truncate(command)}\` (${reason})`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:no_entry: *${who} wants to run ${toolName}*\nReason: _${reason}_\n\`\`\`${truncate(command)}\`\`\`\nReply *yes* / *no* in this thread, or click below.`,
        },
      },
      {
        type: "actions",
        block_id: `consent:${id}`,
        elements: [
          {
            type: "button",
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            action_id: "consent_approve",
            value: id,
          },
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: "Deny" },
            action_id: "consent_deny",
            value: id,
          },
        ],
      },
    ],
  });

  const promptTs = post.ts;
  if (!promptTs) {
    return false; // couldn't post — fail closed
  }

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(async () => {
      pending.delete(id);
      try {
        await client.chat.update({
          channel,
          ts: promptTs,
          text: `⌛ consent timed out — auto-denied: ${truncate(command)}`,
          blocks: [],
        });
      } catch {
        /* ignore */
      }
      resolve(false);
    }, CONSENT_TIMEOUT_MS);

    pending.set(id, { resolve, channel, threadTs, promptTs, timer });
  });
}

/** Called by the button-action handler. */
export async function resolveConsent(
  client: WebClient,
  id: string,
  allowed: boolean,
  by: string,
): Promise<boolean> {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  try {
    await client.chat.update({
      channel: p.channel,
      ts: p.promptTs,
      text: allowed ? `✅ approved by <@${by}>` : `❌ denied by <@${by}>`,
      blocks: [],
    });
  } catch {
    /* ignore */
  }
  p.resolve(allowed);
  return true;
}

/**
 * Match a thread reply against the most recent pending consent in that thread.
 * Returns true if the reply was consumed.
 */
export async function tryResolveByReply(
  client: WebClient,
  channel: string,
  threadTs: string,
  text: string,
  by: string,
): Promise<boolean> {
  const t = text.trim().toLowerCase();
  let allowed: boolean | null = null;
  if (["yes", "y", "approve", "ok", "okay"].includes(t)) allowed = true;
  else if (["no", "n", "deny", "cancel", "stop"].includes(t)) allowed = false;
  if (allowed === null) return false;

  // Find newest pending in this thread
  let pick: [string, Pending] | null = null;
  for (const [id, p] of pending) {
    if (p.channel === channel && p.threadTs === threadTs) {
      if (!pick) pick = [id, p];
    }
  }
  if (!pick) return false;
  return resolveConsent(client, pick[0], allowed, by);
}

function truncate(s: string, max = 400): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
