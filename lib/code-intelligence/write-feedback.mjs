// Incremental write intelligence (V15.3 Phase 1).
//
// A successful edit currently returns nothing a model can act on. The model has
// to spend a whole tool round-trip asking whether the file it just changed still
// parses, and on a weak model that round-trip is often skipped -- which is how a
// broken edit survives until the verifier at the end of a long run.
//
// This module closes that gap without weakening anything:
//
//   * it only ever ADDS a bounded code signal to an already-successful write
//     result; it never blocks, never rewrites, and never rolls back the edit;
//   * it never reports "clean" from an incomplete analysis. The honesty contract
//     below is the whole point of the module, so it is enforced in one place
//     (`classify`) and covered by a test for every branch;
//   * results are bound to the exact file content they were produced for, so a
//     result that arrives after a newer write is discarded instead of being
//     presented as current;
//   * rapid writes to one file coalesce into a single check, and the final
//     check is guaranteed to run.
//
// The diagnostics provider is injected. That keeps this module free of a hard
// dependency on a language server, makes every branch deterministically
// testable, and guarantees a provider failure can never affect a write.

import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { putEvidence } from "../evidence-store.mjs"

// Host tool names that can mutate a file. `ues_code_edit` is UES's own anchored
// editor; the rest are Pi host tools. A tool that is not in this set is never
// instrumented, which is the conservative direction: unlisted surfaces simply
// keep the pre-Patch behaviour instead of getting a guessed one.
export const WRITE_FEEDBACK_TOOLS = Object.freeze([
  "edit",
  "write",
  "write_file",
  "apply_patch",
  "ues_code_edit",
  "str_replace",
  "str_replace_editor",
])

// Extensions with no language-server provider. Answering "unsupported" costs one
// extension lookup and keeps an unsupported file from ever paying for a probe.
const UNSUPPORTED_EXTENSIONS = Object.freeze(new Set([
  ".md", ".markdown", ".txt", ".rst", ".adoc", ".json", ".jsonc", ".yml", ".yaml",
  ".toml", ".ini", ".cfg", ".lock", ".csv", ".tsv", ".svg", ".png", ".jpg", ".jpeg",
  ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tar", ".woff", ".woff2", ".ttf",
  ".env", ".gitignore", ".editorconfig", ".sql",
]))

const PROVIDER_EXTENSIONS = Object.freeze(new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyi", ".java", ".kt", ".kts", ".cs", ".go", ".rs", ".rb", ".php",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".swift", ".scala", ".vue", ".svelte",
]))

export const WRITE_FEEDBACK_STATUS = Object.freeze({
  CLEAN: "confirmed-clean",
  ERRORS: "errors",
  WARNINGS: "warnings",
  DEGRADED: "degraded",
  PENDING: "pending",
  UNSUPPORTED: "unsupported",
  UNAVAILABLE: "unavailable",
})

export const WRITE_FEEDBACK_DEFAULTS = Object.freeze({
  // A write landing inside this window after the previous one for the same file
  // is coalesced into the trailing check instead of starting its own.
  coalesceWindowMs: 750,
  // The window grows with the provider's observed cost. A check that takes two
  // seconds means the model is still inside one feedback cycle when its next
  // edit lands, and stacking a second two-second check behind the first is pure
  // latency: measured against the real TypeScript server, three sequential
  // edits cost three checks at a fixed 750 ms window and two at an adaptive one.
  maxAdaptiveWindowMs: 5_000,
  adaptiveWindowFactor: 1.5,
  adaptiveWindowSamples: 4,
  // Hard ceilings. Exceeding them is reported honestly as a degraded
  // "not checked" outcome; it is never silently dropped.
  maxChecksPerFilePerTurn: 4,
  maxChecksPerTurn: 12,
  maxTrackedFiles: 32,
  maxErrorRows: 12,
  maxWarningRows: 6,
  maxRowMessageChars: 200,
  maxRowCodeChars: 80,
  maxPathChars: 400,
})

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function normalizeRelativeFile(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim()
}

export function fileExtension(relative) {
  const base = String(relative || "").split("/").pop() || ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return ""
  return base.slice(dot).toLowerCase()
}

export function writeFeedbackEligibility(relative) {
  const file = normalizeRelativeFile(relative)
  if (!file) return { eligible: false, reason: "no-file", extension: "" }
  if (file.split("/").includes("..")) return { eligible: false, reason: "path-escape", extension: "" }
  const extension = fileExtension(file)
  if (!extension) return { eligible: false, reason: "no-extension", extension: "" }
  if (UNSUPPORTED_EXTENSIONS.has(extension)) return { eligible: false, reason: "unsupported-extension", extension }
  if (!PROVIDER_EXTENSIONS.has(extension)) return { eligible: false, reason: "unsupported-extension", extension }
  return { eligible: true, reason: "eligible", extension }
}

// Tools whose host contract guarantees ONE file per call.
//
// PROVEN FROM THE ACTUAL Pi 0.87.1 TOOL CONTRACT, not assumed:
//   edit  -> Type.Object({ path: Type.String(), edits: Array<{oldText,newText}> })
//            "Edit a single file using exact text replacement."
//   write -> Type.Object({ path: Type.String(), content: Type.String() })
//   Pi 0.87.1 ships no apply_patch, write_file, str_replace or str_replace_editor
//   tool; the remaining names in WRITE_FEEDBACK_TOOLS come from other hosts and
//   from MCP servers, and are NOT covered by this guarantee.
//
// A tool in this set is allowed to produce a single-file verdict. A tool outside
// it may touch several files, so its verdict must say how many were covered and
// which were not -- a status derived from one file must never be read as a
// statement about the whole call.
export const SINGLE_FILE_WRITE_TOOLS = Object.freeze(["edit", "write"])

// Multi-file-capable write tools. Only names a host or MCP server can actually
// register; Pi itself never does.
export const MULTI_FILE_WRITE_TOOLS = Object.freeze(
  WRITE_FEEDBACK_TOOLS.filter((name) => !SINGLE_FILE_WRITE_TOOLS.includes(name)),
)

// Best-effort extraction of the mutated file from a host tool result.
//
// Only shapes the runtime can actually observe are handled. An unrecognised
// input returns null, and the caller then performs no check at all, which is
// strictly better than guessing a file and analysing the wrong one.
export function extractWrittenFile(toolName, input) {
  return extractWrittenFiles(toolName, input)[0] || null
}

// Every file a single tool call may have mutated.
//
// A patch tool can name many files in one payload, and a multi-file host tool can
// take an array. Returning only the first -- which is what this function used to
// do -- silently under-reported the blast radius: a three-file patch produced one
// file's status and said nothing about the other two, which a model reads as
// "everything I touched is fine". All discovered files are returned, and the
// caller reports coverage against the total.
export function extractWrittenFiles(toolName, input) {
  const name = String(toolName || "").toLowerCase()
  if (!WRITE_FEEDBACK_TOOLS.includes(name)) return []
  const args = input && typeof input === "object" ? input : {}
  const out = []
  const push = (value) => {
    const normalized = normalizeRelativeFile(value)
    if (normalized && !out.includes(normalized)) out.push(normalized)
  }

  for (const key of ["file", "path", "filePath", "file_path", "target", "targetFile"]) {
    if (Array.isArray(args[key])) for (const item of args[key]) push(item)
    else if (args[key] != null) push(args[key])
  }
  for (const key of ["files", "paths", "filePaths"]) {
    if (Array.isArray(args[key])) for (const item of args[key]) push(item)
  }

  // Patch envelopes: a single call can carry many file headers.
  const patch = args.patch ?? args.diff ?? args.input ?? args.patchText
  if (patch != null) {
    const text = String(patch)
    const patterns = [
      /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gm,
      /^\+\+\+\s+b\/(.+)$/gm,
      /^---\s+a\/(.+)$/gm,
      /^\*\*\*\s+Begin Patch[\s\S]*?^\*\*\*\s+End Patch/gm,
    ]
    for (const pattern of patterns) {
      if (pattern.source.includes("Update|Add|Delete")) {
        for (const match of text.matchAll(pattern)) push(match[1])
        continue
      }
      for (const match of text.matchAll(pattern)) push(match[1])
    }
    // A bare "path/to/file" inside an apply-style payload is only trusted when
    // the payload looks like a patch rather than a literal string.
    if (!out.length && /^\s*(\*\*\*|---|@@|diff --git|\+\+\+)/m.test(text)) {
      for (const match of text.matchAll(/^(?:\*\*\*\s+)?(?:Update|Add|Delete)?\s*File:\s*(\S+)$/gm)) push(match[1])
    }
  }
  return out.slice(0, 64)
}

export function contentFingerprint(text) {
  return createHash("sha256").update(Buffer.from(String(text ?? ""), "utf8")).digest("hex")
}

async function readFingerprint(root, relative) {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  if (full !== base && !full.startsWith(base + path.sep)) return { ok: false, reason: "path-escape" }
  try {
    const info = await stat(full)
    if (!info.isFile()) return { ok: false, reason: "not-a-file" }
    const text = await readFile(full, "utf8")
    return { ok: true, fingerprint: contentFingerprint(text), bytes: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    return { ok: false, reason: "unreadable", error: String(error instanceof Error ? error.message : error).slice(0, 200) }
  }
}

function severityOf(diagnostic) {
  const value = Number(diagnostic?.severity)
  if (value === 1) return "error"
  if (value === 2) return "warning"
  if (value === 3) return "info"
  if (value === 4) return "hint"
  return String(diagnostic?.severity || "error").toLowerCase()
}

function compactRow(diagnostic, limits) {
  const range = diagnostic?.range || {}
  const start = range.start || {}
  const code = diagnostic?.code == null ? "" : String(diagnostic.code)
  // `Number(null)` is 0 and `Number(undefined)` is NaN, so a naive
  // isFinite check would report a missing position as line 1 or as NaN. Neither
  // is true, and a model shown a fabricated line number acts on it.
  const finitePosition = (value) => (value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null)
  return {
    line: finitePosition(start.line) == null ? null : finitePosition(start.line) + 1,
    column: finitePosition(start.character) == null ? null : finitePosition(start.character) + 1,
    severity: severityOf(diagnostic),
    code: code.slice(0, limits.maxRowCodeChars),
    source: String(diagnostic?.source || "").slice(0, 80),
    message: String(diagnostic?.message || "").slice(0, limits.maxRowMessageChars),
  }
}

// The single place a status is decided.
//
// The invariant that matters: `complete !== true` can never produce
// `confirmed-clean`, no matter what the diagnostics array contains. An
// incomplete analysis with zero diagnostics is "not proven", and reporting it as
// clean is the exact false-clean this phase exists to prevent.
export function classify(input = {}) {
  const complete = input.complete === true
  const rows = Array.isArray(input.diagnostics) ? input.diagnostics : []
  const errors = rows.filter((row) => severityOf(row) === "error")
  const warnings = rows.filter((row) => severityOf(row) === "warning")

  if (input.status === WRITE_FEEDBACK_STATUS.UNSUPPORTED) {
    return { status: WRITE_FEEDBACK_STATUS.UNSUPPORTED, complete: false, errors: errors.length, warnings: warnings.length }
  }
  if (input.status === WRITE_FEEDBACK_STATUS.PENDING) {
    return { status: WRITE_FEEDBACK_STATUS.PENDING, complete: false, errors: 0, warnings: 0 }
  }
  if (input.status === WRITE_FEEDBACK_STATUS.UNAVAILABLE) {
    return { status: WRITE_FEEDBACK_STATUS.UNAVAILABLE, complete: false, errors: 0, warnings: 0 }
  }
  if (complete) {
    if (errors.length) return { status: WRITE_FEEDBACK_STATUS.ERRORS, complete: true, errors: errors.length, warnings: warnings.length }
    if (warnings.length) return { status: WRITE_FEEDBACK_STATUS.WARNINGS, complete: true, errors: 0, warnings: warnings.length }
    return { status: WRITE_FEEDBACK_STATUS.CLEAN, complete: true, errors: 0, warnings: 0 }
  }
  return {
    status: WRITE_FEEDBACK_STATUS.DEGRADED,
    complete: false,
    errors: errors.length,
    warnings: warnings.length,
  }
}

// Compact, model-facing shape. Deliberately small: a blocker list and a bounded
// warning sample, plus the fields needed to know whether the answer is
// trustworthy. The full provider payload is never inlined.
export function renderFeedback(input = {}) {
  const limits = { ...WRITE_FEEDBACK_DEFAULTS, ...(input.limits || {}) }
  const classified = classify(input)
  const rows = (Array.isArray(input.diagnostics) ? input.diagnostics : [])
    .map((row) => compactRow(row, limits))
  const errors = rows.filter((row) => row.severity === "error")
  const warnings = rows.filter((row) => row.severity === "warning")

  const errorRows = errors.slice(0, limits.maxErrorRows)
  const warningRows = warnings.slice(0, limits.maxWarningRows)
  const truncated = errors.length > errorRows.length || warnings.length > warningRows.length

  const payload = {
    file: String(input.file || "").slice(0, limits.maxPathChars),
    status: classified.status,
    complete: classified.complete === true,
    source: String(input.source || "none"),
    errors: errorRows,
    warnings: warningRows,
    errorCount: errors.length,
    warningCount: warnings.length,
    truncated,
    durationMs: Number.isFinite(Number(input.durationMs)) ? Math.round(Number(input.durationMs)) : null,
    sessionId: input.sessionId == null ? null : String(input.sessionId),
    poolHit: input.poolHit == null ? null : input.poolHit === true,
  }
  if (classified.status === WRITE_FEEDBACK_STATUS.PENDING) {
    payload.pendingForMs = Number.isFinite(Number(input.pendingForMs)) ? Math.round(Number(input.pendingForMs)) : null
  }
  if (classified.status === WRITE_FEEDBACK_STATUS.UNSUPPORTED) payload.reason = input.reason || "unsupported-extension"
  if (classified.status === WRITE_FEEDBACK_STATUS.UNAVAILABLE) payload.reason = input.reason || "lsp-unavailable"
  if (classified.status === WRITE_FEEDBACK_STATUS.DEGRADED) payload.reason = input.reason || "diagnostics-incomplete"
  // Recoverable full evidence. `controller.raw(file)` is reachable only from
  // inside this process, which is not recovery as far as a model or a verifier is
  // concerned: neither can call it. So whenever rows were dropped, the exact
  // provider payload is written to the Evidence Store -- the store the runtime
  // already uses and already has retrieval tools for -- and the reference is
  // carried in the model-facing payload. `ues_code context-expand <ref>` (parent)
  // and `ues_evidence_get <ref>` (child) both resolve it.
  if (input.rawEvidence) {
    payload.rawEvidence = {
      ref: String(input.rawEvidence.ref || ""),
      chars: Math.max(0, Number(input.rawEvidence.chars || 0)),
      omitted: Math.max(0, Number(input.rawEvidence.omitted || 0)),
      retrieveWith: "ues_code context-expand (parent) or ues_evidence_get (child)",
    }
  }
  if (input.stale === true) {
    // A stale result is never presented as current evidence. It is surfaced so
    // the model can see that a newer write superseded it, and it is explicitly
    // not a clean signal.
    payload.stale = true
    payload.status = WRITE_FEEDBACK_STATUS.PENDING
    payload.complete = false
  }
  if (input.supersededByWrite === true) {
    payload.superseded = true
    payload.status = WRITE_FEEDBACK_STATUS.PENDING
    payload.complete = false
  }
  return payload
}

// Summary verdict for a call that may have touched several files.
//
// The rule this enforces: a multi-file call is never described by one file's
// status. It either reports the aggregate honestly, or it says how much of the
// call was covered and which files were not. A model that reads "confirmed-clean"
// after a three-file patch must be able to assume all three were checked; where
// that is not true, the payload says so in the same breath.
function summarizeCall({ files, checked, toolName, singleFileContract }) {
  const rank = { "confirmed-clean": 0, warnings: 1, unsupported: 2, pending: 3, unavailable: 4, degraded: 5, errors: 6 }
  const all = [...files, ...checked].filter(Boolean)
  let status = "confirmed-clean"
  for (const item of all) {
    if (item.status === WRITE_FEEDBACK_STATUS.UNSUPPORTED) continue
    if (rank[item.status] > rank[status]) status = item.status
  }

  const unsupported = files.filter((item) => item?.status === WRITE_FEEDBACK_STATUS.UNSUPPORTED).map((item) => item.file)
  const errorFiles = checked.filter((item) => item?.status === WRITE_FEEDBACK_STATUS.ERRORS).map((item) => item.file)
  // Derived from the FULL per-file list, not from `checked`: a file that was
  // refused, degraded, unavailable or left pending was never proven, whether or
  // not it counts as "checked", and it must be named either way.
  const notProven = files
    .filter((item) => item && item.status !== WRITE_FEEDBACK_STATUS.UNSUPPORTED
      && item.status !== WRITE_FEEDBACK_STATUS.CLEAN
      && item.status !== WRITE_FEEDBACK_STATUS.ERRORS
      && item.status !== WRITE_FEEDBACK_STATUS.WARNINGS)
    .map((item) => item.file)

  // `complete` is only ever true when every discovered file reached a terminal,
  // proven verdict. For a single-file-contract tool that is the whole call; for
  // anything else it requires full coverage.
  const complete = singleFileContract
    ? status === WRITE_FEEDBACK_STATUS.CLEAN
    : status === WRITE_FEEDBACK_STATUS.CLEAN
      && files.length > 0
      && checked.length === files.length - unsupported.length
      && unsupported.length === 0
      && notProven.length === 0

  // A clean aggregate with incomplete coverage is NOT a clean file. Reporting
  // `confirmed-clean` beside `complete: false` is precisely the combination the
  // honesty contract forbids, so partial coverage is reported as degraded with
  // the reason attached.
  const finalStatus = complete
    ? WRITE_FEEDBACK_STATUS.CLEAN
    : status === WRITE_FEEDBACK_STATUS.CLEAN
      ? WRITE_FEEDBACK_STATUS.DEGRADED
      : status

  return {
    status: finalStatus,
    complete,
    reason: complete
      ? null
      : (unsupported.length || notProven.length
        ? "partial-coverage:" + (unsupported.length + notProven.length) + "-of-" + files.length + "-files-unverified"
        : null),
    singleFileContract,
    toolName,
    filesDiscovered: files.length,
    filesChecked: checked.length,
    filesUnsupported: unsupported,
    filesNotProven: notProven,
    errorFiles,
  }
}

function renderText(payload) {
  if (!payload) return null
  const head = `UES post-write ${payload.file}: ${payload.status} (complete=${payload.complete}, source=${payload.source})`
  if (payload.status === WRITE_FEEDBACK_STATUS.PENDING) {
    return `${head}${payload.superseded ? " [superseded by a newer write]" : ""}${payload.stale ? " [result discarded: file changed during analysis]" : ""}`
  }
  if (payload.status === WRITE_FEEDBACK_STATUS.UNSUPPORTED) return `${head} [${payload.reason}]`
  if (payload.status === WRITE_FEEDBACK_STATUS.UNAVAILABLE) return `${head} [${payload.reason}]`
  if (payload.status === WRITE_FEEDBACK_STATUS.DEGRADED) {
    return `${head} [${payload.reason}] not proven clean; found ${payload.errorCount} error(s), ${payload.warningCount} warning(s)`
  }
  if (payload.status === WRITE_FEEDBACK_STATUS.CLEAN) return head
  const lines = []
  for (const row of payload.errors) {
    lines.push(`  L${row.line ?? "?"}:${row.column ?? "?"} ${row.code || "error"} ${row.message}`.trimEnd())
  }
  if (payload.warnings.length) {
    lines.push(`  +${payload.warningCount} warning(s)`)
  }
  if (payload.truncated) lines.push("  ...truncated; run ues_code diagnostics for the full list")
  if (payload.rawEvidence?.ref) {
    lines.push(`  ${payload.rawEvidence.omitted} more diagnostic(s) preserved: ${payload.rawEvidence.ref}`)
    lines.push("  recover them with: ues_code context-expand --ref " + payload.rawEvidence.ref)
  }
  return [head, ...lines].join("\n")
}

function newMetrics() {
  return {
    postWriteChecks: 0,
    postWriteComplete: 0,
    postWriteIncomplete: 0,
    postWriteErrors: 0,
    postWriteCoalesced: 0,
    postWriteStaleDiscarded: 0,
    postWriteUnsupported: 0,
    postWriteUnavailable: 0,
    postWriteBudgetExhausted: 0,
    postWriteProviderFailures: 0,
    postWriteSuperseded: 0,
    postWriteLastDurationMs: null,
  }
}

let GLOBAL_METRICS = newMetrics()

export function writeFeedbackMetrics() {
  return { ...GLOBAL_METRICS }
}

export function resetWriteFeedbackMetrics() {
  GLOBAL_METRICS = newMetrics()
}

// A controller owns exactly one workspace root and one turn of write feedback.
// Runtime cache key: root + turn. Everything long-lived is bounded: at most
// `maxTrackedFiles` slots, each holding one payload and one raw payload.
export function createWriteFeedbackController(options = {}) {
  const limits = { ...WRITE_FEEDBACK_DEFAULTS, ...(options.limits || {}) }
  const root = path.resolve(options.root || process.cwd())
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const schedule = typeof options.schedule === "function" ? options.schedule : defaultSchedule
  const cancelSchedule = typeof options.cancelSchedule === "function" ? options.cancelSchedule : defaultCancel
  const runDiagnostics = options.runDiagnostics
  const enabled = typeof runDiagnostics === "function" && options.enabled !== false

  const slots = new Map()
  const inflight = new Map()
  let turnChecks = 0
  let checkSequence = 0
  let closed = false

  function touchSlot(relative) {
    let slot = slots.get(relative)
    if (!slot) {
      slot = {
        relative,
        lastWriteAt: 0,
        lastCheckAt: 0,
        checksThisTurn: 0,
        lastPayload: null,
        raw: null,
        drainedAt: 0,
        pendingTimer: null,
        pendingSince: 0,
        generation: 0,
        checkDurations: [],
      }
      slots.set(relative, slot)
      while (slots.size > limits.maxTrackedFiles) {
        const oldest = slots.keys().next().value
        if (oldest == null) break
        const victim = slots.get(oldest)
        if (victim?.pendingTimer) cancelSchedule(victim.pendingTimer)
        slots.delete(oldest)
      }
    } else {
      slots.delete(relative)
      slots.set(relative, slot)
    }
    return slot
  }

  function budgetAvailable(slot) {
    if (slot.checksThisTurn >= limits.maxChecksPerFilePerTurn) return "per-file"
    if (turnChecks >= limits.maxChecksPerTurn) return "per-turn"
    return null
  }

  // The window that decides "is this write part of the same feedback cycle as
  // the last one". It is the configured floor, widened to match how long checks
  // on this file actually take, because the only thing the window exists to
  // prevent is stacking a second slow check behind a first one.
  function coalesceWindowFor(slot) {
    const samples = slot.checkDurations.slice(-limits.adaptiveWindowSamples)
    if (!samples.length) return limits.coalesceWindowMs
    const sorted = [...samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const adaptive = Math.round(median * limits.adaptiveWindowFactor)
    return Math.max(limits.coalesceWindowMs, Math.min(limits.maxAdaptiveWindowMs, adaptive))
  }

  function unavailable(file, reason, toolName) {
    return renderFeedback({
      file,
      status: WRITE_FEEDBACK_STATUS.UNAVAILABLE,
      reason,
      source: "none",
      toolName,
    })
  }

  async function check(slot) {
    const generation = slot.generation
    const requestId = `postwrite-${(checkSequence += 1)}`
    const startedAt = now()
    const before = await readFingerprint(root, slot.relative)
    if (!before.ok) {
      turnChecks += 1
      slot.checksThisTurn += 1
      const payload = unavailable(slot.relative, before.reason, "runtime")
      GLOBAL_METRICS.postWriteChecks += 1
      GLOBAL_METRICS.postWriteIncomplete += 1
      return { payload, raw: null, requestId }
    }

    let result
    try {
      result = await runDiagnostics({ root, relative: slot.relative, fingerprint: before.fingerprint, requestId })
    } catch (error) {
      // A provider failure is reported, never propagated: the write already
      // succeeded and must not be undone or retried into a loop.
      GLOBAL_METRICS.postWriteProviderFailures += 1
      result = {
        available: false,
        complete: false,
        diagnostics: [],
        reason: "diagnostics-threw: " + String(error instanceof Error ? error.message : error).slice(0, 160),
      }
    }

    const durationMs = now() - startedAt
    const after = await readFingerprint(root, slot.relative)
    const contentChangedDuringCheck = !after.ok || after.fingerprint !== before.fingerprint
    const superseded = slot.generation !== generation

    turnChecks += 1
    slot.checksThisTurn += 1
    slot.lastCheckAt = now()
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      slot.checkDurations.push(Math.trunc(durationMs))
      while (slot.checkDurations.length > limits.adaptiveWindowSamples * 2) slot.checkDurations.shift()
    }
    GLOBAL_METRICS.postWriteChecks += 1

    if (superseded || contentChangedDuringCheck) {
      // Either a newer write arrived while this check ran, or the file changed
      // underneath the provider. Either way this result describes content that
      // is no longer on disk, so it is discarded rather than shown. Nothing is
      // written to the Evidence Store either: preserving a stale diagnostic set
      // would put superseded evidence behind a live-looking reference.
      GLOBAL_METRICS.postWriteStaleDiscarded += 1
      if (superseded) GLOBAL_METRICS.postWriteSuperseded += 1
      return {
        payload: renderFeedback({
          file: slot.relative,
          status: WRITE_FEEDBACK_STATUS.PENDING,
          stale: contentChangedDuringCheck,
          supersededByWrite: superseded,
          reason: contentChangedDuringCheck ? "content-changed-during-check" : "superseded-by-newer-write",
          source: "none",
        }),
        raw: null,
        requestId,
        discarded: true,
      }
    }

    const complete = result?.complete === true
    const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : []
    const classified = classify({ complete, diagnostics })
    GLOBAL_METRICS.postWriteComplete += complete ? 1 : 0
    GLOBAL_METRICS.postWriteIncomplete += complete ? 0 : 1
    if (classified.status === WRITE_FEEDBACK_STATUS.ERRORS) GLOBAL_METRICS.postWriteErrors += 1
    if (classified.status === WRITE_FEEDBACK_STATUS.UNSUPPORTED) GLOBAL_METRICS.postWriteUnsupported += 1
    if (classified.status === WRITE_FEEDBACK_STATUS.UNAVAILABLE) GLOBAL_METRICS.postWriteUnavailable += 1
    GLOBAL_METRICS.postWriteLastDurationMs = durationMs

    const payload = renderFeedback({
      file: slot.relative,
      complete,
      diagnostics,
      source: result?.diagnosticsSource || result?.source || (complete ? "lsp-publish" : "none"),
      reason: result?.reason || result?.diagnosticsReason || null,
      durationMs,
      sessionId: result?.pool?.sessionId ?? null,
      poolHit: result?.pool?.poolHit ?? null,
    })

    // Only write evidence when something was actually dropped. An untruncated
    // payload has omitted nothing, and writing the full provider output on every
    // check would turn a read-only observation into a growing store.
    let rawEvidence = null
    if (payload.truncated) {
      const omitted = payload.errorCount - payload.errors.length + (payload.warningCount - payload.warnings.length)
      const serialized = JSON.stringify({
        file: slot.relative,
        fingerprint: before.fingerprint,
        complete,
        reason: result?.reason || null,
        provider: result?.diagnosticsSource || result?.source || null,
        errorCount: payload.errorCount,
        warningCount: payload.warningCount,
        diagnostics,
      }, null, 2)
      try {
        const stored = await putEvidence(root, serialized, {
          kind: "post-write-diagnostics",
          source: `ues-post-write:${slot.relative}`,
          summary: `Full post-write diagnostics for ${slot.relative} (${diagnostics.length} rows, ${omitted} omitted from the model-facing payload)`,
        })
        rawEvidence = { ref: stored?.metadata?.ref || stored?.ref || null, chars: serialized.length, omitted }
      } catch {
        // Evidence storage failing must not turn a good check into a bad one.
        rawEvidence = null
      }
    }
    if (rawEvidence?.ref) payload.rawEvidence = rawEvidence

    return {
      payload,
      // Raw evidence stays recoverable and bounded: the exact provider rows for
      // this file, so a compaction can recover what the compact payload dropped.
      raw: {
        requestId,
        file: slot.relative,
        fingerprint: before.fingerprint,
        complete,
        reason: result?.reason || null,
        diagnostics,
        rawEvidence,
      },
      requestId,
    }
  }

  async function settle(slot) {
    if (slot.pendingTimer) {
      cancelSchedule(slot.pendingTimer)
      slot.pendingTimer = null
    }
    const existing = inflight.get(slot.relative)
    const promise = existing || check(slot)
    if (!existing) inflight.set(slot.relative, promise)
    try {
      const outcome = await promise
      if (!inflight.get(slot.relative) || inflight.get(slot.relative) === promise) inflight.delete(slot.relative)
      if (outcome.discarded) return outcome
      slot.lastPayload = outcome.payload
      slot.raw = outcome.raw
      return outcome
    } catch (error) {
      inflight.delete(slot.relative)
      const payload = unavailable(slot.relative, "check-failed", "runtime")
      slot.lastPayload = payload
      return { payload, raw: null }
    }
  }

  function scheduleTrailing(slot, windowMs) {
    if (slot.pendingTimer) cancelSchedule(slot.pendingTimer)
    slot.pendingSince = now()
    const generationAtSchedule = slot.generation
    slot.pendingTimer = schedule(async () => {
      slot.pendingTimer = null
      if (closed) return
      // Only the newest scheduled write runs; an earlier timer that still fires
      // is a no-op rather than a redundant check.
      if (slot.generation !== generationAtSchedule) return
      await settle(slot).catch(() => {})
    }, windowMs)
  }

  const controller = {
    enabled,

    // Called from a host tool_result handler. Never throws, never blocks on
    // anything unbounded, and never mutates the write.
    async noteWrite({ toolName, input, relative, turnId } = {}) {
      const files = relative
        ? [normalizeRelativeFile(relative)]
        : extractWrittenFiles(toolName, input)
      if (!files.length) return null

      const singleFileContract = SINGLE_FILE_WRITE_TOOLS.includes(String(toolName || "").toLowerCase())
      // One file, or a host whose contract says there can only be one: the
      // existing single-file path, unchanged.
      if (files.length === 1 || singleFileContract) {
        return controller.noteSingleFile({ toolName, relative: files[0], turnId })
      }
      return controller.noteMultiFile({ toolName, files, input, turnId })
    },

    async noteSingleFile({ toolName, relative, turnId } = {}) {
      const file = normalizeRelativeFile(relative)
      if (!file) return null

      const eligibility = writeFeedbackEligibility(file)
      if (!eligibility.eligible) {
        const payload = renderFeedback({
          file,
          status: WRITE_FEEDBACK_STATUS.UNSUPPORTED,
          reason: eligibility.reason,
          source: "none",
        })
        GLOBAL_METRICS.postWriteUnsupported += 1
        return { ...payload, text: renderText(payload) }
      }
      if (!enabled) {
        return unavailable(file, "write-feedback-disabled", toolName)
      }

      const slot = touchSlot(file)
      slot.generation += 1
      const writtenAt = now()
      const window = coalesceWindowFor(slot)
      // Two ways to be inside the same feedback cycle: the previous write was
      // recent, or a check for this file only just finished. The second is the
      // one that matters for a slow provider, where the gap between two writes
      // is dominated by the check the model was already waiting on.
      const withinWindow = (slot.lastWriteAt > 0 && (writtenAt - slot.lastWriteAt) < window)
        || (slot.lastCheckAt > 0 && (writtenAt - slot.lastCheckAt) < window)
      slot.lastWriteAt = writtenAt

      const exhausted = budgetAvailable(slot)
      if (exhausted) {
        // Honest refusal: bounded policy, reported, never silent.
        GLOBAL_METRICS.postWriteBudgetExhausted += 1
        const payload = renderFeedback({
          file,
          status: WRITE_FEEDBACK_STATUS.DEGRADED,
          reason: "post-write-check-budget-exhausted:" + exhausted,
          source: "none",
        })
        return { ...payload, text: renderText(payload) }
      }

      if (withinWindow) {
        // Latest-write-wins: do not start a second check, but guarantee the
        // final content is still checked exactly once.
        GLOBAL_METRICS.postWriteCoalesced += 1
        scheduleTrailing(slot, window)
        const payload = renderFeedback({
          file,
          status: WRITE_FEEDBACK_STATUS.PENDING,
          source: "none",
          pendingForMs: Math.max(0, writtenAt - (slot.pendingSince || writtenAt)),
        })
        return { ...payload, text: renderText(payload) }
      }

      const outcome = await settle(slot)
      // The payload is returned inline, so it is already delivered. Marking it
      // here is what stops `drain` replaying the same evidence on the next
      // unrelated tool result.
      if (slot.lastCheckAt) slot.drainedAt = slot.lastCheckAt
      return { ...outcome.payload, text: renderText(outcome.payload) }
    },

    // A call that may have mutated several files. Every discovered file is taken
    // through the same single-file path -- so coalescing, stale detection and the
    // honesty contract are identical -- and the aggregate verdict states how
    // much of the call was actually proven.
    async noteMultiFile({ toolName, files, input, turnId } = {}) {
      const perFile = []
      for (const file of files) {
        const result = await controller.noteSingleFile({ toolName, relative: file, turnId })
        perFile.push(result)
      }
      // "Checked" means a file reached a proven terminal verdict. An unsupported,
      // refused, degraded, unavailable or still-pending file was NOT checked, and
      // counting it as checked is how a partially covered call gets laundered.
      const checked = perFile.filter((item) => item && (
        item.status === WRITE_FEEDBACK_STATUS.CLEAN
        || item.status === WRITE_FEEDBACK_STATUS.ERRORS
        || item.status === WRITE_FEEDBACK_STATUS.WARNINGS
      ))
      const summary = summarizeCall({ files: perFile, checked, toolName, singleFileContract: false })
      const text = [
        `UES post-write ${summary.toolName}: ${summary.status} (complete=${summary.complete}; ${summary.filesChecked}/${summary.filesDiscovered} file(s) checked${summary.reason ? "; " + summary.reason : ""})`,
        ...perFile.filter(Boolean).map((item) => "  " + renderText(item).split("\n")[0]),
        ...(summary.filesUnsupported.length
          ? [`  not instrumented (unsupported): ${summary.filesUnsupported.join(", ")}`]
          : []),
        ...(summary.filesNotProven.length
          ? [`  NOT verified this call: ${summary.filesNotProven.join(", ")}`]
          : []),
        ...(summary.status === WRITE_FEEDBACK_STATUS.CLEAN && summary.filesChecked < summary.filesDiscovered
          ? ["  this verdict covers only the checked files; the rest are unverified"]
          : []),
      ].join("\n")
      return { ...summary, files: perFile, text }
    },

    // Await the trailing check for one file, or for everything pending.
    async flush(relative) {
      if (closed) return null
      const file = relative == null ? null : normalizeRelativeFile(relative)
      const targets = file ? [slots.get(file)].filter(Boolean) : [...slots.values()]
      const payloads = []
      for (const slot of targets) {
        if (!slot.pendingTimer && !inflight.has(slot.relative) && slot.lastPayload) {
          payloads.push(slot.lastPayload)
          continue
        }
        const outcome = await settle(slot)
        if (slot.lastCheckAt) slot.drainedAt = slot.lastCheckAt
        payloads.push(outcome.payload)
      }
      if (file) return payloads[0] ? { ...payloads[0], text: renderText(payloads[0]) } : null
      const last = payloads[payloads.length - 1] || null
      return { files: payloads, ...controller.metrics(), last: last ? { ...last, text: renderText(last) } : null }
    },

    // Exact provider rows for the most recent check of a file, so a compacted
    // model-facing payload never becomes the only copy of the evidence.
    raw(relative) {
      const slot = slots.get(normalizeRelativeFile(relative))
      return slot?.raw || null
    },

    last(relative) {
      const slot = slots.get(normalizeRelativeFile(relative))
      return slot?.lastPayload || null
    },

    // Results a coalesced write is still owed.
    //
    // A coalesced write answers `pending` immediately so the tool result is not
    // held open, which means its final diagnostics arrive later and out of band.
    // Without a delivery path the model could end the turn having been told
    // "pending" and never learn the outcome -- the exact information loss this
    // phase exists to remove. `drain` runs on every tool result, so a completion
    // is delivered on whatever the model does next.
    drain() {
      if (closed) return []
      const out = []
      for (const slot of slots.values()) {
        if (!slot.lastPayload || !slot.lastCheckAt) continue
        if (slot.lastCheckAt <= slot.drainedAt) continue
        slot.drainedAt = slot.lastCheckAt
        // The stored payload is the compact object; it carries no rendered text
        // until it is rendered here. Returning it raw would look delivered while
        // delivering nothing.
        out.push({ ...slot.lastPayload, text: renderText(slot.lastPayload) })
      }
      return out
    },

    metrics() {
      return {
        turnChecks,
        trackedFiles: slots.size,
        inflight: inflight.size,
        perFileChecks: Object.fromEntries([...slots.values()].map((slot) => [slot.relative, slot.checksThisTurn])),
      }
    },

    resetTurn() {
      turnChecks = 0
      for (const slot of slots.values()) slot.checksThisTurn = 0
    },

    async shutdown() {
      closed = true
      for (const slot of slots.values()) {
        if (slot.pendingTimer) cancelSchedule(slot.pendingTimer)
        slot.pendingTimer = null
      }
      await Promise.allSettled([...inflight.values()])
      inflight.clear()
      slots.clear()
    },
  }

  return controller
}

function defaultSchedule(fn, delayMs) {
  const timer = setTimeout(() => { fn().catch(() => {}) }, Math.max(0, Number(delayMs || 0)))
  timer.unref?.()
  return timer
}

function defaultCancel(timer) {
  clearTimeout(timer)
}

// Reentrancy guard.
//
// The post-write signal is produced by the runtime, not by a tool call, so in
// the correct wiring it cannot start another write. This guard makes that a
// checked property instead of an assumption: if anything ever routes a check
// result back through a tool handler, the nested write is dropped and counted.
export function writeFeedbackGuard() {
  let depth = 0
  return {
    enter() {
      if (depth > 0) return false
      depth += 1
      return true
    },
    exit() {
      depth = Math.max(0, depth - 1)
    },
    get depth() {
      return depth
    },
  }
}
