// V16.10 Repo Intelligence V2.
//
// WHY THIS MODULE EXISTS
//
// V16.9 could rank repository files (`repo-map`), build a dependency graph
// (`repo-graph`), build a lexical/symbol index (`semantic-index`) and resolve
// affected tests (`affected-tests`). Each is a correct owner of its own fact.
// What was missing was an ORCHESTRATOR that answers the question a run actually
// asks - "what is relevant to THIS task, given THIS workspace, right now?" -
// without rebuilding three expensive artifacts from scratch on every process
// start and every query.
//
// Repo Intelligence V2 is that orchestrator. It OWNS exactly one behavior: the
// composition and cache lifecycle of repo analysis. It does NOT own ranking
// (that stays `buildRepoMap`), does NOT own graph construction (that stays
// `buildRepoGraph`), does NOT own symbol extraction (that stays
// `semantic-index`). It calls them and caches their RESULTS under a key that
// includes the workspace fingerprint, through `repo-intelligence-cache-v16-10`.
//
// GUARANTEES
//
//   * FINGERPRINT-SCOPED: a cached artifact is only ever reused when the
//     workspace fingerprint is unchanged. A changed tree recomputes. This is
//     what makes an on-disk cache safe: the key is the tree's identity, not a
//     wall-clock TTL.
//   * DEGRADES TO CORRECT: if any owner throws, the orchestrator reports the
//     degradation in `degraded` and returns the best available evidence rather
//     than inventing facts. A failed cache read is a miss, never a wrong answer.
//   * BOUNDED MODEL VIEW: `brief` is a small, honest summary of the ranking
//     (top files + why + affected tests), never a source dump. The full ranked
//     rows remain available for the controller/verifier.
//   * HONEST PROVENANCE: cache hits/misses and the fingerprint are published;
//     nothing claims to be freshly computed when it was reused.

import path from "node:path"
import { runtimeWorkspaceFingerprint } from "./workspace-fingerprint.mjs"
import { buildRepoGraphCached } from "./repo-graph.mjs"
import { buildSemanticIndexCached } from "./semantic-index.mjs"
import { buildRepoMap } from "./repo-map.mjs"
import { resolveAffectedTests } from "./affected-tests.mjs"
import {
  getOrComputeRepoIntel,
  stableOptionsDigest,
} from "./repo-intelligence-cache-v16-10.mjs"
import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const REPO_INTELLIGENCE_SCHEMA_VERSION = 2
export const REPO_INTELLIGENCE_POLICY = "repo-intelligence-v16-10"

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function fingerprintOf(root, options) {
  const provided = String(options.workspaceFingerprint || "")
  if (provided && provided !== "unknown") return provided
  try {
    return runtimeWorkspaceFingerprint(root)
  } catch {
    return "unknown"
  }
}

/**
 * Build (or reuse) the expensive repo artifacts through the persistent,
 * fingerprint-scoped cache.
 *
 * `kind` separates the artifacts so the graph and the semantic index never
 * collide; `optionsDigest` captures only the options that affect the artifact's
 * CONTENT (file limits, depth), never per-query options.
 */
async function cachedArtifacts(root, fingerprint, options) {
  const maxFiles = boundedInt(options.maxFiles, 6000, 1, 100_000)
  const graphDigest = stableOptionsDigest({ maxFiles, maxDepth: boundedInt(options.maxDepth, 8, 1, 64) })
  const semanticDigest = stableOptionsDigest({ maxFiles, maxDepth: boundedInt(options.semanticMaxDepth, 14, 1, 64) })

  const graph = await getOrComputeRepoIntel(
    root,
    { root, workspaceFingerprint: fingerprint, kind: "repo-graph", optionsDigest: graphDigest },
    () => buildRepoGraphCached(root, { maxFiles }),
    { persist: options.persistCache !== false, ttlMs: options.cacheTtlMs },
  ).catch((error) => ({ value: null, cacheHit: false, source: "error", error: String(error?.message || error) }))

  const semantic = await getOrComputeRepoIntel(
    root,
    { root, workspaceFingerprint: fingerprint, kind: "semantic-index", optionsDigest: semanticDigest },
    () => buildSemanticIndexCached(root, { maxFiles, workspaceFingerprint: fingerprint }),
    { persist: options.persistCache !== false, ttlMs: options.cacheTtlMs },
  ).catch((error) => ({ value: null, cacheHit: false, source: "error", error: String(error?.message || error) }))

  return { graph, semantic }
}

/**
 * The single entry point.
 *
 * Returns the ranked repo map plus the artifacts and cache receipts. The caller
 * gets a bounded `brief` for the model and the full `files` rows for control.
 */
export async function buildRepoIntelligence(root = process.cwd(), query = "", options = {}) {
  root = path.resolve(root)
  const startedAt = Date.now()
  const fingerprint = fingerprintOf(root, options)
  const degraded = []

  const { graph, semantic } = await cachedArtifacts(root, fingerprint, options)
  if (!graph.value) degraded.push({ artifact: "repo-graph", reason: graph.error || "unavailable" })
  if (!semantic.value) degraded.push({ artifact: "semantic-index", reason: semantic.error || "unavailable" })

  let map = null
  try {
    map = await buildRepoMap(root, query, {
      ...options,
      maxFiles: boundedInt(options.maxFiles, 6000, 1, 100_000),
      builtGraph: graph.value || undefined,
      builtSemantic: semantic.value || undefined,
      workspaceFingerprint: fingerprint === "unknown" ? "" : fingerprint,
      declaredFiles: options.declaredFiles,
      changedFiles: options.changedFiles,
      contextBudgetChars: options.contextBudgetChars,
      limit: options.limit,
    })
  } catch (error) {
    degraded.push({ artifact: "repo-map", reason: String(error?.message || error) })
  }

  let affected = { tests: [], suggestedCommands: [], degraded: true }
  try {
    affected = await resolveAffectedTests(root, {
      changedFiles: options.changedFiles,
      workspaceFingerprint: fingerprint === "unknown" ? "" : fingerprint,
      limit: options.affectedTestLimit,
    })
  } catch (error) {
    degraded.push({ artifact: "affected-tests", reason: String(error?.message || error) })
  }

  const files = (map?.files || []).map((row) => ({
    path: row.path,
    score: row.score,
    tier: row.tier,
    reasons: row.reasons,
    importantSymbols: row.importantSymbols,
    testLinks: row.testLinks,
  }))

  const brief = renderRepoIntelligenceBrief({ query, files, affected, stats: map?.stats, degraded })

  return {
    schemaVersion: REPO_INTELLIGENCE_SCHEMA_VERSION,
    policy: REPO_INTELLIGENCE_POLICY,
    kind: "ues-repo-intelligence",
    root,
    query: String(query || ""),
    workspaceFingerprint: fingerprint,
    files,
    affectedTests: affected.tests || [],
    suggestedCommands: affected.suggestedCommands || [],
    brief,
    stats: {
      ...(map?.stats || {}),
      affectedTests: (affected.tests || []).length,
      affectedTestsDegraded: affected.degraded === true,
      durationMs: Date.now() - startedAt,
      candidateFiles: files.length,
    },
    cache: {
      graph: { source: graph.source, cacheHit: graph.cacheHit === true },
      semantic: { source: semantic.source, cacheHit: semantic.cacheHit === true },
      fingerprintScoped: fingerprint !== "unknown",
    },
    degraded,
    provenance: {
      fingerprint: fingerprint === "unknown" ? NOT_MEASURED : measured(fingerprint.length),
      files: measured(files.length),
    },
  }
}

/**
 * The bounded, model-facing brief. It names the top files and WHY each was
 * ranked, plus the affected tests, and never inlines source. A reader can always
 * tell that this is a ranking, not the whole repository.
 */
export function renderRepoIntelligenceBrief(input = {}) {
  const files = Array.isArray(input.files) ? input.files.slice(0, 8) : []
  const lines = [`[repo intelligence: query="${input.query || ""}"]`]
  if (!files.length) {
    lines.push("no ranked files")
  } else {
    for (const row of files) {
      const symbols = (row.importantSymbols || []).slice(0, 3).join(",")
      const reasons = (row.reasons || []).slice(0, 3).join(",")
      lines.push(`- ${row.path} [${row.tier || "?"}] score=${row.score}${symbols ? ` symbols=${symbols}` : ""}${reasons ? ` why=${reasons}` : ""}`)
    }
  }
  const tests = (input.affected?.tests || []).slice(0, 6).map((row) => row.path)
  if (tests.length) lines.push(`affected tests: ${tests.join(", ")}`)
  if (Array.isArray(input.degraded) && input.degraded.length) {
    lines.push(`degraded: ${input.degraded.map((row) => row.artifact).join(", ")}`)
  }
  const stats = input.stats || {}
  if (Number.isFinite(Number(stats.candidateCount))) {
    lines.push(`candidates=${stats.candidateCount} selected=${stats.selectedCount} contextChars=${stats.contextChars}`)
  }
  return lines.join("\n")
}

/**
 * Prime the persistent cache for a workspace so the first real query is cheap.
 * Bounded and best-effort: a failure to warm is a miss, not an error.
 */
export async function warmRepoIntelligence(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const fingerprint = fingerprintOf(root, options)
  const { graph, semantic } = await cachedArtifacts(root, fingerprint, options)
  return {
    schemaVersion: REPO_INTELLIGENCE_SCHEMA_VERSION,
    policy: REPO_INTELLIGENCE_POLICY,
    root,
    workspaceFingerprint: fingerprint,
    warmed: {
      graph: Boolean(graph.value),
      semantic: Boolean(semantic.value),
    },
    cache: {
      graph: { source: graph.source, cacheHit: graph.cacheHit === true },
      semantic: { source: semantic.source, cacheHit: semantic.cacheHit === true },
    },
  }
}

/**
 * Explain a single file's placement WITHOUT re-ranking. It reads the already
 * ranked rows and returns the recorded contributions; if the file is absent it
 * says so rather than guessing. This is the verifier-facing view.
 */
export function explainRepoIntelligenceFile(result = {}, filePath = "") {
  const wanted = String(filePath || "").replaceAll("\\", "/")
  const row = (result.files || []).find((item) => String(item.path).replaceAll("\\", "/") === wanted)
  if (!row) {
    return { found: false, path: wanted, reason: "not-in-ranked-set", rankedCount: (result.files || []).length }
  }
  return {
    found: true,
    path: row.path,
    score: row.score,
    tier: row.tier,
    reasons: row.reasons || [],
    importantSymbols: row.importantSymbols || [],
    testLinks: row.testLinks || [],
    workspaceFingerprint: result.workspaceFingerprint,
  }
}

export const repoIntelligenceExports = Object.freeze({
  buildRepoIntelligence,
  warmRepoIntelligence,
  explainRepoIntelligenceFile,
  renderRepoIntelligenceBrief,
})
