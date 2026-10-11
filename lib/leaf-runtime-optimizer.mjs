import { classifyEngineeringTask } from "./task-policy.mjs"

function strings(value) {
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).map(String).map((item) => item.trim()).filter(Boolean)
}

function declaredWriteFiles(task = {}) {
  const files = task?.files || {}
  return [...new Set([
    ...strings(files.create),
    ...strings(files.modify),
    ...strings(files.test),
    ...strings(files.delete),
  ].map((item) => item.replaceAll("\\", "/")))]
}

export function leafTaskPolicy(task = {}, rootPolicy = {}) {
  const writeFiles = declaredWriteFiles(task)
  const readFiles = strings(task?.files?.read)
  const text = [
    task?.title,
    task?.summary,
    ...strings(task?.acceptance),
    ...strings(task?.verification),
    task?.riskNotes,
    writeFiles.length ? "Declared write files: " + writeFiles.join(", ") : "",
    readFiles.length ? "Declared read files: " + readFiles.join(", ") : "",
  ].filter(Boolean).join("\n")

  const policy = classifyEngineeringTask(text, {
    declaredFiles: writeFiles,
    changedFiles: writeFiles.length,
    risk: task?.risk,
    longHorizon: false,
    failureEvidence: false,
  })

  // The root may be DEEP because the overall project is large; do not force an
  // independent low-risk leaf to pay that cost. Root safety is preserved by the
  // final integration/completion gates and by leaf-declared risk.
  return {
    ...policy,
    requireFreshEvidence: true,
    rootExecutionProfile: rootPolicy?.executionProfile || null,
    rootRisk: rootPolicy?.risk || null,
    localEnvWriteExplicitlyAllowed: rootPolicy?.localEnvWriteExplicitlyAllowed === true,
    leafOptimized: true,
  }
}

const FAILURE_SIGNAL = /(?:\bFAIL(?:ED|URE)?\b|\bERROR\b|AssertionError|TypeError|ReferenceError|SQLSTATE|ECONN\w*|EADDRINUSE|expected|actual|exit(?:Code| code)?\s*[:=]?\s*[1-9]|timed?\s*out|timeout|not found|cannot|unable|mismatch|regression|✖|×)/i
const FILE_SIGNAL = /(?:^|\s)(?:[A-Za-z]:)?[^\s:]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|cs|sql|json|yaml|yml)(?::\d+(?::\d+)?)?/i

export function failureDelta(output, options = {}) {
  const maxChars = Math.max(1200, Math.min(8000, Number(options.maxChars || 4200)))
  const raw = String(output || "").trim()
  if (!raw) return ""

  const lines = raw.split(/\r?\n/)
  const selected = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!FAILURE_SIGNAL.test(line) && !FILE_SIGNAL.test(line)) continue
    if (i > 0 && lines[i - 1].trim()) selected.push(lines[i - 1])
    selected.push(line)
    if (i + 1 < lines.length && lines[i + 1].trim()) selected.push(lines[i + 1])
  }

  const compact = [...new Set(selected.map((line) => line.trim()).filter(Boolean))].join("\n")
  if (compact) return compact.slice(0, maxChars)

  // Fail closed on unknown output shape: keep a bounded tail, which usually
  // contains the final verdict/error without replaying the entire previous turn.
  return raw.slice(Math.max(0, raw.length - maxChars))
}

// ---------------------------------------------------------------------------
// V16.18 WEAK-MODEL DECISION CAPSULE.
//
// A compact, DETERMINISTICALLY GENERATED decision state handed to a weak/free
// model before significant turns. It is not a planner: it adds no new plan, no
// new authority and no new reasoning budget. It is an anti-drift / anti-repeat
// structure built from state the runtime already holds, so a weak model spends
// its turn on the next action instead of re-discovering the repository.
//
// Contract: every line is either a measured fact or an explicit UNKNOWN. A line
// with no evidence is rendered as UNKNOWN and never guessed, and repeated
// failures are listed under DO NOT REPEAT so a retry cannot replay them.
// ---------------------------------------------------------------------------

const CAPSULE_POLICY = "weak-model-decision-capsule-v16-18"

function boundedLines(values, limit = 6) {
  return (Array.isArray(values) ? values : [values])
    .map((value) => String(value ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit)
}

function boundedText(value, maxChars = 600) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim()
  if (!raw) return ""
  return raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw
}

/**
 * @param {object} state deterministic runtime state:
 *   { goal, knownFacts, knownFiles, currentFailure, unknowns, currentAction,
 *     verification, doNotRepeat, attempt, profile }
 */
export function buildDecisionCapsule(state = {}) {
  const row = state && typeof state === "object" ? state : {}
  const lines = []
  const unknowns = []
  const section = (label, value) => {
    const text = Array.isArray(value)
      ? boundedLines(value)
      : [String(value ?? "").trim()].filter(Boolean)
    const empty = text.length === 0 || (text.length === 1 && text[0] === "UNKNOWN")
    if (empty) {
      lines.push(`${label}:`, "UNKNOWN")
      unknowns.push(label)
      return
    }
    lines.push(`${label}:`)
    for (const item of text) lines.push("- " + item)
  }

  section("GOAL", [boundedText(row.goal, 400) || "UNKNOWN"])
  section("KNOWN", boundedLines(row.knownFacts, 8).length ? boundedLines(row.knownFacts, 8) : "UNKNOWN")
  section("KNOWN FILES", boundedLines(row.knownFiles, 8).length ? boundedLines(row.knownFiles, 8) : "UNKNOWN")
  section("CURRENT FAILURE", boundedText(row.currentFailure, 600) ? [boundedText(row.currentFailure, 600)] : "UNKNOWN")
  section("UNKNOWN", boundedLines(row.unknowns, 6).length ? boundedLines(row.unknowns, 6) : "UNKNOWN")
  section("CURRENT ACTION", [boundedText(row.currentAction, 400) || "UNKNOWN"])
  section("VERIFICATION REQUIRED", boundedLines(row.verification, 4).length ? boundedLines(row.verification, 4) : "UNKNOWN")
  section("DO NOT REPEAT", boundedLines(row.doNotRepeat, 6).length ? boundedLines(row.doNotRepeat, 6) : "UNKNOWN")

  const text = [
    "## UES decision capsule (deterministic; evidence only)",
    ...lines,
  ].join("\n")

  return {
    schemaVersion: 1,
    policy: CAPSULE_POLICY,
    text,
    chars: text.length,
    unknownSections: unknowns,
    unknownCount: unknowns.length,
    attempt: Math.max(1, Math.trunc(Number(row.attempt || 1))),
    profile: String(row.profile || "") || null,
    providerTokens: "NOT_MEASURED",
  }
}

/** Render the capsule for injection into the model-visible task text. */
export function renderDecisionCapsule(capsule) {
  if (!capsule || !capsule.text) return ""
  return "\n" + capsule.text + "\n"
}
