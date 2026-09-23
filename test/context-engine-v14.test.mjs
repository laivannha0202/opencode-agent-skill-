import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildAdaptiveTaskContext } from "../lib/context-engine-v11.mjs"
import { putEvidence } from "../lib/evidence-store.mjs"
import { proposeMemory, verifyMemory } from "../lib/memory-engine.mjs"

test("V14 adaptive context carries hierarchy and verified memory into the child-agent pack", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-context-v14-"))
  try {
    await mkdir(path.join(root, "src", "payments"), { recursive: true })
    await writeFile(path.join(root, "src", "payments", "verify.mjs"), [
      "export function verifyPayment(status) {",
      "  return status === 'paid'",
      "}",
    ].join("\n"))

    const receipt = await putEvidence(root, "payment verification regression passed", { kind: "test-receipt" })
    const candidate = await proposeMemory(root, {
      content: "Payment verification changes require the payments regression test.",
      type: "procedural",
      scope: "module",
      evidenceRefs: [receipt.ref],
      files: ["src/payments/verify.mjs"],
    })
    await verifyMemory(root, candidate.id, {
      verdict: "PASS",
      verifier: "ues-verifier",
      evidenceRefs: [receipt.ref],
    })

    const result = await buildAdaptiveTaskContext(root, {
      id: "payment-fix",
      title: "Fix payment verification",
      summary: "Update payment verification without breaking the regression contract.",
      files: { modify: ["src/payments/verify.mjs"] },
      acceptance: ["payment verification remains correct"],
      verification: ["run payments regression"],
    }, {
      policy: { contextBudget: 10000, domains: ["nodejs"], profile: { contextStrategy: "incremental-semantic" } },
    })

    assert.equal(result.contextSchemaVersion, 6)
    assert.ok(result.contextManifest.hierarchy?.scopes?.length > 0)
    assert.equal(result.memories[0].id, candidate.id)
    assert.equal(result.promptEnvelope.dynamic.memories[0].id, candidate.id)
    assert.ok(result.promptEnvelope.dynamic.contextHints.hierarchy.length > 0)
    assert.ok(result.capabilityFabric.providers.some((item) => item.capability === "memory" && item.selected === "ues-memory"))
    assert.ok(result.promptEnvelope.dynamic.contextHints.providers.some((item) => item.capability === "code.search"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
