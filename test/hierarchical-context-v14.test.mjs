import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { queryContextHierarchy, selectDiverseHierarchyScopes } from "../lib/hierarchical-context.mjs"

test("V14 hierarchy uses L0/L1 scope routing before L2 source excerpts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-hierarchy-v14-"))
  try {
    await mkdir(path.join(root, "apps", "api", "orders"), { recursive: true })
    await mkdir(path.join(root, "apps", "web", "catalog"), { recursive: true })
    await writeFile(path.join(root, "apps", "api", "orders", "checkout.mjs"), [
      "export function reserveInventory(order) {",
      "  return order.items.length",
      "}",
      "export function completeCheckout(order) {",
      "  return reserveInventory(order)",
      "}",
    ].join("\n"))
    await writeFile(path.join(root, "apps", "web", "catalog", "product.ts"), "export const productCard = true\n")

    const result = await queryContextHierarchy(root, "fix checkout inventory reservation", { maxScopes: 4, maxFiles: 100 })
    assert.equal(result.levels.L2.purpose.includes("source"), true)
    assert.ok(result.scopes.some((scope) => scope.path.includes("apps/api/orders")))
    const scope = result.scopes.find((item) => item.path.includes("apps/api/orders"))
    assert.ok(scope.l0.length <= 256)
    assert.match(scope.l1, /checkout\.mjs/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("V14 hierarchy diversity fence prevents a parent-child chain from consuming scope budget", () => {
  const scopes = selectDiverseHierarchyScopes([
    { path: "apps/api/orders", score: 20 },
    { path: "apps/api", score: 19 },
    { path: "apps", score: 18 },
    { path: "packages/payments", score: 17 },
    { path: "docs", score: 16 },
  ], 3)
  assert.deepEqual(scopes.map((item) => item.path), ["apps/api/orders", "packages/payments", "docs"])
})
