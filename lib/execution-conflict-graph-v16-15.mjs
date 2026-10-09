// V16.15 Execution Conflict Graph V2.
//
// WHY THIS MODULE EXISTS
//
// V16.5 `lib/delegation-safety.mjs` decided write safety from a COARSE signal:
// it reduced every file to a two-segment "root" (`lib/task-graph.mjs` ->
// `lib/task-graph.mjs`, but `packages/a/src/x.ts` -> `packages/a`) and then
// serialized any two writers that shared a root, or any single writer whose
// files spanned more than one root. Both rules are over-conservative:
//
//   * two writers editing DIFFERENT exact files in the SAME directory were
//     serialized even though they cannot corrupt each other;
//   * two writers in DIFFERENT isolated packages were serialized;
//   * a single writer spanning two directories was forced serial-only even when
//     nothing else was running.
//
// The cost of that conservatism is real wall time, and V16.15 exists to remove
// it WITHOUT weakening the one safety law that matters: a read must never race a
// write to the same file and be treated as fresh.
//
// WHAT THIS MODULE OWNS
//
// Exactly one question: given a set of declared write scopes, read scopes,
// side-effect classes and (optional) known module edges, which pairs are
// PROVABLY INDEPENDENT, which CONFLICT, and which are UNKNOWN?
//
// It is a pure decision function. It schedules nothing, spawns nothing, writes
// nothing. The execution authority stays with the existing owners
// (`lib/task-graph.mjs` wave order, `lib/task-dag-scheduler-v16-12.mjs` overlap,
// `lib/delegation-fleet.mjs` bounded child execution).
//
// RELATION KINDS (every one is a FACT about the input, never intuition)
//
//   WRITE_WRITE_SAME_FILE          A writes F, B writes F
//   READ_WRITE_DEPENDENCY          A reads F, B writes F (either direction)
//   SHARED_CONFIG_FAMILY           both write members of one shared config family
//   LOCKFILE_PACKAGE_INTERACTION   a lockfile writer vs any manifest writer
//   GENERATED_OUTPUT               A writes what B declares as generated output
//   MODULE_DEPENDENCY              known module edge between two written modules
//   SHARED_MUTABLE_SERVICE         both touch the same mutable service
//   SAME_EXTERNAL_SIDE_EFFECT      both perform the same external side effect
//   DESTRUCTIVE_SHELL              any destructive shell command
//   UNKNOWN_SCOPE                  a writer with no declared write scope
//
// FAIL-CLOSED LAWS
//
//   1. UNKNOWN IS NOT INDEPENDENT. A scope that declares no write files, or a
//      file path that cannot be normalized inside the repository, is UNKNOWN and
//      conflicts with everything. Silence is never treated as safety.
//   2. SAME DIRECTORY IS NOT A CONFLICT. Only exact files, config families,
//      generated-output edges and declared dependencies create conflict.
//   3. DIFFERENT ISOLATED PACKAGES ARE INDEPENDENT unless a shared config family,
//      a lockfile interaction or a declared module edge says otherwise.
//   4. EVERY VERDICT CARRIES A REASON. There is no "AI intuition" branch and no
//      default-allow. `reasons` is always populated for both outcomes.

import { createHash } from "node:crypto"
import path from "node:path"

export const CONFLICT_GRAPH_SCHEMA_VERSION = 1
export const CONFLICT_GRAPH_POLICY = "execution-conflict-graph-v16-15"

/** Pair relation kinds. Stable ids; do not rename casually. */
export const CONFLICT_KIND = Object.freeze({
  WRITE_WRITE_SAME_FILE: "write-write-same-file",
  READ_WRITE_DEPENDENCY: "read-write-dependency",
  SHARED_CONFIG_FAMILY: "shared-config-family",
  LOCKFILE_PACKAGE_INTERACTION: "lockfile-package-interaction",
  GENERATED_OUTPUT: "generated-output",
  MODULE_DEPENDENCY: "module-dependency",
  SHARED_MUTABLE_SERVICE: "shared-mutable-service",
  SAME_EXTERNAL_SIDE_EFFECT: "same-external-side-effect",
  DESTRUCTIVE_SHELL: "destructive-shell",
  UNKNOWN_SCOPE: "unknown-scope",
})

/** Per-scope classification. */
export const SCOPE_CERTAINTY = Object.freeze({
  INDEPENDENT: "independent",
  CONFLICT: "conflict",
  UNKNOWN: "unknown",
})

/** Pair verdict. */
export const PAIR_VERDICT = Object.freeze({
  INDEPENDENT: "independent",
  CONFLICT: "conflict",
})

// ---------------------------------------------------------------------------
// shared mutable state classes
// ---------------------------------------------------------------------------

/**
 * Shared config FAMILIES. Two writers that touch the same family can corrupt the
 * same generated/locked state even when the exact paths differ (a root
 * `package.json` edit and a workspace `package-lock.json` refresh).
 */
export const SHARED_CONFIG_FAMILY = Object.freeze([
  Object.freeze({
    id: "node-dependencies",
    // Every manifest AND every lockfile of the Node dependency graph.
    pattern: /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/,
    reason: "same Node dependency family (manifest/lockfile interaction)",
  }),
  Object.freeze({
    id: "typescript-root-config",
    pattern: /^tsconfig(\.[A-Za-z0-9_-]+)?\.json$/,
    reason: "root TypeScript project config is shared build state",
  }),
  Object.freeze({
    id: "bundler-root-config",
    pattern: /^(vite|rollup|webpack|esbuild|rspack)\.config\.(mjs|cjs|js|ts)$/,
    reason: "root bundler config is shared build state",
  }),
  Object.freeze({
    id: "repository-attributes",
    pattern: /^\.(gitattributes|gitignore|npmrc)$/,
    reason: "repository-wide attribute/config file affects every path",
  }),
])

const LOCKFILE_RE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/
const MANIFEST_RE = /(^|\/)(package\.json)$/

const DESTRUCTIVE_SHELL_PATTERN =
  /\b(rm\s+-rf|del\s+\/|drop\s+(table|database)|truncate\s+table|git\s+push|git\s+reset\s+--hard|git\s+clean|rmdir\s+\/s|kubectl\s+delete|terraform\s+apply\s+-destroy)\b/i

// V16.16: natural-language task text is a WEAK signal. Bare words like
// "service", "tag", "release", "publish" or "deploy" appear constantly in
// source-code descriptions ("update service class", "fix HTML tag rendering",
// "release lock in mutex", "tag parser bug") and must NEVER imply a runtime
// side effect. Only unambiguously external phrasing counts here. Structured
// declarations (services/externalEffects arrays, explicit flags) and ACTUAL
// planned commands stay STRONG (see COMMAND_EXTERNAL_PATTERN below).
const WEAK_EXTERNAL_SIDE_EFFECT_PATTERN =
  /\b(npm\s+publish|git\s+push|git\s+tag\s+\S|gh\s+release\s+\S|send\s+email|post\s+to\s+webhook|deploy\s+to\s+\S|release\s+to\s+\S|publish\s+to\s+\S|trigger\s+(a\s+)?deploy)\b/i

const WEAK_MUTABLE_SERVICE_PATTERN =
  /\b(dev\s+server|background\s+service|watch\s+mode|database\s+container|docker-compose\s+up|docker\s+compose\s+up|systemctl\b|pm2\s+(start|restart|stop)|restart\s+the\s+\S+\s+service|shared\s+mutable\s+service)\b/i

// A DECLARED planned shell command is not natural language: it is what the
// child will actually execute. Bare verbs here ARE evidence.
const COMMAND_EXTERNAL_PATTERN =
  /\b(npm\s+publish|git\s+push|git\s+tag|gh\s+release|\bdeploy\b|\bpublish\b|send\s+email|post\s+to\s+webhook)\b/i

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value ?? "").trim()).filter(Boolean))].sort()
}

/**
 * A scope is "normalized" when it carries the derived fields `normalizeScope`
 * adds. Detecting that structurally (rather than by the presence of `writeFiles`)
 * is what lets `classifyPair` accept BOTH a raw declaration and an already
 * normalized scope without re-normalizing one and losing its UNKNOWN verdict.
 */
function isNormalizedScope(scope) {
  return Boolean(scope)
    && Array.isArray(scope.writeFiles)
    && Array.isArray(scope.configFamilies)
    && typeof scope.scopeUnknown === "boolean"
}

function unsafeRepoPath(value) {
  const raw = String(value || "").replaceAll("\\", "/")
  if (!raw) return true
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return true
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "")
  return normalized === ".." || normalized.startsWith("../") || normalized === "."
}

/** Normalize one repository-relative file. Returns "" for an unusable path. */
export function normalizeConflictPath(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return ""
  if (unsafeRepoPath(raw)) return ""
  return path.posix.normalize(raw.replaceAll("\\", "/")).replace(/^\.\//, "")
}

function configFamiliesOf(files) {
  const families = new Set()
  for (const file of files) {
    for (const family of SHARED_CONFIG_FAMILY) {
      if (family.pattern.test(file)) families.add(family.id)
    }
  }
  return [...families].sort()
}

/**
 * Is this declared scope a WRITER?
 *
 * This is the ONE rule in the system. It is deliberately conservative: only an
 * explicit `readOnly: true` (or `writer: false`) makes a scope a reader, and
 * everything else that is not provably read-only is treated as a writer. A
 * scope that declared NOTHING is therefore a writer with an UNKNOWN scope, not
 * a harmless reader. Two modules answering this question differently is how a
 * "reader" ends up writing over a sibling.
 *
 * @param {object} spec raw scope declaration
 */
export function isWriterScope(spec = {}) {
  if (spec.readOnly === true || spec.writer === false) return false
  if (spec.readOnly === false || spec.writer === true) return true
  const declared = Array.isArray(spec.writeFiles) ? spec.writeFiles
    : Array.isArray(spec.write) ? spec.write
      : Array.isArray(spec.files) ? spec.files
        : []
  const hasWriteDeclaration = declared.some((value) => String(value ?? "").trim())
  if (hasWriteDeclaration) return true
  const hasReadDeclaration = (Array.isArray(spec.readFiles) ? spec.readFiles : Array.isArray(spec.read) ? spec.read : [])
    .some((value) => String(value ?? "").trim())
  // A scope that declared ONLY reads, and never claimed to write, is a reader.
  if (hasReadDeclaration) return false
  // Declared nothing at all: it cannot be proven read-only, so it is a writer
  // whose scope is UNKNOWN. Silence is never safety.
  return true
}

/**
 * Normalize one scope declaration into the bounded shape the graph reasons
 * about. Every field is optional; an absent field is treated as "not declared",
 * which is exactly the information the fail-closed rules need.
 */
export function normalizeScope(spec = {}, index = 0) {
  const declaredWrite = Array.isArray(spec.writeFiles) ? spec.writeFiles
    : Array.isArray(spec.write) ? spec.write
      : Array.isArray(spec.files) ? spec.files
        : []
  const rawWrite = declaredWrite.map(String)
  const writeFiles = uniqueSorted(rawWrite.map(normalizeConflictPath).filter(Boolean))
  // A path that was DECLARED but could not be normalized is not dropped silently:
  // it downgrades the whole scope to UNKNOWN.
  const unnormalizable = rawWrite.filter((value) => String(value || "").trim() && !normalizeConflictPath(value))

  const declaredRead = Array.isArray(spec.readFiles) ? spec.readFiles
    : Array.isArray(spec.read) ? spec.read
      : []
  const readFiles = uniqueSorted(declaredRead.map(String).map(normalizeConflictPath).filter(Boolean))

  const task = String(spec.task || spec.goal || "")
  // "Is this a writer?" is decided by DECLARATION through the ONE shared rule
  // (`isWriterScope`), so the graph and the execution policy can never disagree.
  // A scope that declared only hostile paths is still a writer, and it is a
  // writer whose scope is UNKNOWN.
  const writer = isWriterScope(spec)

  const services = uniqueSorted(spec.services || spec.mutableServices || [])
  const externalEffects = uniqueSorted(spec.externalEffects || spec.sideEffects || [])
  // V16.16 production wiring (§6): the actual planned shell commands, when the
  // caller declares them. A declared command is classified STRONGLY (it is
  // what will run), while natural-language task text stays WEAK.
  const commands = uniqueSorted(spec.commands || spec.plannedCommands || [])
  const destructiveCommand = commands.some((command) => DESTRUCTIVE_SHELL_PATTERN.test(command))
  const externalCommand = commands.some((command) => COMMAND_EXTERNAL_PATTERN.test(command))
  const generatedOutputs = uniqueSorted(
    (spec.generatedOutputs || []).map((row) => (typeof row === "string" ? row : row?.output)).map(normalizeConflictPath).filter(Boolean),
  )

  const id = String(spec.id || spec.childId || spec.taskId || spec.role || `scope-${index}`)
  return {
    id,
    key: String(spec.key || id),
    taskId: String(spec.taskId || id),
    role: String(spec.role || ""),
    writer,
    readOnly: !writer,
    writeFiles,
    readFiles,
    configFamilies: configFamiliesOf(writeFiles),
    writesLockfile: writeFiles.some((file) => LOCKFILE_RE.test(file)),
    writesManifest: writeFiles.some((file) => MANIFEST_RE.test(file)),
    generatedOutputs,
    services,
    externalEffects,
    commands,
    destructiveShell: spec.destructiveShell === true || destructiveCommand || DESTRUCTIVE_SHELL_PATTERN.test(task),
    externalSideEffectDeclared: spec.externalSideEffect === true
      || externalEffects.length > 0
      || externalCommand
      || WEAK_EXTERNAL_SIDE_EFFECT_PATTERN.test(task),
    mutableServiceDeclared: spec.mutableService === true
      || services.length > 0
      || WEAK_MUTABLE_SERVICE_PATTERN.test(task),
    // A writer with NO declared write scope cannot be reasoned about. It is not
    // "safe because it declared nothing".
    scopeUnknown: writer && writeFiles.length === 0,
    unnormalizablePaths: uniqueSorted(unnormalizable),
    index,
  }
}

// ---------------------------------------------------------------------------
// pair relation
// ---------------------------------------------------------------------------

function intersect(a, b) {
  const right = new Set(b)
  return a.filter((value) => right.has(value))
}

/**
 * Classify ONE pair. Pure. Returns a verdict plus the exact relations that
 * produced it. An empty `relations` array with verdict INDEPENDENT is a proof
 * of independence under the declared information, not a guess.
 */
export function classifyPair(left, right, options = {}) {
  const a = isNormalizedScope(left) ? left : normalizeScope(left)
  const b = isNormalizedScope(right) ? right : normalizeScope(right)
  const relations = []
  const moduleEdges = Array.isArray(options.moduleEdges) ? options.moduleEdges : []
  const generatedEdges = Array.isArray(options.generatedEdges) ? options.generatedEdges : []

  if (a.id === b.id) {
    return {
      verdict: PAIR_VERDICT.CONFLICT,
      pair: [a.id, b.id],
      relations: [{ kind: CONFLICT_KIND.UNKNOWN_SCOPE, detail: "same scope id" }],
      deterministic: true,
    }
  }

  // 1. Fail-closed: an unknown writer scope conflicts with everything.
  for (const scope of [a, b]) {
    if (scope.scopeUnknown) {
      relations.push({
        kind: CONFLICT_KIND.UNKNOWN_SCOPE,
        scope: scope.id,
        detail: "writer declared no write files; scope cannot be proven independent",
      })
    }
    if (scope.unnormalizablePaths.length) {
      relations.push({
        kind: CONFLICT_KIND.UNKNOWN_SCOPE,
        scope: scope.id,
        detail: `write path outside the repository or unnormalizable: ${scope.unnormalizablePaths.slice(0, 5).join(", ")}`,
      })
    }
  }

  // 2. Destructive shell and external side effects never overlap anything.
  for (const scope of [a, b]) {
    if (scope.destructiveShell) {
      relations.push({ kind: CONFLICT_KIND.DESTRUCTIVE_SHELL, scope: scope.id, detail: "destructive shell command" })
    }
  }
  const sharedExternal = intersect(a.externalEffects, b.externalEffects)
  if (sharedExternal.length || (a.externalSideEffectDeclared && b.externalSideEffectDeclared)) {
    relations.push({
      kind: CONFLICT_KIND.SAME_EXTERNAL_SIDE_EFFECT,
      pair: [a.id, b.id],
      detail: sharedExternal.length ? `same external side effect: ${sharedExternal.slice(0, 5).join(", ")}` : "both perform an external side effect",
    })
  }
  const sharedServices = intersect(a.services, b.services)
  if (sharedServices.length || (a.mutableServiceDeclared && b.mutableServiceDeclared && a.writer && b.writer)) {
    relations.push({
      kind: CONFLICT_KIND.SHARED_MUTABLE_SERVICE,
      pair: [a.id, b.id],
      detail: sharedServices.length ? `same mutable service: ${sharedServices.slice(0, 5).join(", ")}` : "both mutate a shared service",
    })
  }

  // 3. Exact write/write overlap.
  const sharedWrites = intersect(a.writeFiles, b.writeFiles)
  if (sharedWrites.length) {
    relations.push({
      kind: CONFLICT_KIND.WRITE_WRITE_SAME_FILE,
      pair: [a.id, b.id],
      files: sharedWrites.slice(0, 20),
      detail: `${sharedWrites.length} identical write file(s)`,
    })
  }

  // 4. Read/write dependency (either direction): the reader's plan assumes the
  //    pre-change content of a file the other scope rewrites.
  const aReadsBWrites = intersect(a.readFiles, b.writeFiles)
  const bReadsAWrites = intersect(b.readFiles, a.writeFiles)
  if (aReadsBWrites.length || bReadsAWrites.length) {
    relations.push({
      kind: CONFLICT_KIND.READ_WRITE_DEPENDENCY,
      pair: [a.id, b.id],
      files: [...new Set([...aReadsBWrites, ...bReadsAWrites])].slice(0, 20),
      detail: `${aReadsBWrites.length + bReadsAWrites.length} read/write dependency file(s)`,
    })
  }

  // 5. Shared config family (same generated/locked state, different paths).
  const sharedFamilies = intersect(a.configFamilies, b.configFamilies)
  if (sharedFamilies.length && (a.writer || b.writer)) {
    relations.push({
      kind: CONFLICT_KIND.SHARED_CONFIG_FAMILY,
      pair: [a.id, b.id],
      families: sharedFamilies,
      detail: sharedFamilies
        .map((id) => SHARED_CONFIG_FAMILY.find((family) => family.id === id)?.reason || id)
        .join("; "),
    })
  }

  // 6. Lockfile <-> manifest interaction: refreshing a lockfile reads EVERY
  //    manifest, so a concurrent manifest edit is a real conflict even when the
  //    exact files differ (root package.json vs a workspace lockfile).
  if ((a.writesLockfile && b.writesManifest) || (b.writesLockfile && a.writesManifest)) {
    relations.push({
      kind: CONFLICT_KIND.LOCKFILE_PACKAGE_INTERACTION,
      pair: [a.id, b.id],
      detail: "a lockfile refresh reads every manifest; a concurrent manifest write is not isolated",
    })
  }

  // 7. Generated-output overlap: A writes a source another scope regenerates.
  const aGeneratesBWrites = intersect(a.generatedOutputs, b.writeFiles)
  const bGeneratesAWrites = intersect(b.generatedOutputs, a.writeFiles)
  const declaredA = generatedEdges
    .filter((edge) => String(edge?.source || "") === a.id)
    .flatMap((edge) => uniqueSorted([edge?.output]).map(normalizeConflictPath))
  const declaredB = generatedEdges
    .filter((edge) => String(edge?.source || "") === b.id)
    .flatMap((edge) => uniqueSorted([edge?.output]).map(normalizeConflictPath))
  const generatedOverlap = [
    ...new Set([
      ...aGeneratesBWrites,
      ...bGeneratesAWrites,
      ...intersect(declaredA, b.writeFiles),
      ...intersect(declaredB, a.writeFiles),
      ...intersect(a.writeFiles, b.generatedOutputs),
      ...intersect(b.writeFiles, a.generatedOutputs),
    ]),
  ]
  if (generatedOverlap.length) {
    relations.push({
      kind: CONFLICT_KIND.GENERATED_OUTPUT,
      pair: [a.id, b.id],
      files: generatedOverlap.slice(0, 20),
      detail: "one scope writes a file the other regenerates from it",
    })
  }

  // 8. Known module dependency between two written modules. Only used when the
  //    caller supplies real edges; a guessed edge would be intuition.
  if (moduleEdges.length) {
    const aWrites = new Set(a.writeFiles)
    const bWrites = new Set(b.writeFiles)
    for (const edge of moduleEdges) {
      const from = normalizeConflictPath(edge?.from)
      const to = normalizeConflictPath(edge?.to)
      if (!from || !to) continue
      if ((aWrites.has(from) && bWrites.has(to)) || (bWrites.has(from) && aWrites.has(to))) {
        relations.push({
          kind: CONFLICT_KIND.MODULE_DEPENDENCY,
          pair: [a.id, b.id],
          detail: `declared module edge ${from} -> ${to} joins the two write scopes`,
        })
        break
      }
    }
  }

  return {
    verdict: relations.length ? PAIR_VERDICT.CONFLICT : PAIR_VERDICT.INDEPENDENT,
    pair: [a.id, b.id],
    relations,
    deterministic: true,
  }
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

/**
 * Build the bounded conflict graph for a scope set.
 *
 * The result contains an explicit `edges` list (conflicts only), a per-scope
 * certainty label, and a deterministic greedy `waves` partition that NEVER
 * places two conflicting scopes in the same wave.
 *
 * Greedy partitioning is O(n * w) with n scopes and w waves; both are bounded by
 * the caller's `maxParallel`, so this can never become a quadratic swarm planner.
 */
export function buildConflictGraph(scopes = [], options = {}) {
  const normalized = (scopes || []).map((scope, index) =>
    isNormalizedScope(scope) ? { ...scope, index } : normalizeScope(scope, index),
  )
  const byId = new Map()
  for (const scope of normalized) {
    if (byId.has(scope.id)) {
      throw new Error(`execution-conflict-graph: duplicate scope id ${scope.id}`)
    }
    byId.set(scope.id, scope)
  }

  const maxParallel = Math.max(1, Math.min(8, Math.trunc(Number(options.maxParallel) || 2)))
  const edges = []
  const pairCache = new Map()

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const pair = classifyPair(normalized[i], normalized[j], options)
      pairCache.set(`${normalized[i].id}\u0000${normalized[j].id}`, pair)
      if (pair.verdict === PAIR_VERDICT.CONFLICT) {
        edges.push({
          left: normalized[i].id,
          right: normalized[j].id,
          kinds: uniqueSorted(pair.relations.map((relation) => relation.kind)),
          relations: pair.relations,
        })
      }
    }
  }

  const conflictsFor = (id) => edges.filter((edge) => edge.left === id || edge.right === id)

  // Deterministic greedy waves: scope order is the caller's declared order, and
  // a scope only joins a wave when it is provably independent of EVERY member.
  const waves = []
  const placed = new Set()
  for (const scope of normalized) {
    if (placed.has(scope.id)) continue
    const wave = [scope.id]
    placed.add(scope.id)
    if (wave.length < maxParallel) {
      for (const candidate of normalized) {
        if (placed.has(candidate.id) || wave.length >= maxParallel) continue
        const independentOfWave = wave.every((member) => {
          const key = `${member}\u0000${candidate.id}`
          const reverse = `${candidate.id}\u0000${member}`
          const pair = pairCache.get(key) || pairCache.get(reverse)
          return pair ? pair.verdict === PAIR_VERDICT.INDEPENDENT : false
        })
        if (!independentOfWave) continue
        wave.push(candidate.id)
        placed.add(candidate.id)
      }
    }
    waves.push(wave)
  }

  const scopeRows = normalized.map((scope) => {
    const conflicts = conflictsFor(scope.id)
    const certainty = scope.scopeUnknown || scope.unnormalizablePaths.length
      ? SCOPE_CERTAINTY.UNKNOWN
      : conflicts.length
        ? SCOPE_CERTAINTY.CONFLICT
        : SCOPE_CERTAINTY.INDEPENDENT
    return {
      id: scope.id,
      key: scope.key,
      taskId: scope.taskId,
      role: scope.role,
      writer: scope.writer,
      readOnly: scope.readOnly,
      writeFiles: scope.writeFiles,
      readFiles: scope.readFiles,
      configFamilies: scope.configFamilies,
      certainty,
      conflictCount: conflicts.length,
      conflictKinds: uniqueSorted(conflicts.flatMap((edge) => edge.kinds)),
    }
  })

  const conflictKinds = uniqueSorted(edges.flatMap((edge) => edge.kinds))
  const unknownScopes = scopeRows.filter((row) => row.certainty === SCOPE_CERTAINTY.UNKNOWN).map((row) => row.id)
  const independentPairs = (normalized.length * (normalized.length - 1)) / 2 - edges.length

  return {
    schemaVersion: CONFLICT_GRAPH_SCHEMA_VERSION,
    policy: CONFLICT_GRAPH_POLICY,
    scopeCount: normalized.length,
    scopes: scopeRows,
    edges,
    edgeCount: edges.length,
    conflictKinds,
    unknownScopes,
    independentPairCount: independentPairs,
    waves,
    waveCount: waves.length,
    maxParallel,
    // A wave is parallel only when it actually holds more than one scope AND no
    // scope in it is UNKNOWN.
    parallelWaves: waves.filter((wave) =>
      wave.length > 1 && wave.every((id) => scopeRows.find((row) => row.id === id)?.certainty !== SCOPE_CERTAINTY.UNKNOWN),
    ).length,
    hasUnknown: unknownScopes.length > 0,
    // Fingerprint of the decision inputs so a caller can prove the graph was
    // built from the same declarations it is about to execute.
    fingerprint: "conflict-graph:sha256:" + createHash("sha256")
      .update(JSON.stringify(normalized.map((scope) => [
        scope.id, scope.writer, scope.writeFiles, scope.readFiles, scope.services, scope.externalEffects,
        scope.commands || [],
      ])))
      .digest("hex").slice(0, 24),
    deterministic: true,
  }
}

/**
 * Convenience wrapper for the delegation-safety owner: is this exact pair
 * provably independent under the declared information?
 */
export function scopesAreIndependent(left, right, options = {}) {
  const pair = classifyPair(left, right, options)
  return {
    independent: pair.verdict === PAIR_VERDICT.INDEPENDENT,
    relations: pair.relations,
    kinds: uniqueSorted(pair.relations.map((relation) => relation.kind)),
  }
}

export const executionConflictGraphExports = Object.freeze({
  buildConflictGraph,
  classifyPair,
  isWriterScope,
  normalizeScope,
  normalizeConflictPath,
  scopesAreIndependent,
  CONFLICT_KIND,
  SCOPE_CERTAINTY,
  PAIR_VERDICT,
  SHARED_CONFIG_FAMILY,
})
