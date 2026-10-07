// V16.13 ResearchBrief + admission: deterministic, speed-first.

import test from "node:test";
import assert from "node:assert/strict";

import {
  RESEARCH_BRIEF_POLICY,
  RESEARCH_CLASS,
  RESEARCH_BUDGETS,
  decideResearchAdmission,
  buildResearchBrief,
  briefIdFor,
  isSufficientEvidence,
  shouldCallDeepSeek,
  shouldLaunchBrowser,
  planSafeOverlap,
  RESEARCH_CAPSULE_MAX_CHARS,
} from "../lib/research-brief-v16-13.mjs";

test("brief policy id is byte-stable", () => {
  assert.equal(RESEARCH_BRIEF_POLICY, "research-brief-v16-13");
});

test("trivial local task stays LOCAL_ONLY with zero research budget", () => {
  const admission = decideResearchAdmission({ question: "fix typo in label", trivialLocal: true });
  assert.equal(admission.researchClass, RESEARCH_CLASS.LOCAL_ONLY);
  assert.equal(admission.externalRequired, false);
  const budget = RESEARCH_BUDGETS[RESEARCH_CLASS.LOCAL_ONLY];
  assert.equal(budget.maxQueries, 0);
  assert.equal(budget.maxSources, 0);
});

test("model confidence alone cannot trigger research", () => {
  const admission = decideResearchAdmission({ question: "unsure about code", signals: { modelUncertain: true } });
  assert.equal(admission.researchClass, RESEARCH_CLASS.LOCAL_ONLY);
  assert.match(admission.reason, /confidence/);
});

test("current/version/upstream signals can trigger research", () => {
  assert.equal(decideResearchAdmission({ signals: { versionUncertainty: true } }).researchClass, RESEARCH_CLASS.OFFICIAL_DOC_REQUIRED);
  assert.equal(decideResearchAdmission({ signals: { upstreamIssueLookup: true } }).researchClass, RESEARCH_CLASS.GITHUB_RESEARCH);
  assert.equal(decideResearchAdmission({ signals: { latestRequested: true } }).researchClass, RESEARCH_CLASS.CURRENT_WEB_RESEARCH);
  assert.equal(decideResearchAdmission({ signals: { userRequestedDeepResearch: true } }).researchClass, RESEARCH_CLASS.DEEP_RESEARCH);
});

test("PI_ONLY is always LOCAL_ONLY", () => {
  const admission = decideResearchAdmission({ piOnly: true, signals: { latestRequested: true, upstreamIssueLookup: true } });
  assert.equal(admission.researchClass, RESEARCH_CLASS.LOCAL_ONLY);
});

test("brief ids are stable canonical hashes", () => {
  const a = briefIdFor("q", RESEARCH_CLASS.GITHUB_RESEARCH, "1.0.0");
  const b = briefIdFor("q", RESEARCH_CLASS.GITHUB_RESEARCH, "1.0.0");
  const c = briefIdFor("q2", RESEARCH_CLASS.GITHUB_RESEARCH, "1.0.0");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
});

test("brief carries bounded budgets and stop conditions", () => {
  const brief = buildResearchBrief({ question: "next.js docs?", task: { signals: { versionUncertainty: true } }, runId: "r1" });
  assert.equal(brief.schemaId, "research-brief-v1");
  assert.ok(brief.maxQueries <= 6);
  assert.ok(brief.maxSources <= 8);
  assert.ok(brief.maxDepth <= 2);
  assert.ok(Array.isArray(brief.stopConditions));
});

test("first-sufficient-evidence semantics are deterministic", () => {
  assert.equal(isSufficientEvidence({
    primarySourceObtained: true, importantClaimsSupported: true,
    noUnresolvedContradiction: true, freshnessSatisfied: true, versionMatched: true,
  }), true);
  assert.equal(isSufficientEvidence({ primarySourceObtained: true, importantClaimsSupported: false, noUnresolvedContradiction: true, freshnessSatisfied: true }), false);
});

test("DeepSeek is not default; browser is last resort", () => {
  assert.equal(shouldCallDeepSeek({}), false);
  assert.equal(shouldCallDeepSeek({ unresolvedContradiction: true }), true);
  assert.equal(shouldLaunchBrowser({ question: "docs lookup" }), false);
  assert.equal(shouldLaunchBrowser({ authenticatedSynthesis: true }), true);
  assert.equal(RESEARCH_CAPSULE_MAX_CHARS, 8000);
});

test("source write does not overlap research when barrier required", () => {
  const brief = buildResearchBrief({ question: "x", task: { signals: { versionUncertainty: true } } });
  const blocked = planSafeOverlap(brief, { includesWrite: true, barrierRequired: true });
  assert.equal(blocked.overlapAllowed, false);
  const allowed = planSafeOverlap(brief, { kinds: ["repo-inspection", "cache-lookup"] });
  assert.equal(allowed.overlapAllowed, true);
});
