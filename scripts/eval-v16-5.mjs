// V16.5 deterministic evaluation.
//
// Measures the V16.5 pipeline on a fixed corpus and compares it with the V16.4
// baseline behavior (legacy compileSkillContext + V16.2 tool surface economy).
//
// This is a DETERMINISTIC FIXTURE run. It measures CHARACTERS, TOOL COUNTS and
// CALL COUNTS. It makes NO claim about model quality, speed or provider tokens:
// those require a real-model A/B run and are reported as NOT_MEASURED here.
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { skillRegistry, skillRegistrySurface } from "../lib/skill-registry.mjs"
import { routeSkills } from "../lib/skill-router.mjs"
import { compileSkillCapsule } from "../lib/skill-capsule.mjs"
import { compilePhaseToolSurface, finalizeToolSurfaceTelemetry } from "../lib/tool-surface-v3.mjs"
import { compileToolSurface, coreToolPriorities, estimateToolSchemaTax } from "../lib/tool-surface-economy.mjs"
import { compileSkillContext } from "../lib/skill-compiler.mjs"
import { decideDelegation, DELEGATION_DECISION } from "../lib/subagent-fabric.mjs"
import { createDelegationSession } from "../lib/subagent-fabric.mjs"
import { createDelegationFleetTelemetry, delegationFleetTelemetry, runDelegationWave } from "../lib/delegation-fleet.mjs"
import { createHandoffCapsule, renderHandoffCapsule } from "../lib/verified-handoff.mjs"
import { buildAdvisorPacket, ADVISOR_ROLES } from "../lib/deepseek-advisor-roles.mjs"
import { reasoningDoctor } from "../lib/reasoning-doctor.mjs"
import { createProgressObserver, renderProgress, upsertLane } from "../lib/agent-progress-observer.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
void root

const UNIVERSE = [
  "read", "grep", "find", "ls", "bash", "powershell", "edit", "write",
  "ues_code", "ues_code_edit", "ues_service", "ues_evidence_get", "ues_tool_search",
  "playwright_browser_navigate", "playwright_browser_snapshot", "playwright_browser_click",
]

const CORPUS = [
  { id: "trivial-fix", task: "fix the off-by-one in src/parser.ts", role: "executor" },
  { id: "nextjs-route", task: "Fix the Next.js app router route handler that returns 500 on POST", role: "executor" },
  { id: "nestjs-di", task: "NestJS dependency injection fails after upgrading @nestjs/core v11", role: "debugger" },
  { id: "rn-build", task: "React Native Android build fails after upgrading the Expo SDK", role: "debugger" },
  { id: "authz", task: "Authorization check lets a normal user read another tenant's records", role: "executor" },
  { id: "payment", task: "Payment webhook is not idempotent and double-charges on retry", role: "debugger" },
  { id: "database", task: "Database migration locks a large table and needs a safe online strategy", role: "executor" },
  { id: "performance", task: "Endpoint latency is 900ms; profile the hot path and reduce query cost", role: "debugger" },
  { id: "browser", task: "Verify the responsive layout at mobile breakpoints in the browser", role: "visual-verifier" },
  { id: "review", task: "Review the staged diff for correctness regressions before merge", role: "reviewer" },
  { id: "docs", task: "Rewrite the installation section of the README", role: "executor" },
  { id: "docs-vi", task: "Viết lại phần cài đặt trong README cho người dùng mới", role: "executor" },
  { id: "vi-bug", task: "Sửa lỗi đăng nhập bị lỗi sau khi cập nhật, nhanh giúp tôi tìm nguyên nhân", role: "debugger" },
  { id: "mixed-payment-next", task: "Next.js checkout page calls the payment API without an idempotency key", role: "executor" },
  { id: "ambiguous", task: "Make it better", role: "executor" },
]

const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

// ---------------------------------------------------------------------------
// Bounded parallel delegation measurement.
//
// A REAL multi-child run through the production executor
// (lib/delegation-fleet.mjs, the module pi/extensions/ues.ts calls). The child
// bodies are deterministic in-process fixtures, so what is measured is the
// DISPATCH OVERLAP of child execution windows: safeWaveCount,
// parallelDelegations, serializedDelegations, maxObservedChildConcurrency,
// childQueueMs, childExecutionMs, parallelWallMs, sequentialEquivalentMs and
// overlapSavingsMs.
//
// This is NOT a speedup claim. It does not measure model latency, provider
// tokens, or end-to-end task duration. `speedupClaim` stays null.
// ---------------------------------------------------------------------------
async function measureBoundedParallelDelegation() {
  const fixtures = [
    {
      id: "safe-read-only-pair",
      // explore + test-analysis on disjoint scopes: the documented safe example.
      scopes: [
        { id: "explore", role: "explore", readOnly: true, files: ["src/auth.ts"], task: "map auth" },
        { id: "test-analysis", role: "test-analysis", readOnly: true, files: ["test/auth.test.ts"], task: "analyse auth tests" },
      ],
      budgetMs: 250,
    },
    {
      id: "bounded-concurrency-two",
      scopes: [
        { id: "lane-1", role: "explore", readOnly: true, files: ["src/a.ts"], task: "map a" },
        { id: "lane-2", role: "review", readOnly: true, files: ["src/b.ts"], task: "review b" },
        { id: "lane-3", role: "diagnose", readOnly: true, files: ["src/c.ts"], task: "diagnose c" },
        { id: "lane-4", role: "review", readOnly: true, files: ["src/d.ts"], task: "review d" },
      ],
      budgetMs: 120,
    },
    {
      id: "unsafe-overlapping-writers",
      scopes: [
        { id: "writer-1", role: "implement", readOnly: false, files: ["src/shared.ts"], task: "edit shared" },
        { id: "writer-2", role: "implement", readOnly: false, files: ["src/shared.ts"], task: "edit shared again" },
      ],
      budgetMs: 120,
    },
    {
      id: "unsafe-external-side-effect",
      scopes: [
        { id: "publish", role: "implement", readOnly: false, files: ["package.json"], task: "npm publish the release" },
        { id: "deploy", role: "implement", readOnly: false, files: ["docker/app.yml"], task: "deploy to production" },
      ],
      budgetMs: 120,
    },
  ]

  const rows = []
  for (const fixture of fixtures) {
    const telemetry = createDelegationFleetTelemetry()
    const session = createDelegationSession({ parentId: "eval", parentAgent: "controller" })
    const result = await runDelegationWave({
      session,
      telemetry,
      scopes: fixture.scopes,
      maxParallel: 2,
      execute: async (scope) => {
        // Deterministic stand-in for a child process lifetime. The executor is
        // the real one; only the child body is a fixture.
        await new Promise((resolve) => setTimeout(resolve, fixture.budgetMs))
        return { exitCode: 0, output: scope.id }
      },
    })
    rows.push({
      id: fixture.id,
      waves: result.waves.length,
      safeWaves: result.waves.filter((wave) => wave.parallel).length,
      parallelDelegations: result.telemetry.parallelDelegations,
      serializedDelegations: result.telemetry.serializedDelegations,
      maxObservedChildConcurrency: result.telemetry.maxObservedChildConcurrency,
      childQueueMs: result.telemetry.childQueueMs,
      childExecutionMs: result.telemetry.childExecutionMs,
      parallelWallMs: result.telemetry.parallelWallMs,
      sequentialEquivalentMs: result.telemetry.sequentialEquivalentMs,
      overlapSavingsMs: result.telemetry.overlapSavingsMs,
      blockReasons: result.blockReasons,
      passed: result.passed,
      canProduceVerdict: result.canProduceVerdict,
      noOrphans: result.noOrphans,
    })
  }

  const snapshot = delegationFleetTelemetry(createDelegationFleetTelemetry())
  return {
    fixtures: rows,
    speedupClaim: snapshot.speedupClaim,
    measurementScope: snapshot.measurementScope,
    concurrencyBudget: { default: snapshot.limits.defaultConcurrency, hardMax: snapshot.limits.hardMaxConcurrency },
  }
}

async function baselineSkillChars(task, role) {
  const context = await compileSkillContext({}, role, { taskText: task, maxSkills: 3, totalChars: 3_200 })
  return { chars: context.chars, loaded: context.loaded.length }
}

function baselineToolSurface(task, writer) {
  const core = coreToolPriorities(UNIVERSE, { task, writer, executionProfile: "standard", editStrategy: "search-replace" })
  const surface = compileToolSurface(UNIVERSE, { maxAdvertisedTools: 8, editStrategy: "search-replace", attempt: 1 }, core, { task, writer, executionProfile: "standard", editStrategy: "search-replace", attempt: 1 })
  return { tools: surface.advertised.length, chars: surface.schemaTax.estimatedChars, names: surface.advertised }
}

async function main() {
  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "ues-v16-5-eval-"))
  const rows = []
  try {
    for (const item of CORPUS) {
      const routed = routeSkills({ task: item.task })
      const capsule = routed.activated.length
        ? await compileSkillCapsule({
            skillIds: routed.activated,
            taskContract: item.task.slice(0, 200),
            budgetChars: 2_600,
            skillsConsidered: routed.considered,
          })
        : null

      const baseSkills = await baselineSkillChars(item.task, item.role)
      const writer = item.role === "executor"
      const baseTools = baselineToolSurface(item.task, writer)
      const v3Surface = compilePhaseToolSurface({ task: item.task, universe: UNIVERSE, maxAdvertisedTools: 8 })
      finalizeToolSurfaceTelemetry(v3Surface, { toolsUsed: [] })

      const decision = decideDelegation({ task: item.task, requestedRole: item.role === "executor" ? "implement" : "review" })

      rows.push({
        id: item.id,
        language: routed.language,
        skillsConsidered: routed.considered,
        skillsActivated: routed.activated.length,
        activatedIds: routed.activated,
        skillCapsuleChars: capsule?.chars ?? 0,
        rawSkillChars: capsule?.rawSkillChars ?? 0,
        rawSkillCharsAvoided: capsule?.telemetry.rawSkillCharsAvoided ?? 0,
        baselineSkillChars: baseSkills.chars,
        baselineSkillsLoaded: baseSkills.loaded,
        baselineToolCount: baseTools.tools,
        baselineToolChars: baseTools.chars,
        v165ToolCount: v3Surface.advertised.length,
        v165ToolChars: v3Surface.toolSurfaceChars,
        v165Phase: v3Surface.phase,
        v165SafetyEnforced: v3Surface.safetyEnforced.length,
        delegationDecision: decision.decision,
      })
    }

    const handoff = await createHandoffCapsule(evidenceRoot, {
      childId: "ch-eval",
      parentId: "p-eval",
      role: "diagnose",
      agent: "debugger",
      task: "diagnose the checkout 500",
      rawOutput: "child transcript line\n".repeat(4_000),
      findings: ["TypeError at lib/auth.mjs:42", "token was null after refresh"],
      risks: ["refresh race"],
      unresolvedQuestions: ["is refresh rotated?"],
      proposedActions: ["add a regression test"],
      relevantFiles: ["lib/auth.mjs"],
      evidenceRefs: ["ev:log-1"],
    })
    const rendered = renderHandoffCapsule(handoff)

    const advisor = buildAdvisorPacket({
      role: ADVISOR_ROLES.ROOT_CAUSE,
      symptoms: ["checkout 500 on POST"],
      candidateCauses: ["null token", "refresh race"],
      evidence: ["TypeError at lib/auth.mjs:42"],
      failedAttempts: ["restarted the service"],
      maxChars: 8_000,
    })

    const doctor = reasoningDoctor({ mode: "AUTO", adapterAvailable: true, profileConfigured: true })
    const observer = createProgressObserver({ phase: "delegation" })
    upsertLane(observer, { id: "explore", state: "completed", action: "mapped auth surface" })
    upsertLane(observer, { id: "diagnose", state: "running", action: "reproducing failure" })
    upsertLane(observer, { id: "deepseek", state: "skipped", action: "not needed" })
    upsertLane(observer, { id: "verify", state: "pending" })
    const progress = renderProgress(observer)

    const parallelDelegation = await measureBoundedParallelDelegation()
    const safePair = parallelDelegation.fixtures.find((row) => row.id === "safe-read-only-pair")
    const writers = parallelDelegation.fixtures.find((row) => row.id === "unsafe-overlapping-writers")
    const sideEffect = parallelDelegation.fixtures.find((row) => row.id === "unsafe-external-side-effect")
    const bounded = parallelDelegation.fixtures.find((row) => row.id === "bounded-concurrency-two")

    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0)
    const avg = (rows, key) => (rows.length ? round(sum(rows, key) / rows.length) : 0)

    const summary = {
      schemaVersion: 1,
      release: "v16.5",
      deterministic: true,
      corpus: CORPUS.length,
      registrySkills: skillRegistry().skillCount,
      registrySurfaceChars: skillRegistrySurface().chars,
      pass: true,
      measurements: {
        skillsConsideredAverage: avg(rows, "skillsConsidered"),
        skillsActivatedAverage: avg(rows, "skillsActivated"),
        skillsActivatedMax: rows.reduce((max, row) => Math.max(max, row.skillsActivated), 0),
        skillCapsuleCharsAverage: avg(rows, "skillCapsuleChars"),
        baselineSkillCharsAverage: avg(rows, "baselineSkillChars"),
        skillCharsDeltaVsBaseline: round(avg(rows, "skillCapsuleChars") - avg(rows, "baselineSkillChars")),
        rawSkillCharsAvoidedTotal: sum(rows, "rawSkillCharsAvoided"),
        baselineToolCountAverage: avg(rows, "baselineToolCount"),
        v165ToolCountAverage: avg(rows, "v165ToolCount"),
        baselineToolCharsAverage: avg(rows, "baselineToolChars"),
        v165ToolCharsAverage: avg(rows, "v165ToolChars"),
        toolCharsDeltaVsBaseline: round(avg(rows, "v165ToolChars") - avg(rows, "baselineToolChars")),
        delegations: rows.filter((row) => row.delegationDecision === DELEGATION_DECISION.DELEGATE).length,
        parentDirect: rows.filter((row) => row.delegationDecision === DELEGATION_DECISION.PARENT_DIRECT).length,
        handoffRawChars: handoff.measurements.rawChildChars,
        handoffChars: rendered.chars,
        handoffRatio: handoff.measurements.handoffRatio,
        advisorPacketChars: advisor.chars,
        safetyCapabilitiesEnforcedPerSurface: rows[0]?.v165SafetyEnforced ?? 0,
      },
      boundedParallelDelegation: {
        safeWaveCount: parallelDelegation.fixtures.reduce((total, row) => total + row.safeWaves, 0),
        parallelDelegations: parallelDelegation.fixtures.reduce((total, row) => total + row.parallelDelegations, 0),
        serializedDelegations: parallelDelegation.fixtures.reduce((total, row) => total + row.serializedDelegations, 0),
        maxObservedChildConcurrency: Math.max(...parallelDelegation.fixtures.map((row) => row.maxObservedChildConcurrency)),
        childQueueMs: parallelDelegation.fixtures.reduce((total, row) => total + row.childQueueMs, 0),
        childExecutionMs: parallelDelegation.fixtures.reduce((total, row) => total + row.childExecutionMs, 0),
        parallelWallMs: parallelDelegation.fixtures.reduce((total, row) => total + row.parallelWallMs, 0),
        sequentialEquivalentMs: parallelDelegation.fixtures.reduce((total, row) => total + row.sequentialEquivalentMs, 0),
        overlapSavingsMs: parallelDelegation.fixtures.reduce((total, row) => total + row.overlapSavingsMs, 0),
        concurrencyBudget: parallelDelegation.concurrencyBudget,
        fixtures: parallelDelegation.fixtures,
      },
      provenance: {
        skillChars: "MEASURED",
        toolCount: "MEASURED",
        toolSchemaChars: "ESTIMATED",
        handoffRatio: "MEASURED",
        boundedParallelDispatchOverlap: "MEASURED",
        providerTokens: "NOT_MEASURED",
        modelQuality: "NOT_MEASURED",
        wallTimeSpeedup: "NOT_MEASURED",
        note: "Deterministic fixture run. No real-model claim is derived from these numbers. boundedParallelDelegation measures dispatch overlap of child execution windows in this process only and is not a speedup, provider-token or model-quality claim.",
      },
    }

    const checks = [
      { id: "skills-considered", pass: summary.measurements.skillsConsideredAverage === registrySkills(), detail: summary.measurements.skillsConsideredAverage },
      { id: "skills-activated-bounded", pass: summary.measurements.skillsActivatedMax <= 4, detail: summary.measurements.skillsActivatedMax },
      { id: "capsule-bounded", pass: summary.measurements.skillCapsuleCharsAverage <= 3_400, detail: summary.measurements.skillCapsuleCharsAverage },
      { id: "tool-surface-narrower", pass: summary.measurements.v165ToolCharsAverage < summary.measurements.baselineToolCharsAverage, detail: `${summary.measurements.v165ToolCharsAverage} < ${summary.measurements.baselineToolCharsAverage}` },
      { id: "handoff-bounded", pass: rendered.chars <= 6_000 && handoff.measurements.handoffRatio < 0.5, detail: `${rendered.chars} ratio=${handoff.measurements.handoffRatio}` },
      { id: "advisor-consultant-only", pass: advisor.authority.canProducePass === false && advisor.authority.hasTerminal === false, detail: true },
      { id: "doctor-read-only", pass: doctor.safety.submittedPrompt === false && doctor.safety.mutatedState === false, detail: true },
      { id: "progress-observer-only", pass: progress.summary.authority.runtime === false, detail: true },
      { id: "no-provider-token-claim", pass: summary.provenance.providerTokens === "NOT_MEASURED", detail: true },
      { id: "false-pass-zero", pass: true, detail: "deterministic fixture produces no task verdict at all" },
      {
        id: "bounded-parallel-safe-pair-overlaps",
        pass: safePair.safeWaves === 1
          && safePair.parallelDelegations === 2
          && safePair.maxObservedChildConcurrency === 2
          && safePair.overlapSavingsMs > 0,
        detail: `waves=${safePair.safeWaves} parallel=${safePair.parallelDelegations} peak=${safePair.maxObservedChildConcurrency} overlapSavingsMs=${safePair.overlapSavingsMs}`,
      },
      {
        id: "bounded-parallel-concurrency-capped",
        pass: bounded.maxObservedChildConcurrency <= parallelDelegation.concurrencyBudget.hardMax
          && bounded.maxObservedChildConcurrency > 1,
        detail: `peak=${bounded.maxObservedChildConcurrency} budget=${JSON.stringify(parallelDelegation.concurrencyBudget)}`,
      },
      {
        id: "unsafe-scopes-serialized",
        pass: writers.parallelDelegations === 0
          && writers.maxObservedChildConcurrency === 1
          && sideEffect.parallelDelegations === 0
          && sideEffect.maxObservedChildConcurrency === 1,
        detail: `writersPeak=${writers.maxObservedChildConcurrency} sideEffectPeak=${sideEffect.maxObservedChildConcurrency}`,
      },
      {
        id: "parallel-fleet-produces-no-verdict",
        pass: parallelDelegation.fixtures.every((row) => row.passed === false && row.canProduceVerdict === false && row.noOrphans === true),
        detail: true,
      },
      {
        id: "no-speedup-claim",
        pass: parallelDelegation.speedupClaim === null && summary.provenance.wallTimeSpeedup === "NOT_MEASURED",
        detail: `speedupClaim=${parallelDelegation.speedupClaim}`,
      },
    ]
    summary.checks = checks
    summary.pass = checks.every((check) => check.pass)
    summary.rows = rows

    console.log(JSON.stringify(summary, null, 2))
    if (!summary.pass) process.exitCode = 1
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true })
  }
}

function registrySkills() {
  return skillRegistry().skillCount
}

void estimateToolSchemaTax
await main()
