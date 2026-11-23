/** Preserve public provider diagnostics without interpreting them as approval. */
export type ProviderFailure = {
  message: string;
  code?: string;
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
  const details = inner.misalignment ?? body.misalignment;
  return {
    message,
    code: code ?? (knownLegacyStop ? "misalignment_policy_violation" : undefined),
    ...(details && typeof details === "object" ? { details: details as Record<string, unknown> } : {}),
  };
}

export function stoppedMessage(sessionId: string | null, failure?: ProviderFailure | null): string {
  const explanation = failure?.details?.detailed_explanation ?? failure?.details?.detailedExplanation;
  return `This conversation is stopped by safety monitoring. Its history and session ID (${sessionId ?? "not yet assigned"}) are preserved. ` +
    (typeof explanation === "string" ? explanation + " " : "No detailed finding was supplied. ") +
    "Wormhole has not retried it. No supported review/continue action is available through this CLI integration.";
}
