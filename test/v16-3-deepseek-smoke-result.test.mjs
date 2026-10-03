// V16.3 DeepSeek smoke result semantics: integration PASS vs advice acceptance.
//
// The live bridge succeeded end-to-end and the local verifier rejected the
// advice. That is a safe system outcome, not an integration failure. PASS
// means the bridge operated (session/fill/submit/extract/parse/verifier/
// cleanup); adviceAccepted reports the verifier verdict separately.
//
// Deterministic. No browser, no network, no live consultation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeIntegrationChecks,
  didLocalVerifierRun,
  evaluateDeepSeekSmokeResult,
  safeVerificationSummary,
} from "../lib/deepseek-smoke-result.mjs";
import { advisorTextFor } from "../lib/web-reasoning-lane.mjs";
import { verifyLocalAdvice } from "../lib/deepseek-response.mjs";
import { classifyBrowserAction } from "../lib/browser-action-taxonomy.mjs";
import { createSubmitGuard } from "../lib/browser-execution.mjs";
import { classifyDeepSeekSmokeStatus, DEEPSEEK_WEB_FAILURE } from "../lib/deepseek-web-adapter.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function acceptedResult() {
  return {
    outcome: "advised",
    advice: { summary: "betaJoin is responsible", confidence: 0.85 },
    verification: { accepted: true, rejectionCount: 0, rejections: [], confirmations: [{ claim: "lib/synthetic/beta.mjs", path: "lib/synthetic/beta.mjs", status: "present" }] },
    flagged: false,
    authorityAttempts: [],
  };
}

function rejectedResult() {
  return {
    outcome: "advice-rejected",
    advice: { summary: "betaJoin is responsible", confidence: 0.85 },
    verification: {
      accepted: false,
      rejectionCount: 1,
      rejections: [{ claim: "synthetic.test.mjs", path: "synthetic.test.mjs", status: "absent", rejection: "referenced-file-not-in-repository" }],
      confirmations: [{ claim: "lib/synthetic/beta.mjs", path: "lib/synthetic/beta.mjs", status: "present" }],
    },
    flagged: false,
    authorityAttempts: [],
  };
}

function goodTelemetry() {
  return { webReasoningEscalations: 1, webReasoningCalls: 1 };
}

function goodCounters() {
  return { fillAttempts: 1, submitAttempts: 1, snapshotAttempts: 12 };
}

// 1. advice-accepted + all integration checks => PASS
test("V16.3 smoke-result 1 accepted advice with full integration is PASS", () => {
  const evaluated = evaluateDeepSeekSmokeResult({ result: acceptedResult(), telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "PASS");
  assert.equal(evaluated.integrationVerified, true);
  assert.equal(evaluated.adviceAccepted, true);
  assert.equal(evaluated.consultationCompleted, true);
  assert.equal(evaluated.responseParsed, true);
  assert.deepEqual(evaluated.failedChecks, []);
});

// 2. advice-rejected + all integration checks => PASS with adviceAccepted=false
test("V16.3 smoke-result 2 rejected advice with full integration is PASS", () => {
  const evaluated = evaluateDeepSeekSmokeResult({ result: rejectedResult(), telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "PASS", "a local rejection is a safe outcome, not an integration failure");
  assert.equal(evaluated.integrationVerified, true);
  assert.equal(evaluated.adviceAccepted, false);
  assert.equal(evaluated.consultationCompleted, true);
  assert.equal(evaluated.localVerifierRan, true);
});

// 3. rejected advice produces advisorText=null
test("V16.3 smoke-result 3 rejected advice never produces advisorText", () => {
  assert.equal(advisorTextFor({ outcome: "advice-rejected", advice: { summary: "x" } }), null);
  assert.equal(advisorTextFor({ outcome: "advice-accepted", advice: null }), null);
  const ok = advisorTextFor({ outcome: "advice-accepted", advice: { summary: "s", hypotheses: [], recommendedApproach: [], filesToInspect: [], risks: [], verificationSuggestions: [], confidence: 0.5 } });
  assert.ok(typeof ok === "string" && ok.includes("ADVISORY EVIDENCE ONLY"));
});

// 4. response parser failure => FAIL
test("V16.3 smoke-result 4 parser failure is FAIL", () => {
  const result = { outcome: "fallback-local", reason: "deepseek-response-not-json", advice: null, verification: null };
  const evaluated = evaluateDeepSeekSmokeResult({ result, telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "FAIL");
  assert.equal(evaluated.responseParsed, false);
  assert.equal(evaluated.consultationCompleted, false);
});

// 5. answer timeout => FAIL
test("V16.3 smoke-result 5 answer timeout is FAIL", () => {
  const result = { outcome: "unavailable", reason: "deepseek-response-timeout:answer-wait", advice: null, verification: null, code: "web-reasoning-unavailable" };
  const evaluated = evaluateDeepSeekSmokeResult({ result, telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "FAIL");
  assert.equal(classifyDeepSeekSmokeStatus(result), "TIMEOUT");
});

// 6. UI_CHANGED => FAIL
test("V16.3 smoke-result 6 UI_CHANGED is FAIL", () => {
  const result = { outcome: "unavailable", reason: "deepseek-ui-selector-changed:answer-wait", advice: null, verification: null, code: "web-reasoning-unavailable" };
  assert.equal(classifyDeepSeekSmokeStatus(result), "UI_CHANGED");
  const evaluated = evaluateDeepSeekSmokeResult({ result, telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "FAIL");
});

// 7. auth required => NEEDS_AUTH
test("V16.3 smoke-result 7 auth required maps to NEEDS_AUTH", () => {
  assert.equal(classifyDeepSeekSmokeStatus({ outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }), "NEEDS_AUTH");
  const result = { outcome: "unavailable", reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED, advice: null, verification: null, code: "web-reasoning-unavailable" };
  const evaluated = evaluateDeepSeekSmokeResult({ result, telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "FAIL", "auth never reaches the advised/rejected branch");
});

// 8. duplicate submit => FAIL
test("V16.3 smoke-result 8 duplicate submit stays refused and is FAIL", () => {
  const guard = createSubmitGuard();
  const taxonomy = { actionClass: "external-side-effect", action: "click" };
  const first = guard.check({ sessionId: "s", taxonomy, locatorFingerprint: "fp", beforeUrl: "u", idempotencyKey: "k", now: 1 });
  assert.equal(first.allowed, true);
  const replay = guard.check({ sessionId: "s", taxonomy, locatorFingerprint: "fp", beforeUrl: "u", idempotencyKey: "k", now: 2 });
  assert.equal(replay.allowed, false);
  assert.equal(replay.reason, "duplicate-submit-refused");
  const result = { outcome: "unavailable", reason: "duplicate-submit-refused", advice: null, verification: null, code: "web-reasoning-unavailable" };
  const evaluated = evaluateDeepSeekSmokeResult({ result, telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "FAIL");
});

// 9. localVerifierRan must be true for integration PASS
test("V16.3 smoke-result 9 verifier must have run for integration PASS", () => {
  const noVerification = { outcome: "advised", advice: { summary: "s", confidence: 0.9 }, verification: null };
  assert.equal(didLocalVerifierRun(noVerification), false);
  const evaluated = evaluateDeepSeekSmokeResult({ result: noVerification, telemetry: goodTelemetry(), counters: goodCounters() });
  assert.equal(evaluated.status, "FAIL");
  assert.ok(evaluated.failedChecks.includes("localVerifierRan"));
  assert.equal(didLocalVerifierRun(rejectedResult()), true);
});

// 10. verification rejection reason appears in safe summary
test("V16.3 smoke-result 10 rejection reason appears bounded in safe summary", () => {
  const summary = safeVerificationSummary(rejectedResult().verification, ["lib/synthetic/alpha.mjs", "lib/synthetic/beta.mjs"]);
  assert.equal(summary.verificationAccepted, false);
  assert.equal(summary.verificationRejectionCount, 1);
  assert.equal(summary.verificationConfirmations, 1);
  assert.equal(summary.verificationRejections.length, 1);
  assert.equal(summary.verificationRejections[0].rejection, "referenced-file-not-in-repository");
  assert.equal(summary.verificationRejections[0].status, "absent");
  assert.equal(summary.verificationRejections[0].path, "synthetic.test.mjs");
});

// 11. raw DeepSeek prose is not printed in rejection summary
test("V16.3 smoke-result 11 safe summary never carries raw prose", async () => {
  const prose = "betaJoin concatenates without spaces and this is the secret detail hunter2";
  const verification = {
    accepted: false,
    rejectionCount: 1,
    rejections: [{ claim: prose, path: "synthetic.test.mjs", status: "absent", rejection: "referenced-file-not-in-repository", summary: prose }],
    confirmations: [],
  };
  const summary = safeVerificationSummary(verification, []);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("hunter2"), "prose must not survive");
  assert.ok(!serialized.includes("concatenates without spaces"), "prose must not survive");
  assert.ok(!("summary" in summary) && !("hypotheses" in summary), "no prose keys");
  // Non-repo paths are withheld, not printed raw.
  const nasty = safeVerificationSummary({ accepted: false, rejectionCount: 1, rejections: [{ rejection: "x", status: "absent", path: "/etc/passwd" }], confirmations: [] }, []);
  assert.equal(nasty.verificationRejections[0].path, "[withheld-non-repo-path]");
});

// 12. runtime verifyLocalAdvice logic unchanged
test("V16.3 smoke-result 12 runtime verifier logic unchanged", () => {
  const present = verifyLocalAdvice({
    advice: { summary: "s", hypotheses: [], recommendedApproach: ["do x"], filesToInspect: ["lib/synthetic/beta.mjs"], risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.8, evidenceBinding: { claims: [{ claim: "lib/synthetic/beta.mjs", path: "lib/synthetic/beta.mjs", status: "present", reason: "exists-in-repository" }] } },
    evidenceBinding: { claims: [{ claim: "lib/synthetic/beta.mjs", path: "lib/synthetic/beta.mjs", status: "present", reason: "exists-in-repository" }] },
  }, {});
  assert.equal(present.accepted, true);
  assert.equal(present.actionAuthorized, "implement-then-verify");
  const absent = verifyLocalAdvice({
    advice: { summary: "s", hypotheses: [], recommendedApproach: ["do x"], filesToInspect: ["nope.mjs"], risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.8, evidenceBinding: { claims: [{ claim: "nope.mjs", path: "nope.mjs", status: "absent", reason: "not-found-in-repository" }] } },
    evidenceBinding: { claims: [{ claim: "nope.mjs", path: "nope.mjs", status: "absent", reason: "not-found-in-repository" }] },
  }, {});
  assert.equal(absent.accepted, false);
  assert.ok(absent.rejections.some((r) => r.rejection === "referenced-file-not-in-repository"));
  assert.equal(absent.isTaskVerdict, false);
  assert.equal(absent.canProducePass, false);
});

// 13. advisor acceptance threshold unchanged
test("V16.3 smoke-result 13 acceptance threshold unchanged (0.3, unflagged, no rejections)", () => {
  const low = verifyLocalAdvice({
    advice: { summary: "s", hypotheses: [], recommendedApproach: ["do x"], filesToInspect: ["a.mjs"], risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.29, evidenceBinding: { claims: [{ claim: "a.mjs", path: "a.mjs", status: "present", reason: "exists-in-repository" }] } },
    evidenceBinding: { claims: [{ claim: "a.mjs", path: "a.mjs", status: "present", reason: "exists-in-repository" }] },
  }, {});
  assert.equal(low.accepted, false, "confidence below 0.3 must reject");
  const flagged = verifyLocalAdvice({
    advice: { summary: "s", hypotheses: [], recommendedApproach: ["do x"], filesToInspect: ["a.mjs"], risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.9, flagged: true, evidenceBinding: { claims: [{ claim: "a.mjs", path: "a.mjs", status: "present", reason: "exists-in-repository" }] } },
    flagged: true,
    evidenceBinding: { claims: [{ claim: "a.mjs", path: "a.mjs", status: "present", reason: "exists-in-repository" }] },
  }, {});
  assert.equal(flagged.accepted, false, "flagged advice must reject");
});

// 14. rejected advice can never authorize action
test("V16.3 smoke-result 14 rejected advice authorizes only reject-and-retry", () => {
  const v = verifyLocalAdvice({
    advice: { summary: "s", hypotheses: [], recommendedApproach: ["do x"], filesToInspect: ["nope.mjs"], risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.9, evidenceBinding: { claims: [{ claim: "nope.mjs", path: "nope.mjs", status: "absent", reason: "not-found-in-repository" }] } },
    evidenceBinding: { claims: [{ claim: "nope.mjs", path: "nope.mjs", status: "absent", reason: "not-found-in-repository" }] },
  }, {});
  assert.equal(v.accepted, false);
  assert.equal(v.actionAuthorized, "reject-and-retry-locally");
  assert.equal(v.isTaskVerdict, false);
  assert.equal(v.canProducePass, false);
  assert.equal(advisorTextFor({ outcome: "advice-rejected", advice: { summary: "s" } }), null);
});

// 15. fillAttempts exactly 1
test("V16.3 smoke-result 15 integration requires fillAttempts exactly 1", () => {
  const base = { result: acceptedResult(), telemetry: goodTelemetry(), cleanupRan: true };
  assert.equal(computeIntegrationChecks({ ...base, counters: { fillAttempts: 1, submitAttempts: 1 } }).promptFilled, true);
  assert.equal(computeIntegrationChecks({ ...base, counters: { fillAttempts: 0, submitAttempts: 1 } }).promptFilled, false);
  assert.equal(computeIntegrationChecks({ ...base, counters: { fillAttempts: 2, submitAttempts: 1 } }).promptFilled, false);
  assert.equal(evaluateDeepSeekSmokeResult({ ...base, counters: { fillAttempts: 0, submitAttempts: 1 } }).status, "FAIL");
});

// 16. submitAttempts exactly 1
test("V16.3 smoke-result 16 integration requires submitAttempts exactly 1", () => {
  const base = { result: acceptedResult(), telemetry: goodTelemetry(), cleanupRan: true };
  assert.equal(computeIntegrationChecks({ ...base, counters: { fillAttempts: 1, submitAttempts: 1 } }).promptSubmitted, true);
  assert.equal(evaluateDeepSeekSmokeResult({ ...base, counters: { fillAttempts: 1, submitAttempts: 0 } }).status, "FAIL");
  assert.equal(evaluateDeepSeekSmokeResult({ ...base, counters: { fillAttempts: 1, submitAttempts: 2 } }).status, "FAIL");
});

// 17. external-side-effect retry remains 0
test("V16.3 smoke-result 17 external-side-effect retry remains 0", () => {
  const click = classifyBrowserAction({ action: "click", provenExternalSideEffect: true });
  assert.equal(click.retryAllowed, false);
  assert.equal(click.maxRetries, 0);
  assert.equal(click.requiresExplicitApproval, true);
});

// Smoke wiring: PASS prints integration + acceptance + bounded verification
test("V16.3 smoke-result 18 live smoke wiring exposes new fields", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8");
  for (const field of ["integrationVerified", "adviceAccepted", "consultationCompleted", "responseParsed", "localVerifierRan", "verificationAccepted", "verificationRejectionCount", "verificationRejections", "evaluateDeepSeekSmokeResult", "safeVerificationSummary"]) {
    assert.ok(smoke.includes(field), `smoke must expose ${field}`);
  }
  const start = smoke.indexOf("// ---- --live:");
  const block = smoke.slice(start);
  const codeOnly = block.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.ok(!/promptInserted\s*:/.test(codeOnly), "old misleading check stays removed");
  // Outcome duality lives single-sourced in the helper; smoke branches on it.
  const helper = await readFile(path.join(root, "lib", "deepseek-smoke-result.mjs"), "utf8");
  assert.ok(helper.includes('"advised"') && helper.includes('"advice-rejected"'), "helper must accept both advised and advice-rejected");
  assert.ok(codeOnly.includes("evaluated.status"), "smoke must branch on evaluated integration status");
});
