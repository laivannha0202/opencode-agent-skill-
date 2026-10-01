import path from "node:path"
import { diagnoseCode } from "./code-intelligence/lsp-provider.mjs"

const STATIC_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".py", ".pyi", ".java", ".kt", ".kts", ".cs", ".go", ".rs", ".rb", ".php",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".swift", ".scala", ".vue", ".svelte",
])

function normalizeFile(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim()
}

function severityOf(row = {}) {
  const value = Number(row?.severity)
  if (value === 1) return "error"
  if (value === 2) return "warning"
  return String(row?.severity || "").toLowerCase()
}

export function fastStaticVerificationCandidates(snapshot = {}) {
  const files = [...new Set(
    (Array.isArray(snapshot?.changedFiles) ? snapshot.changedFiles : [])
      .map(normalizeFile)
      .filter(Boolean),
  )]
  return files.filter((file) => STATIC_EXTENSIONS.has(path.posix.extname(file).toLowerCase()))
}

export async function collectFastStaticEvidence(root, snapshot = {}, options = {}) {
  const candidates = fastStaticVerificationCandidates(snapshot)
  if (!candidates.length) {
    return {
      schemaVersion: 1,
      required: false,
      complete: true,
      errorCount: 0,
      warningCount: 0,
      file: null,
      source: null,
      fingerprint: null,
      reason: "no-static-provider-target",
    }
  }

  if (candidates.length !== 1) {
    return {
      schemaVersion: 1,
      required: true,
      complete: false,
      errorCount: 0,
      warningCount: 0,
      file: null,
      files: candidates.slice(0, 16),
      source: null,
      fingerprint: null,
      reason: "static-scope-not-single-file",
    }
  }

  const file = candidates[0]
  const diagnostics = await diagnoseCode(root, file, {
    timeoutMs: Math.max(1_500, Math.min(15_000, Number(options.timeoutMs || 5_000))),
    maxResults: Math.max(10, Math.min(120, Number(options.maxResults || 60))),
    persistent: true,
    diagnosticsBudgetPolicy: "fast-completeness-gate-v2",
  }).catch((error) => ({
    complete: false,
    diagnostics: [],
    reason: "static-diagnostics-error",
    diagnosticsSource: "none",
    diagnosticsEvidenceFingerprint: null,
    error: error instanceof Error ? error.message : String(error),
  }))

  const rows = Array.isArray(diagnostics?.diagnostics) ? diagnostics.diagnostics : []
  const errorCount = rows.filter((row) => severityOf(row) === "error").length
  const warningCount = rows.filter((row) => severityOf(row) === "warning").length

  return {
    schemaVersion: 1,
    required: true,
    complete: diagnostics?.complete === true,
    errorCount,
    warningCount,
    file,
    source: diagnostics?.diagnosticsSource || diagnostics?.source || null,
    fingerprint: diagnostics?.diagnosticsEvidenceFingerprint || null,
    reason: diagnostics?.complete === true
      ? errorCount > 0 ? "static-errors" : "static-complete"
      : diagnostics?.diagnosticsReason || diagnostics?.reason || "static-diagnostics-incomplete",
    diagnosticsFallbackUsed: diagnostics?.diagnosticsFallbackUsed === true,
    diagnosticsFallbackReason: diagnostics?.diagnosticsFallbackReason || null,
  }
}
