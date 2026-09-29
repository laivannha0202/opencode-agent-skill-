import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildSemanticIndex, buildSemanticIndexCached, clearSemanticIndexRuntimeCache, querySemanticIndex, semanticIndexStatus } from "../lib/semantic-index.mjs"

test("semantic index reuses unchanged files and refreshes changed files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-semantic-index-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "orders.mjs"), [
      "export function calculateTotal(value) {",
      "  return value * 2",
      "}",
      "export const orderTotal = calculateTotal(21)",
      "",
    ].join("\n"))
    await writeFile(path.join(root, "src", "billing.py"), [
      "def reconcile_invoice(invoice_id):",
      "    return invoice_id",
      "",
    ].join("\n"))

    const first = await buildSemanticIndex(root, { rebuild: true, maxFiles: 100 })
    assert.equal(first.stats.files, 2)
    assert.equal(first.stats.reparsed, 2)

    const query = await querySemanticIndex(root, "calculateTotal")
    assert.equal(query.evidenceLevel, "syntax-aware-lexical")
    assert.equal(query.results[0].path, "src/orders.mjs")
    assert.ok(query.results[0].definitions.some((item) => item.name === "calculateTotal"))

    const second = await buildSemanticIndex(root, { maxFiles: 100 })
    assert.equal(second.stats.reused, 2)
    assert.equal(second.stats.reparsed, 0)

    await new Promise((resolve) => setTimeout(resolve, 15))
    await writeFile(path.join(root, "src", "orders.mjs"), [
      "export function calculateTotal(value) {",
      "  return value * 3",
      "}",
      "export function calculateTax(value) {",
      "  return value / 10",
      "}",
      "",
    ].join("\n"))
    const third = await buildSemanticIndex(root, { maxFiles: 100 })
    assert.equal(third.stats.reparsed, 1)
    assert.equal(third.stats.reused, 1)

    const status = await semanticIndexStatus(root)
    assert.equal(status.exists, true)
    assert.equal(status.files, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("semantic index reparses unchanged files when maxFileBytes policy changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-semantic-size-policy-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    const source = "export function visibleAfterBudgetRaise() { return 42 }\n" + "x".repeat(90 * 1024)
    await writeFile(path.join(root, "src", "large.mjs"), source)

    const low = await buildSemanticIndex(root, { rebuild: true, maxFiles: 100, maxFileBytes: 64 * 1024, ioConcurrency: 2 })
    assert.equal(low.index.files["src/large.mjs"].skipped, "too-large")

    const high = await buildSemanticIndex(root, { maxFiles: 100, maxFileBytes: 256 * 1024, ioConcurrency: 2 })
    assert.equal(high.stats.reparsed, 1)
    assert.equal(high.index.files["src/large.mjs"].skipped, undefined)
    assert.ok(high.index.files["src/large.mjs"].symbols.some((item) => item.name === "visibleAfterBudgetRaise"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("semantic runtime cache keys maxFileBytes and rebuild bypasses memory cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-semantic-runtime-key-"))
  try {
    clearSemanticIndexRuntimeCache()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(
      path.join(root, "src", "budgeted.mjs"),
      "export const runtimeCacheBudgetSymbol = 1\n" + "y".repeat(90 * 1024),
    )

    const low = await buildSemanticIndexCached(root, {
      workspaceFingerprint: "same-workspace",
      maxFiles: 100,
      maxFileBytes: 64 * 1024,
      ioConcurrency: 2,
    })
    assert.equal(low.index.files["src/budgeted.mjs"].skipped, "too-large")

    const high = await buildSemanticIndexCached(root, {
      workspaceFingerprint: "same-workspace",
      maxFiles: 100,
      maxFileBytes: 256 * 1024,
      ioConcurrency: 2,
    })
    assert.equal(high.runtimeCacheHit, false)
    assert.ok(high.index.files["src/budgeted.mjs"].symbols.some((item) => item.name === "runtimeCacheBudgetSymbol"))

    const rebuilt = await buildSemanticIndexCached(root, {
      workspaceFingerprint: "same-workspace",
      maxFiles: 100,
      maxFileBytes: 256 * 1024,
      rebuild: true,
      ioConcurrency: 2,
    })
    assert.equal(rebuilt.runtimeCacheHit, false)
  } finally {
    clearSemanticIndexRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})


test("semantic index ignores every canonical UES runtime directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-semantic-runtime-artifacts-"))
  try {
    clearSemanticIndexRuntimeCache()
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "real.mjs"), "export const realSourceSymbol = 1\n")

    for (const dir of [".ues-work", ".ues-learning", ".ues-dashboard", ".ues-sandboxes", ".ues-cache", ".ues-traces", ".ues-memory", ".ues-evals", ".ues-services"]) {
      await mkdir(path.join(root, dir), { recursive: true })
      await writeFile(path.join(root, dir, "runtime-artifact.mjs"), "export const shouldNeverBeIndexed = 1\n")
    }

    const built = await buildSemanticIndex(root, { rebuild: true, maxFiles: 100 })
    assert.equal(built.stats.files, 1)
    assert.ok(built.index.files["src/real.mjs"])
    assert.equal(Object.keys(built.index.files).some((file) => file.startsWith(".ues-")), false)

    const query = await querySemanticIndex(root, "shouldNeverBeIndexed", { maxFiles: 100 })
    assert.equal(query.results.some((item) => item.path.startsWith(".ues-")), false)
  } finally {
    clearSemanticIndexRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})
