// V16.6 regression tests for defects found by MEASUREMENT, not by review.
//
// Every test here corresponds to a behavior that was measurably wrong in the
// first V16.6 implementation and is now pinned so it cannot regress:
//
//   L1  explicit caller risk escalation was silently discarded
//   L2  explicit caller mode (long-horizon) was silently discarded
//   L3  the advisor role table was decorative: everything fell to root-cause
//   L4  deterministic work (version bump / typo / docs) opened the DeepSeek lane
//   L5  absence of risk evidence was treated as evidence of determinism
//   L6  repeated verifier failure did not reach DEEP
//   L7  nextjs tasks were routed to the UI advisor
//   L8  description compression delivered ~0% on real prose descriptions
//   L9  a safety bullet could be dropped by the minimal profile
//  L10  token metrics were double-wrapped, shadowing their provenance
//  L11  the observer reported a redaction on every event
//  L12  safety content was char-sliced away to hit a size target

import assert from "node:assert/strict"
import test from "node:test"

import { classifyEngineeringTask } from "../lib/task-policy.mjs"
import {
  computeOrchestrationBudget,
  applyOrchestrationBudgetToTaskPolicy,
  budgetFingerprint,
} from "../lib/orchestration-budget-v16-6.mjs"
import {
  deriveTaskSignals,
  detectDeterministicChangeKind,
} from "../lib/task-signal-bridge-v16-6.mjs"
import {
  describeToolForProfile,
  profileToolSurface,
  segmentDescription,
  segmentSentences,
  PROFILE_LIMITS,
} from "../lib/tool-description-profiles-v16-6.mjs"
import {
  createConversationSession,
  recordSessionTurn,
  sessionTelemetry,
} from "../lib/deepseek-session-budget.mjs"
import { estimateDeltaTokens, prepareEvidenceDelta } from "../lib/deepseek-evidence-requests.mjs"
import {
  createProgressObserverV2,
  progressTelemetryV2,
  recordProgressV2,
} from "../lib/progress-observer-v2.mjs"
import { PROVENANCE } from "../lib/measurement-provenance.mjs"

/**
 * The eval invariants, restated as predicates over an injected row.
 *
 * Kept here so a REGRESSION in the invariant itself is caught. An earlier
 * invariant was `(x <= 1 ? x : x) <= 5` - identical ternary branches, so it
 * could never fail and reported a vacuous PASS. Each predicate below is proven
 * to reject a deliberately broken row.
 */
const evalInvariants = {
  laneFollowUpsBounded: (row) =>
    row.v16_6.deepSeekTurnBudget.maxConsultations <= 3 && row.v16_6.deepSeekTurnBudget.maxFollowUps <= 2,
  noDeepSeekOnDeterministicWork: (row) => {
    const deterministic = (row.v16_6.reasons || []).some((signal) => String(signal).startsWith("deterministic:"))
    return !deterministic || row.v16_6.maxTurns === 0
  },
  riskEscalationReachesDeep: (row) => {
    const risky = (row.v16_6.reasons || []).some((signal) =>
      /risk=high|risk=critical|change-kind=security/.test(String(signal)),
    )
    return !risky || row.v16_6.executionProfile === "DEEP"
  },
  advisorRolesDiscriminate: (rows) => new Set(rows.map((row) => row.v16_6.advisorRole)).size >= 3,
  noAdvisorRoleWhenDeepSeekOff: (row) => row.v16_6.deepSeekMode !== "off" || row.v16_6.advisorRole === "none",
  delegationWithinHardMax: (row) => row.v16_6.maxChildren <= 3 && row.v16_6.maxParallel <= 3,
}

test("M1: every eval invariant REJECTS a deliberately broken row", () => {
  const good = {
    v16_6: {
      maxTurns: 0,
      advisorRole: "none",
      deepSeekMode: "off",
      executionProfile: "FAST",
      reasons: ["deterministic:docs"],
      maxChildren: 2,
      maxParallel: 2,
      deepSeekTurnBudget: { maxConsultations: 0, maxFollowUps: 0 },
    },
  }
  const goodRows = [
    good,
    { v16_6: { ...good.v16_6, maxTurns: 2, advisorRole: "root-cause", deepSeekMode: "balanced", executionProfile: "BALANCED", reasons: [], deepSeekTurnBudget: { maxConsultations: 1, maxFollowUps: 1 } } },
    { v16_6: { ...good.v16_6, maxTurns: 4, advisorRole: "architecture", deepSeekMode: "balanced", executionProfile: "DEEP", reasons: ["risk=high"], deepSeekTurnBudget: { maxConsultations: 2, maxFollowUps: 2 } } },
  ]
  for (const [name, predicate] of Object.entries(evalInvariants)) {
    if (name === "advisorRolesDiscriminate") continue
    assert.equal(predicate(good), true, `${name} accepts a healthy row`)
  }
  assert.equal(evalInvariants.advisorRolesDiscriminate(goodRows), true, "3 distinct roles pass")

  // Each invariant must fail on the specific violation it exists to catch.
  assert.equal(
    evalInvariants.laneFollowUpsBounded({ v16_6: { ...good.v16_6, deepSeekTurnBudget: { maxConsultations: 4, maxFollowUps: 3 } } }),
    false,
    "laneFollowUpsBounded rejects a follow-up count above the lane hard max",
  )
  assert.equal(
    evalInvariants.noDeepSeekOnDeterministicWork({ v16_6: { ...good.v16_6, maxTurns: 3 } }),
    false,
    "noDeepSeekOnDeterministicWork rejects turns granted to deterministic work",
  )
  assert.equal(
    evalInvariants.riskEscalationReachesDeep({ v16_6: { ...good.v16_6, reasons: ["risk=high"], executionProfile: "BALANCED" } }),
    false,
    "riskEscalationReachesDeep rejects an under-escalated high-risk task",
  )
  assert.equal(
    evalInvariants.advisorRolesDiscriminate([good, { ...good, v16_6: { ...good.v16_6, advisorRole: "root-cause" } }]),
    false,
    "advisorRolesDiscriminate rejects a corpus where every role is identical",
  )
  assert.equal(
    evalInvariants.noAdvisorRoleWhenDeepSeekOff({ v16_6: { ...good.v16_6, deepSeekMode: "off", advisorRole: "root-cause" } }),
    false,
    "noAdvisorRoleWhenDeepSeekOff rejects an advertised role on an off run",
  )
  assert.equal(
    evalInvariants.delegationWithinHardMax({ v16_6: { ...good.v16_6, maxChildren: 4 } }),
    false,
    "delegationWithinHardMax rejects a swarm-sized fan-out",
  )
})

test("M2: the eval script itself passes its strengthened invariants", async () => {
  const { execFileSync } = await import("node:child_process")
  const output = execFileSync(process.execPath, ["scripts/eval-v16-6.mjs"], {
    encoding: "utf8",
    cwd: process.cwd(),
  })
  assert.ok(output.includes("V16.6 eval: invariants hold"), "the eval gate reports its own result")
  const json = JSON.parse(output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1))
  assert.equal(json.scenarios, 20, "the corpus still covers 20 scenarios")
  for (const [name, value] of Object.entries(json.invariants)) {
    assert.equal(value, true, `invariant holds: ${name}`)
  }
  // The corpus must actually contain the release's hard cases.
  const ids = new Set(json.corpus.map((row) => row.id))
  for (const required of ["trivial-fix", "version-bump", "repeated-failure", "security-risk", "long-horizon", "ui-ux"]) {
    assert.ok(ids.has(required), `corpus covers ${required}`)
  }
  // Deterministic work must be free across the corpus.
  for (const row of json.corpus) {
    if (row.v16_6Profile === "FAST") {
      assert.equal(row.maxTurns.v16_6.value, 0, `${row.id}: a FAST profile spends zero DeepSeek turns`)
    }
  }
})


function budgetFor(text, extra = {}) {
  const taskPolicy = classifyEngineeringTask(text)
  return computeOrchestrationBudget({ taskPolicy, text, env: {}, ...extra })
}

test("L1: an explicit caller risk escalation is never discarded by the task policy default", () => {
  // lib/task-policy.mjs always returns a `risk` STRING (defaulting to "low"),
  // so `taskPolicy.risk || input.risk` silently dropped the caller's escalation.
  const text = "Rework the authentication and authorization subsystem across the API and the admin console"
  const withoutCallerRisk = budgetFor(text, { affectedFiles: 8, affectedSubsystems: 3 })
  const withCallerRisk = budgetFor(text, { affectedFiles: 8, affectedSubsystems: 3, risk: "high" })

  assert.equal(withoutCallerRisk.taskSignals.risk, "high", "the auth domain alone already raises risk")
  assert.equal(withCallerRisk.taskSignals.risk, "high", "an explicit risk must win, never be dropped")
  assert.equal(withCallerRisk.executionProfile, "DEEP", "an explicit high risk escalates to DEEP")

  // The downgrade direction must also work: a low caller risk cannot lower a
  // domain-detected high risk.
  const signals = deriveTaskSignals({
    taskPolicy: classifyEngineeringTask(text),
    risk: "low",
  })
  assert.equal(signals.risk, "high", "a caller can never downgrade repository-detected risk")
})

test("L2: an explicit caller mode is not discarded by the task policy default", () => {
  const text = "Plan and execute a phased migration of the whole runtime in verifiable stages"
  const budget = budgetFor(text, { affectedFiles: 2, affectedSubsystems: 1, mode: "long-horizon" })
  assert.equal(budget.taskSignals.longHorizon, true, "the declared mode is honored")
  assert.ok(budget.profileFloors.includes("mode=long-horizon"), "the floor is recorded")
  assert.equal(budget.executionProfile, "DEEP")
})

test("L3: the advisor role table discriminates instead of always falling back", () => {
  const cases = [
    ["Improve the empty states and spacing in the React settings screens", { affectedFiles: 7 }, "ui-ux-review"],
    ["Plan and execute a phased migration of the whole runtime in verifiable stages", { affectedFiles: 9, subsystems: 2, mode: "long-horizon" }, "architecture"],
  ]
  for (const [text, extra, expected] of cases) {
    const budget = budgetFor(text, extra)
    assert.equal(budget.deepSeekAdvisorRole, expected, `${text} selects ${expected}`)
    assert.ok(
      (budget.deepSeekAdvisorRoles.reasons || []).some((row) => !String(row).startsWith("fallback:")),
      "the selection is evidence-driven, not a fallback",
    )
  }

  // And a run that will never call DeepSeek must not advertise a role at all.
  const off = budgetFor("Bump the package version to 16.6.0", { affectedFiles: 2 })
  assert.equal(off.deepSeekMode, "off")
  assert.equal(off.deepSeekAdvisorRole, "none", "an off run reports no advisor role")
})

test("L4: deterministic work never opens the DeepSeek lane", () => {
  for (const text of [
    "Bump the package version to 16.6.0 in package.json and package-lock.json",
    "Fix a typo in the README",
    "Rewrite the installation section of the README",
  ]) {
    const budget = budgetFor(text, { affectedFiles: 2 })
    assert.equal(budget.deterministic, true, `${text} is deterministic`)
    assert.equal(budget.executionProfile, "FAST", `${text} stays FAST`)
    assert.equal(budget.deepSeekMode, "off", `${text} does not open DeepSeek`)
    assert.equal(budget.deepSeekTurnBudget.effectiveMaxTurns, 0, `${text} gets zero turns`)
  }
})

test("L5: absence of risk evidence is NOT evidence of determinism", () => {
  // These have no risk signal at all and a zero task-policy score, yet they are
  // genuine bug/UI work. They must NOT be downgraded to FAST.
  for (const text of [
    "Fix the Next.js app router route handler that returns 500 on POST",
    "Improve the empty states and spacing in the React settings screens",
  ]) {
    const budget = budgetFor(text, { affectedFiles: 3 })
    assert.equal(budget.deterministic, false, `${text} is not deterministic`)
    assert.notEqual(budget.executionProfile, "FAST", `${text} is not downgraded to FAST`)
    assert.ok(budget.deepSeekTurnBudget.effectiveMaxTurns > 0, `${text} keeps a reasoning budget`)
  }

  // A single file bound is a SCOPE signal, not a reasoning signal.
  const single = budgetFor("Fix the null dereference in lib/queue.mjs line 42", { affectedFiles: 1 })
  assert.equal(single.deterministic, false, "a one-file bug is still a bug hunt")
})

test("L6: a repeated verifier failure reaches DEEP", () => {
  const once = budgetFor("Finish the failing migration retry loop", { affectedFiles: 5, verifierFailures: 1 })
  const twice = budgetFor("Finish the failing migration retry loop", { affectedFiles: 5, verifierFailures: 2 })
  assert.notEqual(twice.executionProfile, "FAST")
  assert.ok(twice.profileFloors.includes("repeated-verifier-failure>=2"), "the floor is recorded")
  assert.ok(
    ["BALANCED", "DEEP"].includes(once.executionProfile),
    "one failure alone does not force DEEP",
  )
  assert.equal(twice.executionProfile, "DEEP")
})

test("L7: a full-stack framework is not routed to the UI advisor", () => {
  const budget = budgetFor("Fix the Next.js app router route handler that returns 500 on POST", { affectedFiles: 3 })
  assert.notEqual(budget.deepSeekAdvisorRole, "ui-ux-review", "a 500 in a route handler is a bug hunt")
  assert.equal(budget.changeKind, "bugfix")
})

test("L8: prose descriptions actually compress", () => {
  // The real shape: a single prose paragraph, no bullets.
  const prose =
    "Always-on read-only UES code intelligence for normal Pi chats. Provides bounded semantic/AST search, anchored reads, persistent LSP navigation/diagnostics, document ingestion, and reversible context access without starting the UES controller or a specialist child."
  const surface = [
    { name: "a", description: prose },
    { name: "b", description: "Control the single active session. Supports state inspection and bounded wait. Fails closed when no child session is active." },
    { name: "c", description: "Inspect the local UES service registry. Read-only listing with no mutation. Writes are rejected." },
  ]
  const minimal = profileToolSurface(surface, "minimal")
  const savedPct = 1 - minimal.stats.visibleChars.value / minimal.stats.originalChars.value
  assert.ok(savedPct >= 0.4, `minimal must save >=40% on prose (saved ${(savedPct * 100).toFixed(1)}%)`)
  assert.ok(savedPct <= 0.7, `minimal must not gut a description (saved ${(savedPct * 100).toFixed(1)}%)`)
  assert.equal(minimal.stats.protectiveLinesDropped.value, 0, "no safety unit is ever dropped")
  assert.equal(minimal.stats.fellBack.value, 0)
})

test("L9: a safety bullet survives every profile", () => {
  const description = [
    "Apply fail-closed hash-anchored edits.",
    "- A stale or mismatched anchor is rejected.",
    "- Re-read with ues_code instead of fuzzy retrying.",
    "- Writes are workspace-contained and never touch .env files.",
  ].join("\n")
  for (const profile of ["compact", "minimal"]) {
    const row = describeToolForProfile({ name: "edit", description }, profile)
    for (const line of description.split("\n").slice(1)) {
      assert.ok(row.description.includes(line), `${profile} keeps: ${line.slice(0, 40)}`)
    }
    assert.equal(row.droppedProtective.length, 0)
  }
})

test("L10: token metrics are not double-wrapped", () => {
  const session = createConversationSession({ id: "s1" })
  recordSessionTurn(session, { inputChars: 1000, outputChars: 400 })
  const telemetry = sessionTelemetry(session)

  for (const key of ["inputTokens", "outputTokens"]) {
    const metric = telemetry[key]
    assert.equal(typeof metric.value, "number", `${key}.value is a number, not a nested metric`)
    assert.equal(metric.provenance, PROVENANCE.ESTIMATED, `${key} keeps its ESTIMATED label`)
  }

  const delta = prepareEvidenceDelta({ kind: "diff", data: "x".repeat(1000) })
  const tokens = estimateDeltaTokens(delta)
  assert.equal(typeof tokens.value, "number")
  assert.equal(tokens.provenance, PROVENANCE.ESTIMATED, "an estimate is never relabelled DERIVED")
})

test("L11: the observer only counts REAL redactions", () => {
  const observer = createProgressObserverV2({ mode: "compact" })
  recordProgressV2(observer, "a", { note: "plain note one" })
  recordProgressV2(observer, "b", { note: "another plain note" })
  recordProgressV2(observer, "c", { note: "token sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" })
  recordProgressV2(observer, "d", { note: "third plain note" })

  const telemetry = progressTelemetryV2(observer)
  assert.equal(telemetry.events.value, 5, "every event is counted")
  assert.equal(telemetry.redactions.value, 1, "only the secret counted as a redaction")
})

test("L12: safety content is never truncated to hit a size target", () => {
  const safetyHeavy = Array.from(
    { length: 8 },
    (_, index) => `- NEVER write outside the workspace containment boundary number ${index}.`,
  ).join("\n")
  const row = describeToolForProfile({ name: "edit", description: safetyHeavy }, "minimal")
  assert.equal(row.droppedProtective.length, 0)
  assert.equal(row.overCharBudget, true, "the overage is reported, not silently truncated")
  for (const line of safetyHeavy.split("\n")) {
    assert.ok(row.description.includes(line))
  }
})

test("sentence segmentation never loses characters", () => {
  const lines = [
    "Always-on read-only tool. Provides bounded search. Fails closed without a session.",
    "See lib/foo.mjs for details. Reads are anchored.",
    "Config lives in package.json. Values are verified.",
  ]
  for (const line of lines) {
    const sentences = segmentSentences(line)
    assert.ok(sentences.length >= 1)
    // Rejoining must reproduce the original text (modulo trimmed whitespace).
    assert.equal(sentences.join(" ").replace(/\s+/g, " "), line.replace(/\s+/g, " ").trim())
  }
  // A file reference is NOT treated as a sentence boundary: "…lib/foo.mjs."
  // looks like a sentence end but is one clause. The conservative behavior is to
  // refuse the split and keep the line whole (the unit then still classifies as
  // protective, so the safety clause is not lost).
  const withPath = segmentSentences("Writes go to lib/foo.mjs. Never touch .env files.")
  assert.equal(withPath.length, 1, "a path is not a sentence boundary")
  assert.ok(withPath[0].includes("Never touch .env files."))

  const units = segmentDescription("Writes go to lib/foo.mjs. Never touch .env files.")
  assert.equal(units[0].kind, "protective", "the merged unit is still recognized as a safety statement")
})

test("the budget stays deterministic and safe for the release", () => {
  const text = "Rework the authentication and authorization subsystem"
  const a = budgetFor(text, { affectedFiles: 8, affectedSubsystems: 3, risk: "high" })
  const b = budgetFor(text, { affectedFiles: 8, affectedSubsystems: 3, risk: "high" })
  assert.equal(budgetFingerprint(a), budgetFingerprint(b), "the budget is deterministic")

  // Escalation may only happen with a recorded floor.
  const applied = applyOrchestrationBudgetToTaskPolicy(classifyEngineeringTask(text), a)
  assert.ok(Array.isArray(applied.v16_6.profileFloors))
  assert.equal(applied.v16_6.maxChildren <= 3, true, "delegation stays within the hard max")
  assert.ok(applied.v16_6.deepSeekTurnBudget.maxTurns <= 6, "turns stay under the policy ceiling")
})

test("the deterministic shape detector can only ever contribute a ceiling", () => {
  assert.equal(detectDeterministicChangeKind("Bump the package version to 16.6.0"), "version")
  assert.equal(detectDeterministicChangeKind("Fix a typo in the README"), "docs")
  assert.equal(detectDeterministicChangeKind("Rewrite the installation section of the README"), "docs")
  assert.equal(detectDeterministicChangeKind("Fix the auth bypass in the token verifier"), null)
  assert.equal(detectDeterministicChangeKind("Rewrite the payment reconciliation service"), null)
  assert.equal(detectDeterministicChangeKind(""), null)
})

test("segmentDescription keeps structural lines whole", () => {
  const description = ["Intro sentence. Another one.", "- A bullet.", "  - continuation", "- param: value"].join("\n")
  const units = segmentDescription(description)
  const lineUnits = units.filter((unit) => unit.source === "line")
  assert.ok(lineUnits.some((unit) => unit.text === "- A bullet."))
  assert.ok(units.some((unit) => unit.source === "sentence" && unit.text.startsWith("Intro sentence.")))
})

test("profile bounds remain declared for every profile", () => {
  assert.equal(PROFILE_LIMITS.full.maxInformativeUnits, Infinity)
  assert.ok(PROFILE_LIMITS.compact.maxInformativeUnits < PROFILE_LIMITS.full.maxInformativeUnits)
  assert.ok(PROFILE_LIMITS.minimal.maxInformativeUnits <= PROFILE_LIMITS.compact.maxInformativeUnits)
})
