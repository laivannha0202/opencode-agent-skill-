// V16.6 tool-output economy.
//
// Terminal output is the biggest unmeasured token sink in a run. This module
// compresses ONLY well-understood noise families and leaves everything that
// carries signal byte-identical.
//
// Compressed (only as runs of >= 3 identical lines, or \r frame stacks):
//   * dependency-install noise (npm/yarn/pnpm add/audit/audit lines)
//   * progress-bar / spinner frames
//   * repeated identical diagnostics and repeated identical test lines
//   * repeated success boilerplate
//
// NEVER compressed (a line is preserved verbatim when it matches any of these):
//   * error / failure / exception / assertion output
//   * anything with a file path and line number
//   * diff hunks and `diff --git` headers
//   * commands and their exit status
//   * numbers in a failing context, security warnings
//   * Evidence Store references (evidence:sha256:...)
//   * unique lines (no run) - the default result is byte-identical input
//
// The module is a PURE function: `compressRepetitiveOutput` never throws, and
// `assertNoLossyTransform` is the executable proof that nothing signal-bearing
// was dropped.

import { measured, derived, estimated, NOT_MEASURED, estimateTokensFromChars } from "./measurement-provenance.mjs"

export const TOOL_OUTPUT_ECONOMY_SCHEMA_VERSION = 1
export const TOOL_OUTPUT_ECONOMY_RELEASE = "v16.6"
export const TOOL_OUTPUT_ECONOMY_POLICY = "tool-output-economy-v16-6"

/**
 * V16.6.1 economy modes.
 *
 * `auto` compresses ONLY when every precondition holds: the phase is not a
 * verification phase, the tool call did not fail, no security/error evidence is
 * touched, the raw output is already in the Evidence Store, the lossless audit
 * passes, the family is recognized, and the learner is not reporting
 * rehydration/missed-evidence pressure. `off` and `on` remain explicit operator
 * overrides.
 */
export const ECONOMY_MODES = Object.freeze(["off", "auto", "on"])

export const NOISE_FAMILIES = Object.freeze([
  "dependency-install",
  "progress-bar",
  "repeated-identical-lines",
  "repeated-test-output",
  "repeated-diagnostics",
  "carriage-return-frames",
])

const PRESERVE_PATTERN = new RegExp(
  [
    "\\b(error|errors|failed|failure|failures|fatal|exception|traceback|assertion|assert|denied|refused|forbidden|panic|segfault)\\b",
    "\\bwarn(ing)?\\b.*\\b(security|permission|secret|token|vulnerab)",
    // V16.6.1: a DEPRECATION line is unique evidence. The previous pattern set
    // let `npm warn deprecated <distinct package>` through the noise path, where
    // the consecutive-family collapse replaced several DISTINCT deprecation
    // warnings with one summary line. A package being deprecated is exactly the
    // signal a maintainer must not lose to token savings.
    "\\bdeprecat(ed|ion|ing|e)\\b",
    "[\\w./\\\\-]+:\\d+",
    "^(diff --git|@@ |\\+[^+]|-[^-])",
    "evidence:sha256:",
    "^\\s*\\$\\s",
    "npm (ERR!|error)",
    "exit code \\d+",
    "command failed",
    "not ok \\d+",
    "✗|✖|✘|FAILED",
  ].join("|"),
  "i",
)

// V16.6.1: the literal `up to date date` was a typo that made this pattern never
// match npm's actual `up to date` line, so dependency-install noise was detected
// less often than claimed.
const DEPENDENCY_PATTERN =
  /^(added \d+|removed \d+|changed \d+|audited \d+|found \d+ packages?|up to date\b|npm warn deprecated|warning .*deprecat|packages? are looking for funding|run `npm fund`|npm (audit|notice)\b)/i

// The leading `[`/`|` wrapper is part of how real spinners and progress bars
// are rendered (`[####    ] 60% resolving`, `|####| 12/40`). Without it in the
// class the most common shape in real terminal output was never recognized as a
// progress frame, so it was never collapsed.
const PROGRESS_PATTERN = /^(\s*[\[|]?\s*[⠀-⣿█▓▒░▕▏▍▋■□●○]{2,}[\]|\s]*(\d{1,3}%|\d+\/\d+)?|\s*\d{1,3}%|\s*\|?\s*\d+\/\d+\s*\|?|\s*ETA\b|\s*(loading|processing|building|resolving)\b.*\d)/i

const TEST_OUTPUT_PATTERN = /^(# (tests|pass|fail|suites|todo)|ok \d+ - |not ok \d+ - |✓\s*\d+|✔\s*\d+)/i

const DIAGNOSTIC_PATTERN = /^(\s{2,}(at|>)\s|ℹ|info:|debug:|verbose:)/i

function str(value) {
  return String(value ?? "")
}

/**
 * Which noise families are present. Reported in telemetry so the economy can
 * be measured instead of assumed.
 */
export function detectNoiseFamilies(text, options = {}) {
  const source = str(text)
  if (!source) return []
  const lines = source.split(/\r?\n/)
  const families = new Set()
  const counts = Object.create(null)

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (PRESERVE_PATTERN.test(trimmed)) continue
    if (DEPENDENCY_PATTERN.test(trimmed)) families.add("dependency-install")
    if (PROGRESS_PATTERN.test(trimmed)) families.add("progress-bar")
    if (TEST_OUTPUT_PATTERN.test(trimmed)) families.add("repeated-test-output")
    if (DIAGNOSTIC_PATTERN.test(line)) families.add("repeated-diagnostics")
    counts[trimmed] = (counts[trimmed] || 0) + 1
  }
  const minRun = Math.max(2, Number(options.minRun) || 3)
  for (const [row, count] of Object.entries(counts)) {
    if (count >= minRun && !PRESERVE_PATTERN.test(row)) families.add("repeated-identical-lines")
  }
  if (/\r[^\n]/.test(source)) families.add("carriage-return-frames")
  return [...families]
}

function isPreserved(line) {
  return PRESERVE_PATTERN.test(line)
}

/**
 * Compress the recognized noise families. Returns byte-identical text when
 * nothing matches.
 */
export function compressRepetitiveOutput(text, options = {}) {
  const source = str(text)
  const rawOutputChars = source.length
  if (!source) {
    return {
      schemaVersion: TOOL_OUTPUT_ECONOMY_SCHEMA_VERSION,
      policy: TOOL_OUTPUT_ECONOMY_POLICY,
      text: "",
      rawOutputChars: 0,
      visibleOutputChars: 0,
      compressed: false,
      families: [],
      sections: [],
      runsCollapsed: 0,
      linesIn: 0,
      linesOut: 0,
      recoverable: true,
      enabled: options.enabled !== false,
      provenance: "MEASURED",
    }
  }

  const enabled = options.enabled !== false
  const families = detectNoiseFamilies(source, options)
  if (!enabled || families.length === 0) {
    return {
      schemaVersion: TOOL_OUTPUT_ECONOMY_SCHEMA_VERSION,
      policy: TOOL_OUTPUT_ECONOMY_POLICY,
      text: source,
      rawOutputChars,
      visibleOutputChars: rawOutputChars,
      compressed: false,
      families,
      sections: [],
      runsCollapsed: 0,
      linesIn: source.split(/\r?\n/).length,
      linesOut: source.split(/\r?\n/).length,
      recoverable: true,
      enabled,
      provenance: "MEASURED",
    }
  }

  const minRun = Math.max(2, Number(options.minRun) || 3)
  const lines = source.split("\n")
  const out = []
  const sections = []
  let runsCollapsed = 0

  let index = 0
  while (index < lines.length) {
    const current = lines[index]
    const trimmed = current.trim()
    if (!trimmed || isPreserved(current)) {
      out.push(current)
      index += 1
      continue
    }
    // 1) identical-line runs
    let run = 1
    while (index + run < lines.length && lines[index + run].trim() === trimmed) run += 1
    if (run >= minRun) {
      const family = pickFamily(trimmed)
      out.push(current)
      out.push(`… [V16.6 tool-output economy: ${run - 1} identical ${family} lines collapsed]`)
      sections.push({ family, count: run - 1, sample: trimmed.slice(0, 160) })
      runsCollapsed += run - 1
      index += run
      continue
    }
    // 2) Consecutive progress-bar lines only. These repeat a shape with no
    //    per-line signal, so a bounded summary is safe.
    //
    //    V16.6.1: dependency-install lines were collapsed here too, and because
    //    each `npm warn deprecated <package>` names a DIFFERENT package they were
    //    distinct lines being merged into one. Unique deprecation evidence is now
    //    preserved verbatim by `isPreserved`, so only genuinely no-signal
    //    progress frames collapse.
    const family = noiseFamily(current)
    if (family === "progress-bar") {
      let same = 1
      while (index + same < lines.length && noiseFamily(lines[index + same]) === family) same += 1
      if (same >= minRun) {
        out.push(current)
        out.push(`… [V16.6 tool-output economy: ${same - 1} more ${family} lines collapsed]`)
        sections.push({ family, count: same - 1, sample: trimmed.slice(0, 160) })
        runsCollapsed += same - 1
        index += same
        continue
      }
      for (let offset = 0; offset < same; offset += 1) out.push(lines[index + offset])
      index += same
      continue
    }
    // Short runs of anything else: leave them completely alone.
    for (let offset = 0; offset < run; offset += 1) out.push(lines[index + offset])
    index += run
  }

  // Carriage-return frame stacks (progress bars) collapse to the final frame.
  let compressedText = out.join("\n")
  if (families.includes("carriage-return-frames")) {
    compressedText = collapseCarriageReturns(compressedText)
  }

  return {
    schemaVersion: TOOL_OUTPUT_ECONOMY_SCHEMA_VERSION,
    policy: TOOL_OUTPUT_ECONOMY_POLICY,
    release: TOOL_OUTPUT_ECONOMY_RELEASE,
    text: compressedText,
    rawOutputChars,
    visibleOutputChars: compressedText.length,
    compressed: compressedText !== source,
    families,
    sections,
    runsCollapsed,
    linesIn: lines.length,
    linesOut: compressedText.split("\n").length,
    recoverable: true,
    enabled,
    savedChars: Math.max(0, rawOutputChars - compressedText.length),
    savedTokens: estimateTokensFromChars(Math.max(0, rawOutputChars - compressedText.length)),
    provenance: "MEASURED",
  }
}

function pickFamily(line) {
  if (DEPENDENCY_PATTERN.test(line)) return "dependency-install"
  if (TEST_OUTPUT_PATTERN.test(line)) return "repeated-test-output"
  if (PROGRESS_PATTERN.test(line)) return "progress-bar"
  if (DIAGNOSTIC_PATTERN.test(line)) return "repeated-diagnostics"
  return "repeated-identical-lines"
}

/** Family of a single line, or null when the line is signal (never collapsed). */
function noiseFamily(line) {
  const trimmed = String(line ?? "").trim()
  if (!trimmed) return null
  if (isPreserved(line)) return null
  if (DEPENDENCY_PATTERN.test(trimmed)) return "dependency-install"
  if (PROGRESS_PATTERN.test(trimmed)) return "progress-bar"
  return null
}

/**
 * \r frames: keep the LAST frame of each stack (the final state of a progress
 * bar), drop the intermediate repaints. Any frame that is preserved (contains
 * an error or a path:line) is kept too.
 */
function collapseCarriageReturns(text) {
  const lines = text.split("\n")
  const out = []
  let collapsed = 0
  for (const line of lines) {
    if (!line.includes("\r")) {
      out.push(line)
      continue
    }
    const frames = line.split("\r").filter(Boolean)
    if (frames.length < 2) {
      out.push(line)
      continue
    }
    const kept = frames.filter((frame, position) => position === frames.length - 1 || isPreserved(frame))
    collapsed += frames.length - kept.length
    out.push(kept.join(" "))
  }
  void collapsed
  return out.join("\n")
}

/**
 * Executable proof that the transform dropped nothing signal-bearing.
 * Every preserved line of `before` must appear verbatim in `after`.
 */
export function assertNoLossyTransform(before, after, options = {}) {
  const source = str(before)
  const result = str(after)
  const violations = []
  const beforeLines = source.split(/\r?\n/)
  const afterText = result

  let preservedChecked = 0
  for (const line of beforeLines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!isPreserved(line)) continue
    preservedChecked += 1
    if (!afterText.includes(trimmed)) {
      violations.push(`preserved-line-missing:${trimmed.slice(0, 80)}`)
    }
  }

  // Line numbers that appeared before must still appear.
  const numbers = new Set((source.match(/:\d+\b/g) || []).map((row) => row))
  for (const row of numbers) {
    if (!afterText.includes(row)) violations.push(`line-number-missing:${row}`)
  }

  if (options.requireShorter && result.length > source.length) {
    violations.push("output-grew")
  }

  return {
    ok: violations.length === 0,
    violations,
    preservedLinesChecked: preservedChecked,
    policy: TOOL_OUTPUT_ECONOMY_POLICY,
    provenance: "DERIVED",
  }
}

/** Telemetry with explicit provenance. */
export function toolOutputEconomyTelemetry(result, options = {}) {
  const row = result || {}
  const enabled = row.enabled !== false
  const savedChars = Math.max(0, (Number(row.rawOutputChars) || 0) - (Number(row.visibleOutputChars) || 0))
  return {
    schemaVersion: TOOL_OUTPUT_ECONOMY_SCHEMA_VERSION,
    policy: TOOL_OUTPUT_ECONOMY_POLICY,
    enabled,
    compressed: row.compressed === true,
    families: Array.isArray(row.families) ? row.families : [],
    runsCollapsed: measured(Number(row.runsCollapsed) || 0),
    rawOutputChars: measured(Number(row.rawOutputChars) || 0),
    visibleOutputChars: measured(Number(row.visibleOutputChars) || 0),
    savedChars: derived(savedChars),
    // V16.6.1: chars/4 is an approximation. Reporting it as DERIVED overstated
    // a measurement; it is ESTIMATED, and the provider's own counter is
    // simply NOT_MEASURED.
    estimatedSavedTokens: estimated(Math.round(savedChars / 4)),
    savedTokens: NOT_MEASURED,
    providerTokensSaved: NOT_MEASURED,
    rehydrations: measured(Number(options.rehydrations) || 0),
    compressionRefused: options.compressionRefused === true,
    missedEvidence: options.missedEvidence === true,
    contextWindowShare: NOT_MEASURED,
    transformMs: options.transformMs === undefined ? NOT_MEASURED : measured(Number(options.transformMs)),
    provenance: {
      counters: "MEASURED",
      savings: "DERIVED-from-chars",
      tokenEstimate: "ESTIMATED",
      providerSavings: "NOT_MEASURED",
    },
  }
}

// ---------------------------------------------------------------------------
// V16.6 tool-output economy learner (spec §14)
// ---------------------------------------------------------------------------
//
// Records, per output family, whether compression paid off. The learner can
// only change the STRENGTH of reversible noise compression (the minimum run
// length). It can never drop an evidence-preserving step, disable the Evidence
// Store, change a verifier, or produce a verdict.
//
// Observed fields:
//   rawOutputChars, visibleOutputChars, savedChars, compressionSavings
//   laterRawRehydration   the model had to re-fetch the exact raw output
//   sectionUsefulRate     fraction of informational markers the model acted on
//   missedEvidenceAfterCompression  a needed signal was not visible
//
// If compression made the model recall raw output too often (or evidence was
// missed), the learner RELAXS compression (raises the minimum run length).

export const ECONOMY_LEARNER_SCHEMA_VERSION = 1
export const ECONOMY_LEARNER = Object.freeze({
  minSamples: 8,
  maxKeys: 128,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  hysteresisMargin: 0.15,
  maxRehydrationRate: 0.25,
})

const LEARNER_FORBIDDEN_EFFECTS = Object.freeze([
  "dropsEvidenceStore",
  "disablesVerifier",
  "changesPermissions",
  "producesVerdict",
  "raisesVisibleBudget",
  "relaxesWorkspaceContainment",
])

const learnerStore = new Map()

/** Resolve the economy mode. `off`/`on` are operator overrides. */
export function resolveEconomyMode(env = process.env) {
  const raw = String(env?.UES_TOOL_OUTPUT_ECONOMY ?? "").trim().toLowerCase()
  if (!raw) return { mode: "auto", source: "default", normalized: true, raw: "" }
  if (ECONOMY_MODES.includes(raw)) return { mode: raw, source: "env:UES_TOOL_OUTPUT_ECONOMY", normalized: true, raw }
  return { mode: "auto", source: "env:UES_TOOL_OUTPUT_ECONOMY", normalized: false, raw }
}

/**
 * The AUTO gate. Every precondition is explicit and every refusal is reported,
 * so "compression did not happen" always has a machine-readable reason.
 *
 * This NEVER lowers safety: a failing call, a verification phase or an
 * unarchived raw output is a refusal, not a weaker compression.
 */
export function shouldAutoCompress(input = {}) {
  const mode = ECONOMY_MODES.includes(String(input.mode || "")) ? String(input.mode) : resolveEconomyMode(input.env).mode;
  if (mode === "off") return { compress: false, mode, reason: "operator-off" };
  if (mode === "on") return { compress: true, mode, reason: "operator-on", bypassedGates: true };
  const refusals = []
  if (String(input.phase || "").toLowerCase() === "verify") refusals.push("phase-verify")
  if (input.failed === true) refusals.push("tool-call-failed")
  if (input.securityEvidence === true) refusals.push("security-evidence")
  if (input.errorEvidence === true) refusals.push("error-evidence")
  if (input.rawArchived !== true) refusals.push("raw-output-not-in-evidence-store")
  if (input.auditClean !== true) refusals.push("lossless-audit-failed")
  if (!Array.isArray(input.families) || input.families.length === 0) refusals.push("no-recognized-family")
  if (input.learnerPressure === true) refusals.push("learner-reports-rehydration-or-missed-evidence")
  if (refusals.length) return { compress: false, mode, reason: refusals[0], refusals };
  return { compress: true, mode, reason: "auto-preconditions-met", refusals: [] };
}

function learnerNumber(value) {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function learnerKey(sample = {}) {
  const family = String(sample.commandFamily || sample.family || "tool-output")
  return `${family}\u0000${String(sample.model || "*")}`
}

/**
 * Record one economy outcome. Returns the bounded row and its sample count.
 * Never throws; invalid payloads record nothing and report `recorded:false`.
 */
export function recordEconomyOutcome(sample = {}) {
  const key = learnerKey(sample)
  const row = learnerStore.get(key) || {
    key,
    commandFamily: String(sample.commandFamily || sample.family || "tool-output"),
    model: sample.model ? String(sample.model) : "*",
    samples: 0,
    compressed: 0,
    rawOutputChars: 0,
    visibleOutputChars: 0,
    savedChars: 0,
    rehydrations: 0,
    missedEvidence: 0,
    sectionUsefulSum: 0,
    sectionUsefulSamples: 0,
    lastSeenAt: Date.now(),
  }
  row.samples += 1
  if (sample.compressed === true) row.compressed += 1
  const raw = learnerNumber(sample.rawOutputChars)
  const visible = learnerNumber(sample.visibleOutputChars)
  if (raw != null) row.rawOutputChars += Math.max(0, raw)
  if (visible != null) row.visibleOutputChars += Math.max(0, visible)
  if (raw != null && visible != null) row.savedChars += Math.max(0, raw - visible)
  if (sample.laterRawRehydration === true || Number(sample.laterRawRehydration) > 0) row.rehydrations += 1
  if (sample.missedEvidenceAfterCompression === true) row.missedEvidence += 1
  const useful = learnerNumber(sample.sectionUsefulRate)
  if (useful != null) {
    row.sectionUsefulSum += Math.max(0, Math.min(1, useful))
    row.sectionUsefulSamples += 1
  }
  row.lastSeenAt = Date.now()
  learnerStore.set(key, row)
  gcEconomyLearner()
  return { recorded: true, key, samples: row.samples, savedChars: row.savedChars }
}

/**
 * Compression-strength advice for one output family. Purely advisory: the
 * caller applies `minRun` as a knob and nothing else. Below the sample floor
 * the advice is NEUTRAL, so a fresh workspace keeps the default strength.
 */
export function economyCompressionAdvice(input = {}, options = {}) {
  const key = learnerKey(input)
  const minSamples = Math.max(ECONOMY_LEARNER.minSamples, Number(options.minSamples) || 0)
  const row = learnerStore.get(key)
  if (!row || row.samples < minSamples) {
    return {
      action: "neutral",
      minRun: 3,
      reason: "insufficient-data",
      samples: row?.samples || 0,
      minSamples,
      effect: "compression-strength-only",
    }
  }
  const rehydrateRate = row.rehydrations / row.samples
  const missedRate = row.missedEvidence / row.samples
  const sectionUsefulRate = row.sectionUsefulSamples ? row.sectionUsefulSum / row.sectionUsefulSamples : null
  if (missedRate > 0 || rehydrateRate > ECONOMY_LEARNER.maxRehydrationRate) {
    return {
      action: "relax",
      minRun: 5,
      reason: missedRate > 0 ? "missed-evidence-after-compression" : "rehydration-pressure",
      rehydrateRate,
      missedRate,
      sectionUsefulRate,
      samples: row.samples,
      minSamples,
      effect: "compression-strength-only",
    }
  }
  if (row.savedChars > 0 && rehydrateRate <= ECONOMY_LEARNER.maxRehydrationRate / 2) {
    return {
      action: "compress",
      minRun: 3,
      reason: "measured-savings-without-rehydration",
      rehydrateRate,
      missedRate,
      sectionUsefulRate,
      samples: row.samples,
      minSamples,
      effect: "compression-strength-only",
    }
  }
  return {
    action: "neutral",
    minRun: 3,
    reason: "inside-hysteresis-band",
    rehydrateRate,
    missedRate,
    sectionUsefulRate,
    samples: row.samples,
    minSamples,
    effect: "compression-strength-only",
  }
}

export function economyLearnerReport(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || ECONOMY_LEARNER.maxAgeMs)
  const now = Number(options.now) || Date.now()
  const rows = []
  for (const [key, row] of learnerStore) {
    rows.push({
      key,
      commandFamily: row.commandFamily,
      model: row.model,
      samples: row.samples,
      compressed: row.compressed,
      rawOutputChars: row.rawOutputChars,
      visibleOutputChars: row.visibleOutputChars,
      savedChars: row.savedChars,
      compressionSavings: row.rawOutputChars ? Number((row.savedChars / row.rawOutputChars).toFixed(4)) : null,
      rehydrations: row.rehydrations,
      missedEvidence: row.missedEvidence,
      sectionUsefulRate: row.sectionUsefulSamples ? Number((row.sectionUsefulSum / row.sectionUsefulSamples).toFixed(3)) : null,
      stale: now - row.lastSeenAt > maxAge,
    })
  }
  return {
    schemaVersion: ECONOMY_LEARNER_SCHEMA_VERSION,
    policy: TOOL_OUTPUT_ECONOMY_POLICY,
    keys: learnerStore.size,
    maxKeys: ECONOMY_LEARNER.maxKeys,
    minSamples: ECONOMY_LEARNER.minSamples,
    forbiddenEffects: [...LEARNER_FORBIDDEN_EFFECTS],
    rows,
  }
}

/** Bounded GC: stale rows first, then oldest, capped at maxKeys. */
export function gcEconomyLearner(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || ECONOMY_LEARNER.maxAgeMs)
  const now = Number(options.now) || Date.now()
  let removed = 0
  const stale = [...learnerStore.entries()]
    .filter(([, row]) => now - row.lastSeenAt > maxAge)
    .sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)
  for (const [key] of stale) {
    if (learnerStore.size - removed < ECONOMY_LEARNER.maxKeys * 0.9) break
    learnerStore.delete(key)
    removed += 1
  }
  while (learnerStore.size > ECONOMY_LEARNER.maxKeys) {
    learnerStore.delete(learnerStore.keys().next().value)
    removed += 1
  }
  return { removed, remaining: learnerStore.size }
}

/** Test hook. */
export function resetEconomyLearnerForTests() {
  learnerStore.clear()
}

/**
 * Executable guard: the learner may only change compression strength. Any
 * advice that claims a forbidden effect is rejected.
 */
export function assertEconomyLearnerAuthority(advice) {
  const violations = []
  if (advice?.effect !== "compression-strength-only") violations.push("effect must be compression-strength-only")
  if (!["compress", "relax", "neutral"].includes(String(advice?.action))) violations.push("action must be compress|relax|neutral")
  if (!(Number(advice?.minRun) >= 2)) violations.push("minRun must be >= 2")
  for (const forbidden of LEARNER_FORBIDDEN_EFFECTS) {
    if (advice?.[forbidden] === true) violations.push(`learner must never ${forbidden}`)
  }
  return { ok: violations.length === 0, violations }
}

export const TOOL_OUTPUT_ECONOMY_EXPORTS = Object.freeze([
  "compressRepetitiveOutput",
  "assertNoLossyTransform",
  "detectNoiseFamilies",
  "toolOutputEconomyTelemetry",
  "shouldAutoCompress",
  "resolveEconomyMode",
  "NOISE_FAMILIES",
  "ECONOMY_MODES",
  "recordEconomyOutcome",
  "economyCompressionAdvice",
  "economyLearnerReport",
  "gcEconomyLearner",
  "assertEconomyLearnerAuthority",
  "resetEconomyLearnerForTests",
])
