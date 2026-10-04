// V16.5 Phase 8: bounded parallel delegation safety.
//
// Parallelism is permitted only when file/evidence scope is provably disjoint.
// Two writers on overlapping files, parallel destructive shell, the same external
// side effect, or the same mutable service are all blocked fail-closed.
//
// This module classifies scope. It does not schedule; the existing task-graph
// safe-wave / writer-concurrency logic remains the execution authority.

import { SUBAGENT_FABRIC_SCHEMA_VERSION } from "./subagent-fabric.mjs"

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
})

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
    // Read-only lanes may run in parallel. A writer is only parallel-safe if it
    // declares disjoint roots AND has no shell/service/external side effect.
    parallelClass: destructiveShell || externalSideEffect
      ? "serial-only"
      : writer
        ? (mutableService || roots.length > 1 ? "serial-only" : "disjoint-writer")
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
 * Assess a set of delegation scopes. Returns an explicit plan: which scopes may
 * run together, and the exact reason anything was serialized.
 */
export function assessParallelSafety(scopes = [], options = {}) {
  const classified = (scopes || []).map((scope) => (scope.parallelClass ? scope : classifyScope(scope)))
  const maxParallel = Math.max(1, Math.min(3, Number(options.maxParallel) || 2))
  const blocks = []

  for (const scope of classified) {
    if (scope.destructiveShell) blocks.push({ childId: scope.childId || scope.role, reason: PARALLEL_BLOCK_REASON.DESTRUCTIVE_SHELL })
    if (scope.externalSideEffect) blocks.push({ childId: scope.childId || scope.role, reason: PARALLEL_BLOCK_REASON.EXTERNAL_SIDE_EFFECT })
    if (scope.mutableService && scope.writer) blocks.push({ childId: scope.childId || scope.role, reason: PARALLEL_BLOCK_REASON.MUTABLE_SERVICE })
  }

  for (let i = 0; i < classified.length; i += 1) {
    for (let j = i + 1; j < classified.length; j += 1) {
      const a = classified[i]
      const b = classified[j]
      const { shared, sharedRoots } = overlap(a, b)
      if (a.writer && b.writer && (shared.length || sharedRoots.length)) {
        blocks.push({ pair: [a.childId || a.role, b.childId || b.role], reason: PARALLEL_BLOCK_REASON.WRITER_OVERLAP, shared: shared.slice(0, 10), sharedRoots })
      } else if (shared.length) {
        blocks.push({ pair: [a.childId || a.role, b.childId || b.role], reason: PARALLEL_BLOCK_REASON.OVERLAPPING_FILES, shared: shared.slice(0, 10) })
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
