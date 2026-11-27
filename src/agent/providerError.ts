/** Preserve public provider diagnostics without interpreting them as approval. */
export type ProviderFailure = {
  message: string;
  code?: string;
  /** Older CLI versions sometimes expose only the public diagnostic. */
  codeSource?: "legacy_message";
  /** Local time when this provider rejection was received (epoch milliseconds). */
  occurredAt?: number;
  details?: Record<string, unknown>;
  sessionId?: string | null;
};

export class ProviderError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
    this.name = "ProviderError";
  }
}

export function isSafetyStop(failure: ProviderFailure): boolean {
  return failure.code === "misalignment_policy_violation" || failure.code === "misalignmentPolicyViolation";
}

export function isCyberRejection(failure?: ProviderFailure | null): failure is ProviderFailure & { code: "cyber_policy" } {
  return failure?.code === "cyber_policy";
}

/** A rejection ends that request. Only input authorized by a later human
 * message may continue; old queued messages and their wakes stay blocked,
 * including after a successful follow-up or a bot restart. */
export function assertCyberFollowup(failure: ProviderFailure | null | undefined, userMessageAt?: number): void {
  if (!isCyberRejection(failure)) return;
  if (typeof userMessageAt === "number" && Number.isFinite(userMessageAt) &&
      typeof failure.occurredAt === "number" && Number.isFinite(failure.occurredAt) && userMessageAt > failure.occurredAt) return;
  throw new ProviderError(failure);
}

export function parseProviderError(event: unknown): ProviderFailure | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  if (e.type !== "error" && e.type !== "turn.failed") return null;
  const body = (e.error && typeof e.error === "object" ? e.error : e) as Record<string, unknown>;
  if (typeof body.message !== "string") return null;
  let inner = body;
  try {
    const decoded = JSON.parse(body.message);
    if (decoded && typeof decoded === "object") inner = decoded.error ?? decoded;
  } catch { /* ordinary text */ }
  const rawCode = inner.code ?? inner.codex_error_info ?? inner.codexErrorInfo ?? body.code ?? body.codex_error_info ?? body.codexErrorInfo;
  const code = typeof rawCode === "string" ? rawCode : undefined;
  // Older exec versions omit the typed code. Recognize their exact public
  // safety-stop message; do not classify arbitrary failures as resumable.
  const message = typeof inner.message === "string" ? inner.message : body.message;
  const knownLegacyStop = message.includes("This request was blocked by our safety systems.") && message.includes("Potentially unintended activity");
  const knownLegacyCyber = message.startsWith("This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request.");
  const legacyCode = knownLegacyStop ? "misalignment_policy_violation" : knownLegacyCyber ? "cyber_policy" : undefined;
  const details = inner.misalignment ?? body.misalignment;
  return {
    message,
    code: code ?? legacyCode,
    ...(!code && legacyCode ? { codeSource: "legacy_message" as const } : {}),
    ...(details && typeof details === "object" ? { details: details as Record<string, unknown> } : {}),
  };
}

export function stoppedMessage(sessionId: string | null, failure?: ProviderFailure | null): string {
  const explanation = failure?.details?.detailed_explanation ?? failure?.details?.detailedExplanation;
  return `This conversation is stopped by safety monitoring. Its history and session ID (${sessionId ?? "not yet assigned"}) are preserved. ` +
    (typeof explanation === "string" ? explanation + " " : failure?.message ? `Provider diagnostic: ${failure.message} ` : "No detailed finding was supplied. ") +
    "Wormhole has not retried it. No supported review/continue action is available through this CLI integration.";
}

export function cyberRejectionMessage(sessionId: string | null, failure: ProviderFailure): string {
  return `The provider rejected the request (cyber_policy). That turn has ended; it will not be retried automatically. ` +
    `Your conversation and history (${sessionId ?? "session ID not yet assigned"}) are preserved. ` +
    `Review the provider's diagnostic below, then send a revised request as a new message. ` +
    `Messages queued before the rejection are not submitted. Provider diagnostic: ${failure.message}`;
}
