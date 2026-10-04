// V16.5 Phase 11: Reasoning Doctor (READ-ONLY).
//
// Reports web-reasoning readiness without submitting anything, mutating state,
// printing credentials, or touching a browser profile/cookie store.
//
// Everything here is a pure read of already-bounded in-process state plus
// already-persisted local telemetry. Unavailable values stay explicitly
// unavailable; they are never guessed.

import { advisorLearnerV2Report } from "./advisor-benefit-learner-v2.mjs"
import { packetTelemetry } from "./decision-packet-tiers.mjs"
import { ADVISOR_ROLES } from "./deepseek-advisor-roles.mjs"

export const REASONING_DOCTOR_SCHEMA_VERSION = 1

export const REASONING_READINESS = Object.freeze({
  READY: "ready",
  DEGRADED: "degraded",
  UNAVAILABLE: "unavailable",
  UNKNOWN: "unknown",
})

function availability(value) {
  if (value === true) return REASONING_READINESS.READY
  if (value === false) return REASONING_READINESS.UNAVAILABLE
  return REASONING_READINESS.UNKNOWN
}

/**
 * Build the read-only reasoning readiness report.
 * @param {object} input
 * @param {"AUTO"|"OFF"|"FORCE"|string} [input.mode]
 * @param {boolean} [input.adapterAvailable]
 * @param {string}  [input.profile]     configured model profile id
 * @param {boolean} [input.profileConfigured]
 * @param {boolean} [input.sessionReady] only if safely observable
 * @param {number}  [input.lastMeasuredLatencyMs]
 * @param {Array}   [input.recentConsultations]
 * @param {object}  [input.followUpHealth]
 * @param {boolean} [input.authenticated]  boolean only; never a credential
 */
export function reasoningDoctor(input = {}) {
  const recent = Array.isArray(input.recentConsultations) ? input.recentConsultations : []
  const accepted = recent.filter((row) => row?.adviceAccepted === true).length
  const rejected = recent.filter((row) => row?.adviceAccepted === false).length
  const consulted = recent.length
  const learner = advisorLearnerV2Report()

  const packet = safePacketTelemetry()
  const advisorRoles = Object.values(ADVISOR_ROLES)

  const rows = [
    { key: "provider", label: "Provider", value: String(input.provider || "deepseek-web"), readiness: REASONING_READINESS.READY },
    { key: "mode", label: "Mode", value: String(input.mode || "AUTO").toUpperCase(), readiness: REASONING_READINESS.READY },
    { key: "adapter", label: "Adapter available", value: availability(input.adapterAvailable), readiness: availability(input.adapterAvailable) },
    { key: "profile", label: "Model profile", value: String(input.profile || "unset"), readiness: input.profileConfigured === true ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "session", label: "Session readiness", value: availability(input.sessionReady), readiness: availability(input.sessionReady), note: input.sessionReady === undefined ? "not safely observable in this context" : null },
    { key: "latency", label: "Last measured latency", value: Number.isFinite(Number(input.lastMeasuredLatencyMs)) ? `${Math.round(Number(input.lastMeasuredLatencyMs))} ms` : "NOT_MEASURED", readiness: Number.isFinite(Number(input.lastMeasuredLatencyMs)) ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "consultations", label: "Recent consultations", value: String(consulted), readiness: consulted ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "advice", label: "Recent accept / reject", value: `${accepted} / ${rejected}`, readiness: consulted ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "learner", label: "Benefit learner", value: `${learner.keys} keys, floor ${learner.minSamples}`, readiness: learner.keys ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "packet-tiers", label: "Packet tier stats", value: packet ? JSON.stringify(packet) : "NOT_MEASURED", readiness: packet ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "follow-ups", label: "Follow-up health", value: input.followUpHealth ? JSON.stringify(input.followUpHealth) : "NOT_MEASURED", readiness: input.followUpHealth ? REASONING_READINESS.READY : REASONING_READINESS.UNKNOWN },
    { key: "advisor-roles", label: "Specialist advisor roles", value: advisorRoles.join(", "), readiness: REASONING_READINESS.READY },
    { key: "auth", label: "Authenticated profile", value: availability(input.authenticated), readiness: availability(input.authenticated), note: "boolean only; no credential, cookie or storage value is read" },
  ]

  const blocking = rows.filter((row) => row.readiness === REASONING_READINESS.UNAVAILABLE)
  const verdict = blocking.length === 0
    ? (rows.some((row) => row.readiness === REASONING_READINESS.UNKNOWN) ? REASONING_READINESS.DEGRADED : REASONING_READINESS.READY)
    : REASONING_READINESS.UNAVAILABLE

  return {
    schemaVersion: REASONING_DOCTOR_SCHEMA_VERSION,
    release: "v16.5",
    readOnly: true,
    verdict,
    rows,
    learner: { keys: learner.keys, minSamples: learner.minSamples, weights: learner.rows.map((row) => ({ key: row.key, samples: row.samples, weight: row.weight })) },
    safety: {
      submittedPrompt: false,
      mutatedState: false,
      externalMutation: false,
      credentialOutput: false,
      cookieOrStorageOutput: false,
    },
    authority: {
      consultantOnly: true,
      canProducePass: false,
      isTaskVerdict: false,
      localVerifierIsAuthority: true,
    },
  }
}

function safePacketTelemetry() {
  try {
    const telemetry = packetTelemetry()
    if (!telemetry || typeof telemetry !== "object") return null
    const { schemaVersion, tiers, ...rest } = telemetry
    void schemaVersion
    return { tiers: tiers ? Object.keys(tiers).length : 0, ...rest }
  } catch {
    return null
  }
}

export function renderReasoningDoctor(report) {
  const lines = [
    "UES reasoning doctor (read-only)",
    `Verdict: ${report.verdict}`,
    "",
  ]
  for (const row of report.rows) {
    lines.push(`  ${row.label.padEnd(28)} ${String(row.value).slice(0, 90)}${row.note ? `  (${row.note})` : ""}`)
  }
  lines.push(
    "",
    `Safety: no prompt submitted (${report.safety.submittedPrompt}), no state mutated (${report.safety.mutatedState}), no external mutation (${report.safety.externalMutation}), no credentials printed (${report.safety.credentialOutput}), no cookie/storage output (${report.safety.cookieOrStorageOutput}).`,
    `Authority: consultant-only, canProducePass=${report.authority.canProducePass}; the local verifier remains the final correctness authority.`,
  )
  return lines.join("\n")
}
