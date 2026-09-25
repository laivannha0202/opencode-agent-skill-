import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { compactReversibleOutput } from "../lib/performance-fabric.mjs"
import { getEvidence } from "../lib/evidence-store.mjs"

test("V14.1 reversible compactor leaves bounded output byte-for-byte unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-performance-v141-small-"))
  try {
    const source = "tests: 18 passed\n"
    const result = await compactReversibleOutput(root, source, { maxChars: 16 * 1024 })
    assert.equal(result.compacted, false)
    assert.equal(result.evidenceRef, null)
    assert.equal(result.text, source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V14.1 reversible compactor preserves exact raw output and keeps high-signal failures visible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-performance-v141-large-"))
  try {
    const source = [
      "BEGIN",
      "noise line\n".repeat(9000),
      "FATAL payment mismatch: expected 42 got 41",
      "more noise\n".repeat(3000),
      "END",
    ].join("\n")
    const result = await compactReversibleOutput(root, source, { maxChars: 16 * 1024 })
    assert.equal(result.compacted, true)
    assert.equal(result.strategy, "reversible-head-signal-tail")
    assert.ok(result.text.length <= 16 * 1024)
    assert.match(result.text, /FATAL payment mismatch/)
    assert.match(result.text, /evidence:sha256:/)
    assert.ok(result.evidenceRef)

    const recovered = await getEvidence(root, result.evidenceRef, {
      maxBytes: Buffer.byteLength(source, "utf8") + 32,
    })
    assert.equal(recovered.truncated, false)
    assert.equal(recovered.content, source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V14.2 reversible compactor uses command-aware lint reducer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-performance-v142-lint-"))
  try {
    const source = [
      "noise\n".repeat(5000),
      "src/a.ts:12:4  error  no-unused-vars",
      "✖ 1 problem (1 error, 0 warnings)",
      "tail\n".repeat(2000),
    ].join("\n")
    const result = await compactReversibleOutput(root, source, {
      maxChars: 16 * 1024,
      source: "pnpm lint",
    })
    assert.equal(result.compacted, true)
    assert.equal(result.strategy, "reversible-head-lint-tail")
    assert.match(result.text, /no-unused-vars/)
    assert.match(result.text, /1 problem/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V14.2 reversible compactor exposes bounded JSON shape while preserving raw", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-performance-v142-json-"))
  try {
    const value = {
      errors: Array.from({ length: 400 }, (_, index) => ({
        id: index,
        message: "failure-" + index + "-" + "x".repeat(80),
      })),
      meta: { total: 400, status: "failed" },
    }
    const source = JSON.stringify(value)
    const result = await compactReversibleOutput(root, source, {
      maxChars: 16 * 1024,
      source: "tool --json",
    })
    assert.equal(result.compacted, true)
    assert.equal(result.strategy, "reversible-head-json-tail")
    assert.match(result.text, /errors: array\(400\)/)
    const recovered = await getEvidence(root, result.evidenceRef, {
      maxBytes: Buffer.byteLength(source, "utf8") + 32,
    })
    assert.equal(recovered.content, source)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
