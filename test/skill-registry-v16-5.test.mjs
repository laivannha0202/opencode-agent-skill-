import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONTRACT_CHARS,
  MAX_REGISTRY_CHARS,
  buildSkillContract,
  clearSkillRegistryCache,
  skillRegistry,
  skillRegistryDrift,
  skillRegistrySurface,
  validateSkillContract,
} from "../lib/skill-registry.mjs";

test("V16.5 registry: every shipped skill has a compiled contract", () => {
  clearSkillRegistryCache();
  const drift = skillRegistryDrift();
  assert.equal(drift.aligned, true, JSON.stringify(drift));
  assert.equal(skillRegistry().skillCount, 48);
});

test("V16.5 registry: contract compiles from metadata without loading skill bodies", async () => {
  const contract = buildSkillContract("bug-diagnosis");
  assert.equal(contract.id, "bug-diagnosis");
  assert.ok(contract.intents.includes("ambiguous-failure"));
  assert.ok(contract.intents.includes("regression"));
  assert.ok(contract.requiredTools.includes("read"));
  assert.ok(contract.requiredTools.includes("grep"));
  assert.ok(contract.requiredTools.includes("bash"));
  assert.ok(contract.optionalTools.includes("ues_code"));
  assert.ok(contract.forbiddenActions.includes("publish"));
  assert.ok(contract.forbiddenActions.includes("deploy"));
  assert.equal(contract.outputContract, "bug-diagnosis-report-v1");
  assert.equal(contract.sideEffectClass, "none");
  assert.deepEqual(contract.hostSupport, ["pi"]);
  assert.equal(contract.version, 2);
});

test("V16.5 registry: metadata is bounded and cacheable", () => {
  const surface = skillRegistrySurface();
  assert.ok(surface.chars <= MAX_REGISTRY_CHARS, `surface ${surface.chars} > ${MAX_REGISTRY_CHARS}`);
  assert.equal(surface.fullSkillBodiesLoaded, false);
  for (const contract of skillRegistry().contracts) {
    assert.ok(contract.contractChars <= MAX_CONTRACT_CHARS, `${contract.id} over budget`);
  }
  const second = skillRegistrySurface();
  assert.equal(surface.fingerprint, second.fingerprint);
});

test("V16.5 registry: invalid contracts are rejected", () => {
  assert.throws(() => buildSkillContract("does-not-exist"), /unknown skill id/);
  assert.throws(() => buildSkillContract(""), /unknown skill id/);

  const base = buildSkillContract("code-review");
  assert.equal(validateSkillContract(base).ok, true);

  const missingField = { ...base };
  delete missingField.outputContract;
  assert.equal(validateSkillContract(missingField).ok, false);

  const sideEffect = { ...base, sideEffectClass: "writes-files" };
  assert.equal(validateSkillContract(sideEffect).ok, false);

  const drift = { ...base, version: 1 };
  assert.equal(validateSkillContract(drift).ok, false);

  const unknownId = { ...base, id: "invented-skill" };
  assert.equal(validateSkillContract(unknownId).ok, false);

  const oversize = { ...base, intents: Array.from({ length: 400 }, (_, i) => `intent-${i}`) };
  assert.equal(validateSkillContract(oversize).ok, false);
});

test("V16.5 registry: composability is derived, deterministic and excludes self", () => {
  const first = skillRegistry().contracts;
  clearSkillRegistryCache();
  const second = skillRegistry().contracts;
  assert.equal(first.length, second.length);
  for (const contract of first) {
    const match = second.find((row) => row.id === contract.id);
    assert.ok(match, contract.id);
    assert.deepEqual(match.composableWith, contract.composableWith);
    assert.ok(!contract.composableWith.includes(contract.id), `${contract.id} composes with itself`);
  }
});
