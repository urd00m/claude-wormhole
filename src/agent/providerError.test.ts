import assert from "node:assert/strict";
import { isSafetyStop, isCyberRejection, assertCyberFollowup, parseProviderError, cyberRejectionMessage } from "./providerError.js";

// Public diagnostic observed in the affected CLI transcript. No API calls.
const diagnostic = "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. If you’re doing authorized security work that requires more cyber permissive safeguards, apply for Daybreak access via https://platform.openai.com/settings/organization/status-and-access before retrying.";

for (const event of [
  { type: "error", message: diagnostic, code: "cyber_policy" },
  { type: "turn.failed", error: { message: diagnostic, codex_error_info: "cyber_policy" } },
  { type: "turn.failed", error: { message: diagnostic, codexErrorInfo: "cyber_policy" } },
  { type: "error", message: JSON.stringify({ error: { message: diagnostic, code: "cyber_policy" } }) },
]) {
  const failure = parseProviderError(event);
  assert(failure && isCyberRejection(failure) && !isSafetyStop(failure));
  assert.equal(failure.code, "cyber_policy");
  assert.equal(failure.message, diagnostic);
  assert.equal(failure.codeSource, undefined, "typed codes must remain authoritative");
}

for (const event of [
  { type: "error", message: diagnostic },
  { type: "turn.failed", error: { message: diagnostic } },
]) {
  const failure = parseProviderError(event);
  assert(failure && isCyberRejection(failure) && !isSafetyStop(failure));
  assert.equal(failure.code, "cyber_policy");
  assert.equal(failure.codeSource, "legacy_message");
  assert.equal(failure.message, diagnostic);
}

// Don't infer a policy stop from generic keywords, a refusal response, or an
// explicit non-policy code, even if the text mentions the known diagnostic.
for (const message of ["temporary network failure", "cyber_policy documentation unavailable", "possible cybersecurity risk"]) {
  assert(!isSafetyStop(parseProviderError({ type: "error", message })!));
}
assert(!isSafetyStop(parseProviderError({ type: "error", code: "server_error", message: diagnostic })!));
assert.equal(parseProviderError({ type: "item.completed", item: { type: "agent_message", text: "I cannot help with that request." } }), null);
assert.equal(parseProviderError({ type: "turn.completed" }), null);
assert.equal(parseProviderError(null), null);

assert(isSafetyStop({ code: "misalignment_policy_violation", message: "stopped" }));
assert(isSafetyStop({ code: "misalignmentPolicyViolation", message: "stopped" }));
const rejection = { code: "cyber_policy", message: diagnostic, occurredAt: 1000 };
for (const timestamp of [undefined, NaN, Infinity, 0, 999, 1000]) {
  assert.throws(() => assertCyberFollowup(rejection, timestamp), "automatic or stale input must not resume a rejected turn");
}
assert.doesNotThrow(() => assertCyberFollowup(rejection, 1001));
assert.throws(() => assertCyberFollowup({ code: "cyber_policy", message: diagnostic }, 1001), "unknown rejection time requires reconciliation");
const rendered = cyberRejectionMessage("original-id", rejection);
assert(rendered.includes("cyber_policy"));
assert(rendered.includes("send a revised request as a new message"));
assert(rendered.includes("original-id"));
assert(rendered.includes(diagnostic), "show the actual provider guidance");
assert(!rendered.includes("No detailed finding was supplied"));
console.log("✅ provider errors verified — typed and legacy cyber failures, diagnostic preservation, local explanation and negative cases");
