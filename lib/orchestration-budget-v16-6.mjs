// V16.6 Unified Adaptive Orchestration Budget.
//
// ONE decision per run that answers every "how much effort does this task
// deserve" question, instead of the V16.3-V16.5 split where the task policy, the
// skill router, the tool-surface economy, the escalation router and the advisor
// role table each made their own call.
//
// Evidence priority (V16.6 section 1). Highest wins on conflict:
//
//   1. runtime evidence        what this run already observed (failures this
//                              run, tool utilization, provider retries)
//   2. repository structure    affected files / subsystems / repo scale
//   3. verifier evidence       previous verdicts and failure counts
//   4. task text               the user's wording - weakest, and capped at
//                              +1 to the complexity score so a dramatic
//                              description alone can never produce DEEP
//
// What this module deliberately does NOT do:
//   - it does not decide PASS, FAIL or any verifier verdict
//   - it does not grant permissions, bypass the workspace containment or alter
//     the Evidence Store
//   - it does not turn DeepSeek on: lib/web-reasoning-escalation.mjs stays the
//     only component allowed to say "ask DeepSeek"
//   - it does not relax V16.3 lane bounds or V16.5 safety tool coverage
//
// Every number it returns is labeled with a provenance (MEASURED / DERIVED /
// ESTIMATED / NOT_MEASURED) in `measurements`.

import { createHash } from "node:crypto"
import {
  PROVENANCE,
  derived,
  estimated,
  measured,
  NOT_MEASURED,
  estimateTokensFromChars,
} from "./measurement-provenance.mjs"
import {
  REASONING_MODE,
  REASONING_MODES,
  resolveReasoningMode,
  resolveDeepSeekTurnBudget,
} from "./deepseek-turn-policy-v16-6.mjs"
import { deriveTaskSignals, escalationFloorFor } from "./task-signal-bridge-v16-6.mjs"
import { selectAdvisorRolesV2 } from "./deepseek-advisor-roles-v2.mjs"
import { selectPacketTier, PACKET_TIER_BUDGET } from "./decision-packet-tiers.mjs"
import { recommendedDescriptionProfile } from "./tool-description-profiles-v16-6.mjs"

export const ORCHESTRATION_BUDGET_SCHEMA_VERSION = 1
export const ORCHESTRATION_BUDGET_RELEASE = "v16.6"
export const ORCHESTRATION_BUDGET_POLICY = "unified-orchestration-budget-v16-6"

/** V16.6 profile vocabulary (labels). */
export const EXECUTION_PROFILE = Object.freeze({
  FAST: "FAST",
  BALANCED: "BALANCED",
  DEEP: "DEEP",
})

export const EXECUTION_PROFILES = Object.freeze(Object.values(EXECUTION_PROFILE))

// Integration vocabulary: the existing task-policy profiles that the budget
// maps onto. V16.6 must plug into the existing runtime, not fork it.
export const TASK_POLICY_PROFILE = Object.freeze({
  FAST: "fast",
  BALANCED: "standard",
  DEEP: "deep",
})

const PROFILE_RANK = Object.freeze({ FAST: 0, BALANCED: 1, DEEP: 2 })

// Complexity ordering, used to keep the turn budget coherent with the profile.
const COMPLEXITY_RANK = Object.freeze({ easy: 0, normal: 1, hard: 2, "very-hard": 3 })

// Per-profile orchestration spend. These are the only places the numbers live.
export const PROFILE_SPEND = Object.freeze({
  [EXECUTION_PROFILE.FAST]: Object.freeze({
    contextBudget: 8_000,
    skillMax: 1,
    skillCapsuleChars: 1_200,
    maxAdvertisedTools: 6,
    toolDescriptionProfile: "minimal",
    delegationMode: "parent-direct",
    maxChildren: 1,
    maxParallel: 1,
    verificationStrategy: "targeted",
  }),
  [EXECUTION_PROFILE.BALANCED]: Object.freeze({
    contextBudget: 20_000,
    skillMax: 3,
    skillCapsuleChars: 2_600,
    maxAdvertisedTools: 12,
    toolDescriptionProfile: "compact",
    delegationMode: "bounded-delegation",
    maxChildren: 2,
    maxParallel: 2,
    verificationStrategy: "targeted+affected",
  }),
  [EXECUTION_PROFILE.DEEP]: Object.freeze({
    contextBudget: 48_000,
    skillMax: 5,
    skillCapsuleChars: 4_200,
    maxAdvertisedTools: 20,
    toolDescriptionProfile: "full",
    delegationMode: "bounded-delegation",
    maxChildren: 3,
    maxParallel: 3,
    verificationStrategy: "targeted+integration",
  }),
})

// Hard, non-negotiable bounds (V16.6 section 4). Never raised by this module.
export const DELEGATION_HARD_MAX = Object.freeze({ maxChildren: 3, maxParallel: 3, depth: 2 })

// V16.6.1: the smallest context budget a run may actually apply. An
// optimization may reduce the advertised context budget; it may never reduce it
// below the point where the verifier task, the evidence sections and the safety
// lines stop fitting.
export const MIN_CONTEXT_BUDGET_CHARS = 8_000
export const DEFAULT_DELEGATION = Object.freeze({ maxChildren: 2, maxParallel: 2, depth: 1 })

export const TOOL_DESCRIPTION_PROFILES = Object.freeze(["full", "compact", "minimal"])

function num(value, fallback = null) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function str(value, fallback = "") {
  const text = String(value ?? "").trim()
  return text || fallback
}

/** Map a task-policy profile word to its EXECUTION_PROFILE key. */
function profileKeyFor(profile) {
  const key = String(profile || "").trim().toUpperCase()
  if (EXECUTION_PROFILES.includes(key)) return key
  const match = EXECUTION_PROFILES.find((candidate) => TASK_POLICY_PROFILE[candidate] === String(profile || "").trim().toLowerCase())
  return match || EXECUTION_PROFILE.BALANCED
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

function profileRank(label) {
  const rank = PROFILE_RANK[String(label || "").toUpperCase()]
  return Number.isFinite(rank) ? rank : 1
}

function higherProfile(a, b) {
  return profileRank(a) >= profileRank(b) ? a : b
}


/**
 * Classify the task's execution complexity from evidence, honoring the
 * V16.6 evidence priority.
 *
 * Returns `{ complexity, score, evidenceScore, textScore, basis, reasons }`
 * where `complexity` is the turn-budget vocabulary (easy|normal|hard|very-hard).
 */
export function classifyExecutionComplexity(input = {}) {
  const reasons = []
  let evidenceScore = 0
  let textScore = 0
  const changeKind = input.changeKind || "unknown"

  // --- 1. runtime evidence (highest) -------------------------------------
  const runtimeFailures = int(input.runtimeFailures, 0, 0, 99)
  if (runtimeFailures >= 3) {
    evidenceScore += 3
    reasons.push({ signal: "runtime-failures>=3", basis: "runtime-evidence", impact: 3 })
  } else if (runtimeFailures >= 2) {
    evidenceScore += 2
    reasons.push({ signal: "runtime-failures>=2", basis: "runtime-evidence", impact: 2 })
  } else if (runtimeFailures >= 1) {
    evidenceScore += 1
    reasons.push({ signal: "runtime-failures>=1", basis: "runtime-evidence", impact: 1 })
  }

  const toolUtilization = num(input.toolUtilizationRatio)
  if (toolUtilization !== null && toolUtilization < 0.35) {
    evidenceScore += 1
    reasons.push({ signal: "low-tool-utilization", basis: "runtime-evidence", impact: 1 })
  }

  // --- 2. repository structure -------------------------------------------
  const subsystems = int(input.affectedSubsystems, 0, 0, 99)
  const affectedFiles = int(input.affectedFiles, -1, -1, 10_000)
  const repoFiles = int(input.repoFiles, -1, -1, 5_000_000)
  if (subsystems >= 3) {
    evidenceScore += 2
    reasons.push({ signal: "affected-subsystems>=3", basis: "repository-structure", impact: 2 })
  } else if (subsystems === 2) {
    evidenceScore += 1
    reasons.push({ signal: "affected-subsystems=2", basis: "repository-structure", impact: 1 })
  }
  if (affectedFiles >= 12) {
    evidenceScore += 1
    reasons.push({ signal: "affected-files>=12", basis: "repository-structure", impact: 1 })
  } else if (affectedFiles === 1) {
    reasons.push({ signal: "single-file-bounded", basis: "repository-structure", impact: -1 })
    evidenceScore -= 1
  }
  if (repoFiles > 2_000) {
    evidenceScore += 1
    reasons.push({ signal: "large-repository", basis: "repository-structure", impact: 1 })
  }

  // --- 3. verifier evidence ------------------------------------------------
  const verifierFailures = int(input.verifierFailures, 0, 0, 99)
  const lastVerdict = str(input.lastVerdict, "").toUpperCase()
  if (verifierFailures >= 3) {
    evidenceScore += 2
    reasons.push({ signal: "verifier-failures>=3", basis: "verifier-evidence", impact: 2 })
  } else if (verifierFailures >= 1) {
    evidenceScore += 1
    reasons.push({ signal: "verifier-failures>=1", basis: "verifier-evidence", impact: 1 })
  }
  if (lastVerdict === "FAIL" || lastVerdict === "REVISE") {
    evidenceScore += 1
    reasons.push({ signal: "last-verifier-verdict-not-pass", basis: "verifier-evidence", impact: 1 })
  }

  // --- 4. task text (weakest, capped) --------------------------------------
  const riskyKinds = ["architecture", "security", "data", "refactor"]
  if (riskyKinds.includes(changeKind)) {
    textScore += 1
    reasons.push({ signal: `change-kind:${changeKind}`, basis: "task-text", impact: 1 })
  }
  const ambiguity = int(input.ambiguity, 0, 0, 3)
  if (ambiguity >= 2) {
    textScore += 1
    reasons.push({ signal: "decision-confidence-low", basis: "task-text", impact: 1 })
  }
  // The cap: however dramatic the wording, task text contributes at most 1.
  const rawTextScore = textScore
  textScore = Math.min(1, textScore)
  if (rawTextScore > textScore) {
    reasons.push({ signal: "task-text-score-capped", basis: "task-text", impact: 0 })
  }

  const score = Math.max(0, evidenceScore) + textScore

  let complexity = "normal"
  if (score >= 4 || evidenceScore >= 3) complexity = "very-hard"
  else if (score >= 3) complexity = "hard"
  else if (score === 0 && affectedFiles >= 0 && affectedFiles <= 1 && subsystems <= 1 && runtimeFailures === 0 && verifierFailures === 0) {
    complexity = "easy"
  }

  const dominant = reasons.length
    ? reasons.reduce((best, row) => (row.impact > best.impact ? row : best), reasons[0]).basis
    : "task-text"

  return {
    complexity,
    score,
    evidenceScore,
    textScore,
    changeKind,
    ambiguity,
    basis: dominant,
    reasons,
  }
}

/**
 * The orchestration budget for one run. Pure and deterministic: the same input
 * always produces the same budget and the same fingerprint.
 */
export function computeOrchestrationBudget(input = {}) {
  const taskPolicy = input.taskPolicy || {}
  const env = input.env || process.env

  // V16.6 signal bridge. The task policy returns `risk` as a DEFAULTED string
  // and no `taskClass`/`intent`/`changeKind` at all, so reading those fields
  // directly used to (a) silently discard an explicit caller escalation and
  // (b) leave the advisor-role selector with no evidence at all. The bridge
  // translates the real task-policy shape into the decision vocabulary once.
  const signals = deriveTaskSignals({ ...input, text: input.text ?? input.task ?? taskPolicy.text, taskPolicy })
  const risk = signals.risk

  // Mode precedence: an explicit caller `mode` is a declared plan shape and must
  // not be discarded by the task policy's routine "inline". `taskPolicy.mode`
  // is only used when the caller declared nothing.
  const mode = str(input.mode || taskPolicy.mode, "default")
  const readOnly = taskPolicy.readOnly === true || input.readOnly === true
  const attempt = int(input.attempt, 1, 1, 99)
  const reasoningModeRow = REASONING_MODES.includes(str(input.reasoningMode))
    ? { mode: String(input.reasoningMode), source: "caller", raw: String(input.reasoningMode), normalized: true, invalidValue: null }
    : resolveReasoningMode(env)
  const reasoningMode = reasoningModeRow.mode

  const classified = classifyExecutionComplexity({
    ...input,
    changeKind: signals.changeKind,
    risk,
    runtimeFailures: input.runtimeFailures ?? input.previousFailureCount,
  })

  // ---------------------------------------------------------------------
  // Profile selection. Evidence decides; floors only PREVENT a downgrade
  // that would weaken an existing safety-driven profile.
  // ---------------------------------------------------------------------
  let executionProfile = EXECUTION_PROFILE.BALANCED
  const floors = []
  const boundedSingleFile =
    classified.complexity === "easy" &&
    Number(input.affectedFiles ?? -1) >= 0 &&
    Number(input.affectedFiles) <= 1 &&
    classified.evidenceScore <= 0

  // V16.6 §4 deterministic gate. A version bump, a typo fix or a doc edit is
  // bounded and reasoning-free work: it stays FAST and never opens the DeepSeek
  // lane, regardless of how many metadata files it touches. This is EVIDENCE
  // (the repository classifier already marked the change kind and found no
  // risk signal), not a keyword guess, and it is a CEILING on spend - it can
  // never promote a task to DEEP.
  const deterministicBound = signals.deterministic === true && classified.evidenceScore <= 0
  if (deterministicBound && risk !== "high" && risk !== "critical") {
    executionProfile = EXECUTION_PROFILE.FAST
    floors.push(`deterministic-work:${signals.changeKind}`)
  }
  if (boundedSingleFile && risk === "low" && mode !== "long-horizon" && signals.longHorizon !== true && executionProfile !== EXECUTION_PROFILE.FAST) {
    executionProfile = EXECUTION_PROFILE.FAST
    floors.push("bounded-single-file-low-risk")
  }
  if (classified.evidenceScore >= 3 || classified.complexity === "very-hard") {
    executionProfile = EXECUTION_PROFILE.DEEP
    floors.push("evidence-score>=3")
  }
  // V16.6 §2: a REPEATED verifier failure is a DEEP trigger in its own right,
  // independent of how few files it touches. Two failures means the first
  // recovery attempt already did not work.
  if (int(input.verifierFailures, 0, 0, 99) >= 2) {
    executionProfile = EXECUTION_PROFILE.DEEP
    floors.push("repeated-verifier-failure>=2")
  }
  if (["high", "critical"].includes(risk)) {
    executionProfile = EXECUTION_PROFILE.DEEP
    floors.push(`risk=${risk}`)
  }
  if (mode === "long-horizon" || signals.longHorizon === true) {
    executionProfile = EXECUTION_PROFILE.DEEP
    floors.push(`mode=long-horizon`)
  }
  if (classified.complexity === "hard" && executionProfile === EXECUTION_PROFILE.FAST) {
    executionProfile = EXECUTION_PROFILE.BALANCED
    floors.push("hard-task-cannot-be-fast")
  }
  for (const floor of escalationFloorFor(signals)) {
    if (!floors.includes(floor)) floors.push(floor)
  }
  // The task-policy profile is a floor only when it encodes a safety decision.
  const policyProfile = str(taskPolicy.executionProfile, "standard")
  if (["high", "critical"].includes(risk) && policyProfile === "deep") {
    executionProfile = higherProfile(executionProfile, EXECUTION_PROFILE.DEEP)
    floors.push("task-policy-deep-floor")
  }
  // A deterministic task whose change is still genuinely hard to reason about
  // (e.g. a migration disguised as a config edit) is caught by the evidence
  // floors above; nothing here can re-promote a deterministic task.

  const spend = PROFILE_SPEND[executionProfile]

  // ---------------------------------------------------------------------
  // Context / skill / tool budgets
  // ---------------------------------------------------------------------
  const pressure = Math.max(0, Math.min(1, num(input.contextPressure, 0) ?? 0))
  const pressureAdjusted = pressure > 0.8 ? Math.round(spend.contextBudget * 0.9) : spend.contextBudget
  // V16.6.1: high context pressure TIGHTENS the budget, and the tightened value
  // is the value. `applyOrchestrationBudgetToTaskPolicy` used to re-derive the
  // profile's base spend here, so the run reported 18k while the child runtime
  // actually spent the 20k base. The applied policy now reads `contextBudget`
  // (this value), and the safety floor below keeps it above the smallest usable
  // context window.
  const contextBudget = Math.max(MIN_CONTEXT_BUDGET_CHARS, pressureAdjusted)
  const skillBudget = {
    maxSkills: spend.skillMax,
    capsuleChars: spend.skillCapsuleChars,
    // Never concatenate whole SKILL.md files (V16.6 section 11).
    mode: "capsule",
  }

  let toolDescriptionProfile = spend.toolDescriptionProfile
  const toolSelectionErrors = int(input.toolSelectionErrors, 0, 0, 99)
  if (["high", "critical"].includes(risk)) toolDescriptionProfile = "full"
  else if (toolSelectionErrors >= 2) toolDescriptionProfile = "full"
  else if (executionProfile === EXECUTION_PROFILE.DEEP) toolDescriptionProfile = "full"

  // V16.6 §13 tool-description learner. Only a MODEL with enough observed
  // samples and a clean quality record may move the profile; an observed
  // selection/quality drop widens back to `full`. The safety escalation above
  // always wins because this hook is skipped once the profile is already full.
  let descriptionProfileAdvice = null
  if (toolDescriptionProfile !== "full") {
    const advice = recommendedDescriptionProfile({ model: input.model, risk })
    descriptionProfileAdvice = advice
    if (advice.applied === true && advice.profile) toolDescriptionProfile = advice.profile
  }

  // ---------------------------------------------------------------------
  // DeepSeek: mode, turn budget, role, packet tier
  // ---------------------------------------------------------------------
  const deepSeekMode = executionProfile === EXECUTION_PROFILE.FAST ? "off" : reasoningMode
  // Coherence: the turn budget must not contradict the execution profile. A DEEP
  // budget (high risk, repeated verifier failure, long-horizon) is by definition
  // a hard task, so it earns the hard-tier turn budget rather than the normal
  // one. Without this a DEEP/2-turn pairing was reported for high-risk work.
  const turnComplexity =
    executionProfile === EXECUTION_PROFILE.DEEP && COMPLEXITY_RANK[classified.complexity] < COMPLEXITY_RANK.hard
      ? "hard"
      : classified.complexity
  const turnBudget = resolveDeepSeekTurnBudget({
    complexity: deepSeekMode === "off" ? "easy" : turnComplexity,
    reasoningMode,
    webReasoningMode: input.webReasoningMode,
    advisoryWeight: input.advisoryWeight,
    learnerSamples: input.advisorySamples,
    complexityBasis: classified.basis,
    reasons: classified.reasons.map((row) => row.signal),
  })

  const advisorSelection = selectAdvisorRolesV2({
    phase: input.phase,
    // The bridge-supplied intent/taskClass are what make role selection
    // discriminate; before this, both were undefined in production and every
    // task fell through to `fallback:root-cause`.
    intent: input.intent || signals.intent || taskPolicy.intent,
    taskClass: input.taskClass || signals.taskClass || taskPolicy.taskClass,
    ambiguity: classified.ambiguity,
    changedDiff: input.changedDiff,
    patch: input.patch,
    failedCommand: input.failedCommand,
    browserObservations: input.browserObservations,
    question: input.question,
  })

  const packetTier = selectPacketTier({
    affectedSubsystems: subsystemsOf(input),
    verifierRetries: int(input.verifierFailures, 0, 0, 99),
    unresolvedQuestions: int(input.unresolvedQuestions, 0, 0, 99),
    diffChars: String(input.diff || input.changedDiff || "").length,
    evidenceCount: Array.isArray(input.evidence) ? input.evidence.length : 0,
    architecturalWork: signals.changeKind === "architecture",
    ambiguous: classified.ambiguity >= 2,
  })
  const packetBudget = PACKET_TIER_BUDGET[packetTier] || PACKET_TIER_BUDGET.medium || null

  // ---------------------------------------------------------------------
  // Delegation (bounded, never a swarm)
  // ---------------------------------------------------------------------
  let delegationMode = spend.delegationMode
  let maxChildren = spend.maxChildren
  let maxParallel = spend.maxParallel
  if (input.delegationRequested === false || readOnly === true) {
    delegationMode = "parent-direct"
    maxChildren = Math.min(maxChildren, 1)
    maxParallel = Math.min(maxParallel, 1)
  }
  maxChildren = int(maxChildren, DEFAULT_DELEGATION.maxChildren, 0, DELEGATION_HARD_MAX.maxChildren)
  maxParallel = int(maxParallel, DEFAULT_DELEGATION.maxParallel, 0, DELEGATION_HARD_MAX.maxParallel)
  if (maxParallel > maxChildren) maxParallel = maxChildren
  const maxDelegationDepth = Math.min(
    DELEGATION_HARD_MAX.depth,
    executionProfile === EXECUTION_PROFILE.DEEP ? 2 : 1,
  )

  const parallelReasoning =
    deepSeekMode !== "off" &&
    maxChildren >= 1 &&
    executionProfile !== EXECUTION_PROFILE.FAST

  const verificationStrategy = str(taskPolicy.verification, spend.verificationStrategy) || spend.verificationStrategy

  const budget = {
    schemaVersion: ORCHESTRATION_BUDGET_SCHEMA_VERSION,
    release: ORCHESTRATION_BUDGET_RELEASE,
    policy: ORCHESTRATION_BUDGET_POLICY,

    executionProfile,
    taskPolicyExecutionProfile: TASK_POLICY_PROFILE[executionProfile],
    profileFloors: floors,

    contextBudget,
    contextBudgetDetail: {
      skillChars: skillBudget.capsuleChars,
      advisorPacketChars: packetBudget ? packetBudget.maxPacketChars : 8_000,
      handoffChars: executionProfile === EXECUTION_PROFILE.DEEP ? 6_000 : 3_000,
      evidenceDeltaChars: executionProfile === EXECUTION_PROFILE.FAST ? 2_000 : 4_000,
      toolOutputChars: executionProfile === EXECUTION_PROFILE.FAST ? 12_288 : 24_576,
      contextPressure: pressure,
    },
    skillBudget,

    maxAdvertisedTools: spend.maxAdvertisedTools,
    toolDescriptionProfile,
    toolDescriptionProfileAdvice: descriptionProfileAdvice,

    deepSeekMode,
    reasoningMode,
    reasoningModeSource: reasoningModeRow.source,
    reasoningModeNormalized: reasoningModeRow.normalized,
    deepSeekTurnBudget: turnBudget,
    // When DeepSeek is off the run must not advertise a specialist it will
    // never ask: `none` is the honest answer, and a later escalation replaces
    // it with a real role.
    deepSeekAdvisorRole: deepSeekMode === "off" ? "none" : advisorSelection.primary,
    deepSeekAdvisorRoles: deepSeekMode === "off" ? { ...advisorSelection, primary: null, roles: [], threadCount: 0, disabled: true } : advisorSelection,
    deepSeekPacketTier: deepSeekMode === "off" ? "none" : packetTier,

    delegationMode,
    maxChildren,
    maxParallel,
    maxDelegationDepth,

    verificationStrategy,
    parallelReasoning,

    taskComplexity: classified.complexity,
    taskComplexityBasis: classified.basis,
    changeKind: signals.changeKind,
    taskSignals: signals,
    deterministic: signals.deterministic,
    readOnly,

    reasons: signals.reasons
      .filter((row) => String(row.signal).startsWith("risk") || String(row.signal).startsWith("deterministic"))
      .map((row) => ({ basis: row.basis, impact: 0, signal: row.signal }))
      .concat(
        classified.reasons,
        floors.map((floor) => ({ signal: `floor:${floor}`, basis: "task-text", impact: 0 })),
        [{ signal: `profile:${executionProfile}`, basis: "runtime-evidence", impact: 0 }],
      ),

    measurements: {
      risk: measured(risk),
      attempt: measured(attempt),
      affectedFiles: input.affectedFiles === undefined || input.affectedFiles === null ? NOT_MEASURED : measured(int(input.affectedFiles, 0, 0, 10_000)),
      affectedSubsystems: input.affectedSubsystems === undefined ? NOT_MEASURED : measured(int(input.affectedSubsystems, 0, 0, 99)),
      repoFiles: input.repoFiles === undefined ? NOT_MEASURED : measured(int(input.repoFiles, 0, 0, 5_000_000)),
      runtimeFailures: measured(int(input.runtimeFailures ?? input.previousFailureCount, 0, 0, 99)),
      verifierFailures: measured(int(input.verifierFailures, 0, 0, 99)),
      lastVerdict: input.lastVerdict === undefined || input.lastVerdict === null || input.lastVerdict === "" ? NOT_MEASURED : measured(String(input.lastVerdict)),
      contextPressure: input.contextPressure === undefined ? NOT_MEASURED : measured(pressure),
      toolUtilizationRatio: input.toolUtilizationRatio === undefined ? NOT_MEASURED : measured(num(input.toolUtilizationRatio, 0)),
      toolSelectionErrors: measured(toolSelectionErrors),
      advisorySamples: measured(int(input.advisorySamples, 0, 0, 99_999)),
      complexityScore: derived(classified.score),
      evidenceScore: derived(classified.evidenceScore),
      taskTextScore: derived(classified.textScore),
      contextBudgetChars: derived(contextBudget),
      contextBudgetTokens: estimateTokensFromChars(contextBudget),
      skillCapsuleChars: derived(skillBudget.capsuleChars),
      advertisedToolCap: derived(spend.maxAdvertisedTools),
      deepSeekMaxTurns: derived(turnBudget.maxTurns),
      deepSeekEffectiveTurns: derived(turnBudget.effectiveMaxTurns),
      packetTierMaxChars: packetBudget ? derived(packetBudget.maxPacketChars) : NOT_MEASURED,
      maxChildren: derived(maxChildren),
      maxParallel: derived(maxParallel),
      maxDelegationDepth: derived(maxDelegationDepth),
      providerContextWindow: NOT_MEASURED,
      providerTokensConsumed: NOT_MEASURED,
      actualLatencyMs: NOT_MEASURED,
      actualTokenSavings: NOT_MEASURED,
    },

    provenance: {
      decision: PROVENANCE.DERIVED,
      evidencePriority: ["runtime-evidence", "repository-structure", "verifier-evidence", "task-text"],
      dominantEvidence: classified.basis,
      generatedFrom: [
        "task-policy",
        "workspace-structure",
        "verifier-history",
        "task-text",
      ],
      measuredAt: null,
    },
  }

  budget.fingerprint = budgetFingerprint(budget)
  // V16.6.1: the decision inputs are remembered so a retry can RECOMPUTE the
  // whole budget instead of patching a few fields onto a stale copy. The
  // property is deliberately NON-ENUMERABLE: the budget is spread into
  // `policy.v16_6` and serialized into trajectory events, and the raw inputs
  // (task text, diff, evidence) must never ride along as an incidental copy.
  Object.defineProperty(budget, REFINE_INPUTS, {
    value: refinementInputsOf(input),
    enumerable: false,
    writable: false,
    configurable: true,
  })
  return budget
}

const REFINE_INPUTS = "_v16_6_refinement_inputs"

/** JSON-safe shallow copy of the decision inputs (never re-derived). */
function refinementInputsOf(input) {
  const row = input && typeof input === "object" ? input : {}
  const copy = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || typeof value === "function") continue
    if (value && typeof value === "object") {
      try {
        copy[key] = JSON.parse(JSON.stringify(value))
      } catch {
        // A non-serializable input (a proxy, a class instance with cycles) is
        // dropped rather than kept half-way: a missing input can only cause an
        // extra escalation, never a wrong one.
      }
      continue
    }
    copy[key] = value
  }
  return copy
}

/** Recompute the whole decision from a previous budget plus new evidence. */
function recomputeFromBase(base, input) {
  const previous = base?.[REFINE_INPUTS] || {}
  const merged = { ...previous }
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined) continue
    merged[key] = value
  }
  return computeOrchestrationBudget(merged)
}

function subsystemsOf(input) {
  return int(input.affectedSubsystems, 0, 0, 99)
}

/** Stable hash over the decision-relevant fields (no timestamps, no secrets). */
export function budgetFingerprint(budget) {
  const row = budget || {}
  return sha256(JSON.stringify([
    ORCHESTRATION_BUDGET_SCHEMA_VERSION,
    row.executionProfile,
    row.taskComplexity,
    row.contextBudget,
    row.skillBudget?.maxSkills,
    row.skillBudget?.capsuleChars,
    row.maxAdvertisedTools,
    row.toolDescriptionProfile,
    row.deepSeekMode,
    row.deepSeekTurnBudget?.maxTurns,
    row.deepSeekTurnBudget?.effectiveMaxTurns,
    row.deepSeekAdvisorRole,
    row.deepSeekPacketTier,
    row.delegationMode,
    row.maxChildren,
    row.maxParallel,
    row.maxDelegationDepth,
    row.verificationStrategy,
  ]))
}

/**
 * Apply the budget to the task policy object the runtime already threads
 * through every call site. Only orchestration-spend fields are touched:
 * risk, requirements, verification gates, permission flags and the execution
 * contract are passed through unchanged.
 */
export function applyOrchestrationBudgetToTaskPolicy(taskPolicy, budget) {
  const policy = taskPolicy && typeof taskPolicy === "object" ? { ...taskPolicy } : {}
  const row = budget && typeof budget === "object" ? budget : null
  if (!row) return policy
  const declared = String(policy.executionProfile || "standard").toLowerCase()
  const requested = String(row.taskPolicyExecutionProfile || declared).toLowerCase()
  // V16.6 integration rule.
  //
  // Spending LESS than the task policy allowed is always fine (that is the
  // point of an adaptive budget). Spending MORE needs an evidence FLOOR, not a
  // default: a high/critical risk task, a long-horizon plan, a hard evidence
  // score or a proven single-file bound. Without a floor the run keeps the
  // profile the task policy already chose, so V16.6 never inflates a run just
  // because a heuristic looked at it.
  const declaredRank = PROFILE_RANK[profileKeyFor(declared)] ?? 1
  const requestedRank = PROFILE_RANK[profileKeyFor(requested)] ?? 1
  const floors = Array.isArray(row.profileFloors) ? row.profileFloors.map(String) : []
  let applied = requested
  if (requestedRank > declaredRank && floors.length === 0) applied = declared
  // An existing DEEP floor is always kept.
  if (declared === "deep" && applied !== "deep") applied = "deep"
  const spendKey = EXECUTION_PROFILES.find((key) => TASK_POLICY_PROFILE[key] === applied) || EXECUTION_PROFILE.BALANCED
  const spend = PROFILE_SPEND[spendKey] || PROFILE_SPEND[EXECUTION_PROFILE.BALANCED]
  // V16.6.1: apply the budget's OWN context budget, not the profile's base
  // spend. A pressure-adjusted budget is what the telemetry reports, so it has
  // to be what the task policy (and therefore the child runtime) spends.
  const appliedContextBudget = Math.max(
    MIN_CONTEXT_BUDGET_CHARS,
    int(row.contextBudget, spend.contextBudget, MIN_CONTEXT_BUDGET_CHARS, spend.contextBudget),
  )
  policy.executionProfile = applied
  policy.maxSkills = spend.skillMax
  policy.contextBudget = appliedContextBudget
  policy.profile = {
    ...(policy.profile || {}),
    contextBudget: appliedContextBudget,
    maxSkills: spend.skillMax,
  }
  // The applied record is what the run actually spends. It is reported with its
  // own fingerprint-preserving copy so a preserved FAST lane cannot advertise
  // BALANCED tool-surface numbers it is not using.
  policy.v16_6 = {
    ...row,
    taskPolicyExecutionProfile: applied,
    appliedProfile: applied,
    contextBudget: appliedContextBudget,
    skillBudget: { ...(row.skillBudget || {}), maxSkills: spend.skillMax, capsuleChars: spend.skillCapsuleChars },
    maxAdvertisedTools: spend.maxAdvertisedTools,
    toolDescriptionProfile: row.toolDescriptionProfile,
    delegationMode: spend.delegationMode,
    maxChildren: spend.maxChildren,
    maxParallel: spend.maxParallel,
    verificationStrategy: spend.verificationStrategy,
  }
  return policy
}

/**
 * Refinement on retry. Runtime evidence gathered after the first attempt may
 * only ESCALATE the budget; a retry never gets a smaller budget than the
 * attempt that just failed.
 *
 * V16.6.1: refinement RECOMPUTES the whole decision from the inputs the base
 * budget was built from, instead of patching profile-derived fields onto a
 * stale copy. The previous implementation changed `executionProfile` while
 * leaving `deepSeekMode`, `deepSeekTurnBudget`, `deepSeekAdvisorRole`,
 * `deepSeekPacketTier`, `parallelReasoning` and `maxDelegationDepth` at their
 * pre-escalation values, which produced a real DEEP profile advertised with
 * `deepSeekMode:"off"` and a zero-turn advisor budget. One input, one decision.
 */
export function refineOrchestrationBudget(budget, input = {}) {
  const base = budget && typeof budget === "object" ? budget : computeOrchestrationBudget(input)
  const addedFailures = int(input.verifierFailures, 0, 0, 99)
  const failureText = str(input.failureText, "")
  if (addedFailures <= 0 && !failureText) return base

  const escalated = recomputeFromBase(base, {
    ...input,
    verifierFailures: addedFailures,
    // A verifier failure is NOT also counted as a runtime failure: one fact,
    // one contribution. Double counting would inflate a single retry into a
    // DEEP budget for work that never failed at runtime.
    runtimeFailures: int(input.runtimeFailures, 0, 0, 99),
    lastVerdict: input.lastVerdict || "FAIL",
  })
  // Retry policy, stated once: the first retry earns more room, a second retry
  // (or any captured failure text) earns the full DEEP budget. This is a FLOOR
  // on the recomputed decision, never a substitute for it.
  const wanted = addedFailures >= 2 || failureText ? EXECUTION_PROFILE.DEEP : EXECUTION_PROFILE.BALANCED
  let merged = higherProfile(higherProfile(base.executionProfile, escalated.executionProfile), wanted)
  if (merged === base.executionProfile) {
    return { ...base, refinements: [...(base.refinements || []), "no-escalation"] }
  }
  // When the recomputed decision would land BELOW the retry floor, the floor is
  // expressed as EVIDENCE the classifier already understands (a repeated
  // verifier failure) and the decision is recomputed once more. A DEEP budget
  // therefore can never carry a zero-turn advisor, a `none` role or a
  // `none` packet tier: the profile and every profile-derived field come out of
  // the SAME computation.
  const floorEvidence = merged === EXECUTION_PROFILE.DEEP ? Math.max(addedFailures, 2) : addedFailures
  const refined = merged === escalated.executionProfile
    ? escalated
    : recomputeFromBase(base, {
        ...input,
        verifierFailures: floorEvidence,
        runtimeFailures: int(input.runtimeFailures, 0, 0, 99),
        lastVerdict: input.lastVerdict || "FAIL",
      })
  const next = {
    ...refined,
    profileFloors: [...new Set([...(base.profileFloors || []), "retry-escalation"])],
    refinements: [...(base.refinements || []), `escalated:${base.executionProfile}->${refined.executionProfile}`],
    reasons: [...(base.reasons || []), ...refined.reasons.filter((row) => row.impact > 0)],
  }
  // The chained inputs are the inputs that produced THIS budget, so the next
  // retry refines from the state that actually decided it. Non-enumerable: the
  // budget is spread into `policy.v16_6` and written to trajectory events.
  Object.defineProperty(next, REFINE_INPUTS, {
    value: { ...(base?.[REFINE_INPUTS] || {}), ...input, verifierFailures: floorEvidence },
    enumerable: false,
    writable: false,
    configurable: true,
  })
  next.fingerprint = budgetFingerprint(next)
  return next
}

/** Human-readable one-liner for the observer / run journal. */
export function describeOrchestrationBudget(budget) {
  const row = budget || {}
  return [
    ORCHESTRATION_BUDGET_RELEASE.toUpperCase(),
    row.executionProfile || "?",
    row.taskComplexity || "?",
    `turns=${row.deepSeekTurnBudget?.effectiveMaxTurns ?? 0}`,
    `skills=${row.skillBudget?.maxSkills ?? 0}`,
    `tools=${row.maxAdvertisedTools ?? 0}`,
    `delegation=${row.maxChildren ?? 0}`,
    `verify=${row.verificationStrategy || "?"}`,
  ].join(" | ")
}

/**
 * V16.16 run-level cost reservation (§12).
 *
 * Parallelism must not make wall time faster while making token/cost
 * dramatically worse. Before spawning a wave, the caller reserves a bounded
 * cost against the run budget. The decision is deterministic and never spends
 * a model call to decide model usage.
 *
 * When the budget is insufficient the reservation answers with the cheaper
 * safe alternative IN ORDER: parent-direct where safe, lower concurrency,
 * serialize, delay the optional advisor. Required verification is NEVER
 * removed (`verificationIntact` is always true).
 *
 * Tiny/small tasks default to zero DeepSeek unless the caller explicitly
 * marks the consult necessary; hard tasks get a bounded DeepSeek allowance.
 *
 * @param {object} budget   a computeOrchestrationBudget result (or null)
 * @param {object} request  { parentTurns, childTurns, childContextChars,
 *   simultaneousCalls, deepseekCalls, researchCalls, subprocessSlots,
 *   testSlots, wallMs, taskShape, deepseekNecessary }
 */
export function reserveRunCost(budget = null, request = {}) {
  const num = (value, fallback = 0) => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  const shape = String(request.taskShape || "").toUpperCase()
  const tiny = shape === "TINY" || shape === "SMALL"
  const limits = {
    maxChildTurns: budget?.deepSeekTurnBudget?.effectiveMaxTurns != null
      ? Math.max(0, budget.deepSeekTurnBudget.effectiveMaxTurns * 4)
      : 24,
    maxSimultaneousCalls: Math.max(1, Math.min(3, num(budget?.maxParallel, 2))),
    maxChildContextChars: Math.max(8_000, num(budget?.contextBudget, 20_000)),
    maxDeepseekCalls: tiny && request.deepseekNecessary !== true
      ? 0
      : Math.max(0, Math.min(4, num(budget?.deepSeekTurnBudget?.effectiveMaxTurns, 2))),
    maxResearchCalls: 3,
    maxSubprocessSlots: 4,
    maxTestSlots: 4,
  }
  const reasons = []
  let action = "admit"
  const within = (value, limit, name) => {
    if (value > limit) {
      reasons.push({ signal: `over-${name}`, detail: `requested ${value} exceeds run reservation ${limit}` })
      return false
    }
    return true
  }
  const okTurns = within(num(request.childTurns), limits.maxChildTurns, "child-turns")
  const okSimultaneous = within(num(request.simultaneousCalls), limits.maxSimultaneousCalls, "simultaneous-calls")
  const okContext = within(num(request.childContextChars), limits.maxChildContextChars, "child-context-chars")
  const okDeepseek = within(num(request.deepseekCalls), limits.maxDeepseekCalls, "deepseek-calls")
  const okResearch = within(num(request.researchCalls), limits.maxResearchCalls, "research-calls")
  const okProc = within(num(request.subprocessSlots), limits.maxSubprocessSlots, "subprocess-slots")
  const okTests = within(num(request.testSlots), limits.maxTestSlots, "test-slots")
  if (tiny && num(request.deepseekCalls) > 0 && request.deepseekNecessary !== true) {
    reasons.push({ signal: "tiny-task-no-deepseek", detail: "tiny/small work defaults to zero DeepSeek unless explicitly necessary" })
  }
  if (!(okTurns && okSimultaneous && okContext && okDeepseek && okResearch && okProc && okTests)) {
    // Cheaper safe alternative, in order. Verification is never on the table.
    if (!okSimultaneous && num(request.simultaneousCalls) > 1) {
      action = "lower-concurrency"
      reasons.push({ signal: "lower-concurrency", detail: `reduce simultaneous calls to ${limits.maxSimultaneousCalls}` })
    } else if (tiny) {
      action = "parent-direct"
      reasons.push({ signal: "parent-direct", detail: "tiny/small work stays parent-direct when the reservation does not fit" })
    } else if (!okDeepseek || !okResearch) {
      action = "delay-optional-advisor"
      reasons.push({ signal: "delay-optional-advisor", detail: "optional advisor/research deferred; required verification unchanged" })
    } else {
      action = "serialize"
      reasons.push({ signal: "serialize", detail: "serialize the wave instead of overlapping it" })
    }
  }
  return {
    schemaVersion: ORCHESTRATION_BUDGET_SCHEMA_VERSION,
    release: ORCHESTRATION_BUDGET_RELEASE,
    policy: ORCHESTRATION_BUDGET_POLICY,
    action,
    admitted: action === "admit",
    limits,
    reasons,
    // Required verification is never removed by a cost decision.
    verificationIntact: true,
    deepseekAllowed: limits.maxDeepseekCalls,
    deterministic: true,
  }
}

export const ORCHESTRATION_BUDGET_EXPORTS = Object.freeze([
  "computeOrchestrationBudget",
  "classifyExecutionComplexity",
  "applyOrchestrationBudgetToTaskPolicy",
  "refineOrchestrationBudget",
  "budgetFingerprint",
  "describeOrchestrationBudget",
  "reserveRunCost",
  "EXECUTION_PROFILE",
  "PROFILE_SPEND",
  "DELEGATION_HARD_MAX",
])
