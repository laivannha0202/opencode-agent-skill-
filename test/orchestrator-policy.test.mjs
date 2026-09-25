import test from "node:test"
import assert from "node:assert/strict"
import { classifyEngineeringTask, recoveryPolicyForAttempt, shouldRunDedicatedDiagnosis } from "../lib/orchestrator-policy.mjs"

test("adaptive task policy escalates risky long-horizon work", () => {
  const policy = classifyEngineeringTask(
    "Refactor the entire repository authentication schema migration and public API contracts across many modules.",
  )
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.risk, "high")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
})

test("small local work stays inline", () => {
  const policy = classifyEngineeringTask("Rename a local helper.")
  assert.equal(policy.mode, "inline")
  assert.equal(policy.modelTier, "light")
})


test("declared high risk metadata forces heavy policy", () => {
  const policy = classifyEngineeringTask("Change a local helper", { risk: "high" })
  assert.equal(policy.risk, "high")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.contextBudget, 48_000)
  assert.ok(policy.signals.some((item) => item.name === "declared-high-risk"))
})

test("risk text annotation is recognized by runtime policy", () => {
  const policy = classifyEngineeringTask("Update helper risk: high")
  assert.equal(policy.risk, "high")
  assert.equal(policy.modelTier, "heavy")
})


test("explicit long-horizon wording forces durable deep mode even without a high-risk domain", () => {
  const policy = classifyEngineeringTask("Refactor the entire project safely with integration verification.")
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.requireIntegrationVerification, true)
  assert.equal(policy.profile.durableState, true)
})

test("Vietnamese large-refactor workflow wording is classified as long-horizon", () => {
  const policy = classifyEngineeringTask(
    "Phân tích toàn bộ project hiện tại và thực hiện một refactor lớn nhưng an toàn. Chia công việc thành các task có dependency; cuối cùng phải có integration verification và chỉ finalize khi các gate cho phép.",
  )
  assert.equal(policy.mode, "long-horizon")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.requireIntegrationVerification, true)
  assert.equal(policy.antiHallucination.noCompletionWithoutVerification, true)
  assert.ok(policy.signals.some((item) => item.name === "explicit-long-horizon"))
})

test("V10 FAST policy uses a smaller initial context and expands only after failure", () => {
  const policy = classifyEngineeringTask("Fix this local parser bug.")
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.contextBudget, 8_000)
  assert.equal(policy.maxSkills, 2)

  const first = recoveryPolicyForAttempt(policy, 1)
  const second = recoveryPolicyForAttempt(policy, 2)
  const third = recoveryPolicyForAttempt(policy, 3)

  assert.equal(first.stage, "initial")
  assert.equal(first.contextBudget, 8_000)
  assert.equal(second.stage, "diagnose")
  assert.ok(second.contextBudget > first.contextBudget)
  assert.equal(second.contextStrategy, "incremental-semantic+git")
  assert.equal(second.requireDiagnosis, true)
  assert.equal(third.stage, "deep-recovery")
  assert.equal(third.contextStrategy, "semantic+graph+git")
  assert.equal(third.requireCritic, true)
})

test("V10 keeps high-risk work at full DEEP context", () => {
  const policy = classifyEngineeringTask("Fix authentication permissions in production.")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.contextBudget, 48_000)
  assert.equal(policy.maxSkills, 5)
})


test("read-only repository inspection mentioning database stays lightweight", () => {
  const policy = classifyEngineeringTask(
    "Kiểm tra nhanh repository hiện tại. Không sửa file. Xác định stack frontend backend database và lệnh build test.",
  )
  assert.equal(policy.risk, "low")
  assert.equal(policy.mode, "inline")
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.profile.durableState, false)
  assert.equal(policy.requirePlanCheck, false)
  assert.equal(policy.requireIntegrationVerification, false)
  assert.ok(policy.domains.includes("database"))
  assert.equal(policy.signals.some((item) => item.name === "high-risk-operation"), false)
})

test("real database migration remains high-risk and deep", () => {
  const policy = classifyEngineeringTask(
    "Migrate the database schema for production and update the application code that depends on it.",
  )
  assert.equal(policy.risk, "high")
  assert.equal(policy.executionProfile, "deep")
  assert.equal(policy.modelTier, "heavy")
  assert.equal(policy.profile.durableState, true)
  assert.equal(policy.requirePlanCheck, true)
  assert.equal(policy.requireIntegrationVerification, true)
  assert.ok(policy.signals.some((item) => item.name === "high-risk-operation"))
  assert.ok(policy.domains.includes("database"))
})

test("read-only auth and payment review does not become high-risk from domain words alone", () => {
  const policy = classifyEngineeringTask(
    "Review the auth and payment modules without editing files and report their responsibilities.",
  )
  assert.notEqual(policy.risk, "high")
  assert.equal(policy.profile.durableState, false)
  assert.ok(policy.domains.includes("auth-security"))
  assert.ok(policy.domains.includes("payment"))
})


test("FAST low-risk debugging skips dedicated diagnosis until a retry", () => {
  const policy = classifyEngineeringTask("Fix this local parser regression.")
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.risk, "low")
  assert.equal(shouldRunDedicatedDiagnosis(policy, 1), false)
  assert.equal(shouldRunDedicatedDiagnosis(policy, 2), true)
})

test("non-FAST debugging can diagnose before the first patch", () => {
  const policy = classifyEngineeringTask(
    "Fix this regression across several related modules and callers. " +
    "The failure affects multiple code paths and needs repository-grounded investigation before editing. " +
    "Inspect the affected tests, callers, and dependencies, then make the smallest coherent fix.",
  )
  assert.notEqual(policy.executionProfile, "fast")
  assert.equal(shouldRunDedicatedDiagnosis(policy, 1), true)
})

test("non-debug tasks never spawn a dedicated debugger", () => {
  const policy = classifyEngineeringTask("Rename a local helper.")
  assert.equal(shouldRunDedicatedDiagnosis(policy, 1), false)
  assert.equal(shouldRunDedicatedDiagnosis(policy, 2), false)
})


test("single-file bounded migration helper stays FAST instead of triggering database migration policy", () => {
  const policy = classifyEngineeringTask("Fix migrateUsers(rows) in src/migration.mjs. Return new objects without mutating rows and preserve unrelated fields.")
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.risk, "low")
  assert.equal(policy.mode, "inline")
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.requirePlanCheck, false)
  assert.equal(policy.signals.some((item) => item.name === "data-migration"), false)
})

test("single-file bounded API error helper stays FAST", () => {
  const policy = classifyEngineeringTask("Fix toHttpError(error) in src/api-errors.mjs. Preserve the response shape and map known error codes.")
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.risk, "low")
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.requireIntegrationVerification, false)
})

test("single-file bounded payment event logic can use guarded FAST lane", () => {
  const policy = classifyEngineeringTask("Fix applyPaymentEvent(order, event) in src/payment.mjs. Duplicate ids must be idempotent, malformed ids throw TypeError, and the function must not mutate order.")
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.risk, "low")
  assert.equal(policy.executionProfile, "fast")
  assert.ok(policy.domains.includes("payment"))
})

test("changedFiles metadata can identify a bounded local task", () => {
  const policy = classifyEngineeringTask("Fix the local parser regression and preserve existing behavior.", { changedFiles: 1 })
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.risk, "low")
  assert.equal(policy.executionProfile, "fast")
})

test("critical single-file security or production mutations still fail closed to DEEP", () => {
  const security = classifyEngineeringTask("Fix authorization token validation in src/auth.mjs and rotate the production credential.")
  assert.equal(security.singleFileBounded, true)
  assert.equal(security.risk, "high")
  assert.equal(security.executionProfile, "deep")
  const database = classifyEngineeringTask("Fix migrateRows in src/migration.mjs and migrate the database schema in production.")
  assert.equal(database.singleFileBounded, true)
  assert.equal(database.risk, "high")
  assert.equal(database.executionProfile, "deep")
})
