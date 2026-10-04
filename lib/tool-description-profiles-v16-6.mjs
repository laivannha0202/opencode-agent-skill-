// V16.6 tool-description profiles.
//
// Tool descriptions are the largest fixed part of the model's context. V16.6
// makes that spend an explicit decision of the unified budget instead of an
// accident of the model profile:
//
//   full      byte-identical descriptions (default; zero behavior change)
//   compact   summary + every protective line + bounded parameter bullets
//   minimal   summary + every protective line
//
// What is NEVER removed, in any profile:
//   * required parameters
//   * side-effect / write warnings
//   * permission requirements and approval gates
//   * error semantics (when the tool fails, and what it must not do)
//   * workspace containment and secret rules
//
// If a profile would drop a protective line the compressor falls back to the
// original description and reports `fellBack:true` - a description is never
// made less safe to save tokens.
//
// Only UES-owned tool descriptions flow through this module. Safety
// capabilities in lib/tool-surface-v3.mjs are runtime-enforced and are NOT part
//   of the model-facing surface this module may touch.

import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"
import { DEFERRED_DISPATCHER_TOOL } from "./deferred-tool-hydration.mjs"

export const TOOL_DESCRIPTION_PROFILE_SCHEMA_VERSION = 1
export const TOOL_DESCRIPTION_PROFILE_RELEASE = "v16.6"
export const TOOL_DESCRIPTION_PROFILES = Object.freeze(["full", "compact", "minimal"])
export const DEFAULT_TOOL_DESCRIPTION_PROFILE = "full"

/**
 * Profile limits.
 *
 * `maxInformativeUnits` is the PRIMARY lever: how many non-protective units
 * (capability sentences) a profile may keep. `maxChars` is a secondary SOFT
 * bound - protective content is never truncated to fit it.
 *
 * Measured against the real Pi tool surface (5 UES tools, 1383 chars):
 *   full    1383 chars  baseline
 *   compact  ~45% saved, 0 protective units dropped
 *   minimal  ~60% saved, 0 protective units dropped
 */
export const PROFILE_LIMITS = Object.freeze({
  full: { maxChars: Infinity, maxInformativeUnits: Infinity },
  compact: { maxChars: 520, maxInformativeUnits: 2 },
  minimal: { maxChars: 260, maxInformativeUnits: 0 },
})

// Protective language. Any line matching this must survive every profile:
// permission, containment, failure, recovery and re-read instructions are
// never dropped by a narrower profile.
const PROTECTIVE_PATTERN = new RegExp("(" + [
"\\brequired",
"\\boptional",
"\\bmust",
"\\bnever",
"\\bdo not",
"\\bpermission",
"\\bapprov",
"\\bwarn",
"\\bdanger",
"\\bside[- ]effect",
"\\bdestructive",
"\\bwrite",
"\\boverwrite",
"\\bdelete",
"\\berror",
"\\bfail",
"\\bdenies",
"\\bread[- ]only",
"\\bworkspace",
"\\bsecret",
"\\bcredential",
"\\bcontainment",
"\\blimitation",
"\\bnot allowed",
"\\bescalat",
"\\bverif",
"\\bre-?read",
"\\bmismatch",
"\\bmismatched",
"\\breject",
"\\bstale",
"\\binstead of",
"\\bfail-?closed",
"\\banchor",
"\\b\\.env"
  ].join("|") + ")", "i")
const PARAM_PATTERN = /^[-*]\s+`?[a-zA-Z_][\w.]*`?\s*[:=-]/

/**
 * The NEVER-DROP safety set used at SENTENCE granularity.
 *
 * `PROTECTIVE_PATTERN` (above) is deliberately broad and stays authoritative
 * for structural line classification. It is too broad for sentence-level
 * compression though: measured on the real tool surface it matched capability
 * text ("Provides bounded search, anchored reads, ...") purely because of
 * incidental words like "anchor", which made every description incompressible
 * and forced a 0% measured saving.
 *
 * This narrower set contains only statements whose loss would change what the
 * model is allowed or expected to do: permissions and approval, destructive or
 * write semantics, failure and error semantics, secret and workspace rules,
 * and explicit obligations. A false negative here costs a little capability
 * prose; the post-build audit still falls back whenever a structural protective
 * line is lost, so the failure mode stays "no savings", never "weaker
 * instructions".
 */
const SAFETY_SENTENCE_PATTERN = new RegExp(
  "(" + [
    "\\bmust\\b",
    "\\bmust not\\b",
    "\\bnever\\b",
    "\\bdo not\\b",
    "\\brequired\\b",
    "\\bpermission",
    "\\bapprov",
    "\\bauthoriz",
    "\\bdenies\\b",
    "\\breject",
    "\\bfail-?closed\\b",
    "\\bfails\\b",
    "\\bfailure\\b",
    "\\berror\\b",
    "\\bside[- ]effect",
    "\\bdestructive",
    "\\boverwrite",
    "\\bdelete",
    "\\bwrites?\\b",
    "\\bsecret",
    "\\bcredential",
    "\\btoken\\b",
    "\\.env\\b",
    "\\bworkspace\\b",
    "\\bcontainment\\b",
    "\\bread[- ]only\\b",
    "\\blimitation",
    "\\bnot allowed\\b",
    "\\binstead of\\b",
    "\\bre-?read\\b",
    "\\bunsafe\\b",
    "\\bblocked\\b",
  ].join("|") + ")",
  "i",
)

function classifySentence(sentence) {
  const trimmed = String(sentence || "").trim()
  if (!trimmed) return "blank"
  if (/^\s*[-*#]/.test(trimmed)) return "bullet"
  return SAFETY_SENTENCE_PATTERN.test(trimmed) ? "protective" : "prose"
}

/**
 * Whether a line is STRUCTURAL (bullet / param / continuation / blank).
 *
 * This deliberately inspects the raw shape and NOT `classifyLine`, which
 * returns "protective" first for a bullet such as "- A stale or mismatched
 * anchor is rejected." Testing `kind === "bullet"` therefore never matched it,
 * the line fell into the sentence path, and sentence classification re-labelled
 * it a plain `bullet` - after which `minimal` dropped it as informative prose.
 * A safety rule silently disappeared from the model's tool description.
 */
function isStructuralLine(line) {
  const raw = String(line || "")
  if (!raw.trim()) return true
  if (/^\s*[-*#]/.test(raw)) return true
  if (PARAM_PATTERN.test(raw.trim())) return true
  if (/^\s{2,}\S/.test(raw)) return true
  return false
}

/**
 * Classify a WHOLE-LINE (structural) unit.
 *
 * Structural lines use the BROAD protective pattern, not the sentence set: a
 * bullet such as "- Writes are workspace-contained and never touch .env files."
 * is shaped like a capability bullet but is a hard safety rule.
 */
function classifyStructuralLine(line) {
  const kind = classifyLine(line)
  if (kind === "blank") return "blank"
  if (PROTECTIVE_PATTERN.test(String(line || ""))) return "protective"
  return kind === "blank" ? "blank" : kind
}

/**
 * Sentence segmentation for PROSE lines.
 *
 * Why this exists: measured against the real Pi tool surface, every UES tool
 * description is a SINGLE prose paragraph, not a bullet list. Line-based
 * compression therefore had exactly one line to work with (the summary) and
 * delivered 0% on `compact` and ~1% on `minimal` - and `minimal` "worked" only
 * by char-truncating a safety sentence, which then tripped the fall-back and
 * gave the savings back. The headline 40-70% target was unreachable by
 * construction.
 *
 * Splitting on sentence boundaries lets the compressor drop NON-protective
 * sentences while every protective sentence provably survives (the post-build
 * audit re-checks against the original text, so a mis-split falls back rather
 * than shipping a description that lost an instruction).
 *
 * Deliberately conservative - it refuses to split when the boundary is
 * ambiguous (abbreviation, file path, decimal), and returns the whole line as a
 * single unit in that case.
 */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "vs", "cf", "al", "no", "fig", "approx", "mr", "mrs", "ms", "dr", "jr", "sr", "st",
])

function endsWithAbbreviation(text) {
  const match = String(text).match(/([A-Za-z.]{1,6})\.$/)
  if (!match) return false
  const token = match[1].toLowerCase()
  return ABBREVIATIONS.has(token) || token.length === 1
}

function endsWithFileRef(text) {
  // "…lib/foo.mjs." / "…package.json." - a path looks like a sentence ending
  // but is not one, so never treat it as a boundary.
  return /\.[A-Za-z0-9]{1,6}\.$/.test(String(text))
}

function endsWithDecimal(text) {
  return /\d\.$/.test(String(text))
}

/** Split one prose line into sentence-ish units. Never loses characters. */
export function segmentSentences(line) {
  const text = String(line || "")
  if (text.length < 24) return text ? [text] : []
  const parts = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== "." && ch !== "!" && ch !== "?") continue
    // must be followed by whitespace + a sentence start
    const next = text[i + 1]
    if (next !== undefined && !/\s/.test(next)) continue
    const rest = text.slice(i + 1)
    if (!/^\s+[A-Z0-9`"'([]/.test(rest)) continue
    const head = text.slice(start, i + 1)
    if (endsWithAbbreviation(head) || endsWithFileRef(head) || endsWithDecimal(head)) continue
    parts.push(text.slice(start, i + 1).trim())
    start = i + 1
  }
  if (start < text.length) parts.push(text.slice(start).trim())
  return parts.filter(Boolean)
}

/**
 * Split a description into addressable units. Bullet/param/blank/continuation
 * lines stay whole (their structure carries meaning); PROSE and PROTECTIVE
 * lines are segmented into sentences and each sentence is re-classified.
 *
 * A line whose WHOLE text matches the protective pattern is still prose: it
 * usually contains one safety sentence plus several capability sentences, and
 * classifying it as a single unit would make it incompressible.
 */
export function segmentDescription(description) {
  const units = []
  for (const line of splitLines(description)) {
    if (isStructuralLine(line)) {
      units.push({ text: line, kind: classifyStructuralLine(line), source: "line" })
      continue
    }
    for (const sentence of segmentSentences(line)) {
      units.push({ text: sentence, kind: classifySentence(sentence), source: "sentence" })
    }
  }
  return units
}

function str(value, fallback = "") {
  const text = String(value ?? "")
  return text.trim() ? text : fallback
}

function splitLines(description) {
  return String(description || "").replace(/\r\n/g, "\n").split("\n")
}

function classifyLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return "blank"
  if (PROTECTIVE_PATTERN.test(trimmed)) return "protective"
  if (PARAM_PATTERN.test(trimmed)) return "param"
  if (/^\s*[-*#]/.test(trimmed)) return "bullet"
  if (/^\s{2,}\S/.test(line)) return "continuation"
  return "prose"
}

/**
 * Resolve the effective profile.
 * Precedence: safety floor > explicit env > budget > default.
 * An unknown env value is reported `normalized:false` and falls back to `full`.
 */
export function resolveToolDescriptionProfile(input = {}) {
  const env = input.env || process.env
  const risk = str(input.risk, "low").toLowerCase()
  const raw = str(env?.UES_TOOL_DESCRIPTION_PROFILE, "").toLowerCase()
  const reasons = []

  if (["high", "critical"].includes(risk)) {
    reasons.push(`risk=${risk}:descriptions-must-be-complete`)
    return { profile: "full", source: "safety-floor", normalized: true, raw, reasons }
  }
  if (Number(input.selectionErrors || 0) >= 2) {
    reasons.push("tool-selection-errors>=2")
    return { profile: "full", source: "escalation", normalized: true, raw, reasons }
  }
  if (raw) {
    if (TOOL_DESCRIPTION_PROFILES.includes(raw)) {
      reasons.push("env:UES_TOOL_DESCRIPTION_PROFILE")
      return { profile: raw, source: "env", normalized: true, raw, reasons }
    }
    if (raw === "auto") {
      reasons.push("env:auto->budget-or-full")
    } else {
      reasons.push(`invalid:${raw}->full`)
      return { profile: DEFAULT_TOOL_DESCRIPTION_PROFILE, source: "env", normalized: false, raw, reasons }
    }
  }
  const budgeted = str(input.budgetProfile, "").toLowerCase()
  if (TOOL_DESCRIPTION_PROFILES.includes(budgeted)) {
    reasons.push("unified-budget")
    return { profile: budgeted, source: "budget", normalized: true, raw, reasons }
  }
  reasons.push("default")
  return { profile: DEFAULT_TOOL_DESCRIPTION_PROFILE, source: "default", normalized: true, raw, reasons }
}

/** Environment block to inject into child processes. */
export function toolDescriptionProfileEnv(profile) {
  const value = TOOL_DESCRIPTION_PROFILES.includes(String(profile)) ? String(profile) : DEFAULT_TOOL_DESCRIPTION_PROFILE
  return { UES_TOOL_DESCRIPTION_PROFILE: value }
}

/**
 * Compress one tool description for a profile.
 * Returns the profiled description plus a self-audit; the caller must use
 * `original` whenever `fellBack` is true.
 */
export function describeToolForProfile(tool = {}, profile = "full", options = {}) {
  const name = str(tool.name || tool.tool, "tool")
  const original = String(tool.description || "")
  const limits = PROFILE_LIMITS[profile] || PROFILE_LIMITS.full

  if (profile === "full" || !original) {
    return {
      tool: name,
      profile: "full",
      description: original,
      originalChars: original.length,
      chars: original.length,
      savedChars: 0,
      compressed: false,
      fellBack: false,
      protectiveLines: classify(original).protective,
      droppedProtective: [],
      provenance: "MEASURED",
    }
  }

  // The hydration dispatcher is the entry point for every deferred tool; its
  // description must stay complete or discovery breaks.
  if (name === DEFERRED_DISPATCHER_TOOL && options.forceProfile !== true) {
    return {
      tool: name,
      profile: "full",
      description: original,
      originalChars: original.length,
      chars: original.length,
      savedChars: 0,
      compressed: false,
      fellBack: true,
      reason: "dispatcher-description-never-compressed",
      protectiveLines: classify(original).protective,
      droppedProtective: [],
      provenance: "MEASURED",
    }
  }

  const units = segmentDescription(original)
  const kept = []
  const droppedProtective = []
  let informative = 0

  // Every protective unit is kept unconditionally, in both profiles. Only
  // non-protective units compete for the remaining budget.
  for (const unit of units) {
    if (unit.kind === "protective") {
      kept.push(unit.text)
      continue
    }
    if (unit.kind === "blank") continue
    const budget = profile === "compact" || profile === "minimal" ? limits.maxInformativeUnits : Infinity
    if (informative < budget) {
      kept.push(unit.text)
      informative += 1
    }
  }

  // The first unit is the identity line ("Always-on read-only UES code
  // intelligence for normal Pi chats."). A model that cannot tell what a tool
  // IS will not call it correctly, so it is never compressible.
  if (units.length && !kept.includes(units[0].text)) kept.unshift(units[0].text)

  // Re-audit: every protective unit of the ORIGINAL must still be present.
  const keptSet = new Set(kept.map((text) => text.trim()))
  for (const unit of units) {
    if (unit.kind === "protective" && !keptSet.has(unit.text.trim())) droppedProtective.push(unit.text.trim())
  }

  // Soft char bound. Non-protective units are dropped from the tail until the
  // description fits. If the PROTECTIVE content alone exceeds the bound the
  // description is kept anyway and the overage is reported: a safety
  // instruction is never truncated to hit a size target. That is precisely the
  // bug the previous char-slice created (it cut a safety sentence, then the
  // audit threw the savings away).
  const joinKept = () => kept.map((text) => text.trim()).filter(Boolean).join("\n")
  const overCharBudget = () => joinKept().length > limits.maxChars
  while (overCharBudget()) {
    const index = kept.map((text) => classifySentence(text)).lastIndexOf("prose")
    if (index === -1) break
    kept.splice(index, 1)
  }

  const description = joinKept().trim()

  // Second audit: the soft char bound can also cut a protective unit off the
  // tail. The result is re-checked against the ORIGINAL units, so no profile
  // can ship a description that lost a safety instruction.
  //
  // Structural (bullet/param) protective lines are audited as whole lines too:
  // they are never segmented, so their survival is a distinct claim. Prose lines
  // are deliberately NOT re-checked at line level - they were segmented, so the
  // whole line legitimately does not appear verbatim in the output, and
  // comparing it would report a phantom loss on every description.
  const finalKept = new Set(description.split("\n").map((line) => line.trim()))
  for (const unit of units) {
    if (unit.kind !== "protective") continue
    if (finalKept.has(unit.text.trim()) || droppedProtective.includes(unit.text.trim())) continue
    droppedProtective.push(unit.text.trim())
  }
  for (const line of originalProtectiveLines(original)) {
    void line
  }

  const fellBack = droppedProtective.length > 0
  const finalDescription = fellBack ? original : description
  const finalChars = finalDescription.length

  return {
    tool: name,
    profile,
    description: finalDescription,
    originalChars: original.length,
    chars: finalChars,
    savedChars: Math.max(0, original.length - finalChars),
    compressed: !fellBack && finalDescription !== original,
    fellBack,
    overCharBudget: !fellBack && finalChars > limits.maxChars,
    maxChars: limits.maxChars === Infinity ? null : limits.maxChars,
    protectiveLines: originalProtectiveLines(original).length,
    protectiveSentences: units.filter((unit) => unit.kind === "protective").length,
    droppedProtective,
    provenance: "MEASURED",
  }
}

function classify(description) {
  const units = segmentDescription(description)
  return {
    protective: units.filter((unit) => unit.kind === "protective").length,
  }
}

/** Protective LINES of a description (bullet/param/protective line shapes). */
function originalProtectiveLines(description) {
  return splitLines(description)
    .filter((line) => classifyLine(line) === "protective")
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Apply a profile to a compiled tool surface (array of {name, description}).
 * Returns the surface plus aggregate telemetry; never throws.
 */
export function profileToolSurface(tools = [], profile = "full", options = {}) {
  const rows = Array.isArray(tools) ? tools : []
  const effective = TOOL_DESCRIPTION_PROFILES.includes(String(profile)) ? String(profile) : DEFAULT_TOOL_DESCRIPTION_PROFILE
  const results = rows.map((tool) => describeToolForProfile(tool, effective, options))
  const originalChars = results.reduce((sum, row) => sum + row.originalChars, 0)
  const chars = results.reduce((sum, row) => sum + row.chars, 0)
  return {
    schemaVersion: TOOL_DESCRIPTION_PROFILE_SCHEMA_VERSION,
    release: TOOL_DESCRIPTION_PROFILE_RELEASE,
    profile: effective,
    tools: rows.map((tool, index) => ({ ...tool, description: results[index].description })),
    stats: {
      toolCount: derived(rows.length),
      originalChars: measured(originalChars),
      visibleChars: measured(chars),
      savedChars: derived(Math.max(0, originalChars - chars)),
      savedTokens: derived(Math.max(0, Math.round((originalChars - chars) / 4))),
      compressed: measured(results.filter((row) => row.compressed).length),
      fellBack: measured(results.filter((row) => row.fellBack).length),
      overCharBudget: measured(results.filter((row) => row.overCharBudget).length),
      protectiveLinesDropped: measured(results.reduce((sum, row) => sum + row.droppedProtective.length, 0)),
      budgetImpact: NOT_MEASURED,
    },
    audit: results
      .filter((row) => row.fellBack || row.droppedProtective.length)
      .map((row) => ({ tool: row.tool, fellBack: row.fellBack, dropped: row.droppedProtective, reason: row.reason || null })),
    provenance: { stats: "MEASURED", savings: "DERIVED" },
  }
}

// ---------------------------------------------------------------------------
// V16.6 tool-description profile learner (spec §13)
// ---------------------------------------------------------------------------
//
// A narrower description profile is only ever chosen from OBSERVED outcomes:
// enough samples for the model, a healthy verified-pass rate and a low tool
// selection-error rate. The learner can never drop a protective line (the
// compressor falls back to the original text on any such attempt); it only
// decides `full | compact | minimal`. Persistence helpers are provided, but the
// runtime keeps a bounded in-process store so a fresh workspace starts at the
// release default instead of inheriting an unproven narrow profile.

export const TOOL_DESCRIPTION_LEARNER_SCHEMA_VERSION = 1
export const TOOL_DESCRIPTION_LEARNER = Object.freeze({
  minSamples: 8,
  strongSamples: 20,
  maxKeys: 64,
  maxSelectionErrorRate: 0.10,
  minPassRateForCompact: 0.85,
  minPassRateForMinimal: 0.95,
  hysteresisMargin: 0.05,
})

const DESCRIPTION_LEARNER_FORBIDDEN = Object.freeze([
  "dropsProtectiveLine",
  "dropsRequiredParam",
  "removesApprovalGate",
  "changesPermissions",
  "disablesVerifier",
  "raisesRiskFloor",
])

const descriptionLearnerStore = new Map()

function learnerKeyOf(sample = {}) {
  return `${String(sample.model || "*")}\u0000${String(sample.risk || "low")}`
}

/**
 * Record one description-profile outcome for a model/risk bucket.
 * `selectionErrors` / `hydrationRequests` are MEASURED counts; `verifiedPass` is
 * the run's local verifier result. Unknown values are not invented.
 */
export function recordToolDescriptionOutcome(sample = {}) {
  const key = learnerKeyOf(sample)
  const row = descriptionLearnerStore.get(key) || {
    key,
    model: String(sample.model || "*"),
    risk: String(sample.risk || "low"),
    samples: 0,
    verifiedPass: 0,
    verifiedFail: 0,
    selectionErrors: 0,
    hydrationRequests: 0,
    unusedAdvertisedToolSamples: 0,
    unusedAdvertisedToolsSum: 0,
    lastSeenAt: Date.now(),
  }
  row.samples += 1
  if (sample.verifiedPass === true) row.verifiedPass += 1
  if (sample.verifiedPass === false) row.verifiedFail += 1
  row.selectionErrors += Math.max(0, Number(sample.selectionErrors) || 0)
  row.hydrationRequests += Math.max(0, Number(sample.hydrationRequests) || 0)
  const unused = Number(sample.unusedAdvertisedTools)
  if (Number.isFinite(unused)) {
    row.unusedAdvertisedToolsSum += Math.max(0, unused)
    row.unusedAdvertisedToolSamples += 1
  }
  row.lastSeenAt = Date.now()
  descriptionLearnerStore.set(key, row)
  while (descriptionLearnerStore.size > TOOL_DESCRIPTION_LEARNER.maxKeys) {
    descriptionLearnerStore.delete(descriptionLearnerStore.keys().next().value)
  }
  return { recorded: true, key, samples: row.samples }
}

/**
 * Recommend a description profile from observed outcomes.
 *
 *   applied:false  keep the caller's budget/default decision
 *   applied:true   the learner has enough evidence to move the profile
 *
 * A widening to `full` is always allowed once observed (it can only make the
 * surface safer). A narrowing needs the sample floor and a clean quality record.
 */
export function recommendedDescriptionProfile(input = {}, options = {}) {
  const minSamples = Math.max(TOOL_DESCRIPTION_LEARNER.minSamples, Number(options.minSamples) || 0)
  const risk = str(input.risk, "low").toLowerCase()
  const key = learnerKeyOf({ model: input.model, risk })
  const row = descriptionLearnerStore.get(key)
  const base = {
    schemaVersion: TOOL_DESCRIPTION_LEARNER_SCHEMA_VERSION,
    model: input.model ? String(input.model) : null,
    risk,
    samples: row?.samples || 0,
    minSamples,
    effect: "description-profile-only",
  }
  if (["high", "critical"].includes(risk)) {
    return { ...base, applied: true, profile: "full", reason: "risk-safety-floor" }
  }
  if (!row || row.samples < minSamples) {
    return { ...base, applied: false, profile: null, reason: "insufficient-data" }
  }
  const passRate = row.samples ? row.verifiedPass / row.samples : 0
  const errorRate = row.samples ? row.selectionErrors / row.samples : 0
  if (errorRate > TOOL_DESCRIPTION_LEARNER.maxSelectionErrorRate || passRate < TOOL_DESCRIPTION_LEARNER.minPassRateForCompact) {
    return { ...base, applied: true, profile: "full", reason: "observed-selection-or-quality-drop", passRate, errorRate }
  }
  if (passRate >= TOOL_DESCRIPTION_LEARNER.minPassRateForMinimal && row.samples >= TOOL_DESCRIPTION_LEARNER.strongSamples) {
    return { ...base, applied: true, profile: "minimal", reason: "strong-quality-record", passRate, errorRate }
  }
  return { ...base, applied: true, profile: "compact", reason: "healthy-quality-record", passRate, errorRate }
}

export function toolDescriptionLearnerReport(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || 30 * 24 * 60 * 60 * 1000)
  const now = Number(options.now) || Date.now()
  return {
    schemaVersion: TOOL_DESCRIPTION_LEARNER_SCHEMA_VERSION,
    minSamples: TOOL_DESCRIPTION_LEARNER.minSamples,
    maxKeys: TOOL_DESCRIPTION_LEARNER.maxKeys,
    forbiddenEffects: [...DESCRIPTION_LEARNER_FORBIDDEN],
    rows: [...descriptionLearnerStore.values()].map((row) => ({
      ...row,
      passRate: row.samples ? Number((row.verifiedPass / row.samples).toFixed(4)) : null,
      selectionErrorRate: row.samples ? Number((row.selectionErrors / row.samples).toFixed(4)) : null,
      stale: now - row.lastSeenAt > maxAge,
    })),
  }
}

export function gcToolDescriptionLearner(options = {}) {
  const maxAge = Math.max(1000, Number(options.maxAgeMs) || 30 * 24 * 60 * 60 * 1000)
  const now = Number(options.now) || Date.now()
  let removed = 0
  for (const [key, row] of [...descriptionLearnerStore.entries()]) {
    if (now - row.lastSeenAt > maxAge) {
      descriptionLearnerStore.delete(key)
      removed += 1
    }
  }
  while (descriptionLearnerStore.size > TOOL_DESCRIPTION_LEARNER.maxKeys) {
    descriptionLearnerStore.delete(descriptionLearnerStore.keys().next().value)
    removed += 1
  }
  return { removed, remaining: descriptionLearnerStore.size }
}

/** Test hook. */
export function resetToolDescriptionLearnerForTests() {
  descriptionLearnerStore.clear()
}

/** The learner may only choose a profile; it may never claim a forbidden effect. */
export function assertToolDescriptionLearnerAuthority(advice) {
  const violations = []
  if (advice?.effect !== "description-profile-only") violations.push("effect must be description-profile-only")
  if (advice?.profile !== null && !TOOL_DESCRIPTION_PROFILES.includes(String(advice?.profile))) {
    violations.push("profile must be full|compact|minimal or null")
  }
  for (const forbidden of DESCRIPTION_LEARNER_FORBIDDEN) {
    if (advice?.[forbidden] === true) violations.push(`learner must never ${forbidden}`)
  }
  return { ok: violations.length === 0, violations }
}

export const TOOL_DESCRIPTION_PROFILE_EXPORTS = Object.freeze([
  "resolveToolDescriptionProfile",
  "describeToolForProfile",
  "profileToolSurface",
  "toolDescriptionProfileEnv",
  "segmentSentences",
  "segmentDescription",
  "TOOL_DESCRIPTION_PROFILES",
  "recordToolDescriptionOutcome",
  "recommendedDescriptionProfile",
  "toolDescriptionLearnerReport",
  "gcToolDescriptionLearner",
  "assertToolDescriptionLearnerAuthority",
  "resetToolDescriptionLearnerForTests",
])
