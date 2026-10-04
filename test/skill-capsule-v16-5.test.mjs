import assert from "node:assert/strict";
import test from "node:test";
import { skillRegistry } from "../lib/skill-registry.mjs";
import {
  DEFAULT_CAPSULE_CHARS,
  MAX_CAPSULE_CHARS,
  clearSkillCapsuleCache,
  compileSkillCapsule,
  expandSkillCapsule,
  parseSkillSource,
} from "../lib/skill-capsule.mjs";

const TASK = "Fix payment authorization bug in the Next.js checkout";

test("V16.5 capsule: composes several skills into one bounded block", async () => {
  clearSkillCapsuleCache();
  const capsule = await compileSkillCapsule({
    skillIds: ["payment-engineering", "auth-security", "nextjs-engineering"],
    taskContract: "Fix the checkout 500 without weakening authorization.",
    budgetChars: DEFAULT_CAPSULE_CHARS,
    skillsConsidered: skillRegistry().skillCount,
  });
  assert.equal(capsule.schemaVersion, 1);
  assert.ok(capsule.chars > 0);
  assert.ok(capsule.chars <= DEFAULT_CAPSULE_CHARS + 800, `capsule ${capsule.chars} over budget`);
  assert.ok(capsule.text.includes("## Task contract"));
  assert.ok(capsule.text.includes("### Required constraints (never relaxed)"));
});

test("V16.5 capsule: required constraints survive a tiny budget", async () => {
  clearSkillCapsuleCache();
  const full = await compileSkillCapsule({ skillIds: ["auth-security"], budgetChars: MAX_CAPSULE_CHARS });
  const tight = await compileSkillCapsule({ skillIds: ["auth-security"], budgetChars: 700 });
  assert.ok(tight.constraintCount > 0, "constraints must survive a small budget");
  for (const constraint of full.text.split("\n").filter((line) => line.startsWith("- [auth-security]")).slice(0, tight.constraintCount)) {
    assert.ok(tight.text.includes(constraint), `dropped constraint: ${constraint.slice(0, 60)}`);
  }
});

test("V16.5 capsule: ordering is deterministic and cache fingerprint is stable", async () => {
  clearSkillCapsuleCache();
  const input = { skillIds: ["bug-diagnosis", "test-verification"], taskContract: "Find the regression.", budgetChars: 2_400 };
  const first = await compileSkillCapsule(input);
  const second = await compileSkillCapsule(input);
  assert.equal(first.text, second.text);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(second.cacheHit, true);

  clearSkillCapsuleCache();
  const third = await compileSkillCapsule(input);
  assert.equal(third.text, first.text);
  assert.equal(third.cacheHit, false);
  assert.equal(third.fingerprint, first.fingerprint);
});

test("V16.5 capsule: never loads more skill body than the budget allows", async () => {
  clearSkillCapsuleCache();
  const ids = skillRegistry().contracts.map((contract) => contract.id);
  const capsule = await compileSkillCapsule({ skillIds: ids, budgetChars: DEFAULT_CAPSULE_CHARS });
  assert.ok(capsule.rawSkillChars > capsule.chars * 2, "expected the capsule to be far smaller than 48 full skills");
  assert.ok(capsule.telemetry.rawSkillCharsAvoided > 0);
  assert.equal(capsule.telemetry.evidence, "MEASURED");
  assert.ok(capsule.chars <= DEFAULT_CAPSULE_CHARS + 800);
});

test("V16.5 capsule: provenance records the source skill and heading for every section", async () => {
  clearSkillCapsuleCache();
  const capsule = await compileSkillCapsule({ skillIds: ["payment-engineering", "auth-security"], budgetChars: 3_000 });
  assert.ok(capsule.provenance.length > 0);
  for (const row of capsule.provenance) {
    assert.ok(row.skillId);
    assert.ok(row.heading);
    assert.ok(Number.isInteger(row.lineStart) && row.lineStart > 0);
  }
  const declared = new Set(capsule.provenance.map((row) => row.skillId));
  assert.deepEqual([...declared].sort(), ["auth-security", "payment-engineering"]);
});

test("V16.5 capsule: expandable back to full source on explicit request", async () => {
  clearSkillCapsuleCache();
  const skillIds = ["payment-engineering", "auth-security", "nextjs-engineering", "bug-diagnosis"];
  const capsule = await compileSkillCapsule({ skillIds, budgetChars: 1_200 });
  const expanded = await expandSkillCapsule({ skillIds, maxChars: 12_000 });
  assert.equal(expanded.expanded, true);
  assert.ok(expanded.chars > capsule.chars, `expanded ${expanded.chars} vs capsule ${capsule.chars}`);
  assert.ok(expanded.text.includes("payment-engineering ::"));
  assert.ok(expanded.fingerprint.startsWith("skill-capsule-expand:sha256:"));
});

test("V16.5 capsule: telemetry exposes measured chars only", async () => {
  clearSkillCapsuleCache();
  const capsule = await compileSkillCapsule({ skillIds: ["bug-diagnosis"], skillsConsidered: 48 });
  assert.equal(capsule.telemetry.skillsConsidered, 48);
  assert.equal(capsule.telemetry.skillsActivated, 1);
  assert.ok(capsule.telemetry.skillCapsuleChars > 0);
  assert.ok(capsule.telemetry.rawSkillCharsAvoided >= 0);
  assert.equal(capsule.telemetry.skillCacheHit, false);
  // No provider-token claim is ever invented from a character count.
  assert.equal(capsule.telemetry.providerTokens, undefined);
});

test("V16.5 capsule: source parsing classifies constraint/procedure/reference sections", () => {
  const parsed = parseSkillSource([
    "---",
    "name: demo",
    "---",
    "",
    "# Demo",
    "",
    "Intro line.",
    "",
    "## Safety rules",
    "",
    "Never mutate the workspace outside the sandbox.",
    "",
    "## Steps",
    "",
    "1. Reproduce the failure.",
    "",
    "## API reference",
    "",
    "- option: value",
  ].join("\n"));
  const kinds = parsed.sections.map((section) => section.kind);
  assert.ok(kinds.includes("constraints"));
  assert.ok(kinds.includes("procedure"));
  assert.ok(kinds.includes("reference"));
});

test("V16.5 capsule: unknown skill ids are dropped rather than trusted", async () => {
  clearSkillCapsuleCache();
  const capsule = await compileSkillCapsule({ skillIds: ["auth-security", "totally-invented"] });
  assert.deepEqual(capsule.skillsActivated, ["auth-security"]);
});
