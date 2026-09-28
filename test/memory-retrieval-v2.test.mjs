import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { putEvidence } from "../lib/evidence-store.mjs"
import { proposeMemory, retrieveMemories, verifyMemory } from "../lib/memory-engine.mjs"

async function verified(root, input, evidenceText) {
  const evidence = await putEvidence(root, evidenceText, { kind: "memory-v2-test" })
  const candidate = await proposeMemory(root, { ...input, evidenceRefs: [evidence.ref] })
  return verifyMemory(root, candidate.id, {
    verdict: "PASS",
    verifier: "memory-v2-test-verifier",
    evidenceRefs: [evidence.ref],
  })
}

test("Memory Retrieval V2 enforces file scope when query files are known", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-memory-v2-scope-"))
  try {
    const target = await verified(root, {
      type: "procedural",
      scope: "file",
      content: "Retry checkout only after payment verification fails.",
      files: ["src/checkout-a.mjs"],
    }, "target verified")
    const unrelated = await verified(root, {
      type: "procedural",
      scope: "file",
      content: "Retry checkout only after payment verification fails.",
      files: ["src/checkout-b.mjs"],
    }, "unrelated verified")

    const result = await retrieveMemories(root, "retry checkout payment", {
      files: ["src/checkout-a.mjs"],
    })
    assert.equal(result.retrievalVersion, 2)
    assert.equal(result.results.some((item) => item.id === target.id), true)
    assert.equal(result.results.some((item) => item.id === unrelated.id), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Memory Retrieval V2 ranks real local-import dependency neighbors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-memory-v2-deps-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "entry.mjs"), 'import { helper } from "./helper.mjs"\nexport const value = helper()\n')
    await writeFile(path.join(root, "src", "helper.mjs"), "export const helper = () => 1\n")
    await writeFile(path.join(root, "src", "unrelated.mjs"), "export const unrelated = () => 2\n")

    const dependency = await verified(root, {
      type: "semantic",
      scope: "project",
      content: "Helper behavior requires verified fallback semantics.",
      files: ["src/helper.mjs"],
    }, "helper verified")
    await verified(root, {
      type: "semantic",
      scope: "project",
      content: "Helper behavior requires verified fallback semantics.",
      files: ["src/unrelated.mjs"],
    }, "unrelated verified")

    const result = await retrieveMemories(root, "helper behavior fallback", {
      files: ["src/entry.mjs"],
      limit: 5,
    })
    const found = result.results.find((item) => item.id === dependency.id)
    assert.ok(found)
    assert.ok(found.retrieval.dependency >= 0.9)
    assert.ok(result.dependencyGraph.edgeCount >= 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Memory Retrieval V2 exposes aging and reinforcement signals without weakening evidence gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-memory-v2-reinforce-"))
  try {
    const evidence = await putEvidence(root, "verified contract", { kind: "memory-v2-test" })
    const first = await proposeMemory(root, {
      type: "procedural",
      scope: "project",
      content: "Keep verification receipts immutable across retries.",
      evidenceRefs: [evidence.ref],
    })
    const reinforced = await proposeMemory(root, {
      type: "procedural",
      scope: "project",
      content: "Keep verification receipts immutable across retries.",
      evidenceRefs: [evidence.ref],
    })
    assert.equal(reinforced.reinforcementCount, 2)
    await verifyMemory(root, first.id, {
      verdict: "PASS",
      verifier: "memory-v2-test-verifier",
      evidenceRefs: [evidence.ref],
    })
    const result = await retrieveMemories(root, "verification receipts retries", { touch: true })
    assert.equal(result.results[0].id, first.id)
    assert.ok(result.results[0].retrieval.aging > 0)
    assert.ok(result.results[0].retrieval.reinforcement > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
