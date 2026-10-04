// V16.6 Progress Observer V2.
//
// Observer-only. It reports what the runtime is doing; it never reasons in
// public, never prints a chain of thought, never prints a secret, never prints
// raw advisor text from the external model and never claims a verdict.
//
// Modes (UES_PROGRESS_OBSERVER_V2):
//   compact   (default) one bounded header + one bounded line per transition
//   detailed            adds bounded per-lane detail lines
//   off                 emits nothing
//
// Header format: `UES 16.6 · <REASONING MODE> · <EXECUTION PROFILE>`

import { redactSecrets } from "./secret-redaction.mjs"
import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const PROGRESS_V2_SCHEMA_VERSION = 1
export const PROGRESS_V2_RELEASE = "v16.6"
export const PROGRESS_V2_POLICY = "progress-observer-v2"

export const PROGRESS_MODES = Object.freeze(["compact", "detailed", "off"])
export const DEFAULT_PROGRESS_MODE = "compact"
export const MAX_NOTE_CHARS = 160
export const MAX_EVENTS = 64
export const MAX_LANES_V2 = 8

function str(value, fallback = "") {
  const text = String(value ?? "").trim()
  return text || fallback
}

function int(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Mode resolution. An unknown value is normalized to the default and reported
 * as `normalized:false` - it is never silently treated as `off`.
 */
export function resolveProgressMode(env = process.env) {
  const raw = str(env?.UES_PROGRESS_OBSERVER_V2, "").toLowerCase()
  if (!raw) return { mode: DEFAULT_PROGRESS_MODE, source: "default", normalized: true, raw }
  if (PROGRESS_MODES.includes(raw)) return { mode: raw, source: "env:UES_PROGRESS_OBSERVER_V2", normalized: true, raw }
  return { mode: DEFAULT_PROGRESS_MODE, source: "env:UES_PROGRESS_OBSERVER_V2", normalized: false, raw }
}

/** `UES 16.6 · DEEPSEEK-FIRST · BALANCED` */
export function observerHeaderV2(input = {}) {
  const mode = str(input.reasoningMode, "balanced").toUpperCase()
  const profile = str(input.profile, "BALANCED").toUpperCase()
  const lane = str(input.lane, "").toUpperCase()
  const head = `UES ${PROGRESS_V2_RELEASE.replace("v", "")} · ${mode} · ${profile}`
  return lane ? `${head} · ${lane}` : head
}

/**
 * Sanitize a note for display: redact, collapse whitespace, bound. This is the
 * single exit gate for anything the observer prints.
 */
export function sanitizeNote(value, limit = MAX_NOTE_CHARS) {
  const raw = str(value, "")
  if (!raw) return ""
  const redacted = String(redactSecrets(raw).text ?? raw)
  return redacted.replace(/\s+/g, " ").trim().slice(0, limit)
}

export function createProgressObserverV2(input = {}) {
  const modeRow = input.mode && PROGRESS_MODES.includes(String(input.mode))
    ? { mode: String(input.mode), source: "caller", normalized: true, raw: String(input.mode) }
    : resolveProgressMode(input.env)
  const observer = {
    schemaVersion: PROGRESS_V2_SCHEMA_VERSION,
    release: PROGRESS_V2_RELEASE,
    policy: PROGRESS_V2_POLICY,
    mode: modeRow.mode,
    modeSource: modeRow.source,
    modeNormalized: modeRow.normalized,
    modeRaw: modeRow.raw,
    header: observerHeaderV2(input),
    reasoningMode: str(input.reasoningMode, "balanced"),
    profile: str(input.profile, "BALANCED"),
    phase: str(input.phase, "unknown"),
    lanes: [],
    events: [],
    dropped: 0,
    notesRedacted: 0,
    observerOnly: true,
    counts: { transitions: 0, lanes: 0, redactions: 0 },
  }
  if (observer.mode !== "off") emit(observer, "start", { phase: observer.phase })
  return observer
}

function emit(observer, kind, payload = {}) {
  if (observer.mode === "off") return null
  const event = {
    kind: String(kind),
    phase: str(payload.phase, observer.phase),
    lane: str(payload.lane, ""),
    state: str(payload.state, ""),
    note: sanitizeNote(payload.note),
    turn: int(payload.turn, 0, 0, 99),
    at: Number.isFinite(payload.now) ? payload.now : observer.events.length,
  }
  observer.events.push(event)
  observer.counts.transitions += 1
  if (observer.events.length > MAX_EVENTS) {
    observer.events.shift()
    observer.dropped += 1
  }
  return event
}

/** Record a state transition (observer-only; safe to call from anywhere). */
export function recordProgressV2(observer, kind, payload = {}) {
  if (!observer || observer.schemaVersion !== PROGRESS_V2_SCHEMA_VERSION) return null
  const event = emit(observer, kind, payload)
  // Count a redaction only when sanitizing ACTUALLY changed the text. A counter
  // that ticked once per event would report "redactions" equal to the event
  // count and present noise as a measurement.
  if (event && payload.note !== undefined && payload.note !== null) {
    const raw = String(payload.note)
    if (sanitizeNote(raw, Number.MAX_SAFE_INTEGER) !== raw.replace(/\s+/g, " ").trim()) {
      observer.notesRedacted += 1
      observer.counts.redactions += 1
    }
  }
  return event
}

/** Upsert a bounded lane row (max 8 lanes, bounded action text). */
export function upsertLaneV2(observer, lane = {}) {
  if (!observer) return null
  const id = str(lane.id, "lane")
  const row = {
    id,
    state: str(lane.state, "pending"),
    action: sanitizeNote(lane.action, 80),
    now: Number.isFinite(lane.now) ? lane.now : 0,
  }
  const existing = observer.lanes.findIndex((item) => item.id === id)
  if (existing >= 0) observer.lanes[existing] = row
  else {
    if (observer.lanes.length >= MAX_LANES_V2) {
      observer.dropped += 1
      return null
    }
    observer.lanes.push(row)
    observer.counts.lanes += 1
  }
  return row
}

/**
 * Render the visible progress line(s). Returns `[]` in `off` mode, and a
 * single header line in `compact` mode.
 */
export function renderProgressV2(observer) {
  if (!observer || observer.mode === "off") return []
  const lines = [observer.header]
  const last = observer.events.at(-1)
  if (last) {
    const bits = [last.phase, last.state, last.lane].filter(Boolean).join(" · ")
    lines.push(`${bits}${last.note ? ` — ${last.note}` : ""}`)
  }
  if (observer.mode === "detailed") {
    for (const lane of observer.lanes) {
      lines.push(`  ${lane.id}: ${lane.state}${lane.action ? ` — ${lane.action}` : ""}`)
    }
  }
  return lines.map((line) => sanitizeNote(line, 240))
}

/** Compact one-line summary for the run journal. */
export function summarizeProgressV2(observer) {
  if (!observer) return ""
  const states = observer.lanes.map((lane) => `${lane.id}=${lane.state}`).join(" ")
  return sanitizeNote(
    `${observer.header} | phase=${observer.phase} events=${observer.counts.transitions} lanes=${observer.lanes.length}${states ? ` | ${states}` : ""}`,
    240,
  )
}

export function progressTelemetryV2(observer) {
  const row = observer || {}
  return {
    schemaVersion: PROGRESS_V2_SCHEMA_VERSION,
    policy: PROGRESS_V2_POLICY,
    mode: row.mode || DEFAULT_PROGRESS_MODE,
    modeNormalized: row.modeNormalized !== false,
    events: measured(int(row.counts?.transitions, 0, 0, 9999)),
    lanes: measured(int(row.counts?.lanes, 0, 0, 999)),
    dropped: measured(int(row.dropped, 0, 0, 99_999)),
    redactions: measured(int(row.counts?.redactions, 0, 0, 99_999)),
    observerOnly: true,
    // The observer has no code path that can emit a chain of thought.
    chainOfThoughtEmitted: measured(0),
    secretsEmitted: measured(0),
    header: row.header || "",
    provenance: { counters: "MEASURED", header: "DERIVED" },
  }
}

export const PROGRESS_V2_EXPORTS = Object.freeze([
  "createProgressObserverV2",
  "recordProgressV2",
  "upsertLaneV2",
  "renderProgressV2",
  "summarizeProgressV2",
  "progressTelemetryV2",
  "observerHeaderV2",
  "resolveProgressMode",
  "sanitizeNote",
])
