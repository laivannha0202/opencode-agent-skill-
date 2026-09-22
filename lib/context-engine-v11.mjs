import { buildContextManifest } from "./context-manifest.mjs"
import { planEvidenceBudget } from "./evidence-budget.mjs"
import { putEvidence } from "./evidence-store.mjs"

export async function buildAdaptiveContext(root, task, taskPolicy = {}, options = {}) {
  const budgetPlan = planEvidenceBudget(taskPolicy, task, options.signals || {})
  const manifest = await buildContextManifest(root, task, {
    ...options,
    budget: budgetPlan.total,
    evidenceBudget: budgetPlan,
    strategy: options.strategy || taskPolicy.profile?.contextStrategy || "incremental-semantic+git",
  })
  const evidence = await putEvidence(root, {
    task: task?.id || null,
    manifest: {
      schemaVersion: manifest.schemaVersion,
      declared: manifest.declared,
      tests: manifest.tests,
      changed: manifest.changed,
      rankedReferences: manifest.rankedReferences,
      files: manifest.files,
    },
  }, {
    kind: "context-manifest",
    source: task?.id || "context",
    summary: "Bounded V11 context manifest metadata",
  })
  return {
    schemaVersion: 1,
    kind: "ues-adaptive-context-v11",
    budget: budgetPlan,
    evidence,
    manifest,
  }
}
