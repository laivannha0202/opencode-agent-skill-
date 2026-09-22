import { buildContextManifest } from "./context-manifest.mjs"
import { planEvidenceBudget, evidenceValueScore } from "./evidence-budget.mjs"
import { putEvidence } from "./evidence-store.mjs"
import { inferTaskCapabilities } from "./capability-registry.mjs"
import { buildPromptEnvelope, comparePromptEnvelopes } from "./prompt-cache.mjs"

function taskText(task = {}) {
  return [
    task.title,
    task.summary,
    ...(task.acceptance || []),
    ...(task.verification || []),
  ].filter(Boolean).join(" ")
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
    recentFailure: options.recentFailure || null,
    nextAction: options.nextAction || null,
    recentMessages: options.recentMessages || [],
  })

  const cache = options.previousPromptEnvelope
    ? comparePromptEnvelopes(options.previousPromptEnvelope, promptEnvelope)
    : null

  return {
    schemaVersion: 1,
    contextSchemaVersion: 6,
    capabilities,
    evidenceBudget,
    contextManifest: externalized.manifest,
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
