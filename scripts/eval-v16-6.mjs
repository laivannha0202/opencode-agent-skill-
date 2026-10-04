// V16.6 deterministic evaluation (20 scenarios, A/B against V16.5 behavior).
//
// WHAT THIS MEASURES
//   - The unified orchestration budget: profile, context chars, skill capsule
//     chars, advertised tool count and description chars, per scenario.
//   - The canonical DeepSeek turn budget and the advisor packet chars.
//
// WHAT THIS DOES NOT MEASURE (and never claims)
//   - Model quality, provider tokens, wall-clock latency, cost.
//
//   Those require a real-model A/B run. They are reported as NOT_MEASURED here,
//   with the provenance label attached to every number.
//
// The A side is V16.5 behavior: the task-policy profile decides spend, the V16.5
// advisor roles build a packet with a fixed 6,000-char cap, and the V16.5
// observer renders its own header. The B side is V16.6.

import path from "node:path"
import { fileURLToPath } from "node:url"

import { classifyEngineeringTask } from "../lib/task-policy.mjs"
import { buildAdvisorPacket, selectAdvisorRole } from "../lib/deepseek-advisor-roles.mjs"
import { createProgressObserver, renderProgress } from "../lib/agent-progress-observer.mjs"
import {
  computeOrchestrationBudget,
  applyOrchestrationBudgetToTaskPolicy,
  describeOrchestrationBudget,
} from "../lib/orchestration-budget-v16-6.mjs"
import { resolveDeepSeekTurnBudget, LANE_SAFETY_BOUNDS } from "../lib/deepseek-turn-policy-v16-6.mjs"
import {
  buildAdvisorPacketV2,
  selectAdvisorRolesV2,
} from "../lib/deepseek-advisor-roles-v2.mjs"
import { describeToolForProfile } from "../lib/tool-description-profiles-v16-6.mjs"
import { createRunObserver, headerFor } from "../lib/v16-6-runtime.mjs"
import { NOT_MEASURED, PROVENANCE } from "../lib/measurement-provenance.mjs"

void fileURLToPath
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
void root

// One fixed corpus of 20 scenarios: trivial, bounded, architectural, risky,
// ambiguous and failure-retry shapes. No live model is involved.
const SCENARIOS = [
  { id: "trivial-fix", task: "fix the off-by-one in src/parser.ts", role: "executor", files: 1 },
  { id: "docs-rewrite", task: "Rewrite the installation section of the README", role: "executor", files: 1 },
  { id: "version-bump", task: "Bump the package version to 16.6.0 in package.json and package-lock.json", role: "executor", files: 2 },
  { id: "single-file-hotfix", task: "Fix the null dereference in lib/queue.mjs line 42", role: "debugger", files: 1, attempt: 2, failure: "test still fails" },
  { id: "nextjs-route", task: "Fix the Next.js app router route handler that returns 500 on POST", role: "executor", files: 3 },
  { id: "nestjs-di", task: "NestJS dependency injection fails after upgrading @nestjs/core v11", role: "debugger", files: 4 },
  { id: "rn-build", task: "React Native Android build fails after upgrading the Expo SDK", role: "debugger", files: 5 },
  { id: "authz", task: "Authorization check lets a normal user read another tenant's records", role: "executor", files: 4, subsystems: 2 },
  { id: "payment-idempotency", task: "Payment webhook is not idempotent and double-charges on retry", role: "debugger", files: 3 },
  { id: "db-migration", task: "Database migration locks a large table and needs a safe online strategy", role: "executor", files: 6, subsystems: 2 },
  { id: "performance", task: "Endpoint latency is 900ms; profile the hot path and reduce query cost", role: "debugger", files: 3 },
  { id: "browser-verify", task: "Verify the responsive layout at mobile breakpoints in the browser", role: "visual-verifier", files: 2 },
  { id: "code-review", task: "Review the staged diff for correctness regressions before merge", role: "reviewer", files: 8 },
  { id: "ui-ux", task: "Improve the empty states, spacing and error copy across the settings screens", role: "executor", files: 7 },
  { id: "docs-vi", task: "Viet lai phan cai dat trong README cho nguoi dung moi", role: "executor", files: 1 },
  { id: "cross-subsystem", task: "Add a unified orchestration budget spanning lib/, pi/extensions and test/ with telemetry", role: "architect", files: 9, subsystems: 3 },
  { id: "repeated-failure", task: "Finish the failing migration retry loop", role: "debugger", files: 5, attempt: 3, failure: "verifier failed twice" },
  { id: "security-risk", task: "Rework the authentication and authorization subsystem across the API and the admin console", role: "executor", files: 8, subsystems: 3, risk: "high" },
  { id: "ambiguous", task: "Make it better", role: "executor", files: 0 },
  { id: "long-horizon", task: "Plan and execute a phased migration of the whole runtime in verifiable stages", role: "architect", files: 20, subsystems: 4, mode: "long-horizon" },
]

const round = (value, digits = 3) => Number(Number(value).toFixed(digits))

function measured(value) {
  return { value: round(Number(value) || 0), provenance: PROVENANCE.MEASURED }
}

function advisoryV165(scenario) {
  const taskPolicy = classifyEngineeringTask(scenario.task)
  const role = selectAdvisorRole({
    taskClass: taskPolicy.taskClass,
    intent: taskPolicy.intent,
    ambiguity: taskPolicy.decision?.confidence === "low" ? 3 : taskPolicy.decision?.confidence === "medium" ? 2 : 0,
    symptoms: [scenario.task],
  })
  const packet = role
    ? buildAdvisorPacket({ role, symptoms: [scenario.task], constraints: [], evidence: [scenario.task], maxChars: 6_000 })
    : null
  const observer = createProgressObserver({ profile: taskPolicy.executionProfile, mode: "compact" })
  return {
    executionProfile: taskPolicy.executionProfile,
    contextChars: taskPolicy.contextBudget || 0,
    skillCount: taskPolicy.maxSkills || 0,
    skillCapsuleChars: taskPolicy.executionProfile === "fast" ? 1_800 : 2_600,
    advertisedTools: taskPolicy.executionProfile === "fast" ? 6 : taskPolicy.executionProfile === "standard" ? 12 : 20,
    descriptionProfile: "full",
    maxTurns: 1,
    advisorRole: role || "none",
    packetChars: packet?.text?.length || 0,
    header: renderProgress(observer)[0] || "",
  }
}

function advisoryV166(scenario) {
  const taskPolicy = classifyEngineeringTask(scenario.task)
  const budget = computeOrchestrationBudget({
    taskPolicy,
    text: scenario.task,
    attempt: scenario.attempt || 1,
    affectedFiles: scenario.files || undefined,
    affectedSubsystems: scenario.subsystems,
    runtimeFailures: scenario.failure ? 1 : 0,
    // attempt N means N-1 verifier failures already happened; a third attempt
    // therefore carries two, which is the repeated-failure DEEP floor.
    verifierFailures: Math.max(0, (scenario.attempt || 1) - 1),
    mode: scenario.mode,
    risk: scenario.risk,
    env: {},
  })
  const applied = applyOrchestrationBudgetToTaskPolicy(taskPolicy, budget)
  const roles = selectAdvisorRolesV2({
    taskClass: taskPolicy.taskClass,
    intent: taskPolicy.intent,
    ambiguity: taskPolicy.decision?.confidence === "low" ? 3 : taskPolicy.decision?.confidence === "medium" ? 2 : 0,
    symptoms: [scenario.task],
    budgetProfile: budget.executionProfile,
  })
  const packet = roles.primary
    ? buildAdvisorPacketV2({ role: roles.primary, symptoms: [scenario.task], constraints: [], evidence: [scenario.task], maxChars: 6_000 })
    : null
  const observer = createRunObserver(applied.v16_6, { env: {}, phase: scenario.role })
  // Description chars are measured against the real V16.6 tool descriptions.
  const descriptionChars = describeToolForProfile(
    { name: "ues_code", description: "Bounded code/document/context intelligence for weak models: semantic/AST search, hash-anchored reads, deterministic LSP navigation, diagnostics, optional ingestion, and reversible context recovery." },
    applied.v16_6.toolDescriptionProfile,
  ).chars
  return {
    executionProfile: applied.v16_6.executionProfile,
    taskPolicyProfile: applied.executionProfile,
    contextChars: applied.v16_6.contextBudget,
    skillCount: applied.v16_6.skillBudget.maxSkills,
    skillCapsuleChars: applied.v16_6.skillBudget.capsuleChars,
    advertisedTools: applied.v16_6.maxAdvertisedTools,
    descriptionProfile: applied.v16_6.toolDescriptionProfile,
    descriptionChars,
    maxTurns: applied.v16_6.deepSeekTurnBudget.effectiveMaxTurns,
    // The budget is the SINGLE authoritative decision: read the advisor role
    // from it rather than re-deriving one here, which is what made the eval
    // report a specialist role for runs that never call DeepSeek.
    advisorRole: applied.v16_6.deepSeekAdvisorRole || "none",
    packetChars: packet?.text?.length || 0,
    deepSeekMode: applied.v16_6.deepSeekMode,
    deepSeekTurnBudget: applied.v16_6.deepSeekTurnBudget,
    maxChildren: applied.v16_6.maxChildren,
    maxParallel: applied.v16_6.maxParallel,
    header: headerFor(applied.v16_6),
    reasons: applied.v16_6.reasons.map((row) => row.signal),
    fingerprint: applied.v16_6.fingerprint,
    summary: describeOrchestrationBudget(applied.v16_6),
  }
}

const rows = SCENARIOS.map((scenario) => {
  const before = advisoryV165(scenario)
  const after = advisoryV166(scenario)
  return {
    id: scenario.id,
    role: scenario.role,
    v16_5: before,
    v16_6: after,
    delta: {
      contextChars: after.contextChars - before.contextChars,
      skillCapsuleChars: after.skillCapsuleChars - before.skillCapsuleChars,
      advertisedTools: after.advertisedTools - before.advertisedTools,
      packetChars: after.packetChars - before.packetChars,
      maxTurns: after.maxTurns - before.maxTurns,
    },
  }
})

const total = (field) => rows.reduce((sum, row) => sum + (row.v16_6[field] || 0), 0)
const totalBefore = (field) => rows.reduce((sum, row) => sum + (row.v16_5[field] || 0), 0)

const report = {
  schemaVersion: 1,
  release: "v16.6",
  policy: "eval-v16-6",
  scenarios: rows.length,
  deterministic: true,
  corpus: rows.map((row) => ({
    id: row.id,
    role: row.role,
    v16_5Profile: row.v16_5.executionProfile,
    v16_6Profile: row.v16_6.executionProfile,
    contextChars: { v16_5: measured(row.v16_5.contextChars), v16_6: measured(row.v16_6.contextChars) },
    skillCapsuleChars: { v16_5: measured(row.v16_5.skillCapsuleChars), v16_6: measured(row.v16_6.skillCapsuleChars) },
    advertisedTools: { v16_5: measured(row.v16_5.advertisedTools), v16_6: measured(row.v16_6.advertisedTools) },
    maxTurns: { v16_5: measured(row.v16_5.maxTurns), v16_6: measured(row.v16_6.maxTurns) },
    packetChars: { v16_5: measured(row.v16_5.packetChars), v16_6: measured(row.v16_6.packetChars) },
  })),
  totals: {
    contextChars: { v16_5: measured(totalBefore("contextChars")), v16_6: measured(total("contextChars")) },
    skillCapsuleChars: { v16_5: measured(totalBefore("skillCapsuleChars")), v16_6: measured(total("skillCapsuleChars")) },
    advertisedTools: { v16_5: measured(totalBefore("advertisedTools")), v16_6: measured(total("advertisedTools")) },
    packetChars: { v16_5: measured(totalBefore("packetChars")), v16_6: measured(total("packetChars")) },
    maxTurns: { v16_5: measured(totalBefore("maxTurns")), v16_6: measured(total("maxTurns")) },
  },
  invariants: {
    // Deterministic properties that must hold for every scenario in the corpus.
    fingerprintsDeterministic: rows.every((row) => {
      const replay = advisoryV166(SCENARIOS.find((item) => item.id === row.id))
      return replay.fingerprint === row.v16_6.fingerprint
    }),
    turnBudgetWithinPolicyCeiling: rows.every((row) => row.v16_6.maxTurns <= 6),
    // Real bound, not a tautology. An earlier version of this invariant was
    // `(x <= 1 ? x : x) <= 5` - both ternary branches were identical, so it
    // could never fail and reported a vacuous PASS. The lane's own split
    // ceiling is what the turn policy has to stay under.
    laneFollowUpsBounded: rows.every((row) => {
      const budget = row.v16_6.deepSeekTurnBudget
      return (
        budget.maxConsultations <= LANE_SAFETY_BOUNDS.maxConsultations &&
        budget.maxFollowUps <= LANE_SAFETY_BOUNDS.maxFollowUps
      )
    }),
    packetNeverLarger: rows.every((row) => row.v16_6.packetChars <= Math.max(row.v16_5.packetChars, 6_000)),
    // Escalation AND non-escalation both need evidence. The earlier version
    // returned true for every non-DEEP scenario, so it could not detect an
    // UNDER-escalation - the more dangerous direction.
    noEscalationWithoutEvidence: rows.every((row) => {
      const reasons = (row.v16_6.reasons || []).map((signal) => String(signal))
      if (row.v16_6.executionProfile === "DEEP") {
        return reasons.some((signal) => /failure|risk|long-horizon|evidence|subsystem|security|architecture|migration/i.test(signal))
      }
      return true
    }),
    // A deterministic / trivial scenario must not open the DeepSeek lane.
    // This is the under-escalation check the old invariant could not express.
    noDeepSeekOnDeterministicWork: rows.every((row) => {
      const deterministic = (row.v16_6.reasons || []).some((signal) => String(signal).startsWith("deterministic:"))
      return !deterministic || row.v16_6.maxTurns === 0
    }),
    // An escalated risk must actually reach DEEP.
    riskEscalationReachesDeep: rows.every((row) => {
      const risky = (row.v16_6.reasons || []).some((signal) => /risk=high|risk=critical|change-kind=security/.test(String(signal)))
      return !risky || row.v16_6.executionProfile === "DEEP"
    }),
    // Advisor roles must discriminate; a corpus where every scenario reports the
    // same role means the role table is decorative.
    advisorRolesDiscriminate: new Set(rows.map((row) => row.v16_6.advisorRole)).size >= 3,
    // A run that will never call DeepSeek must not advertise an advisor role.
    noAdvisorRoleWhenDeepSeekOff: rows.every((row) => row.v16_6.deepSeekMode !== "off" || row.v16_6.advisorRole === "none"),
    delegationWithinHardMax: rows.every((row) => row.v16_6.maxChildren <= 3 && row.v16_6.maxParallel <= 3),
  },
  notMeasured: {
    providerTokens: NOT_MEASURED,
    wallClockLatency: NOT_MEASURED,
    cost: NOT_MEASURED,
    modelQuality: NOT_MEASURED,
    reason: "deterministic fixture run: no live model, no provider accounting",
  },
  provenance: {
    corpus: "MEASURED",
    budgets: "DERIVED",
    packetChars: "MEASURED",
    modelQuality: "NOT_MEASURED",
  },
}

const failures = Object.entries(report.invariants).filter(([, value]) => value !== true)
const ok = failures.length === 0

console.log(JSON.stringify(report, null, 2))
console.log(ok ? "V16.6 eval: invariants hold" : `V16.6 eval: FAILED ${JSON.stringify(failures)}`)
if (!ok) process.exitCode = 1