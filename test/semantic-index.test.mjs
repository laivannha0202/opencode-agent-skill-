import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildSemanticIndex, querySemanticIndex, semanticIndexStatus } from "../lib/semantic-index.mjs"

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
