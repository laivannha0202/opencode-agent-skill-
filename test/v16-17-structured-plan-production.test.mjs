// V16.17 (§1) STRUCTURED-PLAN PRODUCTION PATH: run budget ledger is initialized.
//
// The defect (post-tag semantic audit of v16.17.0): `executeStructuredPlan` in
// pi/extensions/ues.ts USED `runBudgetLedger` (reserve / snapshot / settle) but
// never CREATED it. `createRunBudgetLedger` was imported and unused, so on the
// real structured-plan path every run-budget admission threw
// `ReferenceError: runBudgetLedger is not defined` -- and the terminal
// `wave-runtime-failed` return calls `scheduleReport()`, which reads
// `runBudgetLedger.snapshot()`, so a real wave failure hit the undefined path.
//
// This file drives the REAL shipped `executeStructuredPlan` through the SAME
// production module the controller uses (type-stripped from the shipped
// pi/extensions/ues.ts, no hand-written reimplementation). Pre-fix it throws
// `ReferenceError`; post-fix it returns a real schedule whose `runBudgetLedger`
// snapshot carries a real runStartedAt / runDeadlineAt derived from the run
// wall-clock config -- never epoch 0.
//
// The probe runs with `maxAttempts: 0`, so the attempt loop is skipped and the
// completion decision (which calls `scheduleReport()` -> `runBudgetLedger
// .snapshot()`) is reached deterministically with no child spawn and no model.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-17-structured-plan-probe")

// `typebox` is a Pi-host dependency that is not installed in the test
// environment. The extension only uses `Type.Object(...)` for tool parameter
// SCHEMAS, which are irrelevant to `executeStructuredPlan`; a recursive Proxy
// stub satisfies every schema expression without changing behavior under test.
const TYPEBOX_STUB = [
  "const handler = {",
  "  get: () => new Proxy(function () {}, handler),",
  "  apply: () => new Proxy(function () {}, handler),",
  "};",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n")

let booted = null

async function bootShippedExtension() {
  if (booted) return booted
  const probe = path.join(path.dirname(EXTENSION), `__v1617_structured_probe_${process.pid}.mjs`)
  const stub = path.join(PROBE_DIR, "typebox-stub.mjs")
  try {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(stub, TYPEBOX_STUB, "utf8")
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    })
    const stubUrl = pathToFileURL(stub).href
    source = source
      .replaceAll('from "typebox"', `from "${stubUrl}"`)
      .replaceAll("from 'typebox'", `from '${stubUrl}'`)
    writeFileSync(probe, source, "utf8")
    try {
      booted = { module: await import(pathToFileURL(probe).href) }
      return booted
    } finally {
      rmSync(probe, { force: true })
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

function readOnlyPlan(goal) {
  return {
    schemaVersion: 1,
    goal,
    tasks: [
      {
        id: "t1",
        title: "read-only inspection",
        summary: "inspect the repository without mutation",
        risk: "low",
        acceptance: ["inspection completes"],
        verification: ["inspection recorded"],
        dependsOn: [],
        files: { read: ["README.md"] },
      },
    ],
  }
}

test("V16.17 §1: the real executeStructuredPlan initializes exactly ONE run budget ledger", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(
    typeof module.executeStructuredPlan,
    "function",
    "the shipped extension must export the structured-plan production entry (test hook)",
  )

  const runStartedAt = Date.now()
  const runWallClockMs = 600_000
  const result = await module.executeStructuredPlan({
    plan: readOnlyPlan("V16.17 §1 ledger initialization"),
    root: ROOT,
    maxAttempts: 0,
    traceID: `v16-17-b1-${process.pid}`,
    runStartedAt,
    runWallClockMs,
    rootPolicy: {},
  })

  // Pre-fix this threw `ReferenceError: runBudgetLedger is not defined`.
  assert.equal(result.passed, true, "a valid read-only structured plan must complete")

  const ledger = result.schedule?.runBudgetLedger
  assert.ok(ledger, "the schedule must carry the run budget ledger snapshot")
  assert.equal(ledger.policy, "run-budget-ledger-v16-17")
  assert.ok(Number.isFinite(ledger.runStartedAt) && ledger.runStartedAt > 1_000_000_000_000,
    "runStartedAt must be the REAL run start, never epoch 0")
  assert.equal(ledger.runStartedAt, runStartedAt, "the ledger must honor the caller's real runStartedAt")
  assert.equal(ledger.runDeadlineAt, runStartedAt + runWallClockMs,
    "the run deadline must be derived from the real run wall-clock config")
})

test("V16.17 §1: the ledger is run-scoped (one per run) and observes real cumulative spend", async () => {
  const { module } = await bootShippedExtension()
  const runStartedAt = Date.now()
  const runWallClockMs = 600_000
  const result = await module.executeStructuredPlan({
    plan: readOnlyPlan("V16.17 §1 run-scoped ledger"),
    root: ROOT,
    maxAttempts: 0,
    traceID: `v16-17-b1-scope-${process.pid}`,
    runStartedAt,
    runWallClockMs,
    rootPolicy: {},
  })
  const ledger = result.schedule?.runBudgetLedger
  assert.ok(ledger, "the ledger snapshot must exist")
  // A single run-scoped ledger: ceilings derived from the canonical v16_6
  // budget (or the documented default fallback), never `undefined`.
  assert.ok(ledger.ceilings && Number.isFinite(ledger.ceilings.childTurns))
  assert.ok(ledger.spent && typeof ledger.spent === "object")
  // Run-scoped identity + deadline come from THIS run, not a shared/global one.
  assert.equal(ledger.runId, `v16-17-b1-scope-${process.pid}`)
  assert.equal(ledger.runWallClockMs, runWallClockMs)
  assert.equal(ledger.runDeadlineAt, runStartedAt + runWallClockMs)
  // Required verification is never removed by a spend/time decision.
  assert.equal(ledger.verificationIntact, true)
  // Token accounting is honest: an unmeasured run reports null, not zero.
  assert.equal(ledger.totalTokens, null)
  assert.equal(ledger.tokensMeasured, false)
  assert.equal(ledger.tokenProvenance, "NOT_MEASURED")
})

test("V16.17 §1: absent runStartedAt with a deadline starts the run now (never epoch 0)", async () => {
  const { module } = await bootShippedExtension()
  const before = Date.now()
  const runWallClockMs = 600_000
  const result = await module.executeStructuredPlan({
    plan: readOnlyPlan("V16.17 §1 absent-start-with-deadline"),
    root: ROOT,
    maxAttempts: 0,
    traceID: `v16-17-b1-nodeadline-${process.pid}`,
    // runStartedAt intentionally absent; a wall-clock deadline IS enabled.
    runWallClockMs,
    rootPolicy: {},
  })
  const ledger = result.schedule?.runBudgetLedger
  assert.ok(ledger, "the ledger snapshot must exist")
  assert.notEqual(ledger.runStartedAt, 0, "an absent runStartedAt must never be epoch 0")
  assert.ok(Number.isFinite(ledger.runStartedAt) && ledger.runStartedAt >= before,
    "an absent runStartedAt must resolve to the current run start, not epoch 0")
  assert.equal(ledger.runDeadlineAt, ledger.runStartedAt + runWallClockMs,
    "the deadline must be anchored to the resolved run start")
  assert.ok(ledger.runDeadlineAt > Date.now(), "the deadline must be in the future")
})

test("V16.17 §1: no wall-clock budget means no fabricated deadline (never epoch 0)", async () => {
  const { module } = await bootShippedExtension()
  const result = await module.executeStructuredPlan({
    plan: readOnlyPlan("V16.17 §1 no-deadline"),
    root: ROOT,
    maxAttempts: 0,
    traceID: `v16-17-b1-nowall-${process.pid}`,
    // runStartedAt AND runWallClockMs intentionally absent: no deadline at all.
    rootPolicy: {},
  })
  const ledger = result.schedule?.runBudgetLedger
  assert.ok(ledger, "the ledger snapshot must exist even with no wall-clock budget")
  assert.equal(ledger.runDeadlineAt, null, "no wall-clock budget must yield no deadline")
  assert.notEqual(ledger.runStartedAt, 0, "an absent runStartedAt must never be epoch 0")
})
