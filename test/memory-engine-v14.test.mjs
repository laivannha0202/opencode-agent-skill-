import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { putEvidence } from "../lib/evidence-store.mjs"
import {
  memoryStatus,
  proposeMemory,
  retrieveMemories,
  supersedeMemory,
  verifyMemory,
} from "../lib/memory-engine.mjs"

test("V14 memory retrieves only evidence-verified memories and supports supersession", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-memory-v14-"))
  try {
    const evidence = await putEvidence(root, "checkout inventory test passed", { kind: "test-receipt" })
    const candidate = await proposeMemory(root, {
      type: "procedural",
      scope: "module",
      content: "Checkout inventory reservations must be released when payment verification fails.",
      evidenceRefs: [evidence.ref],
      files: ["apps/api/checkout.mjs"],
      confidence: 0.8,
    })
    assert.deepEqual((await retrieveMemories(root, "checkout inventory", { files: ["apps/api/checkout.mjs"] })).results, [])

    const verified = await verifyMemory(root, candidate.id, {
      verdict: "PASS",
      verifier: "ues-verifier",
      evidenceRefs: [evidence.ref],
      confidence: 0.9,
    })
    assert.equal(verified.status, "verified")
    const retrieved = await retrieveMemories(root, "checkout inventory release", { files: ["apps/api/checkout.mjs"] })
    assert.equal(retrieved.results[0].id, candidate.id)
    assert.ok(retrieved.results[0].retrieval.lexical > 0)

    const replacementEvidence = await putEvidence(root, "new checkout contract passed", { kind: "test-receipt" })
    const replacementCandidate = await proposeMemory(root, {
      type: "procedural",
      scope: "module",
      content: "Checkout reservations are now released by the compensation handler after payment failure.",
      evidenceRefs: [replacementEvidence.ref],
      files: ["apps/api/checkout.mjs"],
      confidence: 0.9,
    })
    const replacement = await verifyMemory(root, replacementCandidate.id, {
      verdict: "PASS",
      verifier: "ues-integration-verifier",
      evidenceRefs: [replacementEvidence.ref],
    })
    await supersedeMemory(root, candidate.id, replacement.id)

    const after = await retrieveMemories(root, "checkout payment compensation", { files: ["apps/api/checkout.mjs"] })
    assert.equal(after.results.some((item) => item.id === candidate.id), false)
    assert.equal(after.results.some((item) => item.id === replacement.id), true)
    assert.equal((await memoryStatus(root)).byStatus.superseded, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V14 memory verification fails closed without durable evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-memory-v14-empty-"))
  try {
    const candidate = await proposeMemory(root, { content: "Never trust an unverified memory." })
    await assert.rejects(
      verifyMemory(root, candidate.id, { verdict: "PASS", verifier: "ues-verifier" }),
      /durable evidence/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V14 memory supports task-class affinity, expiry, and usage accounting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-memory-v14-usage-"))
  try {
    const evidence = await putEvidence(root, "review contract passed", { kind: "test-receipt" })
    const current = await proposeMemory(root, {
      content: "Review checkout changes for idempotency regressions.",
      type: "procedural",
      scope: "module",
      taskClass: "review",
      evidenceRefs: [evidence.ref],
      files: ["src/checkout.mjs"],
    })
    await verifyMemory(root, current.id, {
      verdict: "PASS",
      verifier: "ues-verifier",
      evidenceRefs: [evidence.ref],
    })

    const expired = await proposeMemory(root, {
      content: "Old checkout rule that must no longer be recalled.",
      evidenceRefs: [evidence.ref],
      expiresAt: "2000-01-01T00:00:00.000Z",
    })
    await verifyMemory(root, expired.id, {
      verdict: "PASS",
      verifier: "ues-verifier",
      evidenceRefs: [evidence.ref],
    })

    const result = await retrieveMemories(root, "review checkout idempotency", {
      files: ["src/checkout.mjs"],
      taskClass: "review",
      touch: true,
    })
    assert.equal(result.results[0].id, current.id)
    assert.equal(result.results.some((item) => item.id === expired.id), false)
    assert.equal(result.results[0].retrieval.taskClass, 1)
    const status = await memoryStatus(root)
    assert.equal(status.expired, 1)
    assert.equal(status.used, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
