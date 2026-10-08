// V16.5 Phase 8: bounded parallel delegation safety.
//
// Parallelism is permitted only when file/evidence scope is provably disjoint.
// Two writers on overlapping files, parallel destructive shell, the same external
// side effect, or the same mutable service are all blocked fail-closed.
//
// This module classifies scope. It does not schedule; the existing task-graph
// safe-wave / writer-concurrency logic remains the execution authority.
//
// ---------------------------------------------------------------------------
// V16.15: PAIR DECISIONS ARE DELEGATED TO THE CONFLICT GRAPH
// ---------------------------------------------------------------------------
//
// V16.5 decided pair safety from a COARSE signal: it reduced every path to a
// two-segment "root" and serialized any two writers sharing a root. That
// over-serializes real work -- `lib/a.mjs` and `lib/b.mjs` are different files
// that cannot corrupt each other -- and it under-protects in one case: a writer
// that declared no files at all looked "disjoint" because its root set was empty.
//
// V16.15 keeps this module as the owner of the DECISION SURFACE (which reasons
// exist, which scope is serial-only, what a wave may contain) and delegates the
// exact PAIR verdict to `lib/execution-conflict-graph-v16-15.mjs`, which reasons
// about exact files, read/write direction, config families, lockfile/manifest
// interaction, generated outputs, declared module edges, shared services and
// external effects -- and fails closed on an UNKNOWN scope.
//
// The coarse root rule is still available as an explicit fallback
// (`pairStrategy: "legacy-roots"`) so a caller that cannot supply exact
// declarations is never silently upgraded to a weaker or stronger rule.

import { SUBAGENT_FABRIC_SCHEMA_VERSION } from "./subagent-fabric.mjs"
import {
  CONFLICT_KIND,
  PAIR_VERDICT,
  classifyPair,
  normalizeScope,
} from "./execution-conflict-graph-v16-15.mjs"

export const PARALLEL_SAFETY = Object.freeze({
  ALLOWED: "allowed",
  BLOCKED: "blocked",
})

export const PARALLEL_BLOCK_REASON = Object.freeze({
  OVERLAPPING_FILES: "overlapping-files",
  WRITER_OVERLAP: "writer-overlap",
  MUTABLE_SERVICE: "mutable-service",
  EXTERNAL_SIDE_EFFECT: "external-side-effect",
  DESTRUCTIVE_SHELL: "destructive-shell",
  CAPACITY: "capacity",
  // V16.15: a writer that declared no usable write scope. V16.5 let this through
  // as "disjoint"; silence is never safety, so it is serial-only now.
  SCOPE_UNKNOWN: "scope-unknown",
})

/** Which rule decides a PAIR. Stable ids; do not rename casually. */
export const PAIR_STRATEGY = Object.freeze({
  // Exact-file conflict graph (V16.15 default).
  CONFLICT_GRAPH: "conflict-graph",
  // V16.5 two-segment root overlap (explicit fallback only).
  LEGACY_ROOTS: "legacy-roots",
})

// Conflict kinds that are a FILE-level overlap (they justify the V16.5
// `overlappingScopeBlocks` metric). Service / external-effect / destructive-shell
// / unknown-scope pairs are scope-level blocks and are counted separately, so the
// existing metric keeps exactly its V16.5 meaning.
const FILE_LEVEL_CONFLICT_KINDS = new Set([
  CONFLICT_KIND.WRITE_WRITE_SAME_FILE,
  CONFLICT_KIND.READ_WRITE_DEPENDENCY,
  CONFLICT_KIND.SHARED_CONFIG_FAMILY,
  CONFLICT_KIND.LOCKFILE_PACKAGE_INTERACTION,
  CONFLICT_KIND.GENERATED_OUTPUT,
  CONFLICT_KIND.MODULE_DEPENDENCY,
])

const DESTRUCTIVE_SHELL_PATTERN = /\b(rm\s+-rf|del\s+\/|drop\s+(table|database)|truncate\s+table|git\s+push|git\s+reset\s+--hard|git\s+clean|rmdir\s+\/s|kubectl\s+delete|terraform\s+apply\s+-destroy)\b/i
const EXTERNAL_SIDE_EFFECT_PATTERN = /\b(publish|deploy|npm\s+publish|send\s+email|post\s+to\s+webhook|release|tag)\b/i
const MUTABLE_SERVICE_PATTERN = /\b(dev server|background service|watch mode|database container|docker-compose\s+up|service)\b/i

function unique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))]
}

/** Classify one delegation scope. */
export function classifyScope(spec = {}) {
  const files = unique(spec.files)
  const text = String(spec.task || "")
  const writer = spec.readOnly === false
  const destructiveShell = DESTRUCTIVE_SHELL_PATTERN.test(text)
  const externalSideEffect = EXTERNAL_SIDE_EFFECT_PATTERN.test(text)
  const mutableService = MUTABLE_SERVICE_PATTERN.test(text)
  const roots = unique(files.map((file) => file.split("/").slice(0, 2).join("/")))
  // V16.15: a WRITER that declared no file at all cannot be reasoned about.
  // V16.5 treated it as "disjoint" because its root set was empty; that is
  // silence-as-safety, so it is serial-only now.
  const scopeUnknown = writer && files.length === 0

  return {
    role: String(spec.role || ""),
    childId: String(spec.childId || ""),
    files,
    fileCount: files.length,
    roots,
    writer,
    readOnly: !writer,
    destructiveShell,
    externalSideEffect,
    mutableService,
    scopeUnknown,
    // Read-only lanes may run in parallel. A writer is only parallel-safe if it
    // has no shell/service/external side effect and a DECLARED write scope.
    //
    // V16.15: `roots.length > 1` is no longer serial-only. A writer spanning two
    // directories is not unsafe by itself; what matters is whether the OTHER
    // scope in the pair touches the same exact files, config family or module.
    // That question is answered per pair below, not per scope.
    parallelClass: destructiveShell || externalSideEffect || scopeUnknown
      ? "serial-only"
      : writer
        ? (mutableService ? "serial-only" : "disjoint-writer")
        : "read-only",
  }
}

function overlap(a, b) {
  const left = new Set(a.files)
  const right = new Set(b.files)
  const shared = [...left].filter((file) => right.has(file))
  const sharedRoots = unique(a.roots.filter((root) => b.roots.includes(root)))
  return { shared, sharedRoots }
}

/**
 * V16.15: translate a V16.5-classified scope into the conflict graph's shape.
 *
 * Two translations matter:
 *
 *   1. `files` direction. For a WRITER they are write files; for a READ-ONLY
 *      lane they are files the lane READS. The conflict graph must not be told a
 *      reader writes what it only reads, or two readers of one file would be
 *      reported as a write/write conflict.
 *   2. IDENTITY. V16.5 scopes are commonly identified by role alone, so two
 *      `explore` lanes would arrive with the SAME id and the graph would (by its
 *      own fail-closed rule) call them one scope. The index is appended so every
 *      scope the caller declared stays a distinct node.
 */
function graphScopeFor(scope, index) {
  const declared = {
    id: `${String(scope.childId || scope.role || "scope")}#${index}`,
    role: scope.role,
    readOnly: scope.writer !== true,
    destructiveShell: scope.destructiveShell === true,
    externalSideEffect: scope.externalSideEffect === true,
    mutableService: scope.mutableService === true,
  }
  if (scope.writer === true) declared.writeFiles = unique(scope.files)
  else declared.readFiles = unique(scope.files)
  return normalizeScope(declared, index)
}

/** Map one conflict-graph relation kind to the V16.5 block vocabulary. */
function blockReasonForKind(kind, left, right) {
  switch (kind) {
    case CONFLICT_KIND.WRITE_WRITE_SAME_FILE:
      return left.writer && right.writer ? PARALLEL_BLOCK_REASON.WRITER_OVERLAP : PARALLEL_BLOCK_REASON.OVERLAPPING_FILES
    case CONFLICT_KIND.READ_WRITE_DEPENDENCY:
    case CONFLICT_KIND.SHARED_CONFIG_FAMILY:
    case CONFLICT_KIND.LOCKFILE_PACKAGE_INTERACTION:
    case CONFLICT_KIND.GENERATED_OUTPUT:
    case CONFLICT_KIND.MODULE_DEPENDENCY:
      return PARALLEL_BLOCK_REASON.OVERLAPPING_FILES
    case CONFLICT_KIND.SHARED_MUTABLE_SERVICE:
      return PARALLEL_BLOCK_REASON.MUTABLE_SERVICE
    case CONFLICT_KIND.SAME_EXTERNAL_SIDE_EFFECT:
      return PARALLEL_BLOCK_REASON.EXTERNAL_SIDE_EFFECT
    case CONFLICT_KIND.DESTRUCTIVE_SHELL:
      return PARALLEL_BLOCK_REASON.DESTRUCTIVE_SHELL
    case CONFLICT_KIND.UNKNOWN_SCOPE:
      return PARALLEL_BLOCK_REASON.SCOPE_UNKNOWN
    default:
      // An unrecognized relation kind is a conflict we cannot name. Fail closed
      // with the file-level reason rather than dropping it.
      return PARALLEL_BLOCK_REASON.OVERLAPPING_FILES
  }
}

/**
 * V16.5 pair rule: two writers sharing a two-segment root, or any two scopes
 * sharing an exact file. Kept as an EXPLICIT fallback (`pairStrategy:
 * "legacy-roots"`) for a caller that cannot supply exact declarations.
 */
function legacyPairBlocks(a, b) {
  const { shared, sharedRoots } = overlap(a, b)
  if (a.writer && b.writer && (shared.length || sharedRoots.length)) {
    return [{
      pair: [a.childId || a.role, b.childId || b.role],
      reason: PARALLEL_BLOCK_REASON.WRITER_OVERLAP,
      shared: shared.slice(0, 10),
      sharedRoots,
    }]
  }
  if (shared.length) {
    return [{
      pair: [a.childId || a.role, b.childId || b.role],
      reason: PARALLEL_BLOCK_REASON.OVERLAPPING_FILES,
      shared: shared.slice(0, 10),
    }]
  }
  return []
}

/**
 * Assess a set of delegation scopes. Returns an explicit plan: which scopes may
 * run together, and the exact reason anything was serialized.
 */
export function assessParallelSafety(scopes = [], options = {}) {
  const classified = (scopes || []).map((scope) => (scope.parallelClass ? scope : classifyScope(scope)))
  const maxParallel = Math.max(1, Math.min(3, Number(options.maxParallel) || 2))
  const pairStrategy = options.pairStrategy === PAIR_STRATEGY.LEGACY_ROOTS
    ? PAIR_STRATEGY.LEGACY_ROOTS
    : PAIR_STRATEGY.CONFLICT_GRAPH
  const blocks = []

  for (const scope of classified) {
    const id = scope.childId || scope.role
    if (scope.destructiveShell) blocks.push({ childId: id, reason: PARALLEL_BLOCK_REASON.DESTRUCTIVE_SHELL })
    if (scope.externalSideEffect) blocks.push({ childId: id, reason: PARALLEL_BLOCK_REASON.EXTERNAL_SIDE_EFFECT })
    if (scope.mutableService && scope.writer) blocks.push({ childId: id, reason: PARALLEL_BLOCK_REASON.MUTABLE_SERVICE })
    if (scope.scopeUnknown) blocks.push({ childId: id, reason: PARALLEL_BLOCK_REASON.SCOPE_UNKNOWN })
  }
  // Reasons already reported per scope; a pair block would only repeat them.
  const scopeLevelReasons = new Set(blocks.map((block) => block.reason))

  for (let i = 0; i < classified.length; i += 1) {
    for (let j = i + 1; j < classified.length; j += 1) {
      const a = classified[i]
      const b = classified[j]
      if (pairStrategy === PAIR_STRATEGY.LEGACY_ROOTS) {
        blocks.push(...legacyPairBlocks(a, b))
        continue
      }
      const left = graphScopeFor(a, i)
      const right = graphScopeFor(b, j)
      const pair = classifyPair(left, right, {
        moduleEdges: options.moduleEdges,
        generatedEdges: options.generatedEdges,
      })
      if (pair.verdict !== PAIR_VERDICT.CONFLICT) continue
      const kinds = unique(pair.relations.map((relation) => relation.kind))
      const reasons = unique(kinds.map((kind) => blockReasonForKind(kind, a, b)))
        .filter((reason) => !scopeLevelReasons.has(reason))
      for (const reason of reasons) {
        const sharedFiles = unique(
          pair.relations.flatMap((relation) => relation.files || []),
        )
        blocks.push({
          pair: [a.childId || a.role, b.childId || b.role],
          reason,
          kinds,
          ...(sharedFiles.length ? { shared: sharedFiles.slice(0, 10) } : {}),
        })
      }
    }
  }

  const serialOnly = classified.filter((scope) => scope.parallelClass === "serial-only")
  const parallelCandidates = classified.filter((scope) => scope.parallelClass !== "serial-only")
  const duplicateWork = duplicateScopeCount(classified)

  const allowed = blocks.length === 0 && serialOnly.length === 0 && parallelCandidates.length <= maxParallel
  if (parallelCandidates.length > maxParallel) {
    blocks.push({ reason: PARALLEL_BLOCK_REASON.CAPACITY, parallelCandidates: parallelCandidates.length, maxParallel })
  }

  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    decision: allowed ? PARALLEL_SAFETY.ALLOWED : PARALLEL_SAFETY.BLOCKED,
    scopes: classified,
    parallelCandidates: parallelCandidates.map((scope) => scope.childId || scope.role),
    serialOnly: serialOnly.map((scope) => scope.childId || scope.role),
    maxParallel,
    pairStrategy,
    blocks,
    overlappingScopeBlocks: blocks.filter((block) =>
      block.reason === PARALLEL_BLOCK_REASON.OVERLAPPING_FILES || block.reason === PARALLEL_BLOCK_REASON.WRITER_OVERLAP,
    ).length,
    duplicateWork,
  }
}

function duplicateScopeCount(classified) {
  const seen = new Map()
  let duplicates = 0
  for (const scope of classified) {
    const key = unique(scope.files).sort().join("|")
    if (!key) continue
    if (seen.has(key)) duplicates += 1
    else seen.set(key, scope.childId || scope.role)
  }
  return duplicates
}

/**
 * Build waves: each wave is a set of scopes safe to run concurrently.
 * Greedy and deterministic (input order preserved).
 */
export function buildDelegationWaves(scopes = [], options = {}) {
  const assessment = assessParallelSafety(scopes, options)
  const waves = []
  const remaining = [...assessment.scopes]

  while (remaining.length) {
    const head = remaining.shift()
    const wave = [head]
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      if (wave.length >= assessment.maxParallel) break
      const candidate = remaining[i]
      const probe = assessParallelSafety([...wave, candidate], { maxParallel: assessment.maxParallel })
      if (probe.decision === PARALLEL_SAFETY.ALLOWED) {
        wave.push(candidate)
        remaining.splice(i, 1)
      }
    }
    waves.push({
      wave: waves.length + 1,
      // Positional index into the input order, so a caller can execute exactly
      // the classified objects this wave contains without a second classifier.
      indexes: wave.map((scope) => scopes.findIndex((entry) => entry === scope)),
      scopes: wave.map((scope) => scope.childId || scope.role),
      parallelClasses: [...new Set(wave.map((scope) => scope.parallelClass))],
      safe: wave.length > 1,
    })
  }

  return {
    schemaVersion: SUBAGENT_FABRIC_SCHEMA_VERSION,
    waves,
    waveCount: waves.length,
    parallelWaves: waves.filter((row) => row.safe).length,
    maxParallel: assessment.maxParallel,
    blocks: assessment.blocks,
    overlappingScopeBlocks: assessment.overlappingScopeBlocks,
    duplicateWork: assessment.duplicateWork,
    decision: assessment.decision,
  }
}
