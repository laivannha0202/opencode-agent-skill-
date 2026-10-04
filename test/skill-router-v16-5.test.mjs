import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { skillRegistry } from "../lib/skill-registry.mjs";
import {
  DEFAULT_ACTIVE_SKILLS,
  SKILL_UTILITY_LIMIT,
  detectIntent,
  detectTaskLanguage,
  normalizeTask,
  rankSkills,
  recordSkillUtility,
  resetSkillUtilityForTests,
  routeSkills,
  skillUtility,
} from "../lib/skill-router.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrix = JSON.parse(readFileSync(path.join(root, "evals", "v16.5-routing-matrix.json"), "utf8"));

test("V16.5 router: the full routing matrix passes", () => {
  resetSkillUtilityForTests();
  const failures = [];
  for (const row of matrix.cases) {
    const result = routeSkills({ task: row.task });
    const activated = new Set(result.activated);
    const missing = (row.expect || []).filter((id) => !activated.has(id));
    const rejected = (row.reject || []).filter((id) => activated.has(id));
    const overBudget = result.activated.length > Number(row.maxActivated || 3);
    if (missing.length || rejected.length || overBudget) {
      failures.push({ id: row.id, activated: result.activated, missing, rejected, overBudget });
    }
  }
  assert.deepEqual(failures, []);
});

test("V16.5 router: selects the right top skill per stack and domain", () => {
  const cases = [
    ["Fix the Next.js app router route handler that returns 500 on POST", "nextjs-engineering"],
    ["NestJS dependency injection fails after upgrading @nestjs/core", "nestjs-engineering"],
    ["React Native Android build fails after upgrading Expo SDK", "react-native-engineering"],
    ["Payment webhook is not idempotent and double-charges on retry", "payment-engineering"],
    ["Database migration locks a large table", "database-engineering"],
    ["Endpoint latency is 900ms; profile the hot path", "performance-engineering"],
    ["Rewrite the installation section of the README", "documentation-engineering"],
    ["A function sometimes returns the wrong value and the failing case is not reproducible", "bug-diagnosis"],
  ];
  for (const [task, expected] of cases) {
    const result = routeSkills({ task });
    assert.ok(result.activated.includes(expected), `${task} -> ${result.activated.join(",")} (missing ${expected})`);
  }
});

test("V16.5 router: never activates an irrelevant skill for a docs-only task", () => {
  const result = routeSkills({ task: "Rewrite the installation section of the README" });
  assert.deepEqual(result.activated, ["documentation-engineering"]);
  const negatives = ["nextjs-engineering", "payment-engineering", "database-engineering", "ui-ux-engineering", "performance-engineering"];
  for (const id of negatives) assert.ok(!result.activated.includes(id), id);
});

test("V16.5 router: default target is 1-3 and every candidate is explained", () => {
  resetSkillUtilityForTests();
  for (const row of matrix.cases) {
    const result = routeSkills({ task: row.task });
    assert.ok(result.requested === DEFAULT_ACTIVE_SKILLS);
    assert.ok(result.considered === skillRegistry().skillCount);
    if (result.expandedReason) {
      assert.equal(result.expandedReason.expanded, true);
      assert.ok(["above-default-cutoff", "composition-with-independent-evidence"].includes(result.expandedReason.reason));
      assert.ok(result.expandedReason.detail);
    }
    for (const candidate of result.candidates) {
      if (candidate.activated) assert.ok(candidate.reasons.length > 0, `${candidate.id} activated without a reason`);
    }
  }
});

test("V16.5 router: Vietnamese, mixed-script and English language classification", () => {
  assert.equal(detectTaskLanguage("Rewrite the installation section of the README"), "en");
  assert.equal(detectTaskLanguage("Sửa lỗi đăng nhập sau khi cập nhật, giúp tôi tìm nguyên nhân"), "vi");
  assert.equal(detectTaskLanguage("Fix lỗi race condition trong payment webhook"), "mixed");

  const vi = routeSkills({ task: "Sửa lỗi đăng nhập bị lỗi sau khi cập nhật, nhanh giúp tôi tìm nguyên nhân" });
  assert.equal(vi.language, "vi");
  assert.ok(vi.activated.includes("bug-diagnosis"), vi.activated.join(","));

  const mixed = routeSkills({ task: "Fix lỗi race condition trong payment webhook" });
  assert.equal(mixed.language, "mixed");
  assert.ok(mixed.activated.includes("payment-engineering"), mixed.activated.join(","));
});

test("V16.5 router: diacritic-insensitive normalization", () => {
  assert.equal(normalizeTask("Sửa Lỗi Đăng Nhập"), "sua loi dang nhap");
});

test("V16.5 router: low-confidence ambiguous task activates nothing and says so", () => {
  const result = routeSkills({ task: "Make it better" });
  assert.equal(result.ambiguous, true);
  assert.equal(result.confidence, "none");
  assert.deepEqual(result.activated, []);
  assert.equal(result.consideredPositive, 0);
});

test("V16.5 router: negative guard suppresses framework skills on a docs task", () => {
  const ranked = rankSkills({ task: "Update the README installation section for Next.js users" });
  const docs = ranked.candidates.find((row) => row.id === "documentation-engineering");
  const nextjs = ranked.candidates.find((row) => row.id === "nextjs-engineering");
  assert.ok(docs.score > nextjs.score);
  assert.ok(nextjs.reasons.some((reason) => reason.signal === "negative-guard" || reason.signal === "exact-intent"));
});

test("V16.5 router: risk-domain intents escalate to the broader review skill", () => {
  const result = routeSkills({ task: "Authorization check lets a normal user read another tenant's records" });
  assert.ok(result.activated.includes("auth-security"));
  assert.ok(result.activated.includes("web-security-review"), result.activated.join(","));
});

test("V16.5 router: intent detection is deterministic and evidence-driven", () => {
  const first = detectIntent("fix the payment webhook idempotency", { repoEvidence: ["prisma/schema.prisma"] });
  const second = detectIntent("fix the payment webhook idempotency", { repoEvidence: ["prisma/schema.prisma"] });
  assert.deepEqual(first, second);
  assert.ok(first.intents.includes("payment-flow"));
  assert.ok(first.intents.includes("idempotency-fix"));
  assert.ok(first.evidenceStacks.includes("database-engineering"));
});

test("V16.5 router: skill utility is NEUTRAL below the sample floor and never deletes a skill", () => {
  resetSkillUtilityForTests();
  const cold = skillUtility("payment-engineering", "bugfix");
  assert.equal(cold.evidence, "NOT_MEASURED");
  assert.equal(cold.verdict, "neutral");

  for (let i = 0; i < SKILL_UTILITY_LIMIT.minSamples - 1; i += 1) {
    recordSkillUtility({ skillId: "payment-engineering", taskClass: "bugfix", useful: true, verifiedContribution: 1, contextCharsLoaded: 2000 });
  }
  assert.equal(skillUtility("payment-engineering", "bugfix").verdict, "neutral", "must stay neutral below the floor");

  recordSkillUtility({ skillId: "payment-engineering", taskClass: "bugfix", useful: true, verifiedContribution: 1, contextCharsLoaded: 2000, verificationContribution: 1 });
  const warm = skillUtility("payment-engineering", "bugfix");
  assert.equal(warm.evidence, "MEASURED");
  assert.equal(warm.samples, SKILL_UTILITY_LIMIT.minSamples);
  assert.equal(warm.deletionAllowed, false);
  assert.equal(warm.safetyPolicyMutable, false);
});

test("V16.5 router: utility below the sample floor cannot change ranking", () => {
  resetSkillUtilityForTests();
  const baseline = routeSkills({ task: "Fix the payment webhook idempotency bug" });
  recordSkillUtility({ skillId: "payment-engineering", taskClass: "bugfix", falseActivation: true, contextCharsLoaded: 9_000 });
  const after = routeSkills({ task: "Fix the payment webhook idempotency bug" });
  assert.deepEqual(after.activated, baseline.activated);
  resetSkillUtilityForTests();
});
