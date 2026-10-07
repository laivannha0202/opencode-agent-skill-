// V16.12 Execution Acceleration Runtime: composition tests.
//
// This module is a COMPOSITION layer only. These tests pin that it (a) selects a
// deterministic fast path per task shape, (b) never duplicates another owner's
// authority, (c) keeps the release path sacred, and (d) records honest wall-time
// attribution and waste without becoming a second metrics authority.

import test from "node:test"
import assert from "node:assert/strict"

import {
  EXECUTION_ACCELERATION_POLICY,
  TASK_SHAPE,
  FAST_PATH,
  planExecutionAcceleration,
  createAccelerationContext,
  runAcceleratedDag,
  assertFreshGateAllowed,
} from "../lib/execution-acceleration-v16-12.mjs"
import { WALL_CATEGORY, WASTE_OPERATION } from "../lib/waste-detector-v16-12.mjs"
import { NODE_EFFECT, NODE_STATUS } from "../lib/task-dag-scheduler-v16-12.mjs"
import { PROVENANCE } from "../lib/measurement-provenance.mjs"

test("execution acceleration policy id is byte-stable", () => {
  assert.equal(EXECUTION_ACCELERATION_POLICY, "execution-acceleration-v16-12")
})

test("planExecutionAcceleration: a tiny task selects the TINY fast path", () => {
  const plan = planExecutionAcceleration({ changedFiles: ["docs/a.md"], docsOnly: true })
  assert.equal(plan.shape, TASK_SHAPE.TINY)
  assert.equal(plan.fastPath, FAST_PATH.TINY_FAST_PATH)
  assert.equal(plan.capabilities.receiptReuse.enabled, true)
  assert.equal(plan.capabilities.toolResultReuse.enabled, true)
  assert.equal(plan.capabilities.warmServiceReuse.alwaysOn, false)
  assert.equal(plan.freshGatesRequired, false)
})

test("planExecutionAcceleration: a normal task selects the NORMAL path", () => {
  const plan = planExecutionAcceleration({ changedFiles: ["lib/a.mjs", "lib/b.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.NORMAL)
  assert.equal(plan.fastPath, FAST_PATH.NORMAL_PATH)
})

test("planExecutionAcceleration: a deep task selects the DEEP path and allows the suite", () => {
  const plan = planExecutionAcceleration({ changedFiles: ["lib/index.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.DEEP)
  assert.equal(plan.fastPath, FAST_PATH.DEEP_PATH)
  assert.equal(plan.capabilities.incrementalVerification.allowFullSuiteDuringImplementation, true)
})

test("the release path is sacred: receipts disabled, fresh gates required", () => {
  const plan = planExecutionAcceleration({ finalRelease: true, changedFiles: ["lib/a.mjs"] })
  assert.equal(plan.shape, TASK_SHAPE.RELEASE)
  assert.equal(plan.fastPath, FAST_PATH.RELEASE_PATH)
  assert.equal(plan.capabilities.receiptReuse.enabled, false)
  assert.equal(plan.capabilities.toolResultReuse.enabled, false)
  assert.equal(plan.freshGatesRequired, true)
  assert.deepEqual(plan.requiredFreshGates, ["npm test", "release:verify"])
})

test("the release path also disables dev-time overlap shortcuts", () => {
  const plan = planExecutionAcceleration({ finalRelease: true, changedFiles: ["lib/a.mjs"] })
  // Writes are ALWAYS serialized regardless.
  assert.equal(plan.capabilities.dagScheduling.writesSerialized, true)
})

test("a caller may disable reuse and overlap explicitly", () => {
  const plan = planExecutionAcceleration({ changedFiles: ["lib/a.mjs"], allowReuse: false, allowOverlap: false })
  assert.equal(plan.capabilities.receiptReuse.enabled, false)
  assert.equal(plan.capabilities.toolResultReuse.enabled, false)
  assert.equal(plan.capabilities.dagScheduling.enabled, false)
})

test("assertFreshGateAllowed refuses a cached receipt on the release path", () => {
  const release = planExecutionAcceleration({ finalRelease: true, changedFiles: ["lib/a.mjs"] })
  const refused = assertFreshGateAllowed(release, "npm test", { fromReceipt: true })
  assert.equal(refused.allowed, false)
  assert.match(refused.reason, /must run fresh/)
  // A genuinely fresh run is allowed.
  assert.equal(assertFreshGateAllowed(release, "npm test", { fromReceipt: false }).allowed, true)
  // On a non-release path, receipt-sourced evidence is fine.
  const dev = planExecutionAcceleration({ changedFiles: ["lib/a.mjs"] })
  assert.equal(assertFreshGateAllowed(dev, "npm test", { fromReceipt: true }).allowed, true)
})

test("createAccelerationContext attributes wall time and reports honestly", async () => {
  let t = 0
  const ctx = createAccelerationContext({ root: process.cwd(), now: () => t })
  await ctx.timePhase(WALL_CATEGORY.TOOL_EXEC, async () => { t += 100 })
  ctx.attribute(WALL_CATEGORY.VERIFICATION, 50)
  t += 10
  const report = ctx.report()
  assert.equal(report.wall.categories[WALL_CATEGORY.TOOL_EXEC].provenance, PROVENANCE.MEASURED)
  assert.equal(report.wall.categories[WALL_CATEGORY.TOOL_EXEC].value, 100)
  assert.equal(report.wall.categories[WALL_CATEGORY.RELEASE_VERIFY].provenance, PROVENANCE.NOT_MEASURED)
  assert.equal(report.wall.totalWallMs.provenance, PROVENANCE.MEASURED)
  // Overlap saving is never fabricated.
  assert.equal(report.wall.parallelOverlapSavedMs.provenance, PROVENANCE.NOT_MEASURED)
})

test("createAccelerationContext detects a repeated expensive operation", () => {
  let t = 0
  const ctx = createAccelerationContext({ now: () => t })
  ctx.observeOperation(WASTE_OPERATION.GATE, "npm test", 100, "gen-1")
  t += 1
  const second = ctx.observeOperation(WASTE_OPERATION.GATE, "npm test", 100, "gen-1")
  assert.equal(second.repeated, true)
  assert.equal(second.count, 2)
  const report = ctx.report()
  assert.equal(report.waste.wastedOperations, 1)
  assert.equal(report.waste.wasted[0].operation, WASTE_OPERATION.GATE)
})

test("runAcceleratedDag composes the scheduler and preserves write serialization", async () => {
  let active = 0
  let writeOverlap = false
  const make = (id, effect) => ({
    id,
    effect,
    run: async () => {
      active += 1
      if (effect === NODE_EFFECT.SOURCE_WRITE && active > 1) writeOverlap = true
      await new Promise((r) => setTimeout(r, 15))
      active -= 1
    },
  })
  const result = await runAcceleratedDag([make("r1", NODE_EFFECT.READ_ONLY), make("w", NODE_EFFECT.SOURCE_WRITE), make("r2", NODE_EFFECT.READ_ONLY)])
  assert.equal(writeOverlap, false)
  assert.equal(result.ok, true)
  assert.equal(result.nodes.every((n) => n.status === NODE_STATUS.DONE), true)
})

test("runAcceleratedDag with overlap disabled still runs serially and settles", async () => {
  const result = await runAcceleratedDag(
    [
      { id: "a", effect: NODE_EFFECT.READ_ONLY, run: async () => 1 },
      { id: "b", effect: NODE_EFFECT.READ_ONLY, run: async () => 2 },
    ],
    { plan: { allowOverlap: false } },
  )
  assert.equal(result.ok, true)
  assert.equal(result.counts.done, 2)
})

test("planning is deterministic across repeated calls", () => {
  const input = { changedFiles: ["lib/a.mjs", "lib/b.mjs"] }
  assert.deepEqual(planExecutionAcceleration(input), planExecutionAcceleration(input))
})
