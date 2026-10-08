// Explicit tool concurrency contract (V15.5).
// Unknown and side-effecting tools are serial by default. Only bounded
// read/search tools are explicitly parallel-safe.
//
// ---------------------------------------------------------------------------
// V16.15: THE ISOLATED-WRITE LANE
// ---------------------------------------------------------------------------
//
// V15.5 had exactly two outcomes for a mutating tool: serial, or multi-file
// serial. That is correct for a tool that edits the ROOT workspace, but it is
// over-conservative for a tool that edits inside its OWN sandbox / worktree:
// such a write cannot be observed by anyone else, so two of them in DIFFERENT
// sandboxes cannot corrupt each other.
//
// The lane is TRUSTED-ONLY. `isolated` can never come from the tool input, i.e.
// from the model: it is passed as the third argument by the runtime that owns
// the sandbox. A model that writes `{"isolated": true}` into its own arguments
// gets an ordinary serial write.
//
// LAWS
//
//   1. UNKNOWN STILL FAILS SERIAL. A tool whose class is unknown, and any
//      process/shell tool, is serial with respect to everything.
//   2. ISOLATION IS NOT A LICENSE TO OVERLAP THE ROOT. An isolated writer never
//      overlaps a root writer, a read of the root, or an unknown tool.
//   3. DIFFERENT SANDBOX, DISJOINT FILES. Two isolated writers may overlap only
//      when their sandbox ids differ AND their declared resources are disjoint.
//      Same sandbox means same worktree: that is a real conflict.
//   4. THE LANE IS BOUNDED. `ISOLATED_WRITE_MAX_WIDTH` is a hard ceiling; a
//      caller can lower it but never raise it.
export const TOOL_CONCURRENCY_CLASS = Object.freeze({
  READ_PARALLEL_SAFE: "READ_PARALLEL_SAFE",
  READ_SERIAL: "READ_SERIAL",
  WRITE_SERIAL: "WRITE_SERIAL",
  WRITE_MULTI_FILE: "WRITE_MULTI_FILE",
  PROCESS_EXCLUSIVE: "PROCESS_EXCLUSIVE",
  NETWORK_PARALLEL_SAFE: "NETWORK_PARALLEL_SAFE",
  UNKNOWN_SERIAL: "UNKNOWN_SERIAL",
  // V16.15: a mutation whose target is an ISOLATED sandbox/worktree, not the
  // root workspace. It is still a mutation and still never parallel-safe with
  // anything that touches the root.
  ISOLATED_WRITE: "ISOLATED_WRITE",
})

/** Hard ceiling for the isolated-write lane. Aligned with the V16.5 fleet bound. */
export const ISOLATED_WRITE_MAX_WIDTH = 3

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

/**
 * V16.15: read the TRUSTED isolation declaration off the third argument.
 *
 * Deliberately NOT read from `input`: a model-authored `isolated: true` must
 * never be able to promote its own write into the overlap lane.
 */
function isolationOf(options = {}) {
  const sandboxId = String(options.sandboxId || options.worktreeId || "").trim()
  const isolated = options.isolated === true || Boolean(sandboxId)
  if (!isolated) return { isolated: false, sandboxId: "" }
  return { isolated: true, sandboxId: sandboxId || "isolated:unnamed" }
}

/** Resolve the bounded width of the isolated-write lane. */
export function resolveIsolatedWriteWidth(requested) {
  const parsed = Number(requested)
  const base = Number.isFinite(parsed) && parsed >= 1 ? Math.trunc(parsed) : 2
  return Math.max(1, Math.min(ISOLATED_WRITE_MAX_WIDTH, base))
}

export function toolConcurrencyContract(toolName, input = {}, options = {}) {
  const name = normalizedName(toolName)
  const resources = resourceList(input)
  const isolation = isolationOf(options)
  if (PARALLEL_READ.has(name) || name.startsWith("search_") || name.endsWith("_search")) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.READ_PARALLEL_SAFE, parallelSafe: true, mutation: false, resources, reason: "explicit-bounded-read" }
  }
  if (MULTI_WRITE.has(name)) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.WRITE_MULTI_FILE, parallelSafe: false, mutation: true, resources, reason: "explicit-multi-file-write" }
  }
  if (SERIAL_WRITE.has(name)) {
    // An explicitly isolated mutation runs in the isolated-write lane. It is
    // still NOT `parallelSafe` (that flag means "safe to overlap anything", and
    // this is only safe to overlap the other isolated writers). Callers must ask
    // `toolCallsConflict` / `isolatedWriteOverlapAllowed` for the real answer.
    if (isolation.isolated) {
      return {
        schemaVersion: 1,
        tool: name,
        class: TOOL_CONCURRENCY_CLASS.ISOLATED_WRITE,
        parallelSafe: false,
        isolated: true,
        sandboxId: isolation.sandboxId,
        mutation: true,
        resources,
        reason: "isolated-sandbox-write",
      }
    }
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.WRITE_SERIAL, parallelSafe: false, mutation: true, resources, reason: "explicit-write" }
  }
  if (PROCESS_EXCLUSIVE.has(name)) {
    return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.PROCESS_EXCLUSIVE, parallelSafe: false, mutation: null, resources, reason: "process-or-shell-side-effects-unknown" }
  }
  return { schemaVersion: 1, tool: name, class: TOOL_CONCURRENCY_CLASS.UNKNOWN_SERIAL, parallelSafe: false, mutation: null, resources, reason: "unknown-tools-fail-serial" }
}

function isIsolatedWriteContract(contract) {
  return contract?.class === TOOL_CONCURRENCY_CLASS.ISOLATED_WRITE && contract?.isolated === true
}

/**
 * V16.15: may these two isolated writes overlap?
 *
 * YES only when all hold: both are isolated writes, their sandbox ids DIFFER
 * (same sandbox = same worktree = a real conflict), and their declared resources
 * are disjoint. A declaration with NO resources is not "disjoint": it is
 * unknown, so it conflicts.
 */
export function isolatedWriteOverlapAllowed(left, right) {
  if (!isIsolatedWriteContract(left) || !isIsolatedWriteContract(right)) return false
  if (String(left.sandboxId) === String(right.sandboxId)) return false
  const a = left.resources || []
  const b = right.resources || []
  if (!a.length || !b.length) return false
  const rightSet = new Set(b)
  return !a.some((resource) => rightSet.has(resource))
}

export function toolCallsConflict(left = {}, right = {}) {
  const a = toolConcurrencyContract(left.tool ?? left.name, left.input || left.args || {}, left.options || {})
  const b = toolConcurrencyContract(right.tool ?? right.name, right.input || right.args || {}, right.options || {})
  // V16.15: the one new overlap. Everything below this line is the V15.5 rule.
  if (isIsolatedWriteContract(a) && isIsolatedWriteContract(b)) return !isolatedWriteOverlapAllowed(a, b)
  if (a.parallelSafe && b.parallelSafe) return false
  return true
}

export function toolConcurrencySnapshot(toolNames = []) {
  return [...new Set((toolNames || []).map(normalizedName).filter(Boolean))]
    .sort()
    .map((tool) => toolConcurrencyContract(tool))
}
