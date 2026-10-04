// V16.6 Advisor Benefit Learner V3 (spec §21).
//
// V16.5's learner (v2) owned a single number: the AUTO consultation weight. V16.6
// widens the observation to WHAT was useful, not just WHETHER consulting helped:
//
//   * advisor role usefulness        (taskClass | phase | role)
//   * phase usefulness               (taskClass | phase)
//   * task-class usefulness          (taskClass)
//   * evidence-request usefulness    (taskClass | evidenceKind)
//   * extra-turn usefulness          (taskClass | phase)
//
// Authority (asserted by assertAdvisorLearnerV3Authority): the learner is
// ADVISORY ONLY. It may reorder a set of roles the caller already selected; it
// may never invent a role, add a turn, force external reasoning on, disable the
// verifier, change permissions, drop evidence or produce a verdict. Every
// decision still flows through the unified budget and the local verifier.
//
// State is bounded and persisted to the same single learning directory the V16.6
// release already owns (`.ues-learning`). V16.6 adds no second conversation
// store: this module stores aggregate counters, never advice text.

import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export const ADVISOR_LEARNER_V3_SCHEMA_VERSION = 3
export const ADVISOR_LEARNER_V3 = Object.freeze({
  minSamples: 8,
  maxKeys: 800,
  hysteresisMargin: 0.15,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
})

export const LEARNER_V3_FORBIDDEN_EFFECTS = Object.freeze([
  "force-web",
  "disable-verifier",
  "change-permissions",
  "produce-pass",
  "bypass-security",
  "override-user-mode",
  "invent-role",
  "add-turn",
  "drop-evidence",
])

const OBSERVED_FIELDS_V3 = Object.freeze([
  "consulted",
  "adviceAccepted",
  "finalVerifiedResult",
  "evidenceRequestKind",
  "extraTurn",
  "verifierAttemptsBefore",
  "verifierAttemptsAfter",
  "wallTimeDeltaMs",
  "toolCallDelta",
  "followUps",
  "fallbacks",
])

const ROLE_STORE = new Map()
const EVIDENCE_STORE = new Map()
const TURN_STORE = new Map()

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function boundedSet(store, maxKeys) {
  while (store.size > maxKeys) store.delete(store.keys().next().value)
}

function newRow(key, fields) {
  return {
    key,
    ...fields,
    samples: 0,
    benefit: 0,
    harm: 0,
    accepted: 0,
    rejected: 0,
    verifierAttemptsBeforeSum: 0,
    verifierAttemptsBeforeSamples: 0,
    verifierAttemptsAfterSum: 0,
    verifierAttemptsAfterSamples: 0,
    wallTimeDeltaSum: 0,
    wallTimeSamples: 0,
    followUpsSum: 0,
    fallbackSum: 0,
    lastSeenAt: 0,
  }
}

function applySample(row, sample) {
  row.samples += 1
  row.lastSeenAt = Date.now()
  if (sample.adviceAccepted === true) row.accepted += 1
  if (sample.adviceAccepted === false) row.rejected += 1
  if (sample.finalVerifiedResult === true) row.benefit += 1
  if (sample.finalVerifiedResult === false) row.harm += 1
  const before = numberOrNull(sample.verifierAttemptsBefore)
  if (before !== null) {
    row.verifierAttemptsBeforeSum += before
    row.verifierAttemptsBeforeSamples += 1
  }
  const after = numberOrNull(sample.verifierAttemptsAfter)
  if (after !== null) {
    row.verifierAttemptsAfterSum += after
    row.verifierAttemptsAfterSamples += 1
  }
  const wall = numberOrNull(sample.wallTimeDeltaMs)
  if (wall !== null) {
    row.wallTimeDeltaSum += wall
    row.wallTimeSamples += 1
  }
  row.followUpsSum += Number(sample.followUps || 0)
  row.fallbackSum += Number(sample.fallbacks || 0)
}

/**
 * Record one advisor outcome across the V16.6 observation dimensions. Returns
 * the keys updated. Never throws on missing dimensions.
 */
export function recordAdvisorOutcomeV3(sample = {}) {
  const taskClass = String(sample.taskClass || "unknown")
  const phase = String(sample.phase || "execute")
  const role = String(sample.advisorRole || sample.role || "none")
  const keys = {}

  const roleKey = `${taskClass}|${phase}|${role}`
  let roleRow = ROLE_STORE.get(roleKey)
  if (!roleRow) {
    roleRow = newRow(roleKey, { taskClass, phase, advisorRole: role })
    ROLE_STORE.set(roleKey, roleRow)
  }
  applySample(roleRow, sample)
  keys.role = roleKey

  const evidenceKind = String(sample.evidenceRequestKind || "").trim()
  if (evidenceKind) {
    const evidenceKey = `${taskClass}|${evidenceKind}`
    let evidenceRow = EVIDENCE_STORE.get(evidenceKey)
    if (!evidenceRow) {
      evidenceRow = newRow(evidenceKey, { taskClass, evidenceRequestKind: evidenceKind })
      EVIDENCE_STORE.set(evidenceKey, evidenceRow)
    }
    applySample(evidenceRow, sample)
    keys.evidenceRequest = evidenceKey
  }

  if (sample.extraTurn === true || sample.extraTurn === false) {
    const turnKey = `${taskClass}|${phase}`
    let turnRow = TURN_STORE.get(turnKey)
    if (!turnRow) {
      turnRow = newRow(turnKey, { taskClass, phase })
      TURN_STORE.set(turnKey, turnRow)
    }
    applySample(turnRow, sample)
    keys.extraTurn = turnKey
  }

  boundedSet(ROLE_STORE, ADVISOR_LEARNER_V3.maxKeys)
  boundedSet(EVIDENCE_STORE, ADVISOR_LEARNER_V3.maxKeys)
  boundedSet(TURN_STORE, ADVISOR_LEARNER_V3.maxKeys)
  return { recorded: true, keys }
}

function summarizeRow(row, minSamples, margin) {
  const benefitRate = row.samples ? row.benefit / row.samples : 0
  const harmRate = row.samples ? row.harm / row.samples : 0
  const score = numberOrNull(benefitRate - harmRate)
  const sufficient = row.samples >= minSamples
  return {
    key: row.key,
    samples: row.samples,
    benefitRate,
    harmRate,
    score,
    sufficient,
    useful: sufficient && score > margin,
    harmful: sufficient && score < -margin,
    neutral: !sufficient || Math.abs(score) <= margin,
    verifierAttemptsBeforeAvg: row.verifierAttemptsBeforeSamples
      ? Number((row.verifierAttemptsBeforeSum / row.verifierAttemptsBeforeSamples).toFixed(3))
      : null,
    verifierAttemptsAfterAvg: row.verifierAttemptsAfterSamples
      ? Number((row.verifierAttemptsAfterSum / row.verifierAttemptsAfterSamples).toFixed(3))
      : null,
    wallTimeDeltaAvgMs: row.wallTimeSamples
      ? Number((row.wallTimeDeltaSum / row.wallTimeSamples).toFixed(2))
      : null,
    followUpsAvg: row.samples ? Number((row.followUpsSum / row.samples).toFixed(3)) : 0,
    fallbacksAvg: row.samples ? Number((row.fallbackSum / row.samples).toFixed(3)) : 0,
  }
}

function minSamplesOf(options = {}) {
  return Math.max(ADVISOR_LEARNER_V3.minSamples, Number(options.minSamples) || 0)
}

/** Role usefulness for a task class (optionally a single phase). */
export function advisorRoleUsefulnessV3(input = {}, options = {}) {
  const taskClass = String(input.taskClass || "unknown")
  const phase = input.phase ? String(input.phase) : null
  const minSamples = minSamplesOf(options)
  const rows = []
  for (const row of ROLE_STORE.values()) {
    if (row.taskClass !== taskClass) continue
    if (phase && row.phase !== phase) continue
    rows.push({ ...summarizeRow(row, minSamples, ADVISOR_LEARNER_V3.hysteresisMargin), advisorRole: row.advisorRole, phase: row.phase })
  }
  rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.advisorRole.localeCompare(b.advisorRole))
  const confident = rows.filter((row) => row.sufficient && !row.neutral)
  return {
    schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
    dimension: "advisor-role",
    taskClass,
    phase,
    minSamples,
    rows,
    preferred: confident[0]?.advisorRole || null,
    authority: "advisory-only",
  }
}

/** Evidence-request usefulness for a task class. */
export function advisorEvidenceRequestUsefulnessV3(input = {}, options = {}) {
  const taskClass = String(input.taskClass || "unknown")
  const minSamples = minSamplesOf(options)
  const rows = []
  for (const row of EVIDENCE_STORE.values()) {
    if (row.taskClass !== taskClass) continue
    rows.push({ ...summarizeRow(row, minSamples, ADVISOR_LEARNER_V3.hysteresisMargin), evidenceRequestKind: row.evidenceRequestKind })
  }
  rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.evidenceRequestKind.localeCompare(b.evidenceRequestKind))
  return {
    schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
    dimension: "evidence-request",
    taskClass,
    minSamples,
    rows,
    preferred: rows.find((row) => row.sufficient && !row.neutral)?.evidenceRequestKind || null,
    authority: "advisory-only",
  }
}

/** Extra-turn usefulness for a task class + phase. */
export function advisorExtraTurnUsefulnessV3(input = {}, options = {}) {
  const taskClass = String(input.taskClass || "unknown")
  const phase = input.phase ? String(input.phase) : null
  const minSamples = minSamplesOf(options)
  const rows = []
  for (const row of TURN_STORE.values()) {
    if (row.taskClass !== taskClass) continue
    if (phase && row.phase !== phase) continue
    rows.push({ ...summarizeRow(row, minSamples, ADVISOR_LEARNER_V3.hysteresisMargin), phase: row.phase })
  }
  rows.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.phase.localeCompare(b.phase))
  return {
    schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
    dimension: "extra-turn",
    taskClass,
    phase,
    minSamples,
    rows,
    preferred: rows.find((row) => row.sufficient && !row.neutral) ? true : false,
    authority: "advisory-only",
  }
}

/**
 * Reorder an already-selected role list by learned usefulness. The set of
 * roles is never changed: no role is invented and none is dropped. Returns the
 * reordered roles plus the decision, or `applied:false` when the learner has no
 * confident preference.
 */
export function orderAdvisorRolesV3(roles = [], input = {}, options = {}) {
  const original = (Array.isArray(roles) ? roles : [roles]).map((role) => String(role || "")).filter(Boolean)
  if (original.length <= 1) {
    return {
      schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
      roles: original,
      applied: false,
      preferred: null,
      reason: "single-or-empty-role-set",
      samples: 0,
      effect: "advisory-ordering-only",
    }
  }
  const usefulness = advisorRoleUsefulnessV3(input, options)
  const scoreByRole = new Map(usefulness.rows.map((row) => [row.advisorRole, row]))
  const scored = original
    .filter((role) => scoreByRole.get(role)?.sufficient && !scoreByRole.get(role)?.neutral)
    .sort((a, b) => (scoreByRole.get(b)?.score ?? -Infinity) - (scoreByRole.get(a)?.score ?? -Infinity))
  const scoredSet = new Set(scored)
  const reordered = [...scored, ...original.filter((role) => !scoredSet.has(role))]
  const preferred = scored[0] || null
  const applied = preferred !== null && preferred !== original[0]
  return {
    schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
    roles: reordered,
    applied,
    preferred,
    reason: applied ? "learned-role-usefulness" : preferred ? "already-preferred" : "insufficient-data",
    samples: preferred ? scoreByRole.get(preferred)?.samples || 0 : 0,
    effect: "advisory-ordering-only",
  }
}

export function advisorLearnerV3Report(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || ADVISOR_LEARNER_V3.maxAgeMs)
  const now = Number(options.now) || Date.now()
  const collect = (store, extraKey) => [...store.values()].map((row) => ({
    ...summarizeRow(row, minSamplesOf(options), ADVISOR_LEARNER_V3.hysteresisMargin),
    ...row,
    [extraKey]: row[extraKey],
    stale: now - row.lastSeenAt > maxAge,
  }))
  return {
    schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
    minSamples: minSamplesOf(options),
    maxKeys: ADVISOR_LEARNER_V3.maxKeys,
    observedFields: [...OBSERVED_FIELDS_V3],
    forbiddenEffects: [...LEARNER_V3_FORBIDDEN_EFFECTS],
    roleKeys: ROLE_STORE.size,
    evidenceKeys: EVIDENCE_STORE.size,
    turnKeys: TURN_STORE.size,
    roles: collect(ROLE_STORE, "advisorRole"),
    evidenceRequests: collect(EVIDENCE_STORE, "evidenceRequestKind"),
    extraTurns: collect(TURN_STORE, "turnKey"),
  }
}

export function gcAdvisorLearnerV3(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || ADVISOR_LEARNER_V3.maxAgeMs)
  const now = Number(options.now) || Date.now()
  let removed = 0
  for (const store of [ROLE_STORE, EVIDENCE_STORE, TURN_STORE]) {
    const stale = [...store.entries()]
      .filter(([, row]) => now - row.lastSeenAt > maxAge)
      .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
    for (const [key] of stale) {
      if (store.size - removed < ADVISOR_LEARNER_V3.maxKeys * 0.9) break
      store.delete(key)
      removed += 1
    }
    boundedSet(store, ADVISOR_LEARNER_V3.maxKeys)
  }
  return { removed, roleKeys: ROLE_STORE.size, evidenceKeys: EVIDENCE_STORE.size, turnKeys: TURN_STORE.size }
}

export function resetAdvisorLearnerV3ForTests() {
  ROLE_STORE.clear()
  EVIDENCE_STORE.clear()
  TURN_STORE.clear()
}

function statePath(root) {
  return path.join(path.resolve(root), ".ues-learning", ".advisor-learner-v3.json")
}

export async function saveAdvisorLearnerV3(root, options = {}) {
  const file = statePath(root)
  const payload = {
    schemaVersion: ADVISOR_LEARNER_V3_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    roles: [...ROLE_STORE.values()],
    evidenceRequests: [...EVIDENCE_STORE.values()],
    extraTurns: [...TURN_STORE.values()],
  }
  const text = JSON.stringify(payload)
  if (text.length > (Number(options.maxBytes) || 2_000_000)) {
    return { saved: false, reason: "state-too-large", chars: text.length }
  }
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, text + "\n", "utf8")
  await rename(temp, file)
  return { saved: true, file: path.relative(path.resolve(root), file).replaceAll("\\", "/"), chars: text.length }
}

export async function loadAdvisorLearnerV3(root) {
  const file = statePath(root)
  if (!existsSync(file)) return { loaded: false, rows: 0 }
  const parsed = JSON.parse(await readFile(file, "utf8"))
  ROLE_STORE.clear()
  EVIDENCE_STORE.clear()
  TURN_STORE.clear()
  for (const row of parsed.roles || []) if (ROLE_STORE.size < ADVISOR_LEARNER_V3.maxKeys) ROLE_STORE.set(row.key, row)
  for (const row of parsed.evidenceRequests || []) if (EVIDENCE_STORE.size < ADVISOR_LEARNER_V3.maxKeys) EVIDENCE_STORE.set(row.key, row)
  for (const row of parsed.extraTurns || []) if (TURN_STORE.size < ADVISOR_LEARNER_V3.maxKeys) TURN_STORE.set(row.key, row)
  return { loaded: true, rows: ROLE_STORE.size + EVIDENCE_STORE.size + TURN_STORE.size }
}

/**
 * Executable authority guard: any advice the learner produces must be
 * ordering-only and must not claim a forbidden effect.
 */
export function assertAdvisorLearnerV3Authority(advice) {
  const violations = []
  if (advice?.effect !== "advisory-ordering-only") violations.push("effect must be advisory-ordering-only")
  for (const forbidden of LEARNER_V3_FORBIDDEN_EFFECTS) {
    if (advice?.[forbidden] === true) violations.push(`learner must never ${forbidden}`)
  }
  return { ok: violations.length === 0, violations }
}

export const ADVISOR_LEARNER_V3_EXPORTS = Object.freeze([
  "recordAdvisorOutcomeV3",
  "advisorRoleUsefulnessV3",
  "advisorEvidenceRequestUsefulnessV3",
  "advisorExtraTurnUsefulnessV3",
  "orderAdvisorRolesV3",
  "advisorLearnerV3Report",
  "gcAdvisorLearnerV3",
  "saveAdvisorLearnerV3",
  "loadAdvisorLearnerV3",
  "assertAdvisorLearnerV3Authority",
])
