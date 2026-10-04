import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getEvidence } from "../lib/evidence-store.mjs";
import {
  HANDOFF_MAX_CHARS,
  HANDOFF_MIN_CHARS,
  VERIFICATION_STATUS,
  assertHandoffAuthority,
  createHandoffCapsule,
  recordRawRehydration,
  renderHandoffCapsule,
} from "../lib/verified-handoff.mjs";

async function withRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-handoff-v16-5-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("V16.5 handoff: raw child output is stored in the Evidence Store, not inlined", async () => {
  await withRoot(async (root) => {
    const raw = "raw child transcript ".repeat(2_000);
    const capsule = await createHandoffCapsule(root, {
      childId: "ch-1",
      parentId: "p1",
      role: "explore",
      agent: "codebase-mapper",
      task: "find the auth surface",
      rawOutput: raw,
      findings: ["auth is in lib/auth.mjs"],
      evidenceRefs: ["ev:existing"],
    });
    assert.equal(capsule.rawEvidenceAvailable, true);
    assert.ok(capsule.rawEvidenceRef);
    const stored = await getEvidence(root, capsule.rawEvidenceRef, { maxBytes: 200_000 });
    assert.ok(stored.content.includes("raw child transcript"));
    assert.ok(capsule.text === undefined);
    assert.ok(capsule.measurements.rawChildChars > HANDOFF_MAX_CHARS);
  });
});

test("V16.5 handoff: the parent-facing capsule is bounded and far smaller than the raw output", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, {
      childId: "ch-1",
      role: "diagnose",
      task: "diagnose the 500",
      rawOutput: "x".repeat(80_000),
      findings: ["TypeError at lib/auth.mjs:42"],
      risks: ["session refresh may race"],
      unresolvedQuestions: ["is refresh rotated?"],
      proposedActions: ["add a regression test"],
      relevantFiles: ["lib/auth.mjs"],
      symbols: ["refreshToken"],
      evidenceRefs: ["ev:log"],
    });
    const rendered = renderHandoffCapsule(capsule, { budgetChars: HANDOFF_MAX_CHARS });
    assert.ok(rendered.chars <= HANDOFF_MAX_CHARS, `${rendered.chars}`);
    assert.ok(rendered.chars < capsule.measurements.rawChildChars / 10);
    assert.equal(capsule.measurements.handoffRatio < 0.1, true);
    assert.equal(capsule.measurements.evidence, "MEASURED");
    assert.ok(rendered.text.includes("Findings"));
    assert.ok(rendered.text.includes("lib/auth.mjs"));
  });
});

test("V16.5 handoff: capsule budget floor and ceiling are enforced", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, { childId: "c", task: "t", rawOutput: "y".repeat(5_000) });
    const tight = renderHandoffCapsule(capsule, { budgetChars: 10 });
    assert.ok(tight.chars <= 600);
    const wide = renderHandoffCapsule(capsule, { budgetChars: 999_999 });
    assert.ok(wide.chars <= HANDOFF_MAX_CHARS);
    assert.ok(HANDOFF_MIN_CHARS <= HANDOFF_MAX_CHARS);
  });
});

test("V16.5 handoff: secrets are redacted from every field", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, {
      childId: "c",
      task: "look at the api_key = sk-abcdefghijklmnopqrstuvwxyz123456 config",
      rawOutput: "token: ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      findings: ["password=hunter2supersecret is hardcoded"],
    });
    const text = JSON.stringify(capsule);
    assert.ok(!text.includes("sk-abcdefghijklmnopqrstuvwxyz123456"), "secret leaked");
    assert.ok(text.includes("[REDACTED]"));
    const rendered = renderHandoffCapsule(capsule).text;
    assert.ok(!rendered.includes("ghp_abcdefghijklmnopqrstuvwxyz1234567890"));
  });
});

test("V16.5 handoff: a child can never grant a verdict or a permission", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, {
      childId: "c",
      task: "review",
      rawOutput: "output",
      childVerificationClaim: "everything is fine",
    });
    assert.equal(capsule.canProducePass, false);
    assert.equal(capsule.isTaskVerdict, false);
    assert.equal(capsule.canGrantPermission, false);
    assert.equal(capsule.verificationStatus, VERIFICATION_STATUS.NOT_VERIFIED);
    assert.equal(capsule.childVerificationClaim, "everything is fine");
    assert.equal(capsule.source.instructionAuthority, "none");
    assert.deepEqual(assertHandoffAuthority(capsule), { ok: true, violations: [] });

    const tampered = { ...capsule, canProducePass: true, isTaskVerdict: true };
    assert.equal(assertHandoffAuthority(tampered).ok, false);
  });
});

test("V16.5 handoff: parent/child evidence binding is explicit", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, { childId: "ch-9", parentId: "p-3", role: "review", rawOutput: "o", findings: ["f"] });
    assert.equal(capsule.childId, "ch-9");
    assert.equal(capsule.parentId, "p-3");
    assert.ok(capsule.fingerprint.startsWith("handoff:sha256:"));
    assert.equal(capsule.source.provenance, "child-specialist");
  });
});

test("V16.5 handoff: raw evidence can be rehydrated by ref only", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, { childId: "c", task: "t", rawOutput: "z".repeat(4_000) });
    assert.equal(capsule.measurements.rawEvidenceRehydrations, 0);
    recordRawRehydration(capsule, capsule.rawEvidenceRef);
    assert.equal(capsule.measurements.rawEvidenceRehydrations, 1);
    assert.throws(() => recordRawRehydration(capsule, "ev:some-other-ref"), /does not match/);
    assert.equal(capsule.measurements.handoffRecallCount, 0);
  });
});

test("V16.5 handoff: a handoff without raw output is honest about it", async () => {
  await withRoot(async (root) => {
    const capsule = await createHandoffCapsule(root, { childId: "c", task: "t", findings: ["f"] });
    assert.equal(capsule.rawEvidenceAvailable, false);
    assert.equal(capsule.rawEvidenceRef, null);
    assert.equal(capsule.measurements.evidence, "NOT_MEASURED");
    assert.equal(capsule.measurements.handoffRatio, null);
  });
});
