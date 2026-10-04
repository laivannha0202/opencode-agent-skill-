// V16.5 Phase 12: Agent Progress Observer (observer-only).
//
// Renders a bounded fleet view from delegation + advisory state:
//
//   UES
//   +- Explore    ok
//   +- Diagnose   running
//   +- DeepSeek   skipped
//   `- Verify     pending
//
// Hard limits (observer-only invariants):
//   - no chain-of-thought is ever stored or rendered
//   - no secrets
//   - no raw transcripts / unbounded logs
//   - no runtime authority: the view cannot change scheduling, permissions or verdicts

export const PROGRESS_OBSERVER_SCHEMA_VERSION = 1
export const PROGRESS_STATE = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
})

export const MAX_ACTION_CHARS = 120
export const MAX_LANES = 12

const VALID_STATES = new Set(Object.values(PROGRESS_STATE))

const GLYPH = Object.freeze({
  [PROGRESS_STATE.PENDING]: "o",
  [PROGRESS_STATE.RUNNING]: "*",
  [PROGRESS_STATE.COMPLETED]: "v",
  [PROGRESS_STATE.FAILED]: "x",
  [PROGRESS_STATE.SKIPPED]: "-",
  [PROGRESS_STATE.CANCELLED]: "/",
})

function safeAction(value) {
  return String(value || "")
    .replace(/[\r\n]+/g, " ")
    // Structural secret hygiene: the observer never renders token-like strings.
    .replace(/\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_]*(?:secret|token|password|api[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, MAX_ACTION_CHARS)
}

export function createProgressObserver(input = {}) {
  return {
    schemaVersion: PROGRESS_OBSERVER_SCHEMA_VERSION,
    release: "v16.5",
    phase: String(input.phase || "start"),
    observerOnly: true,
    runtimeAuthority: false,
    rendersChainOfThought: false,
    lanes: [],
    startedAt: Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now(),
  }
}

export function upsertLane(observer, lane = {}) {
  if (!observer || typeof observer !== "object") throw new Error("upsertLane requires an observer")
  const id = String(lane.id || lane.role || "").trim()
  if (!id) throw new Error("lane requires an id")
  const existing = observer.lanes.find((row) => row.id === id)
  const value = {
    id,
    label: safeAction(lane.label || id) || id,
    state: VALID_STATES.has(lane.state) ? String(lane.state) : PROGRESS_STATE.PENDING,
    action: safeAction(lane.action || ""),
    elapsedMs: Number.isFinite(Number(lane.elapsedMs)) ? Math.max(0, Math.round(Number(lane.elapsedMs))) : null,
    evidenceRef: lane.evidenceRef ? String(lane.evidenceRef).slice(0, 80) : null,
    updatedAt: Number.isFinite(Number(lane.now)) ? Number(lane.now) : Date.now(),
  }
  if (existing) Object.assign(existing, value)
  else {
    observer.lanes.push(value)
    if (observer.lanes.length > MAX_LANES) observer.lanes.splice(0, observer.lanes.length - MAX_LANES)
  }
  observer.phase = String(lane.phase || observer.phase)
  return observer
}

/** Advance every lane relative to the observer start time. */
export function tickProgress(observer, now = Date.now()) {
  if (!observer) return observer
  for (const lane of observer.lanes) {
    if (lane.state === PROGRESS_STATE.RUNNING && lane.elapsedMs === null) lane.elapsedMs = Math.max(0, now - observer.startedAt)
  }
  return observer
}

export function renderProgress(observer) {
  const lanes = [...(observer?.lanes || [])].sort((a, b) => a.id.localeCompare(b.id))
  const tree = ["UES", `+- phase: ${observer?.phase || "unknown"}`]
  for (const lane of lanes) {
    const glyph = GLYPH[lane.state] || GLYPH.pending
    const parts = [`${glyph} ${lane.label}`]
    if (lane.action) parts.push(`- ${lane.action}`)
    if (lane.elapsedMs !== null) parts.push(`${(lane.elapsedMs / 1000).toFixed(1)}s`)
    tree.push(`|  +- ${parts.join("  ")}`)
  }
  if (!lanes.length) tree.push("|  +- (no lanes registered)")
  tree.push("`- observer-only: this view has no runtime authority")

  return {
    schemaVersion: PROGRESS_OBSERVER_SCHEMA_VERSION,
    text: tree.join("\n"),
    lanes: lanes.map((lane) => ({ id: lane.id, state: lane.state, elapsedMs: lane.elapsedMs })),
    summary: summarizeProgress(observer),
  }
}

export function summarizeProgress(observer) {
  const lanes = observer?.lanes || []
  const counts = {
    completed: 0,
    running: 0,
    failed: 0,
    skipped: 0,
    pending: 0,
    cancelled: 0,
  }
  for (const lane of lanes) {
    if (counts[lane.state] !== undefined) counts[lane.state] += 1
  }
  return {
    schemaVersion: PROGRESS_OBSERVER_SCHEMA_VERSION,
    lanes: lanes.length,
    ...counts,
    authority: { runtime: false, verdict: false, permission: false },
    chainOfThoughtStored: false,
  }
}
