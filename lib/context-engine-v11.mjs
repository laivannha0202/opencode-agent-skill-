import { buildContextManifest } from "./context-manifest.mjs"
import { planEvidenceBudget, evidenceValueScore } from "./evidence-budget.mjs"
import { putEvidence } from "./evidence-store.mjs"
import { inferTaskCapabilities } from "./capability-registry.mjs"
import { buildPromptEnvelope, comparePromptEnvelopes } from "./prompt-cache.mjs"
import { measureContextQuality } from "./context-quality.mjs"
import { retrieveMemories } from "./memory-engine.mjs"
import { capabilityFabricStatus } from "./capability-fabric.mjs"

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
  const manifest = await buildContextManifest(root, task, {
    budget: evidenceBudget.total,
    evidenceBudget,
    strategy: options.strategy || policy?.profile?.contextStrategy || "incremental-semantic+git",
    semanticMaxFiles: options.semanticMaxFiles,
    maxFiles: options.maxFiles,
  })

  const externalized = await externalizeContextExcerpts(root, manifest, {
    task,
    threshold: options.externalizeThreshold,
    inlineChars: options.inlineChars,
  })

  const memoryRetrieval = await retrieveMemories(root, taskText(task), {
    files: taskFilesForMemory(task),
    limit: options.memoryLimit ?? 6,
    taskClass: options.taskClass || task.type || policy.executionProfile || policy.profile?.name || null,
    touch: options.touchMemories !== false,
  }).catch(() => ({ schemaVersion: 1, query: taskText(task), eligible: 0, results: [] }))
  const memories = memoryRetrieval.results || []
  const fabric = await capabilityFabricStatus(root).catch(() => null)
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
