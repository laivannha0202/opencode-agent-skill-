// Explicit tool concurrency contract (V15.5).
// Unknown and side-effecting tools are serial by default. Only bounded
// read/search tools are explicitly parallel-safe.
export const TOOL_CONCURRENCY_CLASS = Object.freeze({
  READ_PARALLEL_SAFE: "READ_PARALLEL_SAFE",
  READ_SERIAL: "READ_SERIAL",
  WRITE_SERIAL: "WRITE_SERIAL",
  WRITE_MULTI_FILE: "WRITE_MULTI_FILE",
  PROCESS_EXCLUSIVE: "PROCESS_EXCLUSIVE",
  NETWORK_PARALLEL_SAFE: "NETWORK_PARALLEL_SAFE",
  UNKNOWN_SERIAL: "UNKNOWN_SERIAL",
})

const PARALLEL_READ = new Set(["read", "grep", "find", "glob", "ls", "ues_code", "ues_evidence_get"])
const SERIAL_WRITE = new Set(["edit", "write", "write_file", "apply_patch", "ues_code_edit"])
const MULTI_WRITE = new Set(["multi_edit", "write_files", "apply_patches"])
const PROCESS_EXCLUSIVE = new Set(["bash", "powershell", "ues_service"])

function normalizedName(value) {
  return String(value || "").trim().toLowerCase()
}

function resourceList(input = {}) {
  const rows = [
    input.path, input.file, input.filePath, input.target,
    ...(Array.isArray(input.paths) ? input.paths : []),
    ...(Array.isArray(input.files) ? input.files : []),
  ].filter((value) => value != null && String(value).trim())
  return [...new Set(rows.map((value) => String(value).replaceAll("\\", "/")))].sort()
}

export function toolConcurrencyContract(toolName, input = {}) {
  const name = normalizedName(toolName)
  const resources = resourceList(input)
  if (PARALLEL_READ.has(name) || name.startsWith("search_") || name.endsWith("_search")) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.READ_PARALLEL_SAFE, parallelSafe: true, mutation: false, resources, reason: "explicit-bounded-read" }
  }
  if (MULTI_WRITE.has(name)) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.WRITE_MULTI_FILE, parallelSafe: false, mutation: true, resources, reason: "explicit-multi-file-write" }
  }
  if (SERIAL_WRITE.has(name)) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.WRITE_SERIAL, parallelSafe: false, mutation: true, resources, reason: "explicit-write" }
  }
  if (PROCESS_EXCLUSIVE.has(name)) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.PROCESS_EXCLUSIVE, parallelSafe: false, mutation: null, resources, reason: "process-or-shell-side-effects-unknown" }
  }
  return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.UNKNOWN_SERIAL, parallelSafe: false, mutation: null, resources, reason: "unknown-tools-fail-serial" }
}

export function toolCallsConflict(left = {}, right = {}) {
  const a = toolConcurrencyContract(left.tool ?? left.name, left.input || left.args || {})
  const b = toolConcurrencyContract(right.tool ?? right.name, right.input || right.args || {})
  if (a.parallelSafe && b.parallelSafe) return false
  return true
}

export function toolConcurrencySnapshot(toolNames = []) {
  return [...new Set((toolNames || []).map(normalizedName).filter(Boolean))]
    .sort()
    .map((tool) => toolConcurrencyContract(tool))
}
