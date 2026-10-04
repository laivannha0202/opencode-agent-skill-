// V16.5 Phase 5: Tool Surface V3 (capability prediction + phase-scoped surface).
//
// The model only sees the tools the current task phase needs. A trivial one-file
// fix must not pay the schema tax of browser, service-manager, document-ingestion
// or DeepSeek controls.
//
// Critical separation:
//   hiding a tool from the MODEL is not removing a runtime permission.
// SAFETY_CAPABILITIES below are runtime-enforced regardless of what is
// advertised, and hydration can never grant a side-effect capability without an
// explicit policy check. Permission authority stays in permission-policy.mjs and
// the Pi permission lattice; this module only decides what is model-facing.

import { createHash } from "node:crypto"
import { DEFERRED_DISPATCHER_TOOL, describeDeferredTool } from "./deferred-tool-hydration.mjs"
import { estimateToolSchemaTax } from "./tool-surface-economy.mjs"

export const TOOL_SURFACE_V3_SCHEMA_VERSION = 1
export const PHASES = Object.freeze(["orient", "investigate", "implement", "verify"])
export const DEFAULT_HYDRATION_BUDGET = 4

/**
 * Runtime-enforced capabilities. These are NOT model-facing tools and are never
 * hidden: the surface compiler reports them separately so hiding a tool can never
 * be mistaken for removing a guard.
 */
export const SAFETY_CAPABILITIES = Object.freeze([
  "permission-lattice",
  "workspace-containment",
  "destructive-shell-policy",
  "dirty-work-guard",
  "local-env-write-guard",
  "secret-redaction",
  "execution-ownership",
  "evidence-store",
  "verification-gate",
  "external-side-effect-no-replay",
  "thinking-level-preserved",
])

// Phase -> baseline model-facing tools.
const PHASE_BASELINE = Object.freeze({
  orient: ["read", "grep", "find", "ls"],
  investigate: ["read", "grep", "find", "ls", "ues_code", "bash"],
  implement: ["read", "grep", "edit", "bash", "ues_code_edit"],
  verify: ["read", "grep", "bash", "ues_evidence_get"],
})

// Capability -> concrete tools.
const CAPABILITY_TOOLS = Object.freeze({
  "read-file": ["read"],
  "search-text": ["grep"],
  "find-paths": ["find"],
  "list-directory": ["ls"],
  "run-shell": ["bash"],
  "code-intelligence": ["ues_code"],
  "anchored-edit": ["ues_code_edit"],
  "edit-file": ["edit"],
  "background-service": ["ues_service"],
  "evidence-fetch": ["ues_evidence_get"],
})

// Signal -> capability. Deterministic keyword matching over normalized task text.
const CAPABILITY_SIGNALS = Object.freeze([
  ["browser-automation", ["browser", "playwright", "e2e", "screenshot", "web page", "render", "visual", "responsive breakpoint", "trinh duyet"]],
  ["background-service", ["dev server", "watch mode", "start the server", "listen on port", "long-running service", "serve the app"]],
  // `model` stays here (a code/symbol hint) and was REMOVED from database-access:
  // it is ambiguous, and a default database reading is worse than none.
  ["code-intelligence", ["schema", "migration", "model", "symbol", "definition", "references", "diagnostics", "type error", "where is", "typecheck", "repo map", "architecture of", "dependency graph", "database", "sql", "orm", "prisma", "drizzle", "repository layer"]],
  ["anchored-edit", ["rename", "symbol rename", "refactor symbol", "move the function", "signature change"]],
  ["evidence-fetch", ["previous output", "full output", "truncated", "earlier evidence", "recall the evidence", "evidence ref"]],
  ["diagnostics", ["type error", "typecheck", "diagnostics", "lint error", "build error"]],
  ["deepseek-advisor", ["hard uncertainty", "second opinion", "adversarial review", "root cause analysis", "architecture trade-off"]],
  ["document-ingestion", ["pdf", "docx", "xlsx", "spreadsheet", "office document"]],
  // V16.6.1: `model` alone no longer implies a database. The disambiguating
  // terms are the ones that actually indicate a data layer; a bare "model"
  // belongs to code intelligence, and repository structure has the last word.
  ["database-access", ["query plan", "transaction", "sql migration", "add a column", "create a table", "index on", "orm", "prisma", "drizzle"]],
])

// Task-shape -> phase. Explicit phase wins.
const PHASE_SIGNALS = Object.freeze([
  ["implement", ["implement", "fix", "add", "create", "refactor", "update", "change", "write", "sua", "them", "tao", "viet"]],
  ["verify", ["verify", "run the tests", "prove", "confirm", "check the fix", "test suite", "kiem chung", "chay test"]],
  ["investigate", ["investigate", "diagnose", "debug", "why", "root cause", "find out", "trace", "debugger", "loi", "nguyen nhan"]],
  ["orient", ["where", "list", "show me", "find files", "map", "survey", "overview", "o dau", "liet ke"]],
])

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim()
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

function phaseFor(text, requested) {
  if (requested && PHASES.includes(String(requested))) return String(requested)
  let best = "investigate"
  let bestHits = 0
  for (const [phase, signals] of PHASE_SIGNALS) {
    const hits = signals.filter((signal) => text.includes(signal)).length
    if (hits > bestHits) {
      best = phase
      bestHits = hits
    }
  }
  return bestHits > 0 ? best : "investigate"
}

/** Predict the capabilities a task phase needs, with the signals that justify them. */
export function predictCapabilities(input = {}) {
  const text = normalize(input.task)
  const phase = phaseFor(text, input.phase)
  const capabilities = []
  const signals = []

  // V16.6.1 EVIDENCE-FIRST capability routing.
  //
  // V16.6 routed purely on task keywords, which produced two concrete wrong
  // answers: "model" was a keyword for BOTH `code-intelligence` and
  // `database-access`, so "refactor the AI model layer" advertised a database
  // capability; and a task text that merely CONTAINS a signal word could
  // outrank what the run had already observed.
  //
  // Priority is now: (1) observed runtime/verifier evidence, (2) repository /
  // file / symbol structure, (3) phase, (4) task text. Text stays the
  // deterministic fallback; nothing here is learned or probabilistic.
  const evidenceCaps = new Set();
  for (const row of Array.isArray(input.runtimeEvidence) ? input.runtimeEvidence : []) {
    const kind = String(row?.kind || "").toLowerCase();
    if (kind === "hydration-error" || kind === "verification-failure" || kind === "test-failure") evidenceCaps.add("code-intelligence");
    if (kind === "compile-error" || kind === "type-error" || kind === "diagnostics") {
      evidenceCaps.add("diagnostics");
      evidenceCaps.add("code-intelligence");
    }
    if (kind === "tool-not-found" || kind === "unknown-tool") evidenceCaps.add("evidence-fetch");
    if (kind === "browser-failure" || kind === "selector-drift") evidenceCaps.add("browser-automation");
  }
  if (Number(input.toolSelectionErrors) > 0) evidenceCaps.add("code-intelligence");
  if (Number(input.toolSelectionErrors) >= 2) evidenceCaps.add("diagnostics");
  if (Number(input.verifierFailures) > 0) evidenceCaps.add("code-intelligence");

  const structuralCaps = new Set();
  const touched = unique([
    ...(Array.isArray(input.changedFiles) ? input.changedFiles : []),
    ...(Array.isArray(input.relevantFiles) ? input.relevantFiles : []),
  ]).map((row) => String(row?.path ?? row ?? "").toLowerCase().replaceAll(String.fromCharCode(92), "/"));
  for (const file of touched) {
    if (/(sql|prisma|schema\.graphql)$/.test(file) || /(^|\/)(migrations?|db|database)\//.test(file)) structuralCaps.add("database-access");
    if (/\.(tsx?|jsx?|vue|svelte|css|scss|html)$/.test(file)) structuralCaps.add("browser-automation");
    if (/(^|\/)(tests?|specs?)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) structuralCaps.add("diagnostics");
    if (/(^|\/)(scripts?|tools?)\//.test(file)) structuralCaps.add("background-service");
  }
  if (Array.isArray(input.symbols) && input.symbols.length) structuralCaps.add("code-intelligence");
  if (Number(input.affectedSubsystems) > 0) structuralCaps.add("code-intelligence");
  if (Array.isArray(input.dependencyGraph) && input.dependencyGraph.length) structuralCaps.add("code-intelligence");

  const textCaps = new Set();
  for (const [capability, tokens] of CAPABILITY_SIGNALS) {
    const hits = tokens.filter((token) => text.includes(token));
    if (!hits.length) continue;
    textCaps.add(capability);
    signals.push({ capability, signals: hits });
  }

  const ordered = [];
  for (const capability of [...evidenceCaps, ...structuralCaps, ...textCaps]) {
    if (ordered.includes(capability)) continue;
    ordered.push(capability);
    signals.push({
      capability,
      signals: evidenceCaps.has(capability)
        ? ["runtime-evidence"]
        : structuralCaps.has(capability)
          ? ["repository-structure"]
          : ["task-text"],
    });
  }
  capabilities.push(...ordered);

  const needsWriter = phase === "implement"
  const needsVerification = phase === "verify" || input.verificationRequired === true
  const baseline = new Set([...(PHASE_BASELINE[phase] || PHASE_BASELINE.investigate)])
  if (needsWriter && !baseline.has("edit")) baseline.add("edit")
  if (needsVerification && !baseline.has("bash")) baseline.add("bash")

  const tools = unique([
    ...[...baseline],
    ...capabilities.flatMap((capability) => CAPABILITY_TOOLS[capability] || []),
  ])
  return {
    schemaVersion: TOOL_SURFACE_V3_SCHEMA_VERSION,
    phase,
    capabilities: unique(capabilities),
    signals,
    baselineTools: [...baseline],
    predictedTools: tools,
    safetyCapabilities: [...SAFETY_CAPABILITIES],
  }
}

/**
 * Compile the model-facing surface for one task phase.
 * `universe` is the full set of tools the host Pi session offers; `denied` is the
 * policy-denied set (already enforced upstream) and is never advertised or hydrated.
 */
export function compilePhaseToolSurface(input = {}) {
  const universe = unique(input.universe)
  const denied = new Set(unique(input.denied))
  const prediction = input.prediction || predictCapabilities(input)
  const profileLimit = Math.max(2, Math.min(universe.length || 1, Number(input.maxAdvertisedTools) || 8))

  const preferred = unique([
    ...prediction.predictedTools,
    ...unique(input.priorityTools),
  ]).filter((tool) => universe.includes(tool) && !denied.has(tool))

  // Host-provided capability tools (browser/MCP) are not a fixed name list, so
  // they are resolved through the same capability vocabulary as hydration.
  const predictedCapabilities = new Set(prediction.capabilities)
  const capabilityTools = universe.filter((tool) => {
    if (preferred.includes(tool)) return false
    return predictedCapabilities.has(describeDeferredTool(tool).capability)
  })

  const advertised = unique([...preferred, ...capabilityTools]).slice(0, profileLimit)
  const deferred = universe.filter((tool) => !advertised.includes(tool) && !denied.has(tool))
  const withheld = universe.filter((tool) => !advertised.includes(tool) && denied.has(tool))
  const dispatcherPresent = deferred.length > 0 && universe.includes(DEFERRED_DISPATCHER_TOOL) && !advertised.includes(DEFERRED_DISPATCHER_TOOL)

  const surface = {
    schemaVersion: TOOL_SURFACE_V3_SCHEMA_VERSION,
    phase: prediction.phase,
    advertised,
    deferred,
    denied: [...denied].sort(),
    hydrationDispatcher: dispatcherPresent ? DEFERRED_DISPATCHER_TOOL : null,
    safetyEnforced: [...SAFETY_CAPABILITIES],
    // Explicit invariant: a hidden tool is still policy-checked at execution.
    hiddenToolsRemainPolicyChecked: true,
    sideEffectHydrationRequiresPolicyCheck: true,
    capabilities: unique([
      ...prediction.capabilities,
      ...advertised.flatMap((tool) => {
        const meta = describeDeferredTool(tool)
        return [meta.capability]
      }),
    ]),
    deniedCapabilities: withheld
      .map((tool) => {
        const meta = describeDeferredTool(tool)
        return { tool, capability: meta.capability, writerOnly: meta.writerOnly === true }
      })
      .filter((row, index, rows) => rows.findIndex((other) => other.capability === row.capability) === index),
    deferredCapabilities: deferred
      .filter((tool) => tool !== DEFERRED_DISPATCHER_TOOL)
      .map((tool) => {
        const meta = describeDeferredTool(tool)
        return { tool, capability: meta.capability, writerOnly: meta.writerOnly === true }
      })
      .filter((row, index, rows) => rows.findIndex((other) => other.capability === row.capability) === index),
    counts: {
      toolsAvailable: universe.length,
      toolsAdvertised: advertised.length,
      toolsDeferred: deferred.length,
      toolsDenied: denied.size,
    },
    fingerprint: "tool-surface-v3:sha256:" + hash([universe.sort(), advertised, deferred, prediction.phase]),
  }
  surface.schemaTax = estimateToolSchemaTax(advertised)
  surface.toolSurfaceChars = surface.schemaTax.estimatedChars
  surface.telemetry = {
    toolsAvailable: universe.length,
    toolsAdvertised: advertised.length,
    toolSurfaceChars: surface.schemaTax.estimatedChars,
    toolHydrations: 0,
    unusedAdvertisedTools: null,
    toolSelectionErrors: 0,
    schemaTaxEvidence: surface.schemaTax.evidence,
  }
  return surface
}

export const HYDRATION_DENY_REASON = Object.freeze({
  UNKNOWN_CAPABILITY: "UNKNOWN_CAPABILITY",
  ALREADY_ADVERTISED: "ALREADY_ADVERTISED",
  ALREADY_HYDRATED: "ALREADY_HYDRATED",
  POLICY_DENIED: "POLICY_DENIED",
  SIDE_EFFECT_REQUIRES_POLICY: "SIDE_EFFECT_REQUIRES_POLICY",
  NO_EVIDENCE: "NO_EVIDENCE",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
})

/**
 * Request exactly one deferred capability.
 *
 * A grant only makes the tool model-facing; execution still flows through every
 * existing guard. Grants are per-surface (never permanent tool loss) and a
 * capability can be hydrated only once per surface.
 */
export function hydrateCapability(surface, request = {}) {
  if (!surface || !Array.isArray(surface.advertised)) throw new Error("hydrateCapability requires a compiled surface")
  const capability = String(request.capability || "").trim()
  const session = surface.hydration || {
    hydrated: [],
    denied: [],
    requests: 0,
    maxHydrations: Math.max(1, Math.min(8, Number(request.maxHydrations) || DEFAULT_HYDRATION_BUDGET)),
    grantLog: [],
  }
  surface.hydration = session
  session.requests += 1

  const receiptBase = {
    schemaVersion: TOOL_SURFACE_V3_SCHEMA_VERSION,
    capability,
    request: session.requests,
    permanentToolLoss: false,
    permissionRemoved: false,
    policyChecked: true,
    safetyEnforced: surface.safetyEnforced,
  }
  const deny = (reason, detail) => {
    const receipt = {
      ...receiptBase,
      granted: false,
      reason,
      detail: detail || null,
      receiptId: "hydrate:sha256:" + hash([surface.fingerprint, capability, reason, session.requests]),
    }
    session.denied = unique([...session.denied, capability])
    session.grantLog.push(receipt)
    return receipt
  }

  if (!capability) return deny(HYDRATION_DENY_REASON.UNKNOWN_CAPABILITY)
  if (request.evidence === undefined || request.evidence === null || String(request.evidence).trim() === "") {
    return deny(HYDRATION_DENY_REASON.NO_EVIDENCE)
  }
  if (session.hydrated.includes(capability)) return deny(HYDRATION_DENY_REASON.ALREADY_HYDRATED)

  const deniedEntry = (surface.deniedCapabilities || []).find((row) => row.capability === capability)
  if (deniedEntry) return deny(HYDRATION_DENY_REASON.POLICY_DENIED, deniedEntry.tool)

  const advertisedTool = surface.advertised.find((tool) => describeDeferredTool(tool).capability === capability)
  if (advertisedTool) return deny(HYDRATION_DENY_REASON.ALREADY_ADVERTISED, advertisedTool)

  const entry = (surface.deferredCapabilities || []).find((row) => row.capability === capability)
  if (!entry) return deny(HYDRATION_DENY_REASON.UNKNOWN_CAPABILITY, "capability is not in the deferred set")
  if (entry.writerOnly === true && request.allowSideEffectHydration !== true) {
    return deny(HYDRATION_DENY_REASON.SIDE_EFFECT_REQUIRES_POLICY, entry.tool)
  }
  if (session.hydrated.length >= session.maxHydrations) return deny(HYDRATION_DENY_REASON.BUDGET_EXHAUSTED)

  session.hydrated = unique([...session.hydrated, capability])
  surface.advertised = [...surface.advertised, entry.tool]
  surface.deferred = surface.deferred.filter((tool) => tool !== entry.tool)
  surface.deferredCapabilities = surface.deferredCapabilities.filter((row) => row.capability !== capability)
  surface.counts.toolsAdvertised = surface.advertised.length
  surface.counts.toolsDeferred = surface.deferred.length
  const tax = estimateToolSchemaTax(surface.advertised)
  surface.schemaTax = tax
  surface.toolSurfaceChars = tax.estimatedChars
  surface.telemetry.toolsAdvertised = surface.advertised.length
  surface.telemetry.toolSurfaceChars = tax.estimatedChars
  surface.telemetry.toolHydrations = session.hydrated.length

  const receipt = {
    ...receiptBase,
    granted: true,
    tool: entry.tool,
    reason: "HYDRATED_ON_EVIDENCE",
    receiptId: "hydrate:sha256:" + hash([surface.fingerprint, capability, "granted", session.requests]),
  }
  session.grantLog.push(receipt)
  return receipt
}

/** Finalize a surface against observed tool usage. Missing data stays explicit. */
export function finalizeToolSurfaceTelemetry(surface, usage = {}) {
  const used = unique(usage.toolsUsed)
  const advertised = surface.advertised
  const unused = advertised.filter((tool) => !used.includes(tool))
  surface.telemetry = {
    ...surface.telemetry,
    toolsUsed: used.length,
    unusedAdvertisedTools: used.length ? unused.length : null,
    unusedAdvertisedToolNames: used.length ? unused : null,
    toolSelectionErrors: Number(usage.toolSelectionErrors ?? surface.telemetry.toolSelectionErrors ?? 0),
  }
  return surface.telemetry
}

export function summarizeHydration(surface) {
  const session = surface?.hydration || { hydrated: [], denied: [], requests: 0, grantLog: [] }
  return {
    schemaVersion: TOOL_SURFACE_V3_SCHEMA_VERSION,
    requests: session.requests,
    hydrated: [...(session.hydrated || [])],
    denied: [...(session.denied || [])],
    granted: (session.grantLog || []).filter((row) => row.granted).length,
    rejected: (session.grantLog || []).filter((row) => !row.granted).length,
    receipts: session.grantLog || [],
  }
}
