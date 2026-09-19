import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

async function loadResults(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const results = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(await readFile(path.join(dir, entry.name), "utf8"))
      for (const item of parsed.results || []) results.push({ ...item, sourceFile: entry.name })
    } catch {}
  }
  return results
}

function signature(item) {
  if (item.agentExit !== 0) return "runtime-exit"
  if (item.orchestration?.required && !item.orchestration?.valid) return "orchestration-adherence"
  if (item.graderExit !== 0) return "behavior-correctness"
  if ((item.telemetry?.parseErrors || 0) > 0) return "telemetry-compat"
  if ((item.durationMs || 0) > 10 * 60_000) return "latency-budget"
  return item.passed ? "success-pattern" : "unknown-failure"
}

const ACTIONS = {
  "runtime-exit": "Improve process/runtime compatibility, timeout diagnostics, or provider failure handling.",
  "orchestration-adherence": "Strengthen long-horizon routing, durable state guidance, and executor handoff.",
  "behavior-correctness": "Improve context selection, task decomposition, verification, or domain guidance.",
  "telemetry-compat": "Update telemetry parsing for the observed runtime event shape.",
  "latency-budget": "Tighten task scope, context size, timeout policy, or model selection.",
  "success-pattern": "Preserve the successful routing/context pattern as a regression case.",
  "unknown-failure": "Inspect the retained trace and add a specific regression before changing guidance.",
}

export function buildLearningProposals(results = []) {
  const buckets = new Map()
  for (const item of results) {
    const key = signature(item)
    const bucket = buckets.get(key) || { signature: key, count: 0, tasks: new Set(), models: new Set(), examples: [] }
    bucket.count += 1
    if (item.task) bucket.tasks.add(item.task)
    if (item.model) bucket.models.add(item.model)
    if (bucket.examples.length < 5) bucket.examples.push({
      task: item.task,
      mode: item.mode,
      model: item.model,
      agentExit: item.agentExit,
      graderExit: item.graderExit,
      durationMs: item.durationMs,
      sourceFile: item.sourceFile,
    })
    buckets.set(key, bucket)
  }

  return [...buckets.values()]
    .sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature))
    .map((bucket) => ({
      id: "learn-" + bucket.signature,
      signature: bucket.signature,
      evidenceCount: bucket.count,
      tasks: [...bucket.tasks].sort(),
      models: [...bucket.models].sort(),
      recommendation: ACTIONS[bucket.signature],
      activation: "proposal-only",
      confidence: bucket.count >= 5 ? "high" : bucket.count >= 2 ? "medium" : "low",
      examples: bucket.examples,
    }))
}

export async function writeLearningBundle(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const evalDir = path.resolve(root, options.evalDir || ".ues-evals")
  const results = await loadResults(evalDir)
  const proposals = buildLearningProposals(results)
  const target = path.join(root, ".ues-learning")
  await mkdir(target, { recursive: true })
  const bundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    evalDir,
    resultCount: results.length,
    policy: "proposal-only; never auto-activate without regression evidence",
    proposals,
  }
  await writeFile(path.join(target, "PROPOSALS.json"), JSON.stringify(bundle, null, 2) + "\n", "utf8")
  return bundle
}
