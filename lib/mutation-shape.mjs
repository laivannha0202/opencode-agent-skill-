const KNOWN_WRITE_TOOLS = new Set(["edit","write","write_file","apply_patch","ues_code_edit","str_replace","str_replace_editor"])
const KNOWN_READ_TOOLS = new Set(["read","grep","find","glob","ls","ues_code","ues_evidence_get"])

function normalized(value) { return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim() }
function pushUnique(out, value) {
  const item = normalized(value)
  if (!item || item.includes("\0") || item.split("/").includes("..")) return
  if (!out.includes(item)) out.push(item)
}
function filesFromInput(input = {}) {
  const out = []
  for (const key of ["path","file","filePath","file_path","target","targetFile"]) {
    const value = input?.[key]
    if (Array.isArray(value)) value.forEach((item) => pushUnique(out, item))
    else if (value != null) pushUnique(out, value)
  }
  for (const key of ["paths","files","filePaths"]) {
    const value = input?.[key]
    if (Array.isArray(value)) value.forEach((item) => pushUnique(out, item))
  }
  for (const operation of Array.isArray(input?.operations) ? input.operations : []) {
    if (!operation || typeof operation !== "object") continue
    for (const key of ["path","file","filePath","target"]) if (operation[key] != null) pushUnique(out, operation[key])
  }
  const patch = input?.patch ?? input?.diff ?? input?.patchText
  if (patch != null) {
    const text = String(patch)
    for (const match of text.matchAll(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gm)) pushUnique(out, match[1])
    for (const match of text.matchAll(/^\+\+\+\s+b\/(.+)$/gm)) pushUnique(out, match[1])
  }
  return out.slice(0, 64)
}
function mutationSignals(input = {}) {
  let score = 0
  for (const key of Object.keys(input || {})) {
    if (/^(content|newText|new_text|replacement|patch|diff|patchText|edits)$/i.test(key)) score += 2
    if (/^(operations|changes|writes|updates)$/i.test(key)) score += 1
  }
  for (const operation of Array.isArray(input?.operations) ? input.operations : []) {
    const kind = String(operation?.op || operation?.operation || operation?.type || "").toLowerCase()
    if (/^(add|create|delete|edit|modify|move|patch|remove|rename|replace|update|write)$/.test(kind)) score += 2
  }
  return score
}
export function detectMutationShape(toolName, input = {}) {
  const name = String(toolName || "").trim().toLowerCase()
  const files = filesFromInput(input && typeof input === "object" ? input : {})
  if (KNOWN_READ_TOOLS.has(name)) return { schemaVersion: 1, mutation: "no", confidence: "known-read-tool", files: [] }
  if (KNOWN_WRITE_TOOLS.has(name)) return { schemaVersion: 1, mutation: "yes", confidence: "known-write-tool", files }
  const signals = mutationSignals(input && typeof input === "object" ? input : {})
  if (signals >= 2 && files.length) return { schemaVersion: 1, mutation: "yes", confidence: "argument-shape", files }
  if (signals > 0 || files.length) return { schemaVersion: 1, mutation: "possible", confidence: "insufficient-shape", files }
  return { schemaVersion: 1, mutation: "no", confidence: "no-mutation-shape", files: [] }
}
export const MUTATION_SHAPE_WRITE_TOOLS = Object.freeze([...KNOWN_WRITE_TOOLS].sort())
