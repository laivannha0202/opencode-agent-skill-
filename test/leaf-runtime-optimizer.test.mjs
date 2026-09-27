import test from "node:test"
import assert from "node:assert/strict"

import { failureDelta, leafTaskPolicy } from "../lib/leaf-runtime-optimizer.mjs"

test("V15.5 low-risk single-file leaf becomes FAST inside a DEEP root", () => {
  const root = { executionProfile: "deep", risk: "high" }
  const leaf = {
    id: "mobile-price-filter",
    title: "Remove obsolete price filter",
    summary: "Update the mobile product screen without changing business semantics.",
    files: { modify: ["apps/mobile/src/screens/ProductScreen.tsx"], read: [], test: [] },
    acceptance: ["The obsolete price filter is absent and existing product actions still render."],
    verification: ["Run the focused mobile component test."],
    risk: "low",
  }
  const policy = leafTaskPolicy(leaf, root)
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.risk, "low")
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.requireIntegrationVerification, false)
  assert.equal(policy.rootExecutionProfile, "deep")
})

test("V15.5 high-risk database leaf never downshifts from DEEP", () => {
  const leaf = {
    id: "db-migration",
    title: "Migrate database schema",
    summary: "Alter the production-facing order schema and preserve existing data.",
    files: { modify: ["apps/api/prisma/schema.prisma"], read: [], test: [] },
    acceptance: ["Existing order data remains valid."],
    verification: ["Run migration validation against the isolated test database."],
    risk: "high",
  }
  const policy = leafTaskPolicy(leaf, { executionProfile: "deep", risk: "high" })
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.risk, "high")
  assert.equal(policy.requireIntegrationVerification, true)
})

test("V15.5 failure delta keeps error evidence and drops unrelated chatter", () => {
  const raw = [
    "exploring package metadata",
    "reading many unrelated files",
    "still thinking",
    "apps/api/src/order.ts:42",
    "AssertionError: expected paid but actual pending",
    "at checkout test",
    "more unrelated narrative",
  ].join("\n")
  const delta = failureDelta(raw, { maxChars: 1800 })
  assert.match(delta, /order\.ts:42/)
  assert.match(delta, /AssertionError/)
  assert.match(delta, /expected paid but actual pending/)
  assert.doesNotMatch(delta, /package metadata/)
})
