import path from "node:path"

// V16.18: the LSP provider is NO LONGER statically imported. This module is
// EAGER because it is verifier POLICY (it decides whether a static diagnostic is
// required at all, and it runs before any LSP process exists), but the provider
// itself hydrates on FIRST REAL DIAGNOSTIC USE. A docs/config task therefore
// never loads the language-server stack. `lib/lazy-runtime.mjs` is the ONE owner
// of the cached, joined, single-flight hydration, so a concurrent second caller
// joins the same import instead of racing it.
import { hydrateRuntimeModule, isLazyModuleLoaded, LAZY_RUNTIME_MODULES } from "./lazy-runtime.mjs"

const isLazyLspProviderLoaded = () => isLazyModuleLoaded(LAZY_RUNTIME_MODULES.LSP_PROVIDER)

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
  // Only NOW is a diagnostic genuinely required, so only now does the LSP stack
  // hydrate. A failure to hydrate degrades to an incomplete result that the
  // existing completeness gate already treats as "not proven" -- it is never a
  // fake PASS.
  const provider = await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.LSP_PROVIDER, { fallback: null })
  if (!provider || typeof provider.diagnoseCode !== "function") {
    return {
      schemaVersion: 1,
      required: true,
      complete: false,
      errorCount: 0,
      warningCount: 0,
      file,
      files: [file],
      source: null,
      fingerprint: null,
      reason: "static-provider-unavailable",
    }
  }

  const diagnostics = await provider.diagnoseCode(root, file, {
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

/**
 * V16.18: bounded shutdown for the LANGUAGE-SERVER STACK.
 *
 * The pool is reachable only through `lib/lazy-runtime.mjs`, so a session that
 * never hydrated it does NOT import the whole LSP stack just to shut down an
 * empty pool. When the stack WAS hydrated, shutdown still runs reliably through
 * the same module the pool owns. Cleanup strength is unchanged either way.
 */
export async function shutdownFastStaticLspProvider() {
  if (typeof isLazyLspProviderLoaded === "function" && !isLazyLspProviderLoaded()) {
    return { stopped: 0, remaining: 0, hydrated: false, reason: "lsp-provider-never-hydrated" }
  }
  const provider = await hydrateRuntimeModule(LAZY_RUNTIME_MODULES.LSP_PROVIDER, { fallback: null })
  if (!provider || typeof provider.shutdownLspPool !== "function") {
    return { stopped: 0, remaining: 0, hydrated: false, reason: "lsp-provider-unavailable" }
  }
  const result = await provider.shutdownLspPool().catch(() => ({ stopped: 0, remaining: 0 }))
  return { ...(result || {}), stopped: Number(result?.stopped || 0), remaining: Number(result?.remaining || 0), hydrated: true }
}
