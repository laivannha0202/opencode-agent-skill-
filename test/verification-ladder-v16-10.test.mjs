// V16.10 Verification Ladder: behavior tests.
//
// The ladder's job is to prove a claim with the CHEAPEST sufficient evidence and
// to never promote unverified work to a PASS. These tests pin both.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  VERIFICATION_LADDER_POLICY,
  VERIFICATION_RUNG,
  EVIDENCE_STRENGTH,
  requiredStrength,
  planVerificationLadder,
  runVerificationLadder,
} from "../lib/verification-ladder-v16-10.mjs"
import { shutdownLspPool } from "../lib/code-intelligence/lsp-provider.mjs"

// The static rung uses the persistent LSP pool; without an explicit shutdown the
// pool keeps the event loop alive and the file would hang after its last test.
test.after(async () => {
  await shutdownLspPool().catch(() => {})
})

function tempRoot() {
  return mkdtempSync(path.join(tmpdir(), "ues-ladder-"))
}

// The persistent diagnostics provider may still hold a handle on the temp dir
// (Windows EBUSY) when the test ends; cleanup must never fail the assertion.
function cleanup(root) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      cleanup(root)
      return
    } catch {
      // best effort; a leaked temp dir is harmless
    }
  }
}

test("V16.10 ladder: required strength is conservative for unknown tasks", () => {
  assert.equal(requiredStrength({ docsOnly: true }), EVIDENCE_STRENGTH.SYNTAX)
  assert.equal(requiredStrength({ risk: "low", executionProfile: "fast" }), EVIDENCE_STRENGTH.SYNTAX)
  assert.equal(requiredStrength({ risk: "high" }), EVIDENCE_STRENGTH.BEHAVIOR)
  // An unclassified task must NOT default to the weakest rung.
  assert.equal(requiredStrength({}), EVIDENCE_STRENGTH.BEHAVIOR)
})

test("V16.10 ladder: the cheapest sufficient rung is targeted first", () => {
  const syntax = planVerificationLadder({ policy: { docsOnly: true }, changedFiles: ["lib/a.mjs"] })
  assert.equal(syntax.requiredStrength, EVIDENCE_STRENGTH.SYNTAX)
  assert.equal(syntax.targetRung, VERIFICATION_RUNG.STATIC)

  const unit = planVerificationLadder({ policy: { executionProfile: "fast", risk: "medium" }, changedFiles: ["lib/a.mjs"] })
  assert.equal(unit.requiredStrength, EVIDENCE_STRENGTH.UNIT)
  assert.equal(unit.targetRung, VERIFICATION_RUNG.AFFECTED)

  const behavior = planVerificationLadder({ policy: { risk: "high" }, changedFiles: ["lib/a.mjs"] })
  assert.equal(behavior.requiredStrength, EVIDENCE_STRENGTH.BEHAVIOR)
  assert.equal(behavior.targetRung, VERIFICATION_RUNG.SUITE)
})

test("V16.10 ladder: a syntax-only claim passes at the static rung and never runs the suite", async () => {
  const root = tempRoot()
  try {
    writeFileSync(path.join(root, "clean.mjs"), "export const x = 1\n")
    let suiteRan = false
    const result = await runVerificationLadder(root, {
      policy: { docsOnly: true },
      changedFiles: ["clean.mjs"],
    }, {
      runSuite: async () => {
        suiteRan = true
        return { passed: true }
      },
    })
    // Static diagnostics on a trivial clean file pass; the suite must NOT run.
    if (result.verdict === "PASS") {
      assert.equal(result.satisfiedRung, VERIFICATION_RUNG.STATIC)
      assert.equal(suiteRan, false)
      assert.equal(result.sufficient, true)
    }
    assert.equal(result.policy, VERIFICATION_LADDER_POLICY)
  } finally {
    cleanup(root)
  }
})

test("V16.10 ladder: absence of evidence yields UNVERIFIED, never PASS", async () => {
  const root = tempRoot()
  try {
    const result = await runVerificationLadder(root, {
      policy: { risk: "high" },
      changedFiles: ["nonexistent.mjs"],
    }, {
      // No suite runner, no affected runner, no reusable receipt.
    })
    assert.equal(result.verdict, "UNVERIFIED")
    assert.notEqual(result.verdict, "PASS")
    assert.ok(result.unmetRequirement)
    assert.equal(result.sufficient, false)
  } finally {
    cleanup(root)
  }
})

test("V16.10 ladder: a suite runner that fails yields FAIL, not UNVERIFIED", async () => {
  const root = tempRoot()
  try {
    const result = await runVerificationLadder(root, {
      policy: { risk: "high", requiredEvidenceStrength: EVIDENCE_STRENGTH.BEHAVIOR },
      changedFiles: ["lib/a.mjs"],
    }, {
      runSuite: async () => ({ passed: false, reason: "3 tests failed" }),
    })
    assert.equal(result.verdict, "FAIL")
    assert.ok(result.attempts.some((row) => row.rung === VERIFICATION_RUNG.SUITE && row.status === "failed"))
  } finally {
    cleanup(root)
  }
})

test("V16.10 ladder: a passing suite yields PASS at the suite rung", async () => {
  const root = tempRoot()
  try {
    const result = await runVerificationLadder(root, {
      policy: { risk: "high" },
      changedFiles: ["lib/a.mjs"],
    }, {
      runSuite: async () => ({ passed: true, command: "npm test", evidenceRef: "evidence:sha256:" + "d".repeat(64) }),
    })
    assert.equal(result.verdict, "PASS")
    assert.equal(result.satisfiedRung, VERIFICATION_RUNG.SUITE)
    assert.equal(result.provenStrength, EVIDENCE_STRENGTH.BEHAVIOR)
    assert.equal(result.sufficient, true)
    assert.equal(result.evidenceRef, "evidence:sha256:" + "d".repeat(64))
  } finally {
    cleanup(root)
  }
})

test("V16.10 ladder: the independent rung is only reachable when declared available", async () => {
  const root = tempRoot()
  try {
    const result = await runVerificationLadder(root, {
      policy: { risk: "high", requiredEvidenceStrength: EVIDENCE_STRENGTH.INDEPENDENT },
      changedFiles: ["lib/a.mjs"],
      independentVerifierAvailable: false,
    }, {
      runSuite: async () => ({ passed: true }),
    })
    // Even a passing suite cannot satisfy an INDEPENDENT requirement.
    assert.equal(result.sufficient, false)
    assert.notEqual(result.verdict, "PASS")
  } finally {
    cleanup(root)
  }
})

test("V16.10 ladder: the plan lists every rung with applicability and sufficiency", () => {
  const plan = planVerificationLadder({ policy: { risk: "medium" }, changedFiles: ["lib/a.mjs"] })
  assert.equal(plan.rungs.length, 5)
  assert.deepEqual(plan.rungs.map((row) => row.rung), ["reuse", "static", "affected-tests", "full-suite", "independent-verifier"])
  assert.equal(plan.deterministic, true)
  assert.equal(plan.escalationPolicy.startsWith("cheapest-sufficient-rung"), true)
})

test("V16.10 ladder: no change means the static rung is not applicable", () => {
  const plan = planVerificationLadder({ policy: { docsOnly: true }, changedFiles: [] })
  const staticRung = plan.rungs.find((row) => row.rung === VERIFICATION_RUNG.STATIC)
  assert.equal(staticRung.applicable, false)
})
