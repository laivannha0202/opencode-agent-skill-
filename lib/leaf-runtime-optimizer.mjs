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
