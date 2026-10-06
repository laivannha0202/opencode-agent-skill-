import { createHash } from "node:crypto"
import { constants as FS_CONSTANTS, realpathSync, statSync } from "node:fs"
import { access, stat } from "node:fs/promises"
import path from "node:path"
import { Worker } from "node:worker_threads"
import { fileURLToPath, pathToFileURL } from "node:url"
import { captureWorkspaceStateV2 } from "./workspace-fingerprint.mjs"
import { resolveGitWorkspaceRoot } from "./workspace-root.mjs"

export const V16_8_BARRIER_SCHEMA_VERSION = 1
export const V16_8_CAPSULE_MAX_CHARS = 1_200
// Reserve room for the short trust/authority envelope rendered around JSON.
export const V16_8_CAPSULE_JSON_MAX_CHARS = 1_100
export const V16_8_PHASE0_TARGET_MS = 300
export const V16_8_PHASE0_HARD_BUDGET_MS = 1_000
export const V16_8_DEFAULT_SOFT_DEADLINE_MS = 20_000
export const V16_8_DEFAULT_HARD_DEADLINE_MS = 35_000

const GENERATED_SEGMENTS = new Set([
  "dist", "build", "coverage", "generated", "__generated__", ".generated", "vendor",
])
const TEST_PATH_RE = /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|\.(?:test|spec|e2e-spec)\.[cm]?[jt]sx?$/i

function nowMs(now) {
  return typeof now === "function" ? Number(now()) : Date.now()
}

function boundedText(value, maxChars) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, Math.max(0, maxChars))
  return text.slice(0, maxChars - 1).trimEnd() + "…"
}

function boundedList(rows, { limit, itemChars }) {
  const source = Array.isArray(rows) ? rows : []
  return [...new Set(source.map((row) => boundedText(row, itemChars)).filter(Boolean))].slice(0, limit)
}

function hashParts(...parts) {
  return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\u0000")).digest("hex").slice(0, 32)
}

function normalizeRelative(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return null
  const normalized = path.posix.normalize(raw)
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null
  return normalized
}

function rawCandidateValues(input = {}) {
  const values = []
  for (const row of input.knownFiles || []) values.push(typeof row === "string" ? row : row?.path)
  for (const row of input.relevantFiles || input.files || []) values.push(typeof row === "string" ? row : row?.path)
  return values.map((value) => String(value || "").trim()).filter(Boolean)
}

function candidateFiles(input = {}) {
  return [...new Set(rawCandidateValues(input).map(normalizeRelative).filter(Boolean))].slice(0, 64)
}

function hasInvalidCandidate(input = {}) {
  return rawCandidateValues(input).some((value) => normalizeRelative(value) === null)
}

function errorEvidence(input = {}) {
  const rows = Array.isArray(input.evidence) ? input.evidence : Array.isArray(input.failingEvidence) ? input.failingEvidence : []
  const candidate = rows.find((row) => /(?:error|failure|diagnostic|verifier|test)/i.test(String(row?.kind || row?.source || ""))) || rows[0]
  return boundedText(typeof candidate === "string" ? candidate : candidate?.text || candidate?.message || "", 900)
}

/**
 * Phase 0 is deliberately tiny: it only shapes facts the caller already has.
 * No repository walk, AST parse, test runner or provider call is allowed here.
 */
export function phase0FastGrounding(input = {}, options = {}) {
  const startedAt = nowMs(options.now)
  const files = candidateFiles(input)
  const failureSnippet = boundedText(errorEvidence(input) || input.failureSnippet || input.notes || "", 900)
  const primaryError = boundedText(input.primaryError || failureSnippet.split(/\r?\n/)[0] || "", 320)
  const activeFile = normalizeRelative(input.activeFile) || files[0] || null
  const task = boundedText(input.task || input.originalTask || "", 1_200)
  const finishedAt = nowMs(options.now)
  return {
    schemaVersion: V16_8_BARRIER_SCHEMA_VERSION,
    kind: "ues-v16-8-phase0",
    task,
    primaryError,
    activeFile,
    failureSnippet,
    knownFiles: files,
    taskFingerprint: hashParts(task, primaryError, activeFile || "", files.join("|")),
    durationMs: Math.max(0, finishedAt - startedAt),
    targetMs: V16_8_PHASE0_TARGET_MS,
    hardBudgetMs: V16_8_PHASE0_HARD_BUDGET_MS,
    withinTarget: Math.max(0, finishedAt - startedAt) <= V16_8_PHASE0_TARGET_MS,
    withinHardBudget: Math.max(0, finishedAt - startedAt) <= V16_8_PHASE0_HARD_BUDGET_MS,
  }
}

function verifiedCandidateRoot(candidate, files) {
  if (!candidate) return null
  const resolved = resolveGitWorkspaceRoot(candidate)
  const root = resolved?.ok === true && resolved.root ? path.resolve(resolved.root) : null
  if (!root) return null
  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  for (const relative of files) {
    const target = path.resolve(root, ...relative.split("/"))
    if (!(target === root || target.startsWith(root + path.sep))) return null
    try {
      const info = statSync(target)
      if (!info.isFile()) return null
      const realTarget = realpathSync(target)
      if (!(realTarget === realRoot || realTarget.startsWith(realRoot + path.sep))) return null
    } catch {
      return null
    }
  }
  return root
}

/**
 * Production normally starts Pi from the repository. An explicit workspaceRoot
 * wins; otherwise process.cwd() is accepted only when every grounded file is
 * proven to exist inside that Git root. If proof is unavailable, the barrier is
 * marked NOT_APPLICABLE rather than inventing a root.
 */
export function resolveBarrierWorkspaceRoot(input = {}, options = {}) {
  const files = candidateFiles(input)
  const invalid = hasInvalidCandidate(input)
  const explicit = options.workspaceRoot || input.workspaceRoot || null
  if (explicit) {
    return {
      root: invalid ? null : verifiedCandidateRoot(explicit, files),
      source: invalid ? "invalid-grounded-path" : "explicit",
      required: true,
    }
  }
  if (invalid) return { root: null, source: "invalid-grounded-path", required: false }
  const inferred = verifiedCandidateRoot(process.cwd(), files)
  return {
    root: inferred,
    source: inferred ? "process-cwd-verified" : "unavailable",
    required: false,
  }
}

export function captureBarrierFingerprint(root) {
  if (!root) return { available: false, fingerprint: null, head: null, changedFiles: [], reason: "workspace-root-unavailable" }
  try {
    const state = captureWorkspaceStateV2(root, { includeDiffOutput: false })
    if (!state?.fingerprint) return { available: false, fingerprint: null, head: String(state?.head || "unknown"), changedFiles: [], reason: "workspace-fingerprint-unavailable" }
    return {
      available: true,
      fingerprint: String(state.fingerprint),
      head: String(state.head || "unknown"),
      changedFiles: (state.changedFiles || []).map((row) => String(row?.path || row)).filter(Boolean),
      reason: null,
    }
  } catch {
    return { available: false, fingerprint: null, head: null, changedFiles: [], reason: "workspace-fingerprint-error" }
  }
}

function generatedReason(relative) {
  const normalized = normalizeRelative(relative)
  if (!normalized) return "invalid-path"
  const parts = normalized.toLowerCase().split("/")
  if (parts.some((part) => GENERATED_SEGMENTS.has(part))) return "generated-path"
  if (/(?:^|[._-])generated(?:[._-]|$)/i.test(path.posix.basename(normalized))) return "generated-file"
  return null
}

async function inspectFile(root, relative) {
  const normalized = normalizeRelative(relative)
  if (!root || !normalized) return { path: relative, exists: false, writable: false, generated: false, reason: "invalid-path" }
  const full = path.resolve(root, ...normalized.split("/"))
  if (!(full === root || full.startsWith(root + path.sep))) {
    return { path: normalized, exists: false, writable: false, generated: false, reason: "path-escape" }
  }
  try {
    const info = await stat(full)
    if (!info.isFile()) return { path: normalized, exists: false, writable: false, generated: false, reason: "not-file" }
    const generated = generatedReason(normalized)
    let writable = true
    try {
      await access(full, FS_CONSTANTS.W_OK)
    } catch {
      writable = false
    }
    return {
      path: normalized,
      exists: true,
      writable,
      generated: Boolean(generated),
      reason: generated || (writable ? null : "read-only"),
    }
  } catch {
    return { path: normalized, exists: false, writable: false, generated: false, reason: "missing" }
  }
}

function affectedTestWorkerSource() {
  const moduleUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "affected-tests.mjs")).href
  // eval:true workers execute as CommonJS. Dynamic import keeps the target ESM
  // while avoiding a top-level-import syntax dependency in the worker source.
  return `
    const { parentPort, workerData } = require("node:worker_threads");
    (async () => {
      try {
        const mod = await import(${JSON.stringify(moduleUrl)});
        const result = await mod.resolveAffectedTests(workerData.root, {
          changedFiles: workerData.changedFiles,
          maxFiles: workerData.maxFiles,
          maxTests: workerData.maxTests,
        });
        parentPort.postMessage({ ok: true, result });
      } catch {
        parentPort.postMessage({ ok: false, reason: "affected-test-discovery-error" });
      }
    })();
  `
}

/**
 * Static test impact runs in a Worker because affected-tests deliberately uses
 * synchronous Git inventory for determinism. This keeps browser polling/timers
 * on the main event loop responsive while still executing ZERO tests/builds.
 */
export function discoverAffectedTestsOffThread(root, changedFiles, options = {}) {
  if (!root || !Array.isArray(changedFiles) || changedFiles.length === 0) {
    return Promise.resolve({ ok: true, tests: [], suggestedCommands: [], skipped: true, reason: "no-source-files" })
  }
  const signal = options.signal
  if (signal?.aborted) return Promise.resolve({ ok: false, tests: [], suggestedCommands: [], aborted: true, reason: "aborted" })
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener?.("abort", onAbort)
      resolve(value)
    }
    const worker = new Worker(affectedTestWorkerSource(), {
      eval: true,
      workerData: {
        root,
        changedFiles: changedFiles.slice(0, 12),
        maxFiles: Math.max(200, Math.min(6_000, Number(options.maxFiles || 4_000))),
        maxTests: Math.max(1, Math.min(40, Number(options.maxTests || 20))),
      },
    })
    const onAbort = () => {
      worker.terminate().catch(() => null)
      finish({ ok: false, tests: [], suggestedCommands: [], aborted: true, reason: "aborted" })
    }
    signal?.addEventListener?.("abort", onAbort, { once: true })
    worker.once("message", (message) => {
      worker.terminate().catch(() => null)
      if (!message?.ok) return finish({ ok: false, tests: [], suggestedCommands: [], reason: message?.reason || "affected-test-discovery-error" })
      finish({
        ok: true,
        tests: (message.result?.tests || []).slice(0, 20),
        suggestedCommands: (message.result?.suggestedCommands || []).slice(0, 12),
        cacheHit: message.result?.cacheHit === true,
        source: message.result?.source || null,
        skipped: false,
        reason: null,
      })
    })
    worker.once("error", () => finish({ ok: false, tests: [], suggestedCommands: [], reason: "affected-test-worker-error" }))
    worker.once("exit", (code) => {
      if (!settled && code !== 0) finish({ ok: false, tests: [], suggestedCommands: [], reason: "affected-test-worker-exit" })
    })
  })
}

/**
 * Start Phase 1A (barrier-critical) and Phase 1B (optional) without writing to
 * the source tree. The caller may abort 1B at the soft deadline or once the
 * barrier has enough evidence; actual test execution is forbidden here.
 */
export function startReadOnlyLocalPrep(input = {}, options = {}) {
  const startedAt = nowMs(options.now)
  const phase0 = options.phase0 || phase0FastGrounding(input, options)
  const workspace = resolveBarrierWorkspaceRoot(input, options)
  const root = workspace.root
  const beforeFingerprint = captureBarrierFingerprint(root)
  const files = phase0.knownFiles
  const critical = Promise.all(files.map((relative) => inspectFile(root, relative))).then((fileRows) => ({
    schemaVersion: 1,
    kind: "ues-v16-8-local-prep-critical",
    workspace,
    beforeFingerprint,
    fileRows,
    validFiles: fileRows.filter((row) => row.exists).map((row) => row.path),
    generatedFiles: fileRows.filter((row) => row.generated).map((row) => row.path),
    readOnlyFiles: fileRows.filter((row) => row.exists && !row.writable).map((row) => row.path),
    durationMs: Math.max(0, nowMs(options.now) - startedAt),
  }))

  const optionalController = new AbortController()
  const parentSignal = options.signal
  const relayAbort = () => optionalController.abort(parentSignal?.reason || new Error("local-prep-aborted"))
  if (parentSignal?.aborted) relayAbort()
  else parentSignal?.addEventListener?.("abort", relayAbort, { once: true })
  const optional = critical.then(async (criticalResult) => {
    if (optionalController.signal.aborted) return { ok: false, aborted: true, tests: [], suggestedCommands: [], reason: "aborted" }
    const sourceFiles = criticalResult.validFiles.filter((file) => !TEST_PATH_RE.test(file))
    return discoverAffectedTestsOffThread(root, sourceFiles, {
      signal: optionalController.signal,
      maxFiles: options.maxFiles,
      maxTests: options.maxTests,
    })
  }).finally(() => parentSignal?.removeEventListener?.("abort", relayAbort))

  return {
    phase0,
    root,
    workspace,
    beforeFingerprint,
    critical,
    optional,
    abortOptional(reason = "optional-prep-no-longer-needed") {
      if (!optionalController.signal.aborted) optionalController.abort(new Error(String(reason)))
    },
  }
}

function adviceFiles(result) {
  const advice = result?.advice || {}
  return boundedList(advice.filesToInspect || advice.files_to_touch || [], { limit: 12, itemChars: 220 })
    .map(normalizeRelative)
    .filter(Boolean)
}

function testPaths(optionalPrep) {
  const rows = optionalPrep?.tests || []
  return [...new Set(rows.map((row) => normalizeRelative(typeof row === "string" ? row : row?.file || row?.path)).filter(Boolean))].slice(0, 6)
}

function capsuleJsonChars(capsule) {
  return JSON.stringify(capsule).length
}

function shrinkCapsule(capsule, maxChars) {
  const output = { ...capsule, files_to_touch: [...capsule.files_to_touch], concrete_steps: [...capsule.concrete_steps], test_targets: [...capsule.test_targets] }
  const fits = () => capsuleJsonChars(output) <= maxChars
  while (!fits() && output.test_targets.length > 2) output.test_targets.pop()
  while (!fits() && output.concrete_steps.length > 3) output.concrete_steps.pop()
  while (!fits() && output.files_to_touch.length > 4) output.files_to_touch.pop()
  if (!fits()) output.root_cause = boundedText(output.root_cause, 220)
  while (!fits() && output.concrete_steps.length > 1) output.concrete_steps.pop()
  if (!fits()) output.root_cause = boundedText(output.root_cause, 120)
  return output
}

/**
 * Strict executor-facing capsule. Raw web prose/CoT is never rendered here.
 * Runtime provenance stays in metadata outside the four model-visible fields.
 */
export function buildExecutorAdvisorCapsule(result, prep = {}, options = {}) {
  if (!result || result.outcome !== "advice-accepted" || !result.advice) return null
  const maxChars = Math.max(500, Math.min(V16_8_CAPSULE_JSON_MAX_CHARS, Number(options.maxChars || V16_8_CAPSULE_JSON_MAX_CHARS)))
  const rows = prep.critical?.fileRows || prep.fileRows || []
  const byPath = new Map(rows.map((row) => [normalizeRelative(row.path), row]))
  const requested = adviceFiles(result)
  const accepted = []
  const rejectedTargets = []
  for (const file of requested) {
    const row = byPath.get(file)
    // When a verified workspace root is available, a target must be present,
    // writable and not generated. Without root proof we keep only targets that
    // were already bound by the upstream local verifier.
    if (rows.length > 0) {
      if (!row?.exists) rejectedTargets.push({ path: file, reason: "missing" })
      else if (row.generated) rejectedTargets.push({ path: file, reason: row.reason || "generated" })
      else if (!row.writable) rejectedTargets.push({ path: file, reason: "read-only" })
      else accepted.push(file)
    } else {
      const presentClaims = new Set((result.evidenceBinding?.claims || result.advice?.evidenceBinding?.claims || [])
        .filter((claim) => claim?.status === "present")
        .map((claim) => normalizeRelative(claim?.path || claim?.claim))
        .filter(Boolean))
      if (presentClaims.has(file)) accepted.push(file)
      else rejectedTargets.push({ path: file, reason: "not-locally-bound" })
    }
  }

  // If the advisor explicitly anchored its plan to files and every target is
  // invalid, using the remaining prose would silently rewrite the plan. Discard.
  if (requested.length > 0 && accepted.length === 0 && rejectedTargets.length === requested.length) {
    return {
      schemaVersion: 1,
      kind: "ues-v16-8-executor-capsule",
      status: "discarded",
      reason: "all-advisor-targets-invalid",
      rejectedTargets,
      modelVisible: null,
      chars: 0,
    }
  }

  const advice = result.advice
  const rootCause = boundedText(advice.summary || advice.hypotheses?.[0] || "External advisor found no concise root cause.", 320)
  const steps = boundedList(advice.recommendedApproach || advice.approach || [], { limit: 6, itemChars: 170 })
  const base = {
    root_cause: rootCause,
    files_to_touch: accepted.slice(0, 8),
    concrete_steps: steps,
    test_targets: testPaths(prep.optional),
  }
  const modelVisible = shrinkCapsule(base, maxChars)
  const chars = capsuleJsonChars(modelVisible)
  return {
    schemaVersion: 1,
    kind: "ues-v16-8-executor-capsule",
    status: rejectedTargets.length ? "degraded" : "accepted",
    reason: rejectedTargets.length ? "invalid-targets-removed-with-receipt" : "validated",
    rejectedTargets,
    modelVisible,
    chars,
    withinBudget: chars <= maxChars,
    maxChars,
    provenance: {
      trust: "untrusted-external",
      authority: "consultant-only",
      workspaceFingerprint: prep.afterFingerprint?.fingerprint || prep.critical?.beforeFingerprint?.fingerprint || null,
      consultGeneration: options.consultGeneration ?? null,
      requestId: result.requestId || null,
      confidence: Number.isFinite(Number(advice.confidence)) ? Number(advice.confidence) : null,
    },
  }
}

export function renderExecutorAdvisorCapsule(capsule) {
  if (!capsule?.modelVisible || capsule.status === "discarded") return null
  const rendered = [
    "UES_ADVISOR_CAPSULE trust=untrusted-external authority=none verify-locally",
    JSON.stringify(capsule.modelVisible),
  ].join("\n")
  return rendered.length <= V16_8_CAPSULE_MAX_CHARS ? rendered : null
}

export function evaluateDecisionBarrier({
  result,
  consultGeneration,
  activeGeneration,
  beforeFingerprint,
  afterFingerprint,
  capsule,
  workspaceRequired = false,
} = {}) {
  const reasons = []
  if (Number(consultGeneration) !== Number(activeGeneration)) reasons.push("stale-generation")
  if (workspaceRequired && (!beforeFingerprint?.available || !afterFingerprint?.available)) reasons.push("workspace-fingerprint-unavailable")
  if (beforeFingerprint?.available && afterFingerprint?.available && beforeFingerprint.fingerprint !== afterFingerprint.fingerprint) reasons.push("workspace-mutated-during-consult")
  if (!result || result.outcome !== "advice-accepted") reasons.push("advisor-not-accepted")
  if (!capsule?.modelVisible || capsule.status === "discarded") reasons.push(capsule?.reason || "capsule-unavailable")
  const passed = reasons.length === 0
  return {
    schemaVersion: 1,
    kind: "ues-v16-8-decision-barrier",
    passed,
    reasons,
    consultGeneration: Number(consultGeneration || 0),
    activeGeneration: Number(activeGeneration || 0),
    beforeFingerprint: beforeFingerprint?.fingerprint || null,
    afterFingerprint: afterFingerprint?.fingerprint || null,
    stale: reasons.includes("stale-generation") || reasons.includes("workspace-mutated-during-consult"),
  }
}

export function overlapTelemetry({
  startedAt,
  finishedAt,
  advisorStartedAt,
  advisorFinishedAt,
  localStartedAt,
  localFinishedAt,
  barrierAt,
  phase0Ms = 0,
  capsuleChars = 0,
  previousAdvisorChars = 0,
  staleDiscard = false,
  advisorAborted = false,
} = {}) {
  const advisorMs = Math.max(0, Number(advisorFinishedAt || 0) - Number(advisorStartedAt || 0))
  const localPrepMs = Math.max(0, Number(localFinishedAt || 0) - Number(localStartedAt || 0))
  const overlapStart = Math.max(Number(advisorStartedAt || 0), Number(localStartedAt || 0))
  const overlapEnd = Math.min(Number(advisorFinishedAt || 0), Number(localFinishedAt || 0))
  const overlapMs = Math.max(0, overlapEnd - overlapStart)
  const totalMs = Math.max(0, Number(finishedAt || 0) - Number(startedAt || 0))
  const barrierWaitMs = Math.max(0, Number(barrierAt || finishedAt || 0) - Math.max(Number(advisorFinishedAt || 0), Number(localFinishedAt || 0)))
  const charsSaved = Math.max(0, Number(previousAdvisorChars || 0) - Number(capsuleChars || 0))
  return {
    schemaVersion: 1,
    kind: "ues-v16-8-overlap-telemetry",
    total_ms: totalMs,
    phase0_ms: Math.max(0, Number(phase0Ms || 0)),
    advisor_ms: advisorMs,
    local_prep_ms: localPrepMs,
    overlap_ms: overlapMs,
    barrier_wait_ms: barrierWaitMs,
    capsule_chars: Math.max(0, Number(capsuleChars || 0)),
    model_visible_chars_saved: charsSaved,
    estimated_input_tokens_saved: Math.ceil(charsSaved / 4),
    estimated_input_tokens_saved_provenance: "ESTIMATED",
    stale_discards: staleDiscard ? 1 : 0,
    advisor_aborts: advisorAborted ? 1 : 0,
    measurement_provenance: {
      timings: "MEASURED",
      chars: "MEASURED",
      provider_tokens: "NOT_MEASURED",
    },
  }
}

export function createLinkedDeadline({ parentSignal, softDeadlineMs = V16_8_DEFAULT_SOFT_DEADLINE_MS, hardDeadlineMs = V16_8_DEFAULT_HARD_DEADLINE_MS, onSoftDeadline } = {}) {
  const controller = new AbortController()
  let hardTimedOut = false
  let softFired = false
  const relay = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal?.reason || new Error("advisor-parent-aborted"))
  }
  if (parentSignal?.aborted) relay()
  else parentSignal?.addEventListener?.("abort", relay, { once: true })
  const softMs = Math.max(0, Number(softDeadlineMs || 0))
  const hardMs = Math.max(1, Number(hardDeadlineMs || V16_8_DEFAULT_HARD_DEADLINE_MS))
  const softTimer = softMs > 0 && softMs < hardMs
    ? setTimeout(() => {
        softFired = true
        try { onSoftDeadline?.() } catch {}
      }, softMs)
    : null
  softTimer?.unref?.()
  let hardResolve
  const hardPromise = new Promise((resolve) => { hardResolve = resolve })
  const hardTimer = setTimeout(() => {
    hardTimedOut = true
    if (!controller.signal.aborted) controller.abort(new Error("web-advisor-hard-deadline"))
    hardResolve({ timedOut: true, reason: "web-advisor-hard-deadline" })
  }, hardMs)
  hardTimer.unref?.()
  return {
    controller,
    signal: controller.signal,
    hardPromise,
    get hardTimedOut() { return hardTimedOut },
    get softFired() { return softFired },
    close() {
      if (softTimer) clearTimeout(softTimer)
      clearTimeout(hardTimer)
      parentSignal?.removeEventListener?.("abort", relay)
    },
  }
}

export function deterministicResolutionProof(input = {}) {
  const proof = input.deterministicResolution
  if (!proof || proof.proven !== true) return { proven: false, reason: "not-proven" }
  const uniqueCandidate = proof.uniqueCandidate === true
  const sourceExists = proof.sourceExists === true
  const diagnosticAgrees = proof.diagnosticAgrees === true
  const mechanicallyDerivable = proof.mechanicallyDerivable === true
  const proven = uniqueCandidate && sourceExists && diagnosticAgrees && mechanicallyDerivable
  return {
    proven,
    reason: proven ? "deterministic-proof-complete" : "deterministic-proof-incomplete",
    evidence: { uniqueCandidate, sourceExists, diagnosticAgrees, mechanicallyDerivable },
  }
}
