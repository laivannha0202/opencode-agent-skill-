// V16 completeness suite: requirement negatives (V16.1), all six adaptive
// strategies (V16.3), seen-context PINNED/isolation (V16.4), the false-pass
// gate, and cross-feature composition. Runtime behavior, not markers.
import test from "node:test"
import assert from "node:assert/strict"

import {
  compileRequirementLedger,
  evaluateRequirementEvidence,
  normalizeRequirementIds,
  validateRequirementPlanCoverage,
} from "../lib/requirement-contract.mjs"
import { buildFinalVerdictMatrix } from "../lib/execution-contract.mjs"
import { compileAdaptiveStrategy } from "../lib/adaptive-strategy.mjs"
import {
  observeSeenContext,
  resetSeenContextLedger,
  seenContextLedgerStats,
} from "../lib/seen-context-ledger.mjs"
import { compileToolSurface, coreToolPriorities } from "../lib/tool-surface-economy.mjs"
import { stableSystemPrefix } from "../lib/provider-cache-stability.mjs"
import {
  createDeferredHydrationSession,
  requestDeferredHydration,
  searchDeferredTools,
} from "../lib/deferred-tool-hydration.mjs"
import { buildTaskTelemetry } from "../lib/run-telemetry.mjs"

// ---- V16.1 requirement negatives ----

test("V16.1 vague tasks still compile to a MUST ledger, never to vacuous PASS", () => {
  const ledger = compileRequirementLedger("do stuff")
  assert.ok(ledger.total >= 1)
  assert.ok(ledger.requirements.every((item) => item.id.startsWith("R")))
  const verdict = evaluateRequirementEvidence(ledger, [])
  assert.equal(verdict.status, "REQUIREMENTS_NOT_VERIFIED")
  assert.equal(verdict.passed, 0)
})

test("V16.1 malformed and unknown requirement ids are rejected, not ignored", () => {
  const ledger = compileRequirementLedger("Add login. Must validate input. Must not log passwords.")
  assert.ok(ledger.total >= 2)
  const goodPlan = {
    tasks: ledger.requirements.map((item, index) => ({ id: `t${index + 1}`, requirementIds: [item.id] })),
  }
  const good = validateRequirementPlanCoverage(goodPlan, ledger)
  assert.equal(good.valid, true)
  const malformed = validateRequirementPlanCoverage(
    { tasks: [{ id: "t1", requirementIds: ["R1", "banana"] }] },
    ledger,
  )
  assert.equal(malformed.valid, false)
  assert.ok(malformed.errors.length > 0)
  const unknown = validateRequirementPlanCoverage(
    { tasks: [{ id: "t1", requirementIds: ["R999"] }] },
    ledger,
  )
  assert.equal(unknown.valid, false)
  const empty = validateRequirementPlanCoverage({ tasks: [] }, ledger)
  assert.equal(empty.valid, false)
  assert.deepEqual(normalizeRequirementIds(["r1", " R2 "]), ["R1", "R2"])
})

test("V16.1 bare PASS claims without concrete detail do NOT verify", () => {
  const ledger = compileRequirementLedger("Add login. Must validate input.")
  const id = ledger.requirements[0].id
  const bare = evaluateRequirementEvidence(ledger, [`UES_REQUIREMENT: ${id} PASS`])
  assert.ok(bare.notVerified.includes(id), "detail-free PASS must degrade to NOT_VERIFIED")
  assert.equal(bare.status, "REQUIREMENTS_NOT_VERIFIED")
  const evidenced = evaluateRequirementEvidence(ledger, [
    `UES_REQUIREMENT: ${id} PASS - verified by npm test login suite: 12 passing (auth.test.mjs)`,
  ])
  const row = evidenced.requirements.find((item) => item.id === id)
  assert.equal(row.status, "PASS")
  const failed = evaluateRequirementEvidence(ledger, [`UES_REQUIREMENT: ${id} FAIL - npm test: 1 failing`])
  assert.equal(failed.status, "REQUIREMENTS_FAIL")
  assert.ok(failed.failed.includes(id))
})

test("V16.1 device-gated work yields an explicit device-pending verdict, never full PASS", () => {
  const matrix = buildFinalVerdictMatrix("Verify login on a physical device via expo go", {
    primaryPass: true,
    primaryOutput: "UES_REQUIREMENT: R1 PASS - expo go session on device serial ABC123 shows login ok",
    primaryChecks: "npm test 12 passing",
  })
  assert.ok(["SOURCE_RUNTIME_PASS_DEVICE_NOT_VERIFIED", "PARTIAL_OR_NOT_VERIFIED"].includes(matrix.final))
  assert.equal(matrix.device, "DEVICE_NOT_VERIFIED")
  assert.notEqual(matrix.final, "PASS")
})

// ---- V16.3 six-strategy matrix ----

test("V16.3 all six edit strategies are reachable from real option combinations", () => {
  const seen = new Map()
  const probe = (name, options) => {
    const profile = compileAdaptiveStrategy({ model: "m", writer: true, attempt: 1, ...options })
    seen.set(profile.editStrategy, name)
    return profile
  }
  probe("search-replace", { task: "fix login bug" })
  probe("whole-file", { task: "create new file for the report" })
  probe("apply-patch", { task: "apply patch from the diff file" })
  probe("symbol-edit", { task: "rename the login handler function" })
  probe("range-edit", { task: "rename the login handler function", attempt: 2, recentFailure: "patch failed: anchor not found" })
  probe("architect-editor", { task: "refactor the auth service", surface: "compact", executionProfile: "deep" })
  for (const strategy of ["search-replace", "whole-file", "apply-patch", "symbol-edit", "range-edit", "architect-editor"]) {
    assert.ok(seen.has(strategy), `${strategy} must be reachable`)
  }
  const readOnly = compileAdaptiveStrategy({ model: "m", writer: false, task: "fix login bug" })
  assert.equal(readOnly.editStrategy, "none")
})

test("V16.3 retry shifts the failing dimension instead of repeating it", () => {
  const first = compileAdaptiveStrategy({ model: "m", writer: true, task: "fix login bug", attempt: 1 })
  const retry = compileAdaptiveStrategy({
    model: "m", writer: true, task: "fix login bug", attempt: 2,
    recentFailure: "edit-application failed: anchor not found",
  })
  assert.notEqual(retry.editStrategy, first.editStrategy)
  assert.equal(retry.retryPolicy, "change-one-or-more-failed-dimensions")
})

// ---- V16.4 seen-context PINNED + isolation ----

test("V16.4 PINNED entries never flip, scopes isolate sessions, TTL marks STALE", () => {
  resetSeenContextLedger("scope-a")
  resetSeenContextLedger("scope-b")
  const first = observeSeenContext("scope-a", "plan", "version one")
  assert.equal(first.state, "NEW")
  const same = observeSeenContext("scope-a", "plan", "version one")
  assert.equal(same.state, "UNCHANGED")
  const changed = observeSeenContext("scope-a", "plan", "version two")
  assert.equal(changed.state, "CHANGED")
  assert.equal(changed.restorable, true)
  assert.equal(changed.restorableState, "RESTORABLE")
  assert.ok((changed.previousText || "").includes("version one"))
  const pinned = observeSeenContext("scope-a", "pinned-key", "do not touch", { pinned: true })
  assert.equal(pinned.state, "PINNED")
  const pinnedAgain = observeSeenContext("scope-a", "pinned-key", "totally different text", { pinned: true })
  assert.equal(pinnedAgain.state, "PINNED")
  const isolated = observeSeenContext("scope-b", "plan", "version one")
  assert.equal(isolated.state, "NEW", "a second session must not inherit the first session's sightings")
  const staleScope = "stale-scope"
  resetSeenContextLedger(staleScope)
  observeSeenContext(staleScope, "k", "old text", { now: 1000, ttlMs: 5000 })
  const stale = observeSeenContext(staleScope, "k", "old text", { now: 1000 + 5000 + 60 * 1000, ttlMs: 5000 })
  assert.equal(stale.state, "STALE")
  assert.ok(stale.staleAgeMs > 0)
  const stats = seenContextLedgerStats("scope-a")
  assert.ok(stats.entries >= 2)
  resetSeenContextLedger("scope-a")
  resetSeenContextLedger("scope-b")
  resetSeenContextLedger(staleScope)
  assert.equal(seenContextLedgerStats("scope-a").entries, 0)
})

// ---- False-pass hardening across the verdict path ----

test("false-pass: no verdict path reports PASS on claim-only evidence", () => {
  const ledger = compileRequirementLedger("Ship checkout. Must charge once. Must not double-charge.")
  const planVerdict = validateRequirementPlanCoverage({ tasks: [] }, ledger)
  assert.equal(planVerdict.valid, false)
  const matrix = buildFinalVerdictMatrix("Ship checkout", {
    primaryPass: true,
    primaryOutput: "done, trust me",
    primaryChecks: "looks good",
  })
  assert.notEqual(matrix.final, "PASS")
  assert.ok(["RUNTIME_NOT_VERIFIED", "RUNTIME_NOT_REQUIRED"].includes(matrix.runtime))
})

// ---- Cross-feature composition ----

test("cross-feature: strategy, economy, hydration, prefix, and telemetry compose", () => {
  const strategy = compileAdaptiveStrategy({ model: "m", writer: true, task: "fix login bug", attempt: 1 })
  const tools = ["read", "grep", "find", "ls", "bash", "powershell", "edit", "write", "ues_code", "ues_code_edit", "ues_service", "ues_tool_search"]
  const surface = compileToolSurface(
    tools,
    { maxAdvertisedTools: 7, surface: "compact" },
    coreToolPriorities(tools, { task: "fix login bug", writer: true, executionProfile: "standard", platform: "win32", attempt: 1 }),
    { task: "fix login bug", writer: true, executionProfile: "standard", platform: "win32", attempt: 1 },
  )
  assert.ok(surface.advertised.includes("ues_tool_search"))
  const session = createDeferredHydrationSession({
    deferred: surface.deferred, advertised: surface.advertised, writer: true,
  })
  const found = searchDeferredTools({ query: surface.deferred[0], deferred: surface.deferred, writer: true })
  assert.ok(found.results.length > 0)
  assert.equal(found.results[0].tool, surface.deferred[0], "exact-name discovery must rank the tool first")
  const grant = requestDeferredHydration(session, found.results[0].tool)
  assert.equal(grant.granted, true)
  const prefix = stableSystemPrefix("# Agent\nFix the login bug.")
  const telemetry = buildTaskTelemetry(
    {
      toolExposure: {
        economy: { schemaPrefixHash: surface.schemaPrefixHash },
        prefixHashes: { systemPrefixHash: prefix.hash, projectPrefixHash: null, evidence: prefix.evidence },
      },
      allowedTools: surface.advertised,
      toolNames: [],
    },
    {},
  )
  assert.ok(telemetry.metrics.schemaPrefixHash)
  assert.equal(telemetry.metrics.systemPrefixHash, prefix.hash)
  assert.equal(telemetry.metrics.prefixHashEvidence, "FINGERPRINTED")
  assert.equal(strategy.evidence, "HEURISTIC")
})
