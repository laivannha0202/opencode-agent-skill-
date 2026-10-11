import { buildContextManifest } from "./context-manifest.mjs"
import { planEvidenceBudget, evidenceValueScore } from "./evidence-budget.mjs"
import { putEvidence } from "./evidence-store.mjs"
import { inferTaskCapabilities } from "./capability-registry.mjs"
import { buildPromptEnvelope, comparePromptEnvelopes } from "./prompt-cache.mjs"
import { measureContextQuality } from "./context-quality.mjs"
import { retrieveMemories } from "./memory-engine.mjs"
import { capabilityFabricStatus } from "./capability-fabric.mjs"
import { failureDelta } from "./leaf-runtime-optimizer.mjs"
import { taskFiles } from "./task-graph.mjs"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

// ---------------------------------------------------------------------------
// V16.18 TWO-STAGE CONTEXT PIPELINE.
//
// LIGHT_CONTEXT is cheap and sufficient for a bounded task. FULL_CONTEXT is the
// full intelligence (semantic index, hierarchy, repository graph, verified
// memory, capability fabric, evidence externalization) and stays exactly as
// powerful as it was. The stage is a SPENDING decision, never a capability
// removal: LIGHT -> FULL is lossless and is taken the moment the light evidence
// is insufficient (`lightContextInsufficient`).
//
// LIGHT_CONTEXT normally contains ONLY:
//   * the task text and direct user constraints;
//   * declared/referenced files and changed-file hints;
//   * the nearest applicable instructions;
//   * bounded grep/search results and bounded relevant file ranges;
//   * the direct recent-failure delta;
//   * the known verification requirement.
// It deliberately does NOT run the full semantic index, the repository graph,
// a large hierarchy build, memory ranking or the capability fabric inventory.
// ---------------------------------------------------------------------------

export const CONTEXT_PIPELINE_STAGE = Object.freeze({
  LIGHT: "LIGHT_CONTEXT",
  FULL: "FULL_CONTEXT",
})

export const CONTEXT_PIPELINE_POLICY = "two-stage-context-pipeline-v16-18"

/** Hard bounds for the light stage. Cheap by construction, never "small later". */
export const LIGHT_CONTEXT_BOUNDS = Object.freeze({
  maxCandidateFiles: 12,
  maxExcerptFiles: 4,
  maxExcerptChars: 1_800,
  maxBasenameMatches: 8,
  maxInstructions: 6,
  maxFailureDeltaChars: 4_200,
})

const LIGHT_INSTRUCTIONS = ["AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function listedSourceFiles(root, limit = 4_000) {
  const result = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) return []
  const files = String(result.stdout || "")
    .split("\0")
    .filter(Boolean)
    .map((value) => String(value).replaceAll("\\", "/"))
    .filter((file) => !file.startsWith(".ues-"))
  return files.slice(0, limit)
}

function lightTaskTerms(task = {}) {
  const source = taskText(task).toLowerCase()
  const stop = new Set([
    "this","that","with","from","into","then","than","when","where","what","your",
    "task","test","tests","file","files","code","change","changes","should","must",
    "được","các","cho","với","trong","này","một","những","không","theo","sau",
  ])
  return [...new Set(
    source
      .split(/[^\p{L}\p{N}_$.-]+/u)
      .map((item) => item.replace(/^[-.$]+|[-.$]+$/g, ""))
      .filter((item) => item.length >= 4 && !stop.has(item)),
  )].slice(0, 16)
}

async function boundedExcerpt(root, relative, maxChars, terms = []) {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  const info = await stat(full).catch(() => null)
  if (!info?.isFile() || info.size > 1024 * 1024) return null
  const source = await readFile(full, "utf8").catch(() => "")
  if (!source) return null
  let text = source
  let startLine = 1
  let centerTerm = null
  if (source.length > maxChars) {
    // Center on the first task-term hit so a range read stays honest about what
    // it skipped, rather than silently presenting a head slice as the whole file.
    const lower = source.toLowerCase()
    let index = -1
    let center = null
    for (const term of terms) {
      const hit = lower.indexOf(String(term).toLowerCase())
      if (hit >= 0 && (index < 0 || hit < index)) {
        index = hit
        center = term
      }
    }
    const start = index >= 0 ? Math.max(0, Math.min(index - Math.floor(maxChars / 3), source.length - maxChars)) : 0
    text = (start > 0 ? "...[truncated]\n" : "") + source.slice(start, start + maxChars)
      + (start + maxChars < source.length ? "\n...[truncated]" : "")
    startLine = start > 0 ? source.slice(0, start).split("\n").length : 1
    centerTerm = center
  }
  return { path: rel(root, full), text, chars: text.length, startLine, centerTerm }
}

function taskTextSafe(task = {}) {
  return taskText(task)
}

/**
 * Build the CHEAP stage of the context pipeline.
 *
 * Everything it returns is bounded and measured. It never claims to have read
 * what it did not read, and it reports its own gaps so the caller can escalate
 * on evidence instead of guessing.
 */
export async function buildLightTaskContext(root, task, options = {}) {
  root = path.resolve(root)
  const startedAt = Date.now()
  const declared = taskFiles(task)
    .map((file) => String(file || "").replaceAll("\\", "/"))
    .filter(Boolean)
  const changed = (Array.isArray(options.changedFiles) ? options.changedFiles : [])
    .map((file) => String(file || "").replaceAll("\\", "/"))
    .filter(Boolean)
  const terms = lightTaskTerms(task)
  const gaps = []

  const listed = listedSourceFiles(root)
  if (!listed.length) gaps.push("repository-file-list-unavailable")

  // Bounded basename/symbol search over the file NAMES only. This is one bounded
  // Git process, never a full-repo read and never the semantic index.
  const declaredSet = new Set(declared)
  const changedSet = new Set(changed)
  const matches = []
  for (const file of listed) {
    if (declaredSet.has(file) || changedSet.has(file)) continue
    const lower = file.toLowerCase()
    const base = path.posix.basename(lower, path.posix.extname(lower))
    const hit = terms.find((term) => base.includes(String(term).toLowerCase()))
    if (!hit) continue
    matches.push({ path: file, hit, score: base === hit ? 2 : 1 })
    if (matches.length >= LIGHT_CONTEXT_BOUNDS.maxBasenameMatches) break
  }
  matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))

  const priority = [...new Set([
    ...declared,
    ...changed,
    ...matches.map((row) => row.path),
  ])].slice(0, LIGHT_CONTEXT_BOUNDS.maxCandidateFiles)

  const bounded = []
  for (const file of priority) {
    if (bounded.length >= LIGHT_CONTEXT_BOUNDS.maxExcerptFiles) break
    const row = await boundedExcerpt(root, file, LIGHT_CONTEXT_BOUNDS.maxExcerptChars, terms)
    if (row) bounded.push({
      ...row,
      role: declaredSet.has(file) ? "declared" : changedSet.has(file) ? "changed" : "matched",
    })
  }

  const instructions = LIGHT_INSTRUCTIONS.filter((name) => existsSync(path.join(root, name)))
    .slice(0, LIGHT_CONTEXT_BOUNDS.maxInstructions)

  const failureText = options.recentFailure
    ? failureDelta(options.recentFailure, { maxChars: LIGHT_CONTEXT_BOUNDS.maxFailureDeltaChars })
    : ""

  const lightPromptEnvelope = buildPromptEnvelope({
    invariants: options.invariants || "evidence-first; scoped edits; fresh verification; no unsupported completion claims",
    role: options.role || "executor",
    skills: options.skills || [],
    projectFacts: { strategy: "light-declared+changed+bounded-search", instructions },
    task,
    evidence: [...declared, ...changed, ...matches.map((row) => row.path)],
    memories: [],
    contextHints: { hierarchy: [], providers: [] },
    recentFailure: failureText || null,
    nextAction: options.nextAction || null,
    recentMessages: options.recentMessages || [],
  })

  // Bounded verification requirement: the caller declares what it already knows.
  const verification = options.verificationRequirement
    ? {
      command: String(options.verificationRequirement.command || ""),
      required: options.verificationRequirement.required !== false,
    }
    : null

  const manifest = {
    schemaVersion: 1,
    strategy: "light-declared+changed+bounded-search",
    stage: CONTEXT_PIPELINE_STAGE.LIGHT,
    declared,
    changed,
    matches,
    instructions,
    rankedReferences: matches.map((row) => ({ path: row.path, score: row.score, matches: [row.hit], symbolHits: [], evidenceLevel: "bounded-name-search" })),
    tests: [],
    hierarchy: null,
    semantic: null,
    graph: { enabled: false, scannedFiles: 0, truncated: true, hotspots: [], ranking: null },
    excerpts: bounded,
    queryTerms: terms,
    used: bounded.reduce((sum, row) => sum + row.chars, 0),
  }

  const result = {
    schemaVersion: 1,
    stage: CONTEXT_PIPELINE_STAGE.LIGHT,
    policy: CONTEXT_PIPELINE_POLICY,
    capabilities: inferTaskCapabilities(taskTextSafe(task), options.facts || {}),
    contextManifest: manifest,
    contextQuality: measureContextQuality(task, manifest, { minRequiredRecall: options.minRequiredRecall }),
    promptEnvelope: lightPromptEnvelope,
    memories: [],
    memoryRetrieval: { schemaVersion: 1, eligible: 0, returned: 0, skipped: "light-stage" },
    capabilityFabric: {
      healthyCapabilities: 0,
      totalCapabilities: 0,
      providers: [],
      skipped: "light-stage",
    },
    evidenceStore: { refs: 0, externalizedBytes: 0, entries: [] },
    recentFailureDelta: failureText,
    verificationRequirement: verification,
    promptCache: {
      stablePrefixHash: lightPromptEnvelope.stablePrefixHash,
      dynamicHash: lightPromptEnvelope.dynamicHash,
      stableChars: lightPromptEnvelope.stableChars,
      dynamicChars: lightPromptEnvelope.dynamicChars,
      cacheableRatio: lightPromptEnvelope.cacheableRatio,
    },
    performance: {
      stage: CONTEXT_PIPELINE_STAGE.LIGHT,
      totalMs: Date.now() - startedAt,
      semanticIndexBuilt: false,
      repoGraphBuilt: false,
      hierarchyBuilt: false,
      memoryRetrieved: false,
      capabilityFabricInventoried: false,
    },
    gaps: [...new Set(gaps)],
  }
  return result
}

/**
 * Escalation decision for the two-stage pipeline. Answers ONE question on
 * evidence: is the cheap stage enough, or must the FULL intelligence run?
 *
 * A conservative answer is always safe here: escalating costs context chars,
 * never correctness. Staying LIGHT on insufficient evidence is what this
 * function exists to prevent.
 */
export function lightContextInsufficient(light, evidence = {}) {
  const row = light && typeof light === "object" ? light : {}
  const reasons = []
  const manifest = row.contextManifest || {}
  const excerptCount = Array.isArray(manifest.excerpts) ? manifest.excerpts.length : 0
  const declaredCount = Array.isArray(manifest.declared) ? manifest.declared.length : 0
  const matches = Array.isArray(manifest.matches) ? manifest.matches.length : 0
  const quality = row.contextQuality && typeof row.contextQuality === "object" ? row.contextQuality : {}

  if (evidence.insufficient === true) reasons.push("caller-reports-insufficient")
  if (Array.isArray(row.gaps) && row.gaps.length) reasons.push(`light-gaps:${row.gaps.join(",")}`)
  if (excerptCount === 0) reasons.push("no-bounded-excerpt")
  if (declaredCount === 0 && matches === 0) reasons.push("no-scope-evidence")
  if (Number(quality.recall) > 0 && Number(quality.recall) < Number(quality.minRequiredRecall || 0)) {
    reasons.push("context-quality-below-threshold")
  }
  if (quality.degraded === true) reasons.push("context-quality-degraded")
  if (evidence.multipleRootCauses === true) reasons.push("multiple-root-causes")
  if (evidence.crossSubsystem === true) reasons.push("cross-subsystem-scope")
  if (evidence.dependencyOwnershipUnclear === true) reasons.push("dependency-ownership-unclear")
  if (evidence.highRiskDomain === true) reasons.push("high-risk-domain")
  if (evidence.architecture === true) reasons.push("architecture-evidence")
  if (evidence.needsVerificationDetail === true) reasons.push("verification-detail-required")
  if (evidence.explicitFullRequest === true) reasons.push("explicit-full-context-request")
  if (evidence.affectedTestsSpanModules === true) reasons.push("affected-tests-multi-module")

  return {
    schemaVersion: 1,
    policy: CONTEXT_PIPELINE_POLICY,
    insufficient: reasons.length > 0,
    reasons,
    stage: reasons.length ? CONTEXT_PIPELINE_STAGE.FULL : CONTEXT_PIPELINE_STAGE.LIGHT,
    // Bounded by construction: the caller escalates at most once.
    escalationBudget: 1,
  }
}

function taskText(task = {}) {
  return [
    task.title,
    task.summary,
    ...(task.acceptance || []),
    ...(task.verification || []),
  ].filter(Boolean).join(" ")
}

function taskFilesForMemory(task = {}) {
  const files = task.files
  const values = []
  if (Array.isArray(files)) values.push(...files)
  else if (files && typeof files === "object") {
    for (const value of Object.values(files)) {
      if (Array.isArray(value)) values.push(...value)
      else if (typeof value === "string") values.push(value)
    }
  }
  if (Array.isArray(task.requiredFiles)) values.push(...task.requiredFiles)
  return [...new Set(values.filter(Boolean))]
}

function rankExcerpt(item = {}, task = {}) {
  const text = taskText(task).toLowerCase()
  const pathValue = String(item.path || "").toLowerCase()
  const declared = item.role === "declared" ? 1 : 0
  const test = item.role === "test" ? 0.9 : 0
  const instruction = item.role === "instruction" ? 0.85 : 0
  const pathMatch = text && pathValue
    ? text.split(/[^a-z0-9_$.-]+/i).filter((term) => term.length >= 4 && pathValue.includes(term.toLowerCase())).length
    : 0
  const relevance = Math.min(1, declared + test + instruction + pathMatch * 0.15)
  return evidenceValueScore({
    relevance,
    freshness: 1,
    confidence: item.role === "reference" ? 0.7 : 1,
    chars: String(item.text || "").length || 1,
  })
}

export async function externalizeContextExcerpts(root, manifest, options = {}) {
  if (!manifest) return { manifest: null, externalized: [], externalizedBytes: 0 }
  const threshold = Math.max(512, Number(options.threshold || 2_500))
  const keepInline = Math.max(256, Number(options.inlineChars || 1_200))
  const externalized = []
  let externalizedBytes = 0
  const excerpts = []

  for (const item of manifest.excerpts || []) {
    const text = String(item.text || "")
    if (text.length <= threshold) {
      excerpts.push(item)
      continue
    }

    const stored = await putEvidence(root, text, {
      kind: "context-excerpt",
      source: item.path || null,
      summary: `Externalized ${item.role || "reference"} context excerpt for ${item.path || "unknown"}`,
    })
    externalized.push({
      ref: stored.ref,
      path: item.path || null,
      role: item.role || null,
      bytes: stored.bytes,
      score: Number(rankExcerpt(item, options.task).toFixed(8)),
    })
    externalizedBytes += stored.bytes
    excerpts.push({
      ...item,
      text: text.slice(0, keepInline) + "\n...[externalized: " + stored.ref + "]",
      evidenceRef: stored.ref,
      originalChars: text.length,
      externalized: true,
    })
  }

  return {
    manifest: {
      ...manifest,
      schemaVersion: Math.max(5, Number(manifest.schemaVersion || 0)),
      excerpts,
      evidencePointers: externalized,
    },
    externalized,
    externalizedBytes,
  }
}

export async function buildAdaptiveTaskContext(root, task, options = {}) {
  const policy = options.policy || {}
  const capabilities = options.capabilities || inferTaskCapabilities(taskText(task), options.facts || {})
  const evidenceBudget = options.evidenceBudget || planEvidenceBudget(policy, task, capabilities.required)
  const contextBuildStartedAt = Date.now()
  const memoryPromise = retrieveMemories(root, taskText(task), {
    files: taskFilesForMemory(task),
    limit: options.memoryLimit ?? 6,
    taskClass: options.taskClass || task.type || policy.executionProfile || policy.profile?.name || null,
    touch: options.touchMemories !== false,
  }).catch(() => ({ schemaVersion: 1, query: taskText(task), eligible: 0, results: [] }))
  const fabricPromise = capabilityFabricStatus(root).catch(() => null)

  const manifestStartedAt = Date.now()
  const manifest = await buildContextManifest(root, task, {
    budget: evidenceBudget.total,
    evidenceBudget,
    strategy: options.strategy || policy?.profile?.contextStrategy || "incremental-semantic+git",
    semanticMaxFiles: options.semanticMaxFiles,
    maxFiles: options.maxFiles,
    changedFiles: options.changedFiles,
    workspaceFingerprint: options.workspaceFingerprint,
  })
  const manifestMs = Date.now() - manifestStartedAt

  const externalizeStartedAt = Date.now()
  const externalized = await externalizeContextExcerpts(root, manifest, {
    task,
    threshold: options.externalizeThreshold,
    inlineChars: options.inlineChars,
  })
  const externalizeMs = Date.now() - externalizeStartedAt

  const [memoryRetrieval, fabric] = await Promise.all([memoryPromise, fabricPromise])
  const memories = memoryRetrieval.results || []
  const providerHints = (fabric?.rows || [])
    .filter((row) => row.selected)
    .slice(0, 12)
    .map((row) => ({
      capability: row.capability,
      selected: row.selected,
      status: row.status,
      fallbacks: (row.fallbacks || []).slice(0, 3),
    }))

  const promptEnvelope = buildPromptEnvelope({
    invariants: options.invariants || "evidence-first; scoped edits; fresh verification; no unsupported completion claims",
    role: options.role || "executor",
    skills: options.skills || policy.domains || [],
    projectFacts: {
      strategy: externalized.manifest?.strategy || null,
      instructions: externalized.manifest?.instructions || [],
      ...(options.projectFacts || {}),
    },
    task,
    evidence: [
      ...(externalized.externalized || []).map((item) => item.ref),
      ...(externalized.manifest?.rankedReferences || []).slice(0, 12).map((item) => item.path),
      ...(options.evidence || []),
    ],
    memories: memories.map((item) => ({
      id: item.id,
      type: item.type,
      scope: item.scope,
      content: item.content,
      confidence: item.confidence,
      files: item.files,
      retrieval: item.retrieval,
    })),
    contextHints: {
      hierarchy: (externalized.manifest?.hierarchy?.scopes || []).slice(0, 6).map((item) => ({
        path: item.path,
        score: item.score,
        l0: item.l0,
      })),
      providers: providerHints,
    },
    recentFailure: options.recentFailure || null,
    nextAction: options.nextAction || null,
    recentMessages: options.recentMessages || [],
  })

  const contextQuality = measureContextQuality(task, externalized.manifest, { minRequiredRecall: options.minRequiredRecall })

  const cache = options.previousPromptEnvelope
    ? comparePromptEnvelopes(options.previousPromptEnvelope, promptEnvelope)
    : null

  return {
    schemaVersion: 1,
    contextSchemaVersion: 6,
    stage: CONTEXT_PIPELINE_STAGE.FULL,
    policy: CONTEXT_PIPELINE_POLICY,
    capabilities,
    evidenceBudget,
    contextManifest: externalized.manifest,
    contextQuality,
    memories,
    memoryRetrieval: {
      schemaVersion: memoryRetrieval.schemaVersion || 1,
      eligible: memoryRetrieval.eligible || 0,
      returned: memories.length,
    },
    capabilityFabric: {
      healthyCapabilities: fabric?.healthyCapabilities || 0,
      totalCapabilities: fabric?.totalCapabilities || 0,
      providers: providerHints,
    },
    evidenceStore: {
      refs: externalized.externalized.length,
      externalizedBytes: externalized.externalizedBytes,
      entries: externalized.externalized,
    },
    promptEnvelope,
    performance: {
      parallelContextPreparation: true,
      stage: CONTEXT_PIPELINE_STAGE.FULL,
      manifestMs,
      externalizeMs,
      totalMs: Date.now() - contextBuildStartedAt,
    },
    promptCache: {
      stablePrefixHash: promptEnvelope.stablePrefixHash,
      dynamicHash: promptEnvelope.dynamicHash,
      stableChars: promptEnvelope.stableChars,
      dynamicChars: promptEnvelope.dynamicChars,
      cacheableRatio: promptEnvelope.cacheableRatio,
      ...(cache || {}),
    },
  }
}