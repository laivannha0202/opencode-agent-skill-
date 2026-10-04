import assert from "node:assert/strict";
import test from "node:test";
import {
  ADVISOR_AUTHORITY,
  ADVISOR_ROLE_SET,
  ADVISOR_ROLES,
  advisorRoleContract,
  assertAdvisorAuthority,
  buildAdvisorPacket,
  selectAdvisorRole,
} from "../lib/deepseek-advisor-roles.mjs";
import {
  ADVISOR_LEARNER_V2,
  assertLearnerAuthority,
  advisorLearnerV2Report,
  advisorWeightV2,
  gcAdvisorLearnerV2,
  loadAdvisorLearnerV2,
  recordAdvisorOutcomeV2,
  resetAdvisorLearnerV2ForTests,
  saveAdvisorLearnerV2,
} from "../lib/advisor-benefit-learner-v2.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("V16.5 advisor: five specialist question types are available", () => {
  assert.deepEqual([...ADVISOR_ROLE_SET].sort(), ["adversarial-review", "alternative-fix", "architecture", "root-cause", "verifier-failure"]);
  for (const role of ADVISOR_ROLE_SET) {
    const contract = advisorRoleContract(role);
    assert.ok(contract.question.length > 10);
    assert.ok(contract.requiredInputs.length > 0);
    assert.ok(contract.forbid.length > 0);
    assert.ok(contract.expects.length > 0);
  }
});

test("V16.5 advisor: role routing is deterministic and situation-driven", () => {
  assert.equal(selectAdvisorRole({ failedCommand: "npm test" }), ADVISOR_ROLES.VERIFIER_FAILURE);
  assert.equal(selectAdvisorRole({ taskClass: "review", changedDiff: "diff" }), ADVISOR_ROLES.ADVERSARIAL_REVIEW);
  assert.equal(selectAdvisorRole({ taskClass: "planning" }), ADVISOR_ROLES.ARCHITECTURE);
  assert.equal(selectAdvisorRole({ symptoms: ["a"], ambiguity: 3 }), ADVISOR_ROLES.ROOT_CAUSE);
  assert.equal(selectAdvisorRole({ changedDiff: "diff" }), ADVISOR_ROLES.ALTERNATIVE_FIX);
  assert.equal(selectAdvisorRole({}), null);
  assert.equal(selectAdvisorRole({ failedCommand: "npm test" }), ADVISOR_ROLES.VERIFIER_FAILURE);
});

test("V16.5 advisor: each role builds a bounded packet with its required inputs", () => {
  const base = {
    symptoms: ["checkout 500"],
    candidateCauses: ["null token"],
    evidence: ["TypeError at lib/auth.mjs:42"],
    failedAttempts: ["restarted the service"],
    constraints: ["no new deps"],
    affectedModules: ["lib/auth.mjs"],
    alternatives: ["keep the monolith"],
    changedDiff: "diff --git a/lib/auth.mjs b/lib/auth.mjs",
    claimedInvariants: ["unauthorized reads are impossible"],
    failedCommand: "npm test",
    diagnostics: ["0 diagnostics"],
    priorAttempt: "restarted once",
    affectedSurface: "lib/auth.mjs",
  };
  for (const role of ADVISOR_ROLE_SET) {
    const packet = buildAdvisorPacket({ role, ...base, maxChars: 6_000 });
    assert.equal(packet.role, role);
    assert.ok(packet.chars <= 6_000 + 200);
    assert.equal(packet.ready, true, JSON.stringify(packet.missingInputs));
    assert.ok(packet.text.includes("This is consultant input"));
    assert.equal(assertAdvisorAuthority(packet).ok, true);
  }
});

test("V16.5 advisor: a missing required input is reported, not silently dropped", () => {
  const packet = buildAdvisorPacket({ role: ADVISOR_ROLES.ROOT_CAUSE, symptoms: ["a"] });
  assert.equal(packet.ready, false);
  assert.ok(packet.missingInputs.includes("candidateCauses"));
  assert.ok(packet.missingInputs.includes("evidence"));
});

test("V16.5 advisor: the adversarial review refuses redesign", () => {
  const packet = buildAdvisorPacket({ role: ADVISOR_ROLES.ADVERSARIAL_REVIEW, changedDiff: "d", evidence: ["test passes"] });
  assert.ok(packet.text.includes("Do not redesign"));
  assert.ok(packet.text.includes("strongest reason this patch could still be wrong"));
  assert.ok(packet.forbid.join(" ").includes("redesign"));
});

test("V16.5 advisor: the verifier-failure packet asks for a discriminating check, not a retry", () => {
  const packet = buildAdvisorPacket({ role: ADVISOR_ROLES.VERIFIER_FAILURE, failedCommand: "npm test", changedDiff: "d", diagnostics: ["none"], priorAttempt: "restarted" });
  assert.ok(packet.text.includes("next discriminating check"));
  assert.ok(packet.forbid.join(" ").includes("retrying the same command"));
  assert.ok(packet.forbid.join(" ").includes("proposing to disable the check"));
});

test("V16.5 advisor: packets stay bounded even with oversized inputs", () => {
  const packet = buildAdvisorPacket({
    role: ADVISOR_ROLES.ARCHITECTURE,
    constraints: ["c".repeat(50_000)],
    affectedModules: Array.from({ length: 500 }, (_, i) => `module-${i}`),
    alternatives: ["a".repeat(20_000)],
    maxChars: 4_000,
  });
  assert.ok(packet.chars <= 4_200, `${packet.chars}`);
  assert.ok(packet.sections.every((section) => section.lines <= 8));
});

test("V16.5 advisor: advisor is consultant-only with no PASS authority", () => {
  assert.equal(ADVISOR_AUTHORITY.consultantOnly, true);
  assert.equal(ADVISOR_AUTHORITY.canProducePass, false);
  assert.equal(ADVISOR_AUTHORITY.isTaskVerdict, false);
  assert.equal(ADVISOR_AUTHORITY.hasFilesystem, false);
  assert.equal(ADVISOR_AUTHORITY.hasGit, false);
  assert.equal(ADVISOR_AUTHORITY.hasTerminal, false);
  assert.equal(ADVISOR_AUTHORITY.receivesSecrets, false);
  assert.throws(() => buildAdvisorPacket({ role: "invented-role" }), /unknown advisor role/);
});

test("V16.5 learner: cold start is NEUTRAL and stays NEUTRAL below the sample floor", () => {
  resetAdvisorLearnerV2ForTests();
  assert.equal(advisorWeightV2({ taskClass: "bugfix", provider: "deepseek-web", model: "ds", advisorRole: "root-cause" }).weight, "neutral");
  for (let i = 0; i < ADVISOR_LEARNER_V2.minSamples - 1; i += 1) {
    recordAdvisorOutcomeV2({ taskClass: "bugfix", provider: "deepseek-web", model: "ds", advisorRole: "root-cause", consulted: true, finalVerifiedResult: true });
  }
  const cold = advisorWeightV2({ taskClass: "bugfix", provider: "deepseek-web", model: "ds", advisorRole: "root-cause" });
  assert.equal(cold.weight, "neutral");
  assert.equal(cold.reason, "insufficient-data");
});

test("V16.5 learner: only moves the AUTO consult weight, with hysteresis", () => {
  resetAdvisorLearnerV2ForTests();
  const scope = { taskClass: "bugfix", provider: "deepseek-web", model: "ds", advisorRole: "root-cause" };
  for (let i = 0; i < 10; i += 1) {
    recordAdvisorOutcomeV2({ ...scope, consulted: true, adviceAccepted: true, finalVerifiedResult: true, verifierAttemptsBefore: 3, verifierAttemptsAfter: 1, wallTimeDeltaMs: 120, toolCallDelta: -2, followUps: 1, fallbacks: 0 });
  }
  const beneficial = advisorWeightV2(scope);
  assert.equal(beneficial.weight, "consult");
  assert.equal(beneficial.reason, "historically-beneficial");
  assert.equal(assertLearnerAuthority(beneficial).ok, true);
  assert.equal(beneficial.effect, "auto-consult-weight-only");

  for (let i = 0; i < 10; i += 1) {
    recordAdvisorOutcomeV2({ ...scope, taskClass: "other", consulted: true, adviceAccepted: false, finalVerifiedResult: false });
  }
  const harmful = advisorWeightV2({ ...scope, taskClass: "other" });
  assert.equal(harmful.weight, "local");
  resetAdvisorLearnerV2ForTests();
});

test("V16.5 learner: provider and model are scoped", () => {
  resetAdvisorLearnerV2ForTests();
  for (let i = 0; i < 10; i += 1) {
    recordAdvisorOutcomeV2({ taskClass: "bugfix", provider: "deepseek-web", model: "model-a", advisorRole: "root-cause", consulted: true, finalVerifiedResult: true });
  }
  assert.equal(advisorWeightV2({ taskClass: "bugfix", provider: "deepseek-web", model: "model-a", advisorRole: "root-cause" }).weight, "consult");
  assert.equal(advisorWeightV2({ taskClass: "bugfix", provider: "deepseek-web", model: "model-b", advisorRole: "root-cause" }).weight, "neutral");
  assert.equal(advisorWeightV2({ taskClass: "bugfix", provider: "other", model: "model-a", advisorRole: "root-cause" }).weight, "neutral");
  resetAdvisorLearnerV2ForTests();
});

test("V16.5 learner: bounded GC removes stale rows and never goes negative", () => {
  resetAdvisorLearnerV2ForTests();
  for (let i = 0; i < 12; i += 1) recordAdvisorOutcomeV2({ taskClass: `t${i}` });
  assert.equal(advisorLearnerV2Report().keys, 12);
  const gc = gcAdvisorLearnerV2({ now: Date.now() + 60 * 24 * 60 * 60 * 1000 });
  assert.equal(gc.removed, 12);
  assert.equal(gc.remaining, 0);
  assert.equal(advisorLearnerV2Report().keys, 0);
  resetAdvisorLearnerV2ForTests();
});

test("V16.5 learner: state persists within a bounded size", async () => {
  resetAdvisorLearnerV2ForTests();
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-learner-v16-5-"));
  try {
    for (let i = 0; i < 5; i += 1) recordAdvisorOutcomeV2({ taskClass: `t${i}`, consulted: true });
    const saved = await saveAdvisorLearnerV2(root);
    assert.equal(saved.saved, true);
    resetAdvisorLearnerV2ForTests();
    const loaded = await loadAdvisorLearnerV2(root);
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.rows, 5);
    const overflow = await saveAdvisorLearnerV2(root, { maxBytes: 10 });
    assert.equal(overflow.saved, false);
    assert.equal(overflow.reason, "state-too-large");
  } finally {
    await rm(root, { recursive: true, force: true });
    resetAdvisorLearnerV2ForTests();
  }
});

test("V16.5 learner: report exposes observed fields and forbidden effects", () => {
  resetAdvisorLearnerV2ForTests();
  recordAdvisorOutcomeV2({ taskClass: "bugfix", consulted: true, adviceAccepted: true, finalVerifiedResult: true, providerTokens: 1234 });
  const report = advisorLearnerV2Report();
  assert.ok(report.observedFields.includes("providerTokens"));
  assert.ok(report.forbiddenEffects.includes("disable-verifier"));
  assert.ok(report.forbiddenEffects.includes("produce-pass"));
  assert.equal(report.rows[0].providerTokenSamples, 1);
  resetAdvisorLearnerV2ForTests();
});
