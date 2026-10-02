// V16.2 same-attempt deferred-tool hydration.
//
// Bounded discovery + hydration interface for tools that the tool-surface
// economy defers off the advertised list. The dispatcher tool
// ("ues_tool_search") is always advertised when a deferred set exists, so the
// model can discover and use a deferred capability inside the SAME session
// (same attempt) instead of failing and waiting for a retry reveal.
//
// Safety design (small on purpose):
// - search is metadata-only and deterministic (score, then alpha, capped).
// - hydration grants are checked against: deferred membership, advertised set,
//   read-only role boundary, forbidden policy set, and a per-session budget.
// - granting only *activates* the real tool (parent allow-list / child
//   setActiveTools). Execution still flows through every existing guard
//   (permission lattice, scheduler, ownership, MCP policy). The dispatcher
//   never executes an arbitrary tool itself.
// - unknown tools, already-advertised tools, writer tools for read-only
//   roles, and budget exhaustion are denied with stable reason codes.
import { createHash } from "node:crypto"

export const DEFERRED_DISPATCHER_TOOL = "ues_tool_search"
export const DISPATCHER_SCHEMA_VERSION = 1
export const HYDRATION_INTERFACE_VERSION = "v16.2-same-attempt/1"
export const DEFAULT_HYDRATION_BUDGET = 4
export const MAX_DISCOVERY_RESULTS = 5
export const HARD_DISCOVERY_LIMIT = 8

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex")
}

// Compact, stable purpose metadata so a weak model can map a need ("read a
// file", "run tests", "browser check") to the right deferred tool without the
// full schema of every deferred tool in context.
export const TOOL_PURPOSES = Object.freeze({
  read: { capability: "read-file", purpose: "Read file contents with line numbers", writerOnly: false, keywords: ["read", "file", "view", "cat", "content"] },
  grep: { capability: "search-text", purpose: "Search file contents by pattern", writerOnly: false, keywords: ["search", "grep", "pattern", "find text", "match"] },
  find: { capability: "find-paths", purpose: "Find files and directories by name", writerOnly: false, keywords: ["find", "locate", "files", "glob", "paths"] },
  ls: { capability: "list-directory", purpose: "List directory entries", writerOnly: false, keywords: ["list", "ls", "directory", "folder"] },
  bash: { capability: "run-shell", purpose: "Run shell commands (tests, builds, scripts)", writerOnly: false, keywords: ["run", "shell", "bash", "test", "build", "command", "exec", "npm"] },
  powershell: { capability: "run-shell", purpose: "Run PowerShell commands on Windows", writerOnly: false, keywords: ["powershell", "windows", "shell", "run", "command"] },
  edit: { capability: "edit-file", purpose: "Apply anchored file edits", writerOnly: true, keywords: ["edit", "modify", "change", "patch", "fix"] },
  write: { capability: "write-file", purpose: "Create or overwrite whole files", writerOnly: true, keywords: ["write", "create", "new file", "overwrite"] },
  ues_code: { capability: "code-intelligence", purpose: "Semantic/AST search, anchored reads, LSP navigation, diagnostics", writerOnly: false, keywords: ["code", "symbols", "definition", "references", "diagnostics", "search code"] },
  ues_code_edit: { capability: "anchored-edit", purpose: "Fail-closed hash-anchored edits with diagnostics", writerOnly: true, keywords: ["anchored", "edit", "refactor", "rename"] },
  ues_service: { capability: "background-service", purpose: "Start/stop supervised background services (dev servers)", writerOnly: false, keywords: ["service", "server", "dev server", "port", "background", "serve"] },
  ues_evidence_get: { capability: "evidence-fetch", purpose: "Fetch preserved evidence by ref after output compaction", writerOnly: false, keywords: ["evidence", "ref", "compact", "truncated", "full output"] },
})

export function describeDeferredTool(name) {
  const tool = String(name || "")
  const known = TOOL_PURPOSES[tool]
  if (known) return { tool, ...known }
  return {
    tool,
    capability: /(playwright|browser)/i.test(tool) ? "browser-automation" : /mcp/i.test(tool) ? "mcp-capability" : "external-capability",
    purpose: `Optional ${tool} capability (external/MCP-provided)`,
    writerOnly: false,
    keywords: [tool.toLowerCase().replace(/[_-]+/g, " ")],
  }
}

function discoveryScore(tool, meta, queryTokens) {
  if (!queryTokens.length) return 0
  const haystack = [tool.toLowerCase(), String(meta.capability || "").toLowerCase(), String(meta.purpose || "").toLowerCase(), ...(meta.keywords || [])].join(" ")
  let score = 0
  let matched = 0
  for (const token of queryTokens) {
    if (!token) continue
    if (tool.toLowerCase() === token) { score += 120; matched += 1 }
    else if (tool.toLowerCase().startsWith(token)) { score += 80; matched += 1 }
    else if (tool.toLowerCase().includes(token)) { score += 50; matched += 1 }
    else if (String(meta.capability || "").toLowerCase().includes(token)) { score += 40; matched += 1 }
    else if (haystack.includes(token)) { score += 20; matched += 1 }
  }
  // At least one query token must match; the rest only rank. Strict AND
  // semantics would hide tools behind stop-words ("run the test suite").
  return matched > 0 ? score : -1
}

export function searchDeferredTools(input = {}) {
  const deferred = unique(input.deferred)
  const query = String(input.query || "").toLowerCase()
  const writer = input.writer === true
  const limit = Math.max(1, Math.min(HARD_DISCOVERY_LIMIT, Math.trunc(Number(input.limit || MAX_DISCOVERY_RESULTS)) || MAX_DISCOVERY_RESULTS))
  const queryTokens = query.split(/[^a-z0-9_+-]+/).map((token) => token.trim()).filter(Boolean).slice(0, 8)
  const rows = []
  for (const tool of deferred) {
    const meta = describeDeferredTool(tool)
    if (meta.writerOnly === true && writer !== true) continue
    const score = discoveryScore(tool, meta, queryTokens)
    if (score < 0) continue
    rows.push({ tool, capability: meta.capability, purpose: meta.purpose, writerOnly: meta.writerOnly, score })
  }
  rows.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
  const results = rows.slice(0, limit).map(({ tool, capability, purpose, writerOnly }) => ({ tool, capability, purpose, writerOnly }))
  return {
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    interfaceVersion: HYDRATION_INTERFACE_VERSION,
    query: String(input.query || ""),
    deferredCount: deferred.length,
    returned: results.length,
    limit,
    deterministic: true,
    results,
  }
}

export function createDeferredHydrationSession(input = {}) {
  const deferred = unique(input.deferred)
  const advertised = new Set(unique(input.advertised))
  return {
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    interfaceVersion: HYDRATION_INTERFACE_VERSION,
    deferred,
    advertised: [...advertised],
    role: String(input.role || ""),
    writer: input.writer === true,
    forbidden: unique(input.forbidden),
    maxHydrations: Math.max(1, Math.min(8, Math.trunc(Number(input.maxHydrations || DEFAULT_HYDRATION_BUDGET)) || DEFAULT_HYDRATION_BUDGET)),
    hydrated: [],
    denied: [],
    discoveryCount: 0,
    hydrationRequests: 0,
    sameAttempt: true,
  }
}

export const HYDRATION_DENY_REASONS = Object.freeze({
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  ALREADY_ADVERTISED: "ALREADY_ADVERTISED",
  ALREADY_HYDRATED: "ALREADY_HYDRATED",
  READ_ONLY_ROLE: "READ_ONLY_ROLE",
  FORBIDDEN_POLICY: "FORBIDDEN_POLICY",
  HYDRATION_BUDGET_EXHAUSTED: "HYDRATION_BUDGET_EXHAUSTED",
})

export function requestDeferredHydration(session, tool, context = {}) {
  if (!session || typeof session !== "object") throw new Error("deferred hydration requires a session")
  const name = String(tool || "").trim()
  const writer = context.writer === true ? true : context.writer === false ? false : session.writer === true
  session.hydrationRequests = Number(session.hydrationRequests || 0) + 1
  const deny = (reason) => {
    session.denied = unique([...(session.denied || []), name].filter(Boolean))
    return { schemaVersion: DISPATCHER_SCHEMA_VERSION, granted: false, tool: name, reason, hydrated: [...(session.hydrated || [])] }
  }
  if (!name) return deny(HYDRATION_DENY_REASONS.UNKNOWN_TOOL)
  const deferredSet = new Set(unique(session.deferred))
  if (!deferredSet.has(name)) {
    const advertisedSet = new Set([...unique(session.advertised), ...unique(session.hydrated)])
    if (advertisedSet.has(name)) return deny(HYDRATION_DENY_REASONS.ALREADY_ADVERTISED)
    return deny(HYDRATION_DENY_REASONS.UNKNOWN_TOOL)
  }
  if (unique(session.hydrated).includes(name)) return deny(HYDRATION_DENY_REASONS.ALREADY_HYDRATED)
  const meta = describeDeferredTool(name)
  if (meta.writerOnly === true && writer !== true) return deny(HYDRATION_DENY_REASONS.READ_ONLY_ROLE)
  if (unique(session.forbidden).includes(name)) return deny(HYDRATION_DENY_REASONS.FORBIDDEN_POLICY)
  if (unique(session.hydrated).length >= Number(session.maxHydrations || DEFAULT_HYDRATION_BUDGET)) {
    return deny(HYDRATION_DENY_REASONS.HYDRATION_BUDGET_EXHAUSTED)
  }
  session.hydrated = unique([...(session.hydrated || []), name])
  return {
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    granted: true,
    tool: name,
    reason: "HYDRATED_SAME_ATTEMPT",
    activation: "set-active-tools",
    capability: meta.capability,
    hydrated: [...session.hydrated],
  }
}

// Apply granted hydrations to an advertised list without touching the attempt
// counter. Original order is preserved (stable prefix); hydrated tools are
// appended in deterministic alpha order so base-prefix hashes stay intact.
export function applyHydratedTools(advertised = [], session = {}) {
  const base = unique(advertised)
  const hydrated = unique(session.hydrated).filter((name) => !base.includes(name)).sort((a, b) => a.localeCompare(b))
  return {
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    attemptUnchanged: true,
    base,
    hydrated,
    advertised: [...base, ...hydrated],
    basePrefixIntact: hydrated.every((name) => !base.includes(name)),
  }
}

// Fixed, tiny dispatcher schema descriptor. Its hash must stay stable across
// hydration events (the discovery interface itself never grows).
export function deferredDispatcherSchema() {
  return {
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    interfaceVersion: HYDRATION_INTERFACE_VERSION,
    tool: DEFERRED_DISPATCHER_TOOL,
    actions: ["search", "hydrate"],
    parameters: {
      action: "search|hydrate",
      query: "free-text need (search)",
      tool: "deferred tool name (hydrate)",
      limit: `1..${HARD_DISCOVERY_LIMIT} (search, default ${MAX_DISCOVERY_RESULTS})`,
    },
  }
}

export function dispatcherSchemaFingerprint() {
  return "dispatcher-schema:sha256:" + sha256(JSON.stringify(deferredDispatcherSchema()))
}

export function summarizeDeferredHydration(session = {}) {
  const hydrated = unique(session.hydrated)
  const denied = unique(session.denied)
  return {
    schemaVersion: DISPATCHER_SCHEMA_VERSION,
    interfaceVersion: HYDRATION_INTERFACE_VERSION,
    sameAttempt: true,
    deferredCount: unique(session.deferred).length,
    discoveryCount: Number(session.discoveryCount || 0),
    hydrationRequests: Number(session.hydrationRequests || 0),
    hydrationCount: hydrated.length,
    maxHydrations: Number(session.maxHydrations || DEFAULT_HYDRATION_BUDGET),
    hydrated,
    denied,
    deniedCount: denied.length,
    dispatcherFingerprint: dispatcherSchemaFingerprint(),
  }
}
