// V16.10 Semantic Tool Router.
//
// WHY THIS MODULE EXISTS
//
// V16.2 owns the advertised tool SURFACE (`compileToolSurface`) and the
// deferred/hydration contract; V16.5 owns phase priority (`phaseToolPriorities`).
// Neither answers the question a run actually has at the moment it decides what
// to do next: "for THIS intent, which of the tools I already have is the RIGHT
// one, and why?". Today that choice is left to the model, and a weak model
// reaching for `bash` to read a file, or `read` to search a repository, is the
// single most expensive routing mistake the runtime can make.
//
// This module is a DETERMINISTIC ranker. It is NOT a second surface owner: it
// can never ADD a tool that `compileToolSurface` withheld, it can never advertise
// a denied tool, and it never makes a network or model call. It consumes the
// existing capability vocabulary (`describeDeferredTool`), the existing
// capability predictor (`predictCapabilities`) and the existing intent detector
// (`detectIntent`), and produces a ranked, explained plan.
//
// "Semantic" here means: a task expressed in words is matched to tools by
// CAPABILITY and PURPOSE keywords plus a small deterministic synonym table -
// never by an embedding, never by a model, never by a network call. That is a
// deliberate constraint: routing must be reproducible and inspectable, and a
// mis-route must be explainable from the published reasons.
//
// GUARANTEES
//
//   * ONE OWNER: this module ranks. `compileToolSurface` still decides the final
//     advertised set; the router's `ordered` is an ORDERING over a universe the
//     caller already owns, filtered to that universe.
//   * NEVER WIDENS: `routeToolIntent` filters to `universe` and drops `denied`.
//     `assertRouteRespectsDenied` proves it for a given plan.
//   * WRITER SAFETY: a `writerOnly` tool is only ever ranked for a writer run.
//   * EXPLAINABLE: every ranked tool carries the reasons it scored what it did.
//   * HONEST CONFIDENCE: confidence is DERIVED from score margins, never a
//     fabricated probability.

import { describeDeferredTool, DEFERRED_DISPATCHER_TOOL } from "./deferred-tool-hydration.mjs"
import { predictCapabilities } from "./tool-surface-v3.mjs"
import { detectIntent, normalizeTask } from "./skill-router.mjs"
import { measured, derived, NOT_MEASURED } from "./measurement-provenance.mjs"

export const TOOL_ROUTER_SCHEMA_VERSION = 1
export const TOOL_ROUTER_POLICY = "semantic-tool-router-v16-10"

/**
 * The routing intents the runtime recognizes. Each maps to the capabilities a
 * correct tool for that intent must expose. This table is the ONE place the
 * intent->capability law lives.
 */
export const ROUTE_INTENT = Object.freeze({
  INSPECT_FILE: "inspect-file",
  LOCATE_CODE: "locate-code",
  EDIT_CODE: "edit-code",
  CREATE_FILE: "create-file",
  RUN_VERIFY: "run-verify",
  FETCH_EVIDENCE: "fetch-evidence",
  MANAGE_SERVICE: "manage-service",
  BROWSE_WEB: "browse-web",
  LIST_STRUCTURE: "list-structure",
})

export const INTENT_CAPABILITIES = Object.freeze({
  [ROUTE_INTENT.INSPECT_FILE]: ["read-file", "code-intelligence"],
  [ROUTE_INTENT.LOCATE_CODE]: ["search-text", "code-intelligence", "find-paths"],
  [ROUTE_INTENT.EDIT_CODE]: ["edit-file", "anchored-edit"],
  [ROUTE_INTENT.CREATE_FILE]: ["write-file", "edit-file"],
  [ROUTE_INTENT.RUN_VERIFY]: ["run-shell"],
  [ROUTE_INTENT.FETCH_EVIDENCE]: ["evidence-fetch"],
  [ROUTE_INTENT.MANAGE_SERVICE]: ["background-service"],
  [ROUTE_INTENT.BROWSE_WEB]: ["browser-automation", "mcp-capability"],
  [ROUTE_INTENT.LIST_STRUCTURE]: ["list-directory", "find-paths"],
})

/**
 * Deterministic synonym expansion. A task says "refactor"; the tool says
 * "rename"/"anchored"/"edit". Without this table the router would miss the
 * obvious match. It is small, curated and versioned - not learned.
 */
export const ROUTE_SYNONYMS = Object.freeze({
  read: ["view", "open", "cat", "show", "inspect", "look", "xem", "đọc"],
  search: ["grep", "find", "locate", "query", "where", "tim", "tìm", "kiếm"],
  edit: ["modify", "change", "patch", "fix", "refactor", "rename", "sua", "sửa"],
  create: ["new", "add", "generate", "scaffold", "write", "tao", "tạo"],
  run: ["test", "build", "lint", "typecheck", "verify", "check", "exec", "chay", "chạy"],
  evidence: ["ref", "compacted", "truncated", "full", "output", "bang", "bằng"],
  service: ["server", "dev server", "watch", "port", "listen", "background"],
  browser: ["playwright", "visual", "screenshot", "e2e", "web page", "ui"],
  structure: ["inventory", "tree", "directory", "folder", "layout", "cau truc", "cấu trúc"],
})

const INTENT_SIGNALS = Object.freeze([
  { intent: ROUTE_INTENT.INSPECT_FILE, tokens: ["read", "open", "view", "show", "inspect", "cat", "content", "line", "xem", "đọc", "noi dung", "nội dung"] },
  { intent: ROUTE_INTENT.LOCATE_CODE, tokens: ["search", "grep", "find", "locate", "where", "query", "symbol", "definition", "reference", "tim", "tìm", "kiếm"] },
  { intent: ROUTE_INTENT.EDIT_CODE, tokens: ["edit", "modify", "change", "patch", "fix", "refactor", "rename", "update", "sua", "sửa", "chinh", "chỉnh"] },
  { intent: ROUTE_INTENT.CREATE_FILE, tokens: ["create", "add", "new file", "generate", "scaffold", "write file", "tao", "tạo", "them file", "thêm file"] },
  { intent: ROUTE_INTENT.RUN_VERIFY, tokens: ["run", "test", "build", "lint", "typecheck", "verify", "check", "npm", "pnpm", "yarn", "pytest", "compile", "chay", "chạy", "kiem", "kiểm"] },
  { intent: ROUTE_INTENT.FETCH_EVIDENCE, tokens: ["evidence", "ref", "compacted", "truncated", "full output", "retrieve", "bang", "bằng"] },
  { intent: ROUTE_INTENT.MANAGE_SERVICE, tokens: ["service", "server", "dev server", "watch", "port", "listen", "serve", "nestjs", "vite", "next dev"] },
  { intent: ROUTE_INTENT.BROWSE_WEB, tokens: ["browser", "playwright", "visual", "screenshot", "e2e", "web page", "ui", "frontend"] },
  { intent: ROUTE_INTENT.LIST_STRUCTURE, tokens: ["list", "directory", "folder", "structure", "inventory", "tree", "architecture", "module", "cau truc", "cấu trúc"] },
])

function tokenize(text) {
  return [...new Set(normalizeTask(text).split(/[^a-z0-9_+.-]+/).map((token) => token.trim()).filter((token) => token.length >= 2))].slice(0, 40)
}

/**
 * Classify a task into ranked intents. Deterministic: it reads task tokens and,
 * only when they are silent, the predicted capabilities. Never a model call.
 */
export function classifyRouteIntents(input = {}) {
  const text = String(input.task || "")
  const tokens = tokenize(text)
  const tokenSet = new Set(tokens)
  const capabilitySignals = new Set(predictCapabilities(input).capabilities)
  const rows = []
  for (const { intent, tokens: signals } of INTENT_SIGNALS) {
    // A single-word signal must match a WHOLE token; only a multi-word phrase may
    // be matched as a substring. Substring matching on a short token produced a
    // real false positive: "ui" matched inside "bUIldRepoMap", which routed a
    // symbol lookup to the browser lane.
    const hits = signals.filter((signal) =>
      signal.includes(" ") ? text.toLowerCase().includes(signal) : tokenSet.has(signal),
    )
    if (hits.length) rows.push({ intent, score: hits.length * 10, hits })
  }
  // Capability fallback: no token matched but the capability predictor fired.
  if (!rows.length) {
    if (capabilitySignals.has("code-intelligence")) rows.push({ intent: ROUTE_INTENT.LOCATE_CODE, score: 5, hits: ["capability:code-intelligence"] })
    if (capabilitySignals.has("read-file")) rows.push({ intent: ROUTE_INTENT.INSPECT_FILE, score: 4, hits: ["capability:read-file"] })
    if (capabilitySignals.has("run-shell")) rows.push({ intent: ROUTE_INTENT.RUN_VERIFY, score: 4, hits: ["capability:run-shell"] })
  }
  rows.sort((a, b) => b.score - a.score || a.intent.localeCompare(b.intent))
  return {
    schemaVersion: TOOL_ROUTER_SCHEMA_VERSION,
    intents: rows.map((row) => row.intent),
    ranked: rows,
    language: detectIntent(text).language,
    taskClasses: detectIntent(text).taskClasses,
    provenance: rows.length ? derived(rows.length) : NOT_MEASURED,
  }
}

/** Build the set of search tokens for a task, with synonyms expanded. */
function expandedTokens(task) {
  const base = tokenize(task)
  const expanded = new Set(base)
  for (const token of base) {
    for (const [canonical, synonyms] of Object.entries(ROUTE_SYNONYMS)) {
      if (token === canonical || synonyms.includes(token)) {
        expanded.add(canonical)
        for (const synonym of synonyms) expanded.add(synonym)
      }
    }
  }
  return [...expanded]
}

function capabilityScore(meta, intents) {
  let score = 0
  const reasons = []
  // The FIRST intent dominates. An ambiguous task ("find where X is defined"
  // matched locate-code, run-verify and browse-web) must not let a later, weaker
  // intent pull an unrelated tool up beside the right one. Rank decay makes the
  // top intent worth strictly more than all lower intents combined.
  intents.forEach((intent, index) => {
    const wanted = INTENT_CAPABILITIES[intent.intent] || []
    if (!wanted.includes(meta.capability)) return
    const decay = 1 / (1 + index * 1.2)
    const points = (100 + intent.score) * decay
    score += points
    reasons.push(`capability:${meta.capability}@${intent.intent}`)
  })
  return { score, reasons }
}

function keywordScore(meta, tokens) {
  const haystack = [
    String(meta.tool || "").toLowerCase(),
    String(meta.capability || "").toLowerCase(),
    String(meta.purpose || "").toLowerCase(),
    ...(meta.keywords || []).map((keyword) => String(keyword).toLowerCase()),
  ].join(" ")
  let score = 0
  const reasons = []
  for (const token of tokens) {
    if (!token || token.length < 2) continue
    if (String(meta.tool || "").toLowerCase() === token) {
      score += 60
      reasons.push(`exact-tool:${token}`)
    } else if (haystack.includes(token)) {
      score += 18
      reasons.push(`keyword:${token}`)
    }
  }
  return { score, reasons }
}

/**
 * Rank every tool in `universe` for the task. Pure and deterministic.
 *
 * Returns rows ordered best-first. Writer-only tools are excluded unless
 * `writer === true`; denied tools are excluded always. A tool the caller did not
 * put in `universe` can never appear - the router cannot widen the surface.
 */
export function rankCandidateTools(input = {}) {
  const universe = [...new Set((input.universe || []).map(String).filter(Boolean))]
  const denied = new Set((input.denied || []).map(String))
  const writer = input.writer === true
  const classification = input.classification || classifyRouteIntents(input)
  const intents = classification.ranked || []
  const tokens = expandedTokens(input.task || "")
  const phaseTools = new Set((input.phaseTools || []).map(String))

  const rows = []
  for (const tool of universe) {
    if (denied.has(tool)) continue
    const meta = describeDeferredTool(tool)
    if (meta.writerOnly === true && !writer) continue
    const capability = capabilityScore(meta, intents)
    const keyword = keywordScore(meta, tokens)
    let score = capability.score + keyword.score
    const reasons = [...capability.reasons, ...keyword.reasons]
    if (phaseTools.has(tool)) {
      score += 40
      reasons.push("phase-priority")
    }
    if (tool === DEFERRED_DISPATCHER_TOOL) {
      // The dispatcher is a discovery interface, not a task tool: it ranks last
      // among positives and never outranks a concrete match.
      score = Math.min(score, 1)
      reasons.push("discovery-dispatcher")
    }
    if (score <= 0) continue
    rows.push({ tool, capability: meta.capability, writerOnly: meta.writerOnly === true, score, reasons })
  }
  rows.sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))
  return rows
}

/**
 * The routing entry point. Produces an ordered plan plus a primary choice, a
 * bounded fallback chain and honest confidence.
 */
export function routeToolIntent(input = {}) {
  const classification = classifyRouteIntents(input)
  const ranked = rankCandidateTools({ ...input, classification })
  const universe = [...new Set((input.universe || []).map(String).filter(Boolean))]
  const denied = new Set((input.denied || []).map(String))
  const limit = Math.max(1, Math.min(16, Math.trunc(Number(input.limit || 8)) || 8))
  const ordered = ranked.slice(0, limit).map((row) => row.tool)
  const primary = ordered[0] || null

  // Confidence is DERIVED from the score margin between the top two candidates,
  // never fabricated. A tie is reported as a tie.
  let confidence = "none"
  let margin = null
  if (ranked.length >= 1) {
    margin = ranked.length >= 2 ? ranked[0].score - ranked[1].score : ranked[0].score
    if (ranked.length === 1 || margin >= 60) confidence = "high"
    else if (margin >= 20) confidence = "medium"
    else confidence = "low"
  }

  return {
    schemaVersion: TOOL_ROUTER_SCHEMA_VERSION,
    policy: TOOL_ROUTER_POLICY,
    task: String(input.task || ""),
    intents: classification.intents,
    ordered,
    primary,
    fallbackChain: ordered.slice(1),
    ranked: ranked.slice(0, limit),
    confidence,
    margin,
    deniedTools: [...denied].sort(),
    // The router can only order tools the caller owns.
    universeCount: universe.length,
    routedCount: ordered.length,
    widened: false,
    deterministic: true,
    provenance: { confidence: ranked.length ? derived(margin ?? 0) : NOT_MEASURED, universe: measured(universe.length) },
  }
}

/**
 * The invariant that matters: a route plan must never contain a tool outside the
 * caller's universe and must never contain a denied tool. Returns the violations
 * so a caller can fail closed.
 */
export function assertRouteRespectsDenied(plan = {}, universe = [], denied = []) {
  const universeSet = new Set((universe || []).map(String))
  const deniedSet = new Set((denied || []).map(String))
  const tools = plan.ordered || []
  const outsideUniverse = tools.filter((tool) => !universeSet.has(tool))
  const deniedPresent = tools.filter((tool) => deniedSet.has(tool))
  return {
    ok: outsideUniverse.length === 0 && deniedPresent.length === 0,
    outsideUniverse,
    deniedPresent,
    checked: tools.length,
  }
}

/**
 * Merge a route plan into the V16.2 priority list WITHOUT widening it. The
 * returned list is a reordering of `priorities ∪ routedTools`, intersected with
 * the universe and with `denied` removed. `compileToolSurface` remains the
 * authority that trims it to the advertised limit.
 */
export function mergeRouteIntoPriorities(priorities = [], plan = {}, universe = [], denied = []) {
  const universeSet = new Set((universe || []).map(String))
  const deniedSet = new Set((denied || []).map(String))
  const seen = new Set()
  const merged = []
  for (const tool of [...(plan.ordered || []), ...priorities]) {
    const name = String(tool)
    if (!universeSet.has(name) || deniedSet.has(name) || seen.has(name)) continue
    seen.add(name)
    merged.push(name)
  }
  return merged
}

export const semanticToolRouterExports = Object.freeze({
  routeToolIntent,
  rankCandidateTools,
  classifyRouteIntents,
  assertRouteRespectsDenied,
  mergeRouteIntoPriorities,
  ROUTE_INTENT,
  INTENT_CAPABILITIES,
})
