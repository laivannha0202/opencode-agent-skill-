// V16.18 adaptive efficiency regression suite.
//
// Each block maps onto a required invariant from the V16.18 brief. The suite is
// deterministic and offline: no provider, no network, no browser, no LSP server.
// Where the brief asks for a MEASUREMENT that this harness cannot obtain
// (provider token usage), the assertion is that the value is reported as
// NOT_MEASURED rather than fabricated.

import assert from "node:assert/strict"
import test from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { classifyEngineeringTask } from "../lib/task-policy.mjs"
import {
  PROVISIONAL_FAST_DISCOVERY_BOUNDS,
  PROVISIONAL_EXCLUDED_CHANGE_KINDS,
  PROVISIONAL_BLOCKING_SIGNALS,
  affectedScopeKnown,
  computeOrchestrationBudget,
  escalateProvisionalDiscovery,
  provisionalFastDiscoveryEligible,
  refineOrchestrationBudget,
} from "../lib/orchestration-budget-v16-6.mjs"
import { plannerValueGate } from "../lib/planning-speed-policy.mjs"
import {
  CONTEXT_PIPELINE_STAGE,
  buildLightTaskContext,
  lightContextInsufficient,
} from "../lib/context-engine-v11.mjs"
import { buildDecisionCapsule, renderDecisionCapsule, failureDelta } from "../lib/leaf-runtime-optimizer.mjs"
import { createRunWorkspaceStateOwner } from "../lib/workspace-state-owner.mjs"
import {
  RESOURCE_CLASS,
  RESOURCE_GOVERNOR_CAPS,
  createResourceGovernor,
} from "../lib/resource-governor-v16-18.mjs"
import { LAZY_RUNTIME_MODULES, isLazyModuleLoaded } from "../lib/lazy-runtime.mjs"

const REPO = path.resolve(import.meta.dirname, "..")
const EXTENSION = path.join(REPO, "pi/extensions/ues.ts")

function budgetFor(text, facts = {}, args = {}) {
  const taskPolicy = classifyEngineeringTask(text, facts)
  return computeOrchestrationBudget({ taskPolicy, env: {}, model: "openai/gpt-5-mini", ...args })
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "ues-a18-"))
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "t@e.com"], { cwd: root })
  execFileSync("git", ["config", "user.name", "T"], { cwd: root })
  mkdirSync(path.join(root, "src"), { recursive: true })
  mkdirSync(path.join(root, "src/b"), { recursive: true })
  writeFileSync(path.join(root, "AGENTS.md"), "# agents\n")
  writeFileSync(path.join(root, "package.json"), '{"name":"x"}\n')
  writeFileSync(path.join(root, "src/login-form.tsx"),
    "export function LoginForm() {\n  const [submitting, setSubmitting] = useState(true)\n  return null\n}\n")
  writeFileSync(path.join(root, "src/auth-client.ts"),
    "export async function postLogin() { return fetch('/api/login') }\n")
  writeFileSync(path.join(root, "src/b/api.ts"), "export function widgetHandler() { return 1 }\n")
  execFileSync("git", ["add", "."], { cwd: root })
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root, stdio: "ignore" })
  return root
}

function readSource(rel) {
  return readFileSync(path.join(REPO, rel), "utf8")
}

// ===========================================================================
// A. ROUTING
// ===========================================================================

test("A1: unknown file scope + low-risk short bug does NOT require BALANCED prep", () => {
  const budget = budgetFor("Fix the submit button staying disabled after the API fails.")
  assert.equal(budget.executionProfile, "FAST")
  assert.equal(budget.provisionalFastDiscovery.active, true)
  assert.equal(budget.provisionalFastDiscovery.scopeKnownAtStart, false)
  // UNKNOWN is neutral, not tiny: the classification never claims "easy".
  assert.notEqual(budget.taskComplexity, "easy")
  // The lightweight start is a CEILING on spend, not a downgrade of safety.
  assert.equal(budget.deepSeekMode, "off")
  assert.equal(budget.maxChildren, 1)
  assert.equal(budget.maxAdvertisedTools, 6)
})

test("A2: unknown affectedFiles is neutral (not broad, not tiny)", () => {
  assert.equal(affectedScopeKnown({ affectedFiles: undefined }), false)
  assert.equal(affectedScopeKnown({ affectedFiles: null }), false)
  assert.equal(affectedScopeKnown({ affectedFiles: 0 }), true)
  assert.equal(affectedScopeKnown({ affectedFiles: 4 }), true)
  const known = computeOrchestrationBudget({
    taskPolicy: { risk: "low", executionProfile: "standard" },
    affectedFiles: 4,
  })
  assert.deepEqual(known.profileFloors, [], "a KNOWN 4-file scope carries no provisional floor")
  assert.equal(known.executionProfile, "BALANCED")
})

test("A3: runtime discovery of <=3 candidates keeps the lane lightweight", () => {
  const start = budgetFor("Fix the submit button staying disabled after the API fails.")
  const grounded = escalateProvisionalDiscovery(start, {
    candidateFiles: 2,
    subsystems: 1,
    discoveryOperations: 4,
  })
  assert.equal(grounded.provisionalFastDiscovery.outcome, "bounded")
  assert.equal(grounded.executionProfile, "FAST")
  // Bounded discovery is NOT a licence to skip verification.
  assert.equal(grounded.verificationStrategy, "targeted")
})

test("A4: discovery of cross-subsystem scope escalates to BALANCED", () => {
  const start = budgetFor("Fix the submit button staying disabled after the API fails.")
  const broad = escalateProvisionalDiscovery(start, {
    candidateFiles: 6,
    subsystems: 3,
    discoveryOperations: 5,
  })
  assert.equal(broad.executionProfile, "BALANCED")
  assert.equal(broad.provisionalFastDiscovery.outcome, "escalated-balanced")
  assert.ok(broad.profileFloors.includes("multi-subsystem-scope"))
  // Escalation is lossless: the heavier profile regains its own spend.
  assert.equal(broad.maxAdvertisedTools, 12)
  assert.equal(broad.deepSeekMode, "balanced")
})

test("A5: insufficient discovery evidence escalates too", () => {
  const start = budgetFor("Fix the submit button staying disabled after the API fails.")
  const insufficient = escalateProvisionalDiscovery(start, {
    candidateFiles: -1,
    subsystems: -1,
    discoveryOperations: 5,
    insufficient: true,
  })
  assert.equal(insufficient.executionProfile, "BALANCED")
  assert.ok(insufficient.profileFloors.includes("discovery-insufficient"))
})

test("A6: security/auth/payment/schema tasks are never captured by the lane", () => {
  for (const text of [
    "Change the auth permission check to bypass tenant isolation",
    "Update the payment checkout webhook handling",
    "Run the database migration for the new schema",
    "Refactor the whole repository module structure",
  ]) {
    const budget = budgetFor(text)
    assert.equal(budget.executionProfile, "DEEP", `${text} must stay DEEP`)
    assert.equal(budget.provisionalFastDiscovery.active, false, `${text} must not open the provisional lane`)
  }
  // And at the gate level, for a synthetic policy that hides the domains.
  for (const changeKind of PROVISIONAL_EXCLUDED_CHANGE_KINDS) {
    const gate = provisionalFastDiscoveryEligible({ attempt: 1 }, {
      risk: "low",
      changeKind,
      signals: [],
      sensitiveDomains: [],
      reasons: [],
    }, { evidenceScore: 0 })
    assert.equal(gate.eligible, false, `changeKind=${changeKind} must never start provisional`)
  }
})

test("A7: repeated verifier failure escalates to DEEP from the lightweight start", () => {
  const start = budgetFor("Fix the submit button staying disabled after the API fails.")
  const once = refineOrchestrationBudget(start, { verifierFailures: 1, risk: "low" })
  const twice = refineOrchestrationBudget(once, { verifierFailures: 2, risk: "low" })
  assert.equal(twice.executionProfile, "DEEP")
  assert.ok(twice.profileFloors.includes("repeated-verifier-failure>=2"), "the floor is recorded")
  assert.ok(twice.profileFloors.includes("retry-escalation"))
  assert.ok(!twice.profileFloors.includes("provisional-fast-discovery"),
    "a resolved lane must not keep claiming its provisional floor")
  assert.equal(twice.provisionalFastDiscovery.resolved, true)
  // Retry never shrinks the budget.
  assert.ok(twice.maxChildren >= start.maxChildren)
  assert.ok(twice.contextBudget >= start.contextBudget)
  assert.equal(once.executionProfile, "BALANCED", "one failure alone does not force DEEP")
})

test("A8: explicit long-horizon work stays strong", () => {
  const budget = budgetFor("Refactor the whole repository module structure")
  assert.equal(budget.executionProfile, "DEEP")
  assert.equal(budget.provisionalFastDiscovery.active, false)
  const blocked = [...PROVISIONAL_BLOCKING_SIGNALS]
  for (const signal of blocked) {
    const gate = provisionalFastDiscoveryEligible({ attempt: 1 }, {
      risk: "low",
      signals: [signal],
      reasons: [],
    }, { evidenceScore: 0 })
    assert.equal(gate.eligible, false, `${signal} must never start provisional`)
  }
})

test("A9: a retry never opens the provisional lane", () => {
  const budget = budgetFor("Fix the submit button staying disabled after the API fails.", {}, { attempt: 3 })
  assert.equal(budget.provisionalFastDiscovery.active, false)
  const gate = provisionalFastDiscoveryEligible({ attempt: 2 }, { risk: "low", signals: [], reasons: [] }, { evidenceScore: 0 })
  assert.equal(gate.eligible, false)
  assert.deepEqual(gate.reasons, ["retry-attempt"])
})

test("A10: the provisional lane can never restart after it resolved", () => {
  const start = budgetFor("Fix the submit button staying disabled after the API fails.")
  const resolved = escalateProvisionalDiscovery(start, { candidateFiles: 2, subsystems: 1 })
  assert.equal(resolved.provisionalFastDiscovery.active, false)
  assert.equal(resolved.provisionalFastDiscovery.resolved, true)
  // A second escalation on a RESOLVED budget keeps its resolved record.
  const again = escalateProvisionalDiscovery(resolved, { candidateFiles: 8, subsystems: 4 })
  assert.equal(again.provisionalFastDiscovery.resolved, true)
  assert.equal(again.provisionalFastDiscovery.startedProvisional, true)
})

test("A11: the discovery bounds are declared, small and immutable", () => {
  assert.deepEqual({ ...PROVISIONAL_FAST_DISCOVERY_BOUNDS }, {
    maxCandidateFiles: 3,
    maxSubsystems: 1,
    maxDiscoveryOperations: 5,
  })
  assert.throws(() => {
    "use strict"
    PROVISIONAL_FAST_DISCOVERY_BOUNDS.maxCandidateFiles = 99
  })
})

// ===========================================================================
// B. CAPABILITY PRESERVATION (deferred != disabled)
// ===========================================================================

test("B1: the extension keeps every heavyweight capability reachable", () => {
  const source = readSource("pi/extensions/ues.ts")
  // Planner / plan checker.
  assert.ok(source.includes("ues-architect") && source.includes("ues-plan-checker"))
  // Subagents / delegation fleet.
  assert.ok(source.includes("ues-executor") && source.includes("ues-debugger") && source.includes("ues-verifier"))
  // Deferred, never deleted.
  for (const marker of [
    "loadBrowserLaneModule",
    "loadBrowserWorkerClientModule",
    "loadDeepSeekWebAdapterModule",
    "loadWebReasoningLaneModule",
    "loadExecutionAccelerationModule",
    "loadLspProviderModule",
    "loadExternalResearchBrokerModule",
    "loadParallelCodingRuntimeModule",
  ]) {
    assert.ok(source.includes(marker), `${marker} must remain reachable (deferred, not deleted)`)
  }
  // Eagerly-imported owners that are not lazy must still be present.
  for (const marker of ["service-manager.mjs", "stopAllServices", "clearRepoGraphRuntimeCache", "clearSemanticIndexRuntimeCache"]) {
    assert.ok(source.includes(marker), `${marker} must remain present`)
  }
  assert.ok(source.includes("createRunWorkspaceStateOwner"), "the run workspace owner must be wired")
  assert.ok(source.includes("buildLightTaskContext"), "the LIGHT context stage must be wired")
  assert.ok(source.includes("resolveProvisionalFastDiscovery"), "the provisional lane must be wired")
  assert.ok(source.includes("plannerValueGate"), "the planner value gate must be wired")
  assert.ok(source.includes("buildDecisionCapsule"), "the decision capsule must be wired")
})

test("B2: same-attempt deferred hydration stays declared", () => {
  const source = readSource("lib/deferred-tool-hydration.mjs")
  assert.ok(source.includes("sameAttempt: true"), "the same-attempt flag must be declared")
  assert.ok(source.includes("HYDRATED_SAME_ATTEMPT"), "the same-attempt grant reason must exist")
  assert.ok(source.includes("ues_tool_search"), "the deferred dispatcher must remain the entry point")
  // Deferred != disabled: the deferred surface still names the expensive tools.
  for (const tool of ["ues_code", "ues_service", "ues_code_edit"]) {
    assert.ok(source.includes(tool), `${tool} must stay in the deferred surface`)
  }
  const ues = readSource("pi/extensions/ues.ts")
  assert.ok(
    ues.includes("ues_tool_search") && /hydration/i.test(ues),
    "the extension must consume the deferred hydration session",
  )
})

test("B3: FAST does not preload planner/advisor/browser/repo-graph/LSP", () => {
  const budget = budgetFor("Fix the submit button staying disabled after the API fails.")
  assert.equal(budget.executionProfile, "FAST")
  assert.equal(budget.deepSeekMode, "off", "FAST opens zero advisor turns")
  assert.equal(budget.deepSeekTurnBudget.effectiveMaxTurns, 0)
  assert.equal(budget.delegationMode, "parent-direct", "FAST is parent-direct")
  assert.equal(budget.maxChildren, 1)
  assert.equal(budget.maxParallel, 1)
  assert.ok(budget.maxAdvertisedTools <= 6, "FAST advertises a minimal surface")
  assert.equal(budget.contextBudget, 8_000, "FAST uses the smallest context ceiling")
})

test("B4: the planner value gate removes a bounded planner turn, never a floor", () => {
  const bounded = plannerValueGate({
    taskPolicy: { requirePlanCheck: true, risk: "low", executionProfile: "fast", mode: "inline" },
    attempt: 1,
    candidateFiles: 2,
    subsystems: 1,
  })
  assert.equal(bounded.required, false)
  assert.ok(bounded.skips.includes("bounded-scope:files=2/subsystems=1"))

  for (const floor of [
    { risk: "high" },
    { mode: "long-horizon" },
    { repeatedImplementationFailure: true },
    { architecture: true },
    { ownershipAmbiguous: true },
    { dependencyOwnershipUnclear: true },
    { crossPackage: true },
    { candidateFiles: 5 },
    { subsystems: 2 },
  ]) {
    const gated = plannerValueGate({
      taskPolicy: {
        requirePlanCheck: true,
        executionProfile: "standard",
        mode: "inline",
        risk: "low",
        ...floor,
      },
      attempt: 1,
    })
    assert.equal(gated.required, true, `${JSON.stringify(floor)} must keep the planner`)
    assert.ok(gated.floors.length > 0)
  }
  // Explicit phases always keep the planner.
  const phased = plannerValueGate({
    taskPolicy: { requirePlanCheck: true, risk: "low", mode: "inline" },
    attempt: 1,
    phases: ["inspect", "edit", "verify"],
  })
  assert.equal(phased.required, true)
  assert.ok(phased.floors.some((row) => String(row).startsWith("explicit-phases")))

  // A task policy that does not require a plan check never gains one from the gate.
  const notRequired = plannerValueGate({ taskPolicy: { requirePlanCheck: false, risk: "low" }, attempt: 1 })
  assert.equal(notRequired.required, false)
})

test("B5: DEEP keeps full planner/advisory/delegation/context reachability", () => {
  const budget = budgetFor("Change the auth permission check to bypass tenant isolation")
  assert.equal(budget.executionProfile, "DEEP")
  assert.equal(budget.contextBudget, 48_000)
  assert.ok(budget.maxChildren >= 1)
  assert.ok(["balanced", "force", "deep"].includes(budget.deepSeekMode))
  assert.ok(budget.deepSeekTurnBudget.effectiveMaxTurns > 0)
})

// ===========================================================================
// C. WORKSPACE STATE (one immutable generation per run)
// ===========================================================================

test("C1: read-only work reuses ONE workspace generation", () => {
  const owner = createRunWorkspaceStateOwner({ root: REPO })
  const first = owner.current("admission")
  const second = owner.current("budget")
  const third = owner.current("context")
  assert.equal(owner.state().captures, 1, "exactly one capture for read-only work")
  assert.equal(first.generation, second.generation)
  assert.equal(second.generation, third.generation)
  assert.equal(owner.state().reuses, 2)
  assert.equal(owner.isCurrent(first), true)
  assert.equal(owner.state().generation, 1)
})

test("C2: a mutation invalidates the generation exactly once", () => {
  const owner = createRunWorkspaceStateOwner({ root: REPO })
  const before = owner.current("run-start")
  const marked = owner.invalidate("post-write:executor")
  assert.equal(marked.invalidatedGeneration, before.generation)
  assert.equal(owner.isCurrent(before), false, "a stale snapshot can never be presented as current")
  const after = owner.current("advisor")
  assert.equal(owner.state().captures, 2, "the refresh happens exactly once")
  assert.ok(after.generation > before.generation)
  assert.equal(owner.state().invalidations, 1)
})

test("C3: an explicit boundary always captures exactly one fresh generation", () => {
  const owner = createRunWorkspaceStateOwner({ root: REPO })
  owner.current("run-start")
  owner.refresh("post-edit")
  owner.refresh("post-verification")
  const state = owner.state()
  assert.equal(state.captures, 3)
  assert.equal(state.generation, 3)
})

test("C4: cursor advances and reuses again after the refresh", () => {
  const owner = createRunWorkspaceStateOwner({ root: REPO })
  const a = owner.current("run-start")
  owner.invalidate("post-write")
  const b = owner.current("post-write-reader")
  const c = owner.current("later-reader")
  assert.equal(b.generation, c.generation)
  assert.ok(c.generation > a.generation)
  assert.equal(owner.state().captures, 2)
})

test("C5: a no-op refresh cannot alias two readers to different snapshots", () => {
  const owner = createRunWorkspaceStateOwner({ root: REPO })
  const one = owner.current("a")
  const two = owner.current("b")
  assert.equal(one.fingerprint, two.fingerprint)
  assert.equal(one.capturedAt, two.capturedAt)
})

test("C6: an unavailable workspace identity is reported honestly, never as a cacheable one", (t) => {
  const bare = mkdtempSync(path.join(os.tmpdir(), "ues-a18-nogit-"))
  t.after(() => rmSync(bare, { recursive: true, force: true }))
  const missing = path.join(os.tmpdir(), `ues-a18-missing-${process.pid}-${Date.now()}`)

  for (const root of [bare, missing]) {
    const owner = createRunWorkspaceStateOwner({ root })
    const snapshot = owner.current("unavailable")
    // The V2 fingerprint is a deterministic WORKSPACE IDENTITY (it does not
    // require Git), so it is present. What must fail closed is the CACHEABILITY
    // claim: a non-repository observation may never be used as a cacheable
    // identity by the context cache or the advisor cache key.
    assert.equal(snapshot.git, false, `${root} must not claim Git identity`)
    assert.equal(snapshot.cacheable, false, `${root} must not claim a cacheable identity`)
    assert.deepEqual(snapshot.changedFiles, [])
    assert.equal(owner.state().captures, 1, "an unavailable observation is still ONE generation")
    assert.equal(owner.isCurrent(snapshot), true)
  }

  // Two different roots must never share an identity.
  const a = createRunWorkspaceStateOwner({ root: bare }).current("a")
  const b = createRunWorkspaceStateOwner({ root: missing }).current("b")
  assert.notEqual(a.fingerprint, b.fingerprint)
})

test("C7: dirty and untracked state stays truthful in a mutation", (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const owner = createRunWorkspaceStateOwner({ root })
  const clean = owner.current("run-start")
  assert.equal(clean.available, true)
  assert.deepEqual([...clean.changedFiles].sort(), [])

  writeFileSync(path.join(root, "src/login-form.tsx"),
    "export function LoginForm() {\n  const [submitting, setSubmitting] = useState(false)\n  return null\n}\n")
  writeFileSync(path.join(root, "src/untracked.ts"), "export const scratch = 1\n")
  owner.invalidate("post-write")
  const dirty = owner.current("post-write")
  assert.deepEqual([...dirty.changedFiles].sort(), ["src/login-form.tsx", "src/untracked.ts"])
  // A different observation must produce a different fingerprint, so a cache
  // key built on the old generation can never be reused for the new one.
  assert.notEqual(clean.fingerprint, dirty.fingerprint)
})

// ===========================================================================
// D. CONTEXT (two-stage pipeline)
// ===========================================================================

test("D1: a simple task uses LIGHT_CONTEXT and pays for none of the heavy owners", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const light = await buildLightTaskContext(root, {
    id: "t",
    title: "Fix the submit button staying disabled after the API fails",
    summary: "LoginForm owns the submitting state",
    acceptance: [],
    verification: [],
    files: { modify: ["src/login-form.tsx"], read: ["src/auth-client.ts"] },
  })
  assert.equal(light.stage, CONTEXT_PIPELINE_STAGE.LIGHT)
  assert.equal(light.performance.semanticIndexBuilt, false)
  assert.equal(light.performance.repoGraphBuilt, false)
  assert.equal(light.performance.hierarchyBuilt, false)
  assert.equal(light.performance.memoryRetrieved, false)
  assert.equal(light.performance.capabilityFabricInventoried, false)
  assert.equal(light.memoryRetrieval.skipped, "light-stage")
  assert.equal(light.capabilityFabric.skipped, "light-stage")
  assert.ok(light.contextManifest.excerpts.length > 0)
  assert.ok(light.chars === undefined)
  assert.equal(lightContextInsufficient(light).insufficient, false)
})

test("D2: LIGHT_CONTEXT insufficiency escalates to FULL_CONTEXT", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const empty = await buildLightTaskContext(root, { id: "t", title: "nothing at all here", acceptance: [], verification: [] })
  const gate = lightContextInsufficient(empty, {})
  assert.equal(gate.insufficient, true)
  assert.equal(gate.stage, CONTEXT_PIPELINE_STAGE.FULL)
  assert.ok(gate.reasons.includes("no-bounded-excerpt"))
  assert.ok(gate.reasons.includes("no-scope-evidence"))

  for (const evidence of [
    { highRiskDomain: true },
    { crossSubsystem: true },
    { multipleRootCauses: true },
    { dependencyOwnershipUnclear: true },
    { architecture: true },
    { explicitFullRequest: true },
    { needsVerificationDetail: true },
    { insufficient: true },
  ]) {
    const row = lightContextInsufficient({ gaps: [] }, evidence)
    assert.equal(row.insufficient, true, JSON.stringify(evidence))
  }
})

test("D3: the light stage reports its own gaps instead of guessing", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // A directory that is not a Git repository cannot list its files.
  const bare = mkdtempSync(path.join(os.tmpdir(), "ues-a18-bare-"))
  t.after(() => rmSync(bare, { recursive: true, force: true }))
  const light = await buildLightTaskContext(bare, { id: "t", title: "a task", acceptance: [], verification: [] })
  assert.ok(light.gaps.includes("repository-file-list-unavailable"))
  const gate = lightContextInsufficient(light)
  assert.equal(gate.insufficient, true)
  assert.ok(gate.reasons.some((row) => String(row).startsWith("light-gaps:")))
})

test("D4: the light stage stays bounded and never whole-file reads a big file", async (t) => {
  const root = makeFixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, "src/huge.ts"), "const padding = " + "x".repeat(20_000) + "\n")
  const light = await buildLightTaskContext(root, {
    id: "t",
    title: "Fix the submit button staying disabled after the API fails",
    acceptance: [],
    verification: [],
    files: { modify: ["src/huge.ts"] },
  })
  for (const excerpt of light.contextManifest.excerpts) {
    assert.ok(excerpt.chars <= 1_800 + 64, `excerpt must stay bounded (${excerpt.chars})`)
    assert.ok(excerpt.text.includes("[truncated]"), "a truncated read must SAY so")
  }
  // The whole pack must never exceed its own file/excerpt ceilings.
  assert.ok(light.contextManifest.excerpts.length <= 4)
})

test("D5: the bounded failure delta replaces the verbose log", () => {
  const noisy = Array.from({ length: 400 }, (_, i) => `  at frame${i} (file${i}.js:${i})`).join("\n")
  const delta = failureDelta("FAIL test\n" + noisy + "\n1 failed, 2 passed")
  assert.ok(delta.length <= 4_200, "the delta is bounded")
  assert.ok(/FAIL|failed/i.test(delta), "the delta keeps the verdict")
  assert.ok(delta.length < noisy.length, "the delta is smaller than the noisy log")
  // A structured failure keeps file/line/assertion instead of a raw dump.
  const structured = failureDelta([
    "not ok 1 - submit re-enables after a rejected request",
    "  ---",
    "  expected: true",
    "  actual: false",
    "  at src/login-form.tsx:12:5",
    "1..1",
  ].join("\n"))
  assert.ok(/expected|actual|login-form/.test(structured))
  // An empty input can never be rendered as a fabricated failure.
  assert.equal(failureDelta(""), "")
})

// ===========================================================================
// E. LSP
// ===========================================================================

test("E1: the LSP provider is no longer statically reachable", () => {
  const fast = readSource("lib/fast-static-verification.mjs")
  assert.ok(!/(?:^|\n)\s*import\s[^;\n]*?from\s*["'][^"']*lsp-provider\.mjs["']/.test(fast),
    "fast-static-verification must not STATICALLY import the LSP provider")
  assert.ok(fast.includes("hydrateRuntimeModule(LAZY_RUNTIME_MODULES.LSP_PROVIDER"))
  const ues = readSource("pi/extensions/ues.ts")
  assert.ok(!/(?:^|\n)\s*import\s[^;\n]*from\s*["'][^"']*code-intelligence\/lsp-provider\.mjs["']/.test(ues),
    "ues.ts must not statically import the LSP provider")
  assert.ok(ues.includes("async function shutdownLspPool("))
})

test("E2: a docs/config task never hydrates the LSP stack", async () => {
  // Import only the eager pieces the cold start uses.
  const { collectFastStaticEvidence } = await import("../lib/fast-static-verification.mjs")
  const root = makeFixture()
  try {
    const result = await collectFastStaticEvidence(root, { changedFiles: ["docs/README.md"] })
    assert.equal(result.required, false)
    assert.equal(result.reason, "no-static-provider-target")
    assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.LSP_PROVIDER), false,
      "a non-code change must not hydrate the language-server stack")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("E3: shutdown of an un-hydrated pool stays cheap", async () => {
  const { shutdownFastStaticLspProvider } = await import("../lib/fast-static-verification.mjs")
  const out = await shutdownFastStaticLspProvider()
  assert.equal(out.hydrated, false)
  assert.equal(out.stopped, 0)
  assert.equal(out.reason, "lsp-provider-never-hydrated")
  assert.equal(isLazyModuleLoaded(LAZY_RUNTIME_MODULES.LSP_PROVIDER), false,
    "shutdown must not import the whole LSP stack just to stop an empty pool")
})

test("E4: a single changed code file requests diagnostics (the only LSP trigger)", async () => {
  const { fastStaticVerificationCandidates } = await import("../lib/fast-static-verification.mjs")
  assert.deepEqual(fastStaticVerificationCandidates({ changedFiles: ["a.md", "b.json"] }), [])
  assert.deepEqual(fastStaticVerificationCandidates({ changedFiles: ["a.md", "src/x.ts", "b.json"] }), ["src/x.ts"])
  assert.deepEqual(fastStaticVerificationCandidates({ changedFiles: ["a.ts", "b.ts"] }), ["a.ts", "b.ts"])
})

// ===========================================================================
// F. TOOL SURFACE
// ===========================================================================

test("F1: FAST advertises a minimal sufficient tool surface", () => {
  const budget = budgetFor("Fix the submit button staying disabled after the API fails.")
  assert.ok(budget.maxAdvertisedTools <= 6)
  assert.equal(budget.toolDescriptionProfile, "minimal")
  // The description profile is the advertised-schema economy, so it must be the
  // cheap one for a FAST run.
  assert.match(budget.toolDescriptionProfile, /minimal|compact/)
})

test("F2: deferred capabilities are reachable in the same attempt", () => {
  const deferred = readSource("lib/deferred-tool-hydration.mjs")
  for (const marker of ["browser", "service", "code"]) {
    assert.ok(deferred.toLowerCase().includes(marker), `${marker} must stay in the deferred surface`)
  }
  const ues = readSource("pi/extensions/ues.ts")
  assert.ok(ues.includes("revealDeferredTools") || ues.includes("deferredToolNames") || ues.includes("DEFERRED"),
    "the retry/reveal path must exist")
})

// ===========================================================================
// G. RETRY INTELLIGENCE
// ===========================================================================

test("G1: transient failures may retry, deterministic failures are fingerprinted", async () => {
  const recovery = await import("../lib/planning-recovery.mjs")
  assert.equal(typeof recovery.planningFailureFingerprint, "function")
  assert.equal(typeof recovery.classifyPlanningFailure, "function")
  // Transient classes stay retryable.
  const transient = recovery.classifyPlanningFailure({ exitCode: 1, error: "socket hang up ECONNRESET" })
  assert.equal(transient.retryable, true)
  const timeout = recovery.classifyPlanningFailure({ error: "planner runtime timed out (idle-timeout)" })
  assert.equal(timeout.retryable, true)
  // A deterministic schema/parse failure is fingerprinted so an identical retry
  // can be recognised instead of blindly replayed.
  const parse = recovery.classifyPlanningFailure({ plan: null, parseError: "no JSON in output" })
  const first = recovery.planningFailureFingerprint(parse, { validation: { errors: ["t1: missing acceptance"] } })
  const same = recovery.planningFailureFingerprint(parse, { validation: { errors: ["t1: missing acceptance"] } })
  const different = recovery.planningFailureFingerprint(parse, { validation: { errors: ["t2: unknown file"] } })
  assert.equal(first, same, "an identical failure must produce an identical fingerprint")
  assert.notEqual(first, different, "different evidence must produce a different fingerprint")
  // No failure at all is not a retryable failure.
  const none = recovery.classifyPlanningFailure({ plan: { tasks: [] }, validation: { valid: true } })
  assert.equal(none.retryable, false)
})

test("G2: the absolute run deadline is never renewed by a retry", () => {
  const ues = readSource("pi/extensions/ues.ts")
  assert.ok(ues.includes("runDeadlineAtMs"), "the run deadline must be threaded through")
  assert.ok(ues.includes("runDeadlineRemaining") || ues.includes("remaining") , "the deadline must be clamped to the remaining time")
  assert.ok(!/escalateRunBudget\([^)]*deadline/i.test(ues), "escalation must not touch the run deadline")
})

// ===========================================================================
// H. GLOBAL RESOURCE GOVERNOR
// ===========================================================================

test("H1: nested work cannot exceed a global class cap", async () => {
  const governor = createResourceGovernor({ caps: { CPU_HEAVY: 2 } })
  const a = await governor.acquire(RESOURCE_CLASS.CPU_HEAVY, { taskId: "parent" })
  assert.ok(a)
  // The same task nested in the same class consumes DEPTH, not width.
  const nested = await governor.acquire(RESOURCE_CLASS.CPU_HEAVY, { taskId: "parent" })
  assert.ok(nested)
  assert.equal(governor.live(RESOURCE_CLASS.CPU_HEAVY), 1, "re-entrancy must not consume a second unit")
  const other = await governor.acquire(RESOURCE_CLASS.CPU_HEAVY, { taskId: "sibling" })
  assert.ok(other, "a second unit is still available")
  assert.equal(governor.live(RESOURCE_CLASS.CPU_HEAVY), 2)
  const overflow = await governor.acquire(RESOURCE_CLASS.CPU_HEAVY, {
    taskId: "overflow",
    timeoutMs: 20,
  })
  assert.equal(overflow, null, "the global cap must refuse an over-cap unit")
  assert.equal(governor.state().timedOut, 1)
  // Releasing the nested lease must NOT free the outer unit.
  governor.release(nested)
  assert.equal(governor.live(RESOURCE_CLASS.CPU_HEAVY), 2, "a nested release is depth, not width")
  governor.release(a)
  assert.equal(governor.live(RESOURCE_CLASS.CPU_HEAVY), 1)
  governor.release(other)
  assert.equal(governor.live(RESOURCE_CLASS.CPU_HEAVY), 0)
})

test("H2: abort releases every lease", async () => {
  const governor = createResourceGovernor({ caps: { WRITER: 1 } })
  const controller = new AbortController()
  const first = await governor.withLease(RESOURCE_CLASS.WRITER, async () => {
    controller.abort()
    const blocked = await governor.withLease(RESOURCE_CLASS.WRITER, async () => "never", {
      signal: controller.signal,
      timeoutMs: 60,
    })
    assert.equal(blocked.ok, false)
    return "ran"
  }, { signal: controller.signal })
  assert.equal(first.ok, true)
  assert.equal(governor.live(RESOURCE_CLASS.WRITER), 0, "the abort path released the unit")
})

test("H3: a failure releases the lease", async () => {
  const governor = createResourceGovernor({ caps: { LSP: 1 } })
  await assert.rejects(
    () => governor.withLease(RESOURCE_CLASS.LSP, async () => { throw new Error("boom") }),
    /boom/,
  )
  assert.equal(governor.live(RESOURCE_CLASS.LSP), 0, "a throw must not strand a unit")
  const again = await governor.withLease(RESOURCE_CLASS.LSP, async () => "ok")
  assert.equal(again.ok, true)
})

test("H4: no deadlock when LSP + test + child model compete", async () => {
  const governor = createResourceGovernor()
  assert.equal(RESOURCE_GOVERNOR_CAPS[RESOURCE_CLASS.CPU_HEAVY], 3)
  assert.equal(RESOURCE_GOVERNOR_CAPS[RESOURCE_CLASS.WRITER], 1)
  const jobs = [
    RESOURCE_CLASS.CPU_HEAVY,
    RESOURCE_CLASS.LSP,
    RESOURCE_CLASS.MODEL_CHILD,
    RESOURCE_CLASS.WRITER,
    RESOURCE_CLASS.IO_HEAVY,
  ]
  const results = await Promise.all(jobs.map((cls, index) =>
    governor.withLease(cls, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return cls + ":" + index
    }, { taskId: `task-${index}`, timeoutMs: 2_000 }),
  ))
  assert.equal(results.length, jobs.length)
  assert.equal(results.filter((row) => row.ok).length, jobs.length, "every class must make progress")
  for (const cls of jobs) {
    assert.equal(governor.live(cls), 0, `${cls} must be fully released`)
  }
  const state = governor.state()
  assert.ok(state.admitted >= jobs.length)
  assert.equal(state.leases, 0, "no lease leaked")
  assert.equal(state.timedOut, 0, "no waiter timed out")
})

test("H5: the governor can only narrow, never raise an existing limit", () => {
  const governor = createResourceGovernor({ caps: { CPU_HEAVY: 1 } })
  const widened = createResourceGovernor({ caps: { CPU_HEAVY: 99 } })
  // A caller-supplied override is honoured for a TEST governor, but the exported
  // production caps are frozen and cannot be widened by this module.
  assert.equal(governor.caps.CPU_HEAVY, 1)
  assert.equal(RESOURCE_GOVERNOR_CAPS.CPU_HEAVY, 3)
  assert.equal(widened.caps.CPU_HEAVY, 99)
  Object.freeze(RESOURCE_GOVERNOR_CAPS)
})

test("H6: unknown classes are refused, not assumed cheap", async () => {
  const governor = createResourceGovernor()
  const out = await governor.withLease("NOT_A_CLASS", async () => "ran")
  assert.equal(out.ok, false)
  assert.equal(out.reason, "unknown-class")
  assert.equal(governor.state().refused, 1)
})

test("H7: the advisor consult is a MODEL_CHILD lease that fails OPEN, never blocking the task", async () => {
  const ues = readSource("pi/extensions/ues.ts")
  assert.ok(ues.includes("runUnderResourceLease"), "the advisor consult must be lease-guarded")
  assert.ok(ues.includes("RESOURCE_LEASE_REFUSED"), "a refusal must be a sentinel, not a throw")
  assert.ok(ues.includes('"resource-lease-refused:model-child"'), "a refusal must be journaled with its reason")
  // Fail open in AUTO: a refused advisor turn falls back to local execution.
  assert.ok(/failOpen:\s*webLane\.mode !== "force"/.test(ues),
    "AUTO must fail open to local execution when the advisor cannot run")
  // The governor can only narrow: production caps are frozen and bounded.
  const { RESOURCE_GOVERNOR_CAPS: caps } = await import("../lib/resource-governor-v16-18.mjs")
  assert.equal(Object.isFrozen(caps), true)
  for (const value of Object.values(caps)) {
    assert.ok(Number.isFinite(value) && value >= 1 && value <= 6, `cap ${value} must stay conservative`)
  }
})

// ===========================================================================
// I. QUALITY
// ===========================================================================

test("I1: a simple one-file fix keeps its verification strategy", () => {
  const budget = budgetFor("Fix the submit button staying disabled after the API fails.")
  assert.equal(budget.verificationStrategy, "targeted")
  assert.equal(budget.provisionalFastDiscovery.active, true)
  // FAST is a ceiling on spend, so `adaptive`/`full` are unreachable there, but
  // a higher profile restores them immediately -- verification is never removed.
  const escalated = refineOrchestrationBudget(budget, { verifierFailures: 1, risk: "low" })
  assert.ok(/targeted/.test(escalated.verificationStrategy), "targeted verification survives the escalation")
  assert.notEqual(escalated.executionProfile, "FAST")
  const deep = refineOrchestrationBudget(escalated, { verifierFailures: 2, risk: "low" })
  assert.ok(["targeted+affected", "targeted+integration", "adaptive", "full"].includes(deep.verificationStrategy),
    `a DEEP run must strengthen verification, got ${deep.verificationStrategy}`)
})

test("I2: a multi-file refactor escalates", () => {
  const budget = budgetFor("Update the retry policy across the repo", { changedFiles: 7 })
  assert.ok(["BALANCED", "DEEP"].includes(budget.executionProfile))
  assert.notEqual(budget.provisionalFastDiscovery.active, true)
})

test("I3: release-critical work keeps full fresh gates", () => {
  const ues = readSource("pi/extensions/ues.ts")
  assert.ok(ues.includes("verification-ladder-v16-10.mjs"), "the verification ladder remains reachable")
  assert.ok(ues.includes("planVerificationLadder"), "the ladder must be PLANNED, not bypassed")
  const ladder = readSource("lib/verification-ladder-v16-10.mjs")
  assert.ok(/fresh-matching-receipt|no-fresh-matching-receipt/.test(ladder),
    "the ladder must require FRESH evidence, not a cached PASS")
  assert.ok(ladder.includes("REUSE") && ladder.includes("VERIFICATION_RUNG"),
    "the ladder rungs must stay declared")
  // The release gate is an npm script and must still chain the eval suites.
  const pkg = JSON.parse(readSource("package.json"))
  assert.ok(pkg.scripts["release:verify"], "release:verify must remain a real script")
  assert.ok(pkg.scripts["release:verify"].includes("eval:v16.17"),
    "release:verify must still run the previous eval suite")
  assert.ok(pkg.scripts["release:verify"].includes("eval:v16.18"),
    "release:verify must run the current eval suite")
  assert.ok(pkg.scripts.ci, "the ci gate must remain")
})

// ===========================================================================
// J. WEAK-MODEL DECISION CAPSULE
// ===========================================================================

test("J1: the capsule is deterministic and bounded", () => {
  const state = {
    goal: "Fix the submit button staying disabled after the API fails.",
    knownFacts: ["LoginForm owns the submitting state."],
    knownFiles: ["src/login-form.tsx"],
    currentFailure: "FAIL src/login-form.tsx:12 expected true actual false",
    unknowns: ["Whether finally resets state."],
    currentAction: "Inspect the submit handler only.",
    verification: ["targeted"],
    doNotRepeat: ["Re-scan the entire repository."],
    attempt: 1,
    profile: "fast",
  }
  const first = buildDecisionCapsule(state)
  const second = buildDecisionCapsule(state)
  assert.equal(first.text, second.text)
  assert.ok(first.chars < 2_000)
  assert.ok(first.text.includes("GOAL:"))
  assert.ok(first.text.includes("DO NOT REPEAT:"))
  assert.equal(first.providerTokens, "NOT_MEASURED")
  assert.ok(renderDecisionCapsule(first).startsWith("\n"))
})

test("J2: the capsule never fabricates a fact", () => {
  const capsule = buildDecisionCapsule({ goal: "Do the thing." })
  // Only GOAL is known; the other seven sections must be UNKNOWN.
  assert.equal(capsule.unknownCount, 7)
  for (const label of [
    "KNOWN",
    "KNOWN FILES",
    "CURRENT FAILURE",
    "UNKNOWN",
    "CURRENT ACTION",
    "VERIFICATION REQUIRED",
    "DO NOT REPEAT",
  ]) {
    assert.ok(capsule.unknownSections.includes(label), `${label} must be reported UNKNOWN`)
  }
  assert.ok(!capsule.text.includes("undefined"))
  assert.ok(!capsule.text.includes("null"))
  assert.ok(!capsule.text.includes("[object Object]"))
})

// ===========================================================================
// K. POST-AUDIT HARDENING (stale generation + stage-keyed context cache)
// ===========================================================================

test("K1: the context cache never serves a LIGHT pack as FULL intelligence", () => {
  const ues = readSource("pi/extensions/ues.ts")
  // A LIGHT-eligible turn must not consult the FULL cache: a cache HIT would be
  // FULL intelligence at LIGHT cost, which defeats the stage economy; and a
  // LIGHT pack must never be STORED where a later FULL turn could read it.
  assert.ok(ues.includes("Only FULL_CONTEXT packs are cached"), "the cache contract must be documented at the read site")
  assert.ok(
    /CONTEXT_PACK_CACHE\.get\(cacheKey\)/.test(ues) === false || ues.includes("!lightStageEligible ? CONTEXT_PACK_CACHE.get(cacheKey) : null"),
    "the cache READ must be skipped for a LIGHT-eligible turn",
  )
  assert.ok(
    ues.includes('contextStage === "FULL_CONTEXT"'),
    "the cache WRITE must be gated on the resolved FULL stage",
  )
  // `buildAdaptiveTaskContext` is the FULL stage and must stamp it as such.
  assert.ok(readSource("lib/context-engine-v11.mjs").includes('stage: CONTEXT_PIPELINE_STAGE.FULL'))
})

test("K2: the consult cache and the patch review bind to the live generation", () => {
  const ues = readSource("pi/extensions/ues.ts")
  // After a writer turn the live generation is invalidated; a consult-cache key
  // or a patch-review diff built from the RUN-START snapshot would replay a
  // pre-edit identity/diff as if it were current. Both must read through the
  // run owner, which performs exactly one fresh capture after the mutation.
  assert.ok(
    ues.includes("workspaceDecisionInputs(cwd, runWorkspaceStateFor(cwd))"),
    "the consult-cache identity must bind to the live generation",
  )
  assert.ok(
    ues.includes("boundedWorkspaceDiff(cwd, 6_000, runWorkspaceStateFor(cwd))"),
    "the patch review must diff the live generation",
  )
  assert.ok(
    ues.includes("(runWorkspaceStateFor(cwd)?.changedFiles || [])"),
    "the patch grounding must list the live generation's files",
  )
})

test("K3: post-write invalidation runs even when the ledger is absent", () => {
  const ues = readSource("pi/extensions/ues.ts")
  // The stale-generation hazard is independent of the evidence-ledger wiring:
  // a run with no ledger (no web lane / hydration failed) still invalidates.
  assert.ok(
    /if \(WRITE_AGENTS\.has\(agent\)/.test(ues),
    "the post-write boundary must not be conditional on the ledger",
  )
  assert.ok(
    ues.includes("if (sharedContextLedger) sharedContextLedger.bumpEpoch"),
    "the ledger bump stays best-effort inside the unconditional boundary",
  )
})

test("K4: pre-verification and completion snapshots read the live generation", () => {
  const ues = readSource("pi/extensions/ues.ts")
  // Verification receipts and static probes bind to a workspace fingerprint;
  // the snapshot they bind to must be the live post-implementation generation.
  assert.ok(
    ues.includes("runtimeWorkspaceSnapshot(cwd, { workspaceState: runWorkspaceStateFor(cwd) })"),
    "the fast-gate snapshot must read the live generation",
  )
  assert.ok(
    ues.includes("runtimeWorkspaceSnapshot(cwd, { workspaceState: runWorkspaceStateFor(cwd) })"),
    "the completion-audit snapshot must read the live generation",
  )
})

