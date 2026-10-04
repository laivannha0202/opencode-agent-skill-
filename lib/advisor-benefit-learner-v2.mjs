// V16.5 Phase 10: Advisor Benefit Learner V2.
//
// V16.4's learner was observational. V16.5 adds provider/model scoping, a
// persisted bounded state with GC, and richer observation fields. It still may
// ONLY move the AUTO consultation weight.
//
// Never allowed (asserted by assertLearnerAuthority):
//   force web | disable verifier | change permissions | produce PASS
//   bypass security | override explicit user mode

import { existsSync } from "node:fs"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { ADVISOR_WEIGHT } from "./advisor-benefit-learner.mjs"

export const ADVISOR_LEARNER_V2_SCHEMA_VERSION = 2
export const ADVISOR_LEARNER_V2 = Object.freeze({
  minSamples: 8,
  maxKeys: 500,
  hysteresisMargin: 0.15,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
})

export const LEARNER_FORBIDDEN_EFFECTS = Object.freeze([
  "force-web",
  "disable-verifier",
  "change-permissions",
  "produce-pass",
  "bypass-security",
  "override-user-mode",
])

const OBSERVED_FIELDS = Object.freeze([
  "consulted",
  "adviceAccepted",
  "verifierAttemptsBefore",
  "verifierAttemptsAfter",
  "finalVerifiedResult",
  "wallTimeDeltaMs",
  "toolCallDelta",
  "providerTokens",
  "browserLatencyMs",
  "followUps",
  "fallbacks",
])

const store = new Map()

function keyOf(sample = {}) {
  return [
    String(sample.taskClass || "unknown"),
    String(sample.subsystemBucket || "s1"),
    String(sample.ambiguityClass || "low"),
    String(sample.failureClass || "none"),
    String(sample.provider || "deepseek-web"),
    String(sample.model || "unset"),
    String(sample.advisorRole || "none"),
  ].join("|")
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function resetAdvisorLearnerV2ForTests() {
  store.clear()
}

export function advisorLearnerV2Size() {
  return store.size
}

export function recordAdvisorOutcomeV2(sample = {}) {
  const key = keyOf(sample)
  let row = store.get(key)
  if (!row) {
    if (store.size >= ADVISOR_LEARNER_V2.maxKeys) store.delete(store.keys().next().value)
    row = {
      key,
      taskClass: String(sample.taskClass || "unknown"),
      subsystemBucket: String(sample.subsystemBucket || "s1"),
      ambiguityClass: String(sample.ambiguityClass || "low"),
      failureClass: String(sample.failureClass || "none"),
      provider: String(sample.provider || "deepseek-web"),
      model: String(sample.model || "unset"),
      advisorRole: String(sample.advisorRole || "none"),
      samples: 0,
      consulted: 0,
      accepted: 0,
      rejected: 0,
      verifiedPass: 0,
      verifiedFail: 0,
      verifierAttemptsBeforeSum: 0,
      verifierAttemptsAfterSum: 0,
      verifierAttemptsBeforeSamples: 0,
      verifierAttemptsAfterSamples: 0,
      wallTimeDeltaSum: 0,
      wallTimeSamples: 0,
      toolCallDeltaSum: 0,
      toolCallSamples: 0,
      providerTokenSamples: 0,
      browserLatencySum: 0,
      browserLatencySamples: 0,
      followUpsSum: 0,
      fallbackSum: 0,
      lastSeenAt: 0,
    }
    store.set(key, row)
  }
  row.samples += 1
  row.lastSeenAt = Date.now()
  if (sample.consulted === true) row.consulted += 1
  if (sample.adviceAccepted === true) row.accepted += 1
  if (sample.adviceAccepted === false) row.rejected += 1
  if (sample.finalVerifiedResult === true) row.verifiedPass += 1
  if (sample.finalVerifiedResult === false) row.verifiedFail += 1

  const before = numberOrNull(sample.verifierAttemptsBefore)
  if (before !== null) { row.verifierAttemptsBeforeSum += before; row.verifierAttemptsBeforeSamples += 1 }
  const after = numberOrNull(sample.verifierAttemptsAfter)
  if (after !== null) { row.verifierAttemptsAfterSum += after; row.verifierAttemptsAfterSamples += 1 }
  const wall = numberOrNull(sample.wallTimeDeltaMs)
  if (wall !== null) { row.wallTimeDeltaSum += wall; row.wallTimeSamples += 1 }
  const tools = numberOrNull(sample.toolCallDelta)
  if (tools !== null) { row.toolCallDeltaSum += tools; row.toolCallSamples += 1 }
  if (numberOrNull(sample.providerTokens) !== null) row.providerTokenSamples += 1
  const latency = numberOrNull(sample.browserLatencyMs)
  if (latency !== null) { row.browserLatencySum += latency; row.browserLatencySamples += 1 }
  row.followUpsSum += Number(sample.followUps || 0)
  row.fallbackSum += Number(sample.fallbacks || 0)
  return { key, samples: row.samples }
}

/**
 * AUTO consultation weight. NEUTRAL below the sample floor and inside the
 * hysteresis band. Only ever moves the AUTO weight.
 */
export function advisorWeightV2(sample = {}, options = {}) {
  const minSamples = Math.max(ADVISOR_LEARNER_V2.minSamples, Number(options.minSamples) || 0)
  const row = store.get(keyOf(sample))
  if (!row || row.samples < minSamples) {
    return {
      weight: ADVISOR_WEIGHT.NEUTRAL,
      reason: "insufficient-data",
      samples: row?.samples || 0,
      minSamples,
      effect: "auto-consult-weight-only",
    }
  }
  const benefitRate = row.verifiedPass / row.samples
  const harmRate = row.verifiedFail / row.samples
  const margin = ADVISOR_LEARNER_V2.hysteresisMargin
  if (benefitRate - harmRate > margin) {
    return { weight: ADVISOR_WEIGHT.CONSULT, reason: "historically-beneficial", benefitRate, harmRate, samples: row.samples, effect: "auto-consult-weight-only" }
  }
  if (harmRate - benefitRate > margin) {
    return { weight: ADVISOR_WEIGHT.LOCAL, reason: "historically-not-beneficial", benefitRate, harmRate, samples: row.samples, effect: "auto-consult-weight-only" }
  }
  return { weight: ADVISOR_WEIGHT.NEUTRAL, reason: "inside-hysteresis-band", benefitRate, harmRate, samples: row.samples, effect: "auto-consult-weight-only" }
}

export function advisorLearnerV2Report(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || ADVISOR_LEARNER_V2.maxAgeMs)
  const now = Number(options.now) || Date.now()
  const rows = []
  for (const [key, row] of store) {
    const stale = now - row.lastSeenAt > maxAge
    rows.push({
      key,
      taskClass: row.taskClass,
      provider: row.provider,
      model: row.model,
      advisorRole: row.advisorRole,
      samples: row.samples,
      consulted: row.consulted,
      accepted: row.accepted,
      rejected: row.rejected,
      verifiedPass: row.verifiedPass,
      verifiedFail: row.verifiedFail,
      verifierAttemptsBeforeAvg: row.verifierAttemptsBeforeSamples ? Number((row.verifierAttemptsBeforeSum / row.verifierAttemptsBeforeSamples).toFixed(3)) : null,
      verifierAttemptsAfterAvg: row.verifierAttemptsAfterSamples ? Number((row.verifierAttemptsAfterSum / row.verifierAttemptsAfterSamples).toFixed(3)) : null,
      wallTimeDeltaAvgMs: row.wallTimeSamples ? Number((row.wallTimeDeltaSum / row.wallTimeSamples).toFixed(2)) : null,
      toolCallDeltaAvg: row.toolCallSamples ? Number((row.toolCallDeltaSum / row.toolCallSamples).toFixed(3)) : null,
      providerTokenSamples: row.providerTokenSamples,
      browserLatencyAvgMs: row.browserLatencySamples ? Number((row.browserLatencySum / row.browserLatencySamples).toFixed(2)) : null,
      followUpsAvg: Number((row.followUpsSum / row.samples).toFixed(3)),
      fallbacksAvg: Number((row.fallbackSum / row.samples).toFixed(3)),
      weight: advisorWeightV2({ ...row }).weight,
      stale,
    })
  }
  return {
    schemaVersion: ADVISOR_LEARNER_V2_SCHEMA_VERSION,
    keys: store.size,
    maxKeys: ADVISOR_LEARNER_V2.maxKeys,
    minSamples: ADVISOR_LEARNER_V2.minSamples,
    observedFields: [...OBSERVED_FIELDS],
    forbiddenEffects: [...LEARNER_FORBIDDEN_EFFECTS],
    rows,
  }
}

/** Bounded GC: drops stale rows, oldest first, capped at maxKeys. */
export function gcAdvisorLearnerV2(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || ADVISOR_LEARNER_V2.maxAgeMs)
  const now = Number(options.now) || Date.now()
  const stale = [...store.entries()].filter(([, row]) => now - row.lastSeenAt > maxAge).sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
  let removed = 0
  for (const [key] of stale) {
    if (store.size - removed >= ADVISOR_LEARNER_V2.maxKeys * 0.9) break
    store.delete(key)
    removed += 1
  }
  while (store.size > ADVISOR_LEARNER_V2.maxKeys) {
    store.delete(store.keys().next().value)
    removed += 1
  }
  return { removed, remaining: store.size }
}

function statePath(root) {
  return path.join(path.resolve(root), ".ues-work", ".advisor-learner-v2.json")
}

export async function saveAdvisorLearnerV2(root, options = {}) {
  const file = statePath(root)
  const payload = {
    schemaVersion: ADVISOR_LEARNER_V2_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    rows: [...store.values()].map((row) => ({ ...row })),
  }
  const text = JSON.stringify(payload)
  if (text.length > (Number(options.maxBytes) || 512_000)) {
    return { saved: false, reason: "state-too-large", chars: text.length }
  }
  await mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, text + "\n", "utf8")
  await rename(temp, file)
  return { saved: true, file: path.relative(path.resolve(root), file).replaceAll("\\", "/"), chars: text.length }
}

export async function loadAdvisorLearnerV2(root) {
  const file = statePath(root)
  if (!existsSync(file)) return { loaded: false, rows: 0 }
  const parsed = JSON.parse(await readFile(file, "utf8"))
  store.clear()
  for (const row of parsed.rows || []) {
    if (store.size >= ADVISOR_LEARNER_V2.maxKeys) break
    store.set(row.key || keyOf(row), row)
  }
  return { loaded: true, rows: store.size }
}

export function assertLearnerAuthority(weight) {
  const violations = []
  if (weight?.weight === undefined) violations.push("weight is undefined")
  if (weight?.effect !== "auto-consult-weight-only") violations.push("learner effect must be auto-consult-weight-only")
  for (const forbidden of LEARNER_FORBIDDEN_EFFECTS) {
    if (weight?.[forbidden] === true) violations.push(`learner must never ${forbidden}`)
  }
  return { ok: violations.length === 0, violations }
}
