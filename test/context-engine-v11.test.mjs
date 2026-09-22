import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildAdaptiveTaskContext } from "../lib/context-engine-v11.mjs"
import { getEvidence } from "../lib/evidence-store.mjs"

test("V11 adaptive context externalizes large excerpts and keeps bounded inline evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-context-v11-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "feature.js"), [
      "export function feature(input) {",
      "  return input + 1",
      "}",
      "",
      "x".repeat(8000),
    ].join("\n"))

    const task = {
      id: "feature",
      title: "Fix feature behavior",
      summary: "Update the declared feature implementation and verify it.",
      files: { modify: ["src/feature.js"] },
      acceptance: ["feature returns the required value"],
      verification: ["run the nearest test"],
      risk: "low",
    }

    const result = await buildAdaptiveTaskContext(root, task, {
      policy: {
        contextBudget: 8000,
        risk: "low",
        domains: ["nodejs"],
        profile: { contextStrategy: "incremental-semantic" },
      },
      externalizeThreshold: 1200,
      inlineChars: 300,
    })

    assert.equal(result.contextSchemaVersion, 6)
    assert.equal(result.evidenceBudget.total, 8000)
    assert.ok(result.contextManifest.excerpts.length >= 1)
    const externalized = result.contextManifest.excerpts.find((item) => item.externalized)
    assert.ok(externalized)
    assert.match(externalized.text, /evidence:sha256:/)
    assert.ok(externalized.text.length < externalized.originalChars)
    assert.equal(result.evidenceStore.refs >= 1, true)

    const stored = await getEvidence(root, externalized.evidenceRef, { maxChars: 200 })
    assert.equal(stored.returnedBytes, 200)
    assert.equal(stored.truncated, true)
    assert.ok(result.promptCache.stablePrefixHash)
    assert.ok(result.promptCache.cacheableRatio > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
