import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { extractValidatedPlan, repairPlannerJson } from "../lib/plan-salvage.mjs"
import {
  classifyPlanningFailure,
  directLaneDecision,
  plannerSelfCheck,
  planningFailureFingerprint,
  planningRecoveryDecision,
  PLANNING_ERROR,
} from "../lib/planning-recovery.mjs"

const PLAN = {
  schemaVersion: 1,
  goal: "release metadata",
  tasks: [{
    id: "task-01",
    title: "metadata",
    summary: "update metadata",
    dependsOn: [],
    files: { create: [], modify: ["README.md"], test: [], delete: [], read: [] },
    acceptance: ["version is current"],
    verification: ["run checker"],
    verificationCommands: [{ command: "git", args: ["status", "--short"] }],
    requirementIds: ["R1"],
    risk: "low",
  }],
}

test("V16.2 repairs the real malformed verificationCommands shape without a model retry", () => {
  const raw = JSON.stringify(PLAN).replace(
    '{"command":"git","args":["status","--short"]}',
    '{"command":"git","status","--short"]}',
  )
  const out = extractValidatedPlan("UES_PLAN_JSON:\n" + raw)
  assert.equal(out.validation.valid, true)
  assert.equal(out.repaired, true)
  assert.ok(out.repairs.includes("verification-command-args-key"))
  assert.deepEqual(out.plan.tasks[0].verificationCommands[0], {
    command: "git",
    args: ["status", "--short"],
  })
})

test("V16.2 bounded repair stays fail-closed for semantic omissions", () => {
  const broken = structuredClone(PLAN)
  broken.tasks[0].acceptance = []
  const out = extractValidatedPlan("UES_PLAN_JSON:\n" + JSON.stringify(broken))
  assert.equal(out.validation.valid, false)
})

test("V16.2 bounded repair handles trailing commas but rejects nonsense and repair floods", () => {
  const trailing = JSON.stringify(PLAN).replace(/}\]}$/, "},]}")
  assert.equal(repairPlannerJson(trailing).ok, true)
  assert.equal(repairPlannerJson('{"schemaVersion":1,"tasks":[ totally broken ]}').ok, false)
  const flooded = '{“a”:1,“b”:2,“c”:3,“d”:4,“e”:5}'
  const bounded = repairPlannerJson(flooded, { maxRepairs: 4 })
  assert.equal(bounded.ok, false)
  assert.equal(bounded.error, "repair-budget-exceeded")
})

test("V16.2 planner failures use stable explicit classifications", () => {
  assert.equal(classifyPlanningFailure({ plan: null, parseError: "bad json" }).code, PLANNING_ERROR.PARSE)
  assert.equal(classifyPlanningFailure({ plan: {}, validation: { valid: false, errors: ["x"] } }).code, PLANNING_ERROR.SCHEMA)
  assert.equal(classifyPlanningFailure({ plan: {}, validation: { valid: true }, requirementGate: { valid: false, errors: ["R1"] } }).code, PLANNING_ERROR.REQUIREMENT)
  assert.equal(classifyPlanningFailure({ stopReason: "absolute-hard-timeout" }).code, PLANNING_ERROR.TIMEOUT)
  assert.equal(classifyPlanningFailure({ exitCode: 1, stderr: "connection reset" }).code, PLANNING_ERROR.TRANSPORT)
})

test("V16.2 direct lane accepts bounded edits, ignores negative side-effect text, and refuses actual push/publish", () => {
  const task = [
    "Only change README.md, package.json and package-lock.json current version from 16.1.0 to 16.2.0.",
    "Run the focused checks.",
    "DO NOT npm publish. Do not modify scripts/check-release-consistency.mjs or test/release-consistency.test.mjs.",
  ].join(" ")
  const direct = directLaneDecision(task, { risk: "high", readOnly: false }, { phases: [] })
  assert.equal(direct.eligible, true)
  assert.deepEqual(direct.files.sort(), ["README.md", "package-lock.json", "package.json"])

  const push = directLaneDecision(
    task + " Then run git push origin main.",
    { risk: "high", readOnly: false },
    { phases: [] },
  )
  assert.equal(push.eligible, false)
  assert.equal(push.reason, "external-workflow-side-effect")

  const publish = directLaneDecision(
    task + " Then perform npm publish.",
    { risk: "high", readOnly: false },
    { phases: [] },
  )
  assert.equal(publish.eligible, false)
})

test("V16.2 no-repeat recovery suppresses identical planner failures and bounded fallback wins", () => {
  const failure = { code: PLANNING_ERROR.PARSE, retryable: true, message: "bad json" }
  const fingerprint = planningFailureFingerprint(failure, { repairs: [] })
  const stop = planningRecoveryDecision({
    attempts: 2,
    maxAttempts: 2,
    failure,
    fingerprint,
    previousFingerprints: [fingerprint],
    task: "Refactor the whole repository",
    policy: { risk: "medium" },
    executionContract: { phases: [] },
  })
  assert.equal(stop.action, "STOP")
  assert.equal(stop.reason, "repeated-planning-failure")

  const fallback = planningRecoveryDecision({
    attempts: 1,
    maxAttempts: 2,
    failure,
    fingerprint,
    previousFingerprints: [],
    task: "Only change README.md current version from 1 to 2",
    policy: { risk: "low" },
    executionContract: { phases: [] },
  })
  assert.equal(fallback.action, "DIRECT_FALLBACK")

  const inferredFallback = planningRecoveryDecision({
    attempts: 1,
    maxAttempts: 2,
    failure: { code: PLANNING_ERROR.SCHEMA, retryable: true, message: "minor schema drift" },
    fingerprint: "different",
    previousFingerprints: [],
    task: "Implement the already-grounded narrow change",
    candidatePlan: PLAN,
    policy: { risk: "low" },
    executionContract: { phases: [] },
  })
  assert.equal(inferredFallback.action, "DIRECT_FALLBACK")
})

test("V16.2 controller wiring caps architect turns, preserves fallback evidence, and separates child tool timeout", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const [uesSource, childSource] = await Promise.all([
    readFile(path.join(root, "pi/extensions/ues.ts"), "utf8"),
    readFile(path.join(root, "pi/extensions/ues-child-runtime.ts"), "utf8"),
  ])

  assert.ok(uesSource.includes("if (architectTurns >= 2) return null"))
  assert.equal((uesSource.match(/await run\(\s*["']ues-architect["']/g) || []).length, 0)
  assert.ok(uesSource.includes("planning.direct-fallback"))
  assert.ok(uesSource.includes("Planner recovery evidence preserved for direct continuation"))
  assert.ok(uesSource.includes("planningBudget?.absoluteRunTimeoutMs"))
  assert.ok(uesSource.includes("UES_CHILD_TOOL_TIMEOUT_SEC"))

  assert.ok(childSource.includes("configuredToolTimeout"))
  assert.ok(childSource.includes("V16.2 per-tool ceiling"))
  assert.ok(childSource.includes("Math.min(requestedToolTimeout, configuredToolTimeoutSec)"))
})

test("V16.2 planner self-check combines schema/requirement/phase gates and grounds declared modify paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v16-2-self-check-"))
  try {
    await writeFile(path.join(root, "README.md"), "ok\n", "utf8")
    const good = plannerSelfCheck({
      root,
      plan: PLAN,
      validation: { valid: true, errors: [] },
      requirementGate: { valid: true, errors: [] },
      phaseGate: { valid: true, errors: [] },
    })
    assert.equal(good.valid, true)

    const missing = structuredClone(PLAN)
    missing.tasks[0].files.modify = ["missing.md"]
    const bad = plannerSelfCheck({
      root,
      plan: missing,
      validation: { valid: true, errors: [] },
      requirementGate: { valid: true, errors: [] },
    })
    assert.equal(bad.valid, false)
    assert.ok(bad.errors.some((item) => item.includes("missing modify path missing.md")))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
