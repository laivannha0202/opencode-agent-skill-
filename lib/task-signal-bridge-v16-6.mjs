// V16.6 task signal bridge.
//
// Why this module exists.
//
// The unified budget (lib/orchestration-budget-v16-6.mjs) decides on evidence,
// and the advisor-role selector decides on a task class. Neither of those
// vocabularies matches what lib/task-policy.mjs actually returns.
//
// `classifyEngineeringTask()` produces `{ risk, score, signals[], domains[],
// executionProfile, mode, decision, recovery }`. It does NOT produce
// `taskClass`, `intent` or a `changeKind`, and `risk` is a defaulted string
// rather than an observed one. Two defects followed from that mismatch:
//
//   1. `risk: taskPolicy.risk || input.risk` silently discarded an explicit
//      caller escalation (`input.risk = "high"`) because `taskPolicy.risk` is
//      always a non-empty string - a high-risk task could never escalate.
//   2. `selectAdvisorRolesV2` reads `intent`/`taskClass`, got nothing, and
//      fell through to `fallback:root-cause` for every task - so the advisor
//      role table was decorative in production.
//
// This module is the ONE place that translates the real task-policy shape into
// the V16.6 decision vocabulary. It is pure, deterministic and total: any
// missing signal becomes `unknown`, never a guess.
//
// It adds no authority. It cannot grant permission, decide PASS, or change a
// safety floor; it only labels evidence the budget already consumes.

import { PROVENANCE, derived, measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const TASK_SIGNAL_BRIDGE_SCHEMA_VERSION = 1
export const TASK_SIGNAL_BRIDGE_POLICY = "task-signal-bridge-v16-6"

// Ordered so escalation is a max(), never a silent downgrade.
export const RISK_RANK = Object.freeze({
  unknown: 0,
  none: 0,
  low: 1,
  medium: 2,
  moderate: 2,
  high: 3,
  critical: 4,
})

export const RISK_VALUES = Object.freeze(["unknown", "low", "medium", "high", "critical"])

// Domains the repository's own classifier marks as sensitive. A task touching
// one of these is a risk ELEVATION floor, never a way to spend less.
const SENSITIVE_DOMAINS = Object.freeze({
  "auth-security": "high",
  payment: "high",
  database: "medium",
  "api-contract": "medium",
})

// Map `classifyEngineeringTask().domains` onto a V16.6 change kind.
//
// `nextjs` is deliberately NOT mapped to `ui`: Next.js is a full-stack
// framework, and a "route handler returns 500" report is a backend bug hunt,
// not a design review. Treating it as UI sent those tasks to the UI advisor.
const DOMAIN_CHANGE_KIND = Object.freeze({
  "auth-security": "security",
  payment: "data",
  database: "data",
  "api-contract": "feature",
  devops: "config",
  "react-native": "ui",
  react: "ui",
})

const CHANGE_KINDS = Object.freeze([
  "bugfix",
  "feature",
  "refactor",
  "architecture",
  "security",
  "data",
  "ui",
  "docs",
  "version",
  "test",
  "config",
  "research",
  "unknown",
])

const TASK_CLASSES = Object.freeze([
  "ui",
  "review",
  "planning",
  "research",
  "debugging",
  "general",
  "docs",
])

const INTENTS = Object.freeze([
  "ui-ux",
  "accessibility",
  "code-review",
  "plan",
  "architecture",
  "research",
  "debug",
  "implement",
  "docs",
])

function str(value, fallback = "") {
  const text = String(value ?? "").trim()
  return text || fallback
}

function normalizeRisk(value) {
  const key = str(value).toLowerCase()
  return Object.hasOwn(RISK_RANK, key) ? key : "unknown"
}

function riskRank(value) {
  return RISK_RANK[normalizeRisk(value)] ?? 0
}

function maxRisk(a, b) {
  const left = normalizeRisk(a)
  const right = normalizeRisk(b)
  return riskRank(right) > riskRank(left) ? right : left
}

function signalNames(taskPolicy) {
  const signals = Array.isArray(taskPolicy?.signals) ? taskPolicy.signals : []
  return signals.map((row) => String(row?.name || "")).filter(Boolean)
}

function hasSignal(names, name) {
  return names.includes(name)
}

function normalizeChangeKind(value) {
  const key = str(value).toLowerCase()
  return CHANGE_KINDS.includes(key) ? key : "unknown"
}

function normalizeTaskClass(value) {
  const key = str(value).toLowerCase()
  return TASK_CLASSES.includes(key) ? key : "general"
}

function normalizeIntent(value) {
  const key = str(value).toLowerCase()
  return INTENTS.includes(key) ? key : ""
}

/**
 * Bounded DETERMINISTIC-SHAPE detector.
 *
 * This is the only keyword-shaped thing in the V16.6 decision path, and it is
 * deliberately asymmetric: it can only ever contribute a DETERMINISTIC change
 * kind, which is a SPENDING CEILING (FAST, no DeepSeek). It can never escalate
 * a task, never grant authority, and never touch a safety floor - so a false
 * positive costs context, never correctness.
 *
 * The alternative (treating "no risk signal" as deterministic) was measured to
 * downgrade real bugs and UI tasks to FAST, which is far more expensive.
 *
 * The list is closed and auditable; add a shape only when the change really is
 * reasoning-free.
 */
const DETERMINISTIC_SHAPES = Object.freeze([
  { kind: "version", re: /\b(bump|change|update)\s+(the\s+)?(package\s+)?version\b|\bversion\s+(bump|to)\b/i },
  { kind: "docs", re: /\b(rewrite|fix|update|edit|correct|tidy)\b[^.\n]{0,40}\b(readme|changelog|docs?|documentation|comment)\b/i },
  { kind: "docs", re: /\btypo\b/i },
  { kind: "docs", re: /\bdoc(umentation)?\s+(string|text|comment)s?\b/i },
])

/**
 * @param {string} text raw task text
 * @returns {string|null} a deterministic change kind, or null
 */
export function detectDeterministicChangeKind(text) {
  const value = str(text)
  if (!value) return null
  for (const shape of DETERMINISTIC_SHAPES) {
    if (shape.re.test(value)) return shape.kind
  }
  return null
}

/**
 * Translate task-policy evidence into the V16.6 decision vocabulary.
 *
 * Precedence, highest first (never a silent downgrade):
 *   1. an explicit caller signal (`input.risk`, `input.changeKind`, ...)
 *   2. the sensitive domain the repository classifier already detected
 *   3. a named task-policy signal (`data-migration`, `declared-high-risk`, ...)
 *   4. the task policy's own profile/score
 *
 * Returns every field with its own reason so the budget can report WHY instead
 * of asserting a label.
 */
export function deriveTaskSignals(input = {}) {
  const taskPolicy = input.taskPolicy && typeof input.taskPolicy === "object" ? input.taskPolicy : {}
  const names = signalNames(taskPolicy)
  const domains = Array.isArray(taskPolicy.domains) ? taskPolicy.domains.map((row) => str(row)).filter(Boolean) : []
  const reasons = []

  // A caller-declared long-horizon mode is plan-shaped work even when the task
  // text carried no long-request signal. Computed first: it decides the change
  // kind and the task class below.
  const modeWord = str(input.mode || taskPolicy.mode).toLowerCase()
  const longHorizonMode = ["long", "long-horizon", "deep"].includes(modeWord) || input.longHorizon === true
  const explicitLongHorizon = hasSignal(names, "explicit-long-horizon") || longHorizonMode

  // --- risk -------------------------------------------------------------
  const policyRisk = normalizeRisk(taskPolicy.risk)
  const callerRisk = normalizeRisk(input.risk)
  let risk = maxRisk(policyRisk, callerRisk)
  if (callerRisk !== "unknown" && riskRank(callerRisk) > riskRank(policyRisk)) {
    reasons.push({ signal: `risk-explicit:${callerRisk}`, basis: "runtime-evidence" })
  }

  let domainRisk = "unknown"
  for (const domain of domains) {
    const candidate = SENSITIVE_DOMAINS[domain]
    if (candidate && riskRank(candidate) > riskRank(domainRisk)) domainRisk = candidate
  }
  if (riskRank(domainRisk) > riskRank(risk)) {
    reasons.push({ signal: `risk-domain:${domains.join(",")}=${domainRisk}`, basis: "repository-structure" })
    risk = domainRisk
  }
  if (!reasons.length) reasons.push({ signal: `risk:${risk}`, basis: "repository-structure" })

  // --- change kind ------------------------------------------------------
  let changeKind = normalizeChangeKind(input.changeKind)
  if (changeKind === "unknown" && input.text !== undefined && input.text !== null) {
    const detected = detectDeterministicChangeKind(input.text)
    if (detected) {
      changeKind = detected
      reasons.push({ signal: `change-kind-deterministic-shape:${detected}`, basis: "task-text" })
    }
  }
  if (changeKind === "unknown") {
    for (const domain of domains) {
      const mapped = DOMAIN_CHANGE_KIND[domain]
      if (mapped) {
        changeKind = mapped
        reasons.push({ signal: `change-kind-domain:${domain}`, basis: "repository-structure" })
        break
      }
    }
  }
  if (changeKind === "unknown") {
    if (explicitLongHorizon) changeKind = "architecture"
    else if (hasSignal(names, "data-migration")) changeKind = "data"
    else if (hasSignal(names, "public-contract")) changeKind = "feature"
    else if (hasSignal(names, "debugging")) changeKind = "bugfix"
    else if (hasSignal(names, "declared-high-risk") || hasSignal(names, "high-risk-operation")) changeKind = "security"
    else if (hasSignal(names, "many-changed-files")) changeKind = "refactor"
  }
  // NOTE: changeKind deliberately stays "unknown" when no evidence identifies
  // it. Guessing "docs" from a zero task-policy score mislabelled an ordinary
  // refactor as a documentation edit, which is exactly the kind of invented
  // signal this release forbids.
  const changeKindSource = reasons.some((row) => row.signal.startsWith("change-kind-domain"))
    ? "repository-structure"
    : hasSignal(names, "debugging") || hasSignal(names, "data-migration")
      ? "task-text"
      : "repository-structure"

  // --- deterministic work ----------------------------------------------
  // "Deterministic" means: POSITIVE evidence that the change is bounded and
  // reasoning-free, and no risk signal anywhere.
  //
  // Absence of risk evidence is NOT evidence of determinism. An earlier version
  // treated `executionProfile: fast` + `score: 0` as deterministic, which is
  // what the task policy returns for ANY short, keyword-free sentence - so real
  // bugs and UI tasks ("route handler returns 500 on POST") were downgraded to
  // FAST with zero DeepSeek turns. Determinism must be asserted positively.
  //
  // `singleFileBounded` is deliberately NOT a deterministic signal. It bounds
  // the CHANGE SURFACE, not the REASONING: a one-file null dereference is
  // still a bug hunt that benefits from a second pair of eyes. It already drives
  // the FAST profile through `boundedSingleFile` in the budget.
  const DETERMINISTIC_KINDS = ["docs", "version", "config", "test"]
  const riskyDomains = domains.filter((domain) => SENSITIVE_DOMAINS[domain])
  const noRiskSignal =
    !hasSignal(names, "declared-high-risk") &&
    !hasSignal(names, "high-risk-operation") &&
    !hasSignal(names, "data-migration") &&
    !hasSignal(names, "public-contract") &&
    !hasSignal(names, "explicit-long-horizon") &&
    !riskyDomains.length
  const deterministic = DETERMINISTIC_KINDS.includes(changeKind) && noRiskSignal
  if (deterministic) {
    reasons.push({ signal: `deterministic:${changeKind}`, basis: "repository-structure" })
  }

  // --- task class + intent (for the advisor role selector) ---------------
  let taskClass = normalizeTaskClass(input.taskClass)
  let intent = normalizeIntent(input.intent)
  const UI_DOMAINS = ["react", "react-native"]
  if (taskClass === "general" && !intent) {
    // Ordered most-specific first. A DOMAIN shape outranks the `debugging`
    // signal, which lib/task-policy.mjs raises very broadly (it matches any
    // mention of an error/regression). Trusting it first turned a UI change and
    // a pre-merge review into root-cause hunts.
    if (explicitLongHorizon) {
      taskClass = "planning"
      intent = "architecture"
    } else if (domains.some((domain) => UI_DOMAINS.includes(domain))) {
      taskClass = "ui"
      intent = "ui-ux"
    } else if (changeKind === "ui") {
      taskClass = "ui"
      intent = "ui-ux"
    } else if (hasSignal(names, "debugging")) {
      taskClass = "debugging"
      intent = "debug"
    } else if (["docs", "version", "config"].includes(changeKind)) {
      taskClass = "docs"
      intent = "docs"
    }
  }
  if (intent) reasons.push({ signal: `intent:${intent}`, basis: "repository-structure" })

  const complexityAmbiguity = Number(input.ambiguity ?? 0)
  const ambiguity = Number.isFinite(complexityAmbiguity) ? complexityAmbiguity : 0

  return {
    schemaVersion: TASK_SIGNAL_BRIDGE_SCHEMA_VERSION,
    policy: TASK_SIGNAL_BRIDGE_POLICY,
    risk,
    riskRank: riskRank(risk),
    riskSource: callerRisk !== "unknown" && riskRank(callerRisk) >= riskRank(domainRisk) ? "runtime-evidence" : "repository-structure",
    domains,
    sensitiveDomains: riskyDomains,
    changeKind,
    changeKindSource,
    taskClass,
    intent: intent || null,
    deterministic,
    longHorizon: longHorizonMode,
    ambiguity,
    policyExecutionProfile: str(taskPolicy.executionProfile) || null,
    singleFileBounded: taskPolicy.singleFileBounded === true,
    policyScore: taskPolicy.score === undefined ? NOT_MEASURED : measured(Number(taskPolicy.score) || 0),
    signals: names,
    reasons,
    measurements: {
      risk: measured(risk),
      policyScore: taskPolicy.score === undefined ? NOT_MEASURED : measured(Number(taskPolicy.score) || 0),
      domains: derived(domains.length),
      signalCount: derived(names.length),
      ambiguity: input.ambiguity === undefined ? NOT_MEASURED : measured(ambiguity),
    },
    provenance: PROVENANCE.DERIVED,
  }
}

/**
 * Evidence-floor helper: does this signal set justify ESCALATING spend above
 * what the task policy already allowed?
 *
 * Deliberately does NOT include `deterministic-work`. Deterministic work is a
 * reason to spend LESS, and this list is consumed as "reasons to spend more";
 * mixing the two would let a typo fix escalate a run.
 */
export function escalationFloorFor(signals) {
  const row = signals && typeof signals === "object" ? signals : {}
  const floors = []
  if (["high", "critical"].includes(String(row.risk || ""))) floors.push(`risk=${row.risk}`)
  if (String(row.changeKind || "") === "security") floors.push("change-kind=security")
  if (String(row.changeKind || "") === "architecture") floors.push("change-kind=architecture")
  return floors
}

export const TASK_SIGNAL_BRIDGE_EXPORTS = Object.freeze([
  "deriveTaskSignals",
  "escalationFloorFor",
  "detectDeterministicChangeKind",
  "RISK_RANK",
  "RISK_VALUES",
])
