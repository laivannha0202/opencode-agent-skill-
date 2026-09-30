// Weak-model code-intelligence benchmark (V15.2 performance hardening).
//
// Measures the Parent Code Intelligence Lite hot path against real providers:
// cold/warm symbols, semantic search, small-file and large-file diagnostics,
// repeated warm operations, and pool status. Prints one JSON receipt so a
// before/after comparison is a diff, not an opinion.
//
//   node scripts/benchmark-code-intelligence.mjs [--root <dir>] [--json]

import { performance } from "node:perf_hooks"
import { stat } from "node:fs/promises"
import path from "node:path"
import { diagnoseCode, lspOperation, lspPoolStatus, searchCodeIntelligence, shutdownLspPool } from "../lib/code-intelligence/index.mjs"
import { resetLspPoolMetrics } from "../lib/code-intelligence/lsp-pool.mjs"
import { resetDiagnosticsBudgetHistory } from "../lib/code-intelligence/diagnostics-budget.mjs"
import { reduceCodePayload } from "../lib/code-intelligence/model-payload.mjs"

const WARM_SAMPLES = 5

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function round(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits))
}

async function measure(fn) {
  const started = performance.now()
  const value = await fn()
  return { ms: round(performance.now() - started), value }
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  return process.argv[index + 1] || fallback
}

async function firstExisting(root, candidates) {
  for (const relative of candidates) {
    const file = path.join(root, relative)
    const info = await stat(file).catch(() => null)
    if (info?.isFile()) return { relative, file, bytes: info.size }
  }
  return null
}

async function main() {
  const root = path.resolve(argValue("--root", process.cwd()))
  const small = await firstExisting(root, ["lib/ids.mjs", "lib/evidence-receipt.mjs", "package.json"])
  const large = await firstExisting(root, ["pi/extensions/ues.ts", "lib/task-engine.mjs", "bin/ocskill.mjs"])
  if (!small) throw new Error("benchmark requires at least one small source file in " + root)

  const report = {
    schemaVersion: 1,
    kind: "ues-code-intelligence-benchmark",
    node: process.version,
    platform: process.platform,
    root,
    fixtures: { small: small && { file: small.relative, bytes: small.bytes }, large: large && { file: large.relative, bytes: large.bytes } },
    cases: {},
  }

  resetLspPoolMetrics()
  resetDiagnosticsBudgetHistory()

  try {
    const symbolOptions = { persistent: true, timeoutMs: 7_000, maxResults: 120 }
    const diagnosticsOptions = { timeoutMs: 5_000, maxResults: 80, persistent: true }

    const cold = await measure(() => lspOperation(root, small.relative, "symbols", symbolOptions))
    report.cases.symbolsCold = {
      ms: cold.ms,
      coldStartMs: cold.value?.pool?.coldStartMs ?? null,
      operationDurationMs: cold.value?.pool?.operationDurationMs ?? null,
      poolHit: cold.value?.pool?.poolHit ?? null,
      complete: cold.value?.reason === "ok",
      outputChars: JSON.stringify(cold.value ?? null).length,
    }

    const warm = []
    for (let index = 0; index < WARM_SAMPLES; index += 1) {
      const run = await measure(() => lspOperation(root, small.relative, "symbols", symbolOptions))
      warm.push(run)
    }
    report.cases.symbolsWarm = {
      samples: warm.length,
      medianMs: round(median(warm.map((item) => item.ms))),
      minMs: round(Math.min(...warm.map((item) => item.ms))),
      maxMs: round(Math.max(...warm.map((item) => item.ms))),
      allWarm: warm.every((item) => item.value?.pool?.poolHit === true),
      operationDurationMs: round(median(warm.map((item) => item.value?.pool?.operationDurationMs ?? 0))),
    }

    const searchCold = await measure(() => searchCodeIntelligence(root, "withManagedLspSession", {
      maxResults: 12,
      persistent: true,
      policySource: "parent-lite",
    }))
    const searchWarm = await measure(() => searchCodeIntelligence(root, "withManagedLspSession", {
      maxResults: 12,
      persistent: true,
      policySource: "parent-lite",
    }))
    report.cases.search = {
      coldMs: searchCold.ms,
      warmMs: searchWarm.ms,
      cacheHit: searchWarm.value?.semantic?.runtimeCacheHit === true,
      results: searchWarm.value?.semantic?.results?.length ?? 0,
      outputChars: JSON.stringify(searchWarm.value ?? null).length,
      structuralProvider: searchWarm.value?.structural?.provider ?? null,
      structuralReason: searchWarm.value?.structural?.reason ?? null,
    }

    const smallDiagnostics = await measure(() => diagnoseCode(root, small.relative, diagnosticsOptions))
    report.cases.diagnosticsSmall = {
      ms: smallDiagnostics.ms,
      complete: smallDiagnostics.value?.complete === true,
      diagnosticsReason: smallDiagnostics.value?.diagnosticsReason ?? null,
      diagnosticsSource: smallDiagnostics.value?.diagnosticsSource ?? null,
      diagnostics: smallDiagnostics.value?.diagnostics?.length ?? 0,
      budgetMs: smallDiagnostics.value?.diagnosticsBudgetMs ?? null,
      budgetSource: smallDiagnostics.value?.diagnosticsBudgetSource ?? null,
      budgetBucket: smallDiagnostics.value?.diagnosticsBudgetBucket ?? null,
      fallbackLaunched: smallDiagnostics.value?.diagnosticsFallbackLaunched === true,
      fallbackUsed: smallDiagnostics.value?.diagnosticsFallbackUsed === true,
      fallbackDurationMs: smallDiagnostics.value?.diagnosticsFallbackDurationMs ?? null,
      fallbackAbandoned: smallDiagnostics.value?.diagnosticsFallbackAbandoned === true,
      outputChars: JSON.stringify(smallDiagnostics.value ?? null).length,
    }

    const smallRepeat = await measure(() => diagnoseCode(root, small.relative, diagnosticsOptions))
    report.cases.diagnosticsSmallRepeat = {
      ms: smallRepeat.ms,
      complete: smallRepeat.value?.complete === true,
      diagnosticsReason: smallRepeat.value?.diagnosticsReason ?? null,
      budgetSource: smallRepeat.value?.diagnosticsBudgetSource ?? null,
      budgetBucket: smallRepeat.value?.diagnosticsBudgetBucket ?? null,
      fallbackUsed: smallRepeat.value?.diagnosticsFallbackUsed === true,
    }

    let largeRepeat = null
    if (large) {
      const largeDiagnostics = await measure(() => diagnoseCode(root, large.relative, diagnosticsOptions))
      largeRepeat = await measure(() => diagnoseCode(root, large.relative, diagnosticsOptions))
      report.cases.diagnosticsLarge = {
        ms: largeDiagnostics.ms,
        complete: largeDiagnostics.value?.complete === true,
        diagnosticsReason: largeDiagnostics.value?.diagnosticsReason ?? null,
        diagnosticsSource: largeDiagnostics.value?.diagnosticsSource ?? null,
        diagnostics: largeDiagnostics.value?.diagnostics?.length ?? 0,
        budgetMs: largeDiagnostics.value?.diagnosticsBudgetMs ?? null,
        budgetSource: largeDiagnostics.value?.diagnosticsBudgetSource ?? null,
        budgetBucket: largeDiagnostics.value?.diagnosticsBudgetBucket ?? null,
        fallbackLaunched: largeDiagnostics.value?.diagnosticsFallbackLaunched === true,
        fallbackUsed: largeDiagnostics.value?.diagnosticsFallbackUsed === true,
        fallbackDurationMs: largeDiagnostics.value?.diagnosticsFallbackDurationMs ?? null,
        fallbackAbandoned: largeDiagnostics.value?.diagnosticsFallbackAbandoned === true,
        outputChars: JSON.stringify(largeDiagnostics.value ?? null).length,
      }
      report.cases.diagnosticsLargeRepeat = {
        ms: largeRepeat.ms,
        complete: largeRepeat.value?.complete === true,
        diagnosticsReason: largeRepeat.value?.diagnosticsReason ?? null,
        diagnostics: largeRepeat.value?.diagnostics?.length ?? 0,
        budgetSource: largeRepeat.value?.diagnosticsBudgetSource ?? null,
        budgetBucket: largeRepeat.value?.diagnosticsBudgetBucket ?? null,
        fallbackUsed: largeRepeat.value?.diagnosticsFallbackUsed === true,
      }
    }

    const repeated = []
    for (let index = 0; index < WARM_SAMPLES; index += 1) {
      const run = await measure(() => lspOperation(root, small.relative, "symbols", symbolOptions))
      repeated.push(run)
    }
    report.cases.repeatedWarm = {
      samples: repeated.length,
      medianMs: round(median(repeated.map((item) => item.ms))),
      allWarm: repeated.every((item) => item.value?.pool?.poolHit === true),
      sessionStable: new Set(repeated.map((item) => item.value?.pool?.sessionId)).size === 1,
    }

    const status = await measure(async () => lspPoolStatus({ includeSessions: true, persistent: true }))
    report.cases.status = {
      ms: status.ms,
      outputChars: JSON.stringify(status.value).length,
      sessions: status.value?.sessions?.length ?? 0,
      metrics: status.value?.metrics ?? null,
    }

    // Model-facing payload sizes: what Parent Code Intelligence Lite actually
    // puts in front of a weak model, before and after payload reduction.
    const modelFacing = (action, payload, file) => {
      const { payload: reduced, reduction } = reduceCodePayload(action, payload, { file: file ?? null })
      const rawChars = JSON.stringify(payload, null, 2).length
      const reducedChars = JSON.stringify(reduced, null, 2).length
      return {
        rawChars,
        reducedChars,
        savedChars: reduction.savedChars,
        applied: reduction.applied,
        strategies: reduction.strategies,
        rawPreserved: rawChars >= 4 * 1024 && reduction.applied,
      }
    }
    report.modelFacing = {
      symbols: modelFacing("symbols", cold.value, small.relative),
      search: modelFacing("search", searchWarm.value, null),
      diagnosticsLarge: large ? modelFacing("diagnostics", largeRepeat.value ?? null, large.relative) : null,
    }
    report.pool = lspPoolStatus({ includeSessions: false, persistent: true }).metrics
  } finally {
    await shutdownLspPool(root)
  }

  console.log(JSON.stringify(report, null, 2))
}

await main()
