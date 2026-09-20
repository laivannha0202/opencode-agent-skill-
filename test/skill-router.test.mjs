import test from "node:test"
import assert from "node:assert/strict"
import { routeSkills } from "../global-config/plugins/ues-router/router.js"

test("v2 router selects focused process and domain skills", () => {
  assert.deepEqual(
    routeSkills("Fix an auth permission regression where a tenant can edit another tenant resource.", 4),
    [
      "ues-engineering-orchestrator",
      "ues-bug-diagnosis",
      "ues-auth-security",
      "ues-change-impact-analysis",
    ],
  )

  assert.deepEqual(
    routeSkills("React Native Android screen regression after a Gradle change", 4),
    [
      "ues-engineering-orchestrator",
      "ues-bug-diagnosis",
      "ues-react-native-engineering",
    ],
  )

  assert.deepEqual(
    routeSkills("Please review this code", 2),
    ["ues-engineering-orchestrator"],
  )
})

test("v2 router caps automatic skills and falls back to repo exploration", () => {
  const routed = routeSkills(
    "Fix a payment webhook auth regression involving database migration and API contract compatibility.",
    3,
  )
  assert.equal(routed.length, 3)
  assert.deepEqual(routeSkills("Find the repository function that formats labels.", 4), ["ues-repo-explorer"])
})

test("v2 router adds persistent planning skills for explicit long-horizon work", () => {
  assert.deepEqual(
    routeSkills("Implement a large task across the whole repository with many files and keep it resumable.", 4),
    [
      "ues-engineering-orchestrator",
      "ues-long-task-state",
      "ues-task-planner",
    ],
  )
})



test("resume-style long-horizon prompts always include the orchestrator", () => {
  const routed = routeSkills(
    "Resume this work across many files and keep a durable execution plan.",
    6,
  )
  assert.ok(routed.includes("ues-engineering-orchestrator"))
  assert.ok(routed.includes("ues-long-task-state"))
  assert.ok(routed.includes("ues-task-planner"))
})


test("router distinguishes webhook from React hooks and diagnoses fixes", () => {
  const routed = routeSkills(
    "Fix duplicate payment webhook processing and verify idempotency.",
    6,
  )
  assert.ok(routed.includes("ues-bug-diagnosis"))
  assert.ok(routed.includes("ues-payment-engineering"))
  assert.ok(routed.includes("ues-change-impact-analysis"))
  assert.ok(!routed.includes("ues-react-engineering"))
})

test("router does not treat public API response schema as a database schema", () => {
  const routed = routeSkills(
    "Change a public API response schema without breaking consumers.",
    6,
  )
  assert.ok(routed.includes("ues-api-contract"))
  assert.ok(routed.includes("ues-change-impact-analysis"))
  assert.ok(!routed.includes("ues-database-engineering"))
})

test("router recognizes accessible focus management", () => {
  const routed = routeSkills(
    "Implement accessible focus management.",
    6,
  )
  assert.ok(routed.includes("ues-accessibility"))
})

test("router retains domain and impact skills under cap pressure (long-horizon database + auth)", () => {
  const routed = routeSkills(
    "Implement a whole-repository database and auth migration across the entire project, keep it durable and resumable.",
    4,
  )
  assert.ok(routed.includes("ues-engineering-orchestrator"))
  assert.ok(routed.includes("ues-database-engineering"))
  assert.ok(routed.includes("ues-change-impact-analysis"))
  assert.ok(routed.includes("ues-auth-security"))
})

test("router keeps domain skills ahead of generic process skills when the cap binds", () => {
  assert.deepEqual(
    routeSkills(
      "Debug a payment webhook regression, investigate performance and accessibility in the checkout flow across the entire project.",
      4,
    ),
    [
      "ues-engineering-orchestrator",
      "ues-payment-engineering",
      "ues-change-impact-analysis",
      "ues-performance-engineering",
    ],
  )
})

test("router grows domain retention as the cap rises (all domain skills at cap 5)", () => {
  const routed = routeSkills(
    "Debug a payment webhook regression, investigate performance and accessibility in the checkout flow across the entire project.",
    5,
  )
  assert.ok(routed.includes("ues-accessibility"))
  assert.ok(routed.includes("ues-payment-engineering"))
  assert.ok(routed.includes("ues-change-impact-analysis"))
  assert.ok(routed.includes("ues-performance-engineering"))
})

test("router evicts generic process skills before domain skills by design", () => {
  const routed = routeSkills(
    "Fix a payment webhook auth regression involving database migration and API contract compatibility.",
    3,
  )
  assert.equal(routed.length, 3)
  assert.ok(routed.includes("ues-database-engineering"))
  assert.ok(routed.includes("ues-change-impact-analysis"))
  assert.ok(!routed.includes("ues-bug-diagnosis"))
})

test("router leaves non-truncated routing output unchanged", () => {
  assert.deepEqual(
    routeSkills("Add ARIA labels to the checkout payment form.", 6),
    [
      "ues-engineering-orchestrator",
      "ues-payment-engineering",
      "ues-change-impact-analysis",
      "ues-accessibility",
    ],
  )
})


test("router handles Vietnamese engineering prompts", () => {
  const routed = routeSkills(
    "Sửa lỗi phân quyền thanh toán trong toàn bộ dự án, kiểm tra cơ sở dữ liệu và API công khai.",
    6,
  )
  assert.ok(routed.includes("ues-engineering-orchestrator"))
  assert.ok(routed.includes("ues-auth-security"))
  assert.ok(routed.includes("ues-payment-engineering"))
  assert.ok(routed.includes("ues-database-engineering"))
})

test("router recognizes backend framework domains", () => {
  assert.ok(routeSkills("Fix FastAPI pydantic validation regression", 6).includes("ues-fastapi-engineering"))
  assert.ok(routeSkills("Review Django REST permission handling", 6).includes("ues-django-engineering"))
  assert.ok(routeSkills("Debug NestJS dependency injection failure", 6).includes("ues-nestjs-engineering"))
})
