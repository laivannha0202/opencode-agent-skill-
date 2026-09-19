import test from "node:test"
import assert from "node:assert/strict"
import { classifyReviewFiles } from "../lib/review-scope.mjs"

test("review scope classifies high-risk boundaries deterministically", () => {
  const result = classifyReviewFiles([
    "src/auth/session.ts",
    "db/migrations/2026_add_payment.sql",
    "src/components/Button.tsx",
  ])
  const byPath = new Map(result.map((item) => [item.path, item.risk]))
  assert.equal(byPath.get("src/auth/session.ts").level, "high")
  assert.equal(byPath.get("db/migrations/2026_add_payment.sql").level, "critical")
  assert.equal(byPath.get("src/components/Button.tsx").level, "low")
})
