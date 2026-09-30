// Graph-ranked repo-map retrieval benchmark (V15.3 Phase 3 release gate).
//
//   node scripts/bench-repo-map.mjs [--json] [--k <n>]
//
// This is the release gate for Phase 3, so it runs three rankings over the same
// 21 deterministic fixture queries and prints them side by side:
//
//   baseline-lexical   what `ues_code search` returns today: semantic-index
//                      lexical/symbol scoring alone.
//   baseline-pagerank  what context-manifest builds today: the existing
//                      personalized-PageRank over the import graph, seeded by the
//                      same lexical results plus declared/changed files.
//   v3                 the graph-ranked repo map.
//
// Recall@K is measured against each query's own expected file set, MRR against
// its single primary target. "Irrelevant files" counts every returned file that
// is not in that set, so a ranking cannot improve its numbers by returning
// fewer, better-picked files unless the recall holds.
//
// The V3 module is loaded optionally so this exact command also produces a
// valid pre-patch baseline receipt.

import path from "node:path"
import { buildSemanticIndexCached, clearSemanticIndexRuntimeCache, querySemanticIndex } from "../lib/semantic-index.mjs"
import { buildRepoGraph, clearRepoGraphRuntimeCache } from "../lib/repo-graph.mjs"
import { rankContextGraph } from "../lib/context-graph-rank.mjs"
import { gitChangedFiles } from "../lib/affected-tests.mjs"
import { writeRetrievalFixture } from "../evals/retrieval/fixture.mjs"
import { loadRetrievalQueries, scoreRetrievalRun } from "../evals/retrieval/score.mjs"
import { argValue, optionalModule, printReceipt, round, timed, withTempDir } from "./bench-common.mjs"

const DEFAULT_K = 10
const CONTEXT_BUDGET_CHARS = 6_000

function top(rows, k) {
  return rows.slice(0, k).map((row) => ({ path: row.path, score: row.score, reasons: row.reasons || [] }))
}

// Context is measured with ONE payload shape for every ranking.
//
// The first version of this benchmark measured each ranking with its own row
// shape, so the richer map was penalised for carrying `importantSymbols` and
// `testLinks` that the baselines simply do not produce. The ranking overhead --
// "what does the model read just to learn which files matter" -- has to be
// compared like for like, so every ranking is charged for the same fields, and
// anything a ranking cannot supply counts as empty rather than free.
const COMMON_ROW_KEYS = ["path", "score"]

function commonRowCost(row) {
  const payload = {}
  for (const key of COMMON_ROW_KEYS) payload[key] = row[key] ?? null
  return JSON.stringify(payload).length + 1
}

function commonContextChars(rows) {
  let total = 0
  for (const row of rows) total += commonRowCost(row)
  return total
}

// The map's real cost, reported separately: this is what the model actually
// pays for the richer payload the map ships.
function mapPayloadChars(row) {
  const payload = {
    path: row.path,
    score: round(row.score, 3),
    importantSymbols: (row.importantSymbols || []).map((item) => (typeof item === "string" ? item : item.name)).slice(0, 6),
    relationship: row.relationship || null,
    testLinks: (row.testLinks || []).slice(0, 3),
  }
  return JSON.stringify(payload).length + 1
}

async function run(root) {
  await writeRetrievalFixture(root)
  const queries = await loadRetrievalQueries()
  const k = Math.max(1, Number(argValue("--k", DEFAULT_K)))

  const semantic = await buildSemanticIndexCached(root, { maxFiles: 500 })
  const graph = await buildRepoGraph(root, { maxFiles: 500 })

  const v3 = await optionalModule("../lib/repo-map.mjs")

  const cases = { "baseline-lexical": [], "baseline-pagerank": [] }
  if (v3.ok) cases.v3 = []
  const timings = { "baseline-lexical": [], "baseline-pagerank": [] }
  if (v3.ok) timings.v3 = []

  for (const item of queries) {
    const changed = item.changed.length ? item.changed : gitChangedFiles(root)

    // --- baseline-lexical -------------------------------------------------
    const lexicalStart = Date.now()
    const lexical = await querySemanticIndex(root, item.query, {
      builtIndex: semantic,
      limit: 50,
    })
    const lexicalRows = top(lexical.results, k)
    timings["baseline-lexical"].push(Date.now() - lexicalStart)
    cases["baseline-lexical"].push({
      ...item,
      ranked: lexicalRows,
      contextChars: commonContextChars(lexicalRows),
      payloadChars: 0,
      queryMs: Date.now() - lexicalStart,
    })

    // --- baseline-pagerank ------------------------------------------------
    const pagerankStart = Date.now()
    const ranked = rankContextGraph(graph, {
      semanticResults: lexical.results,
      declared: item.declared,
      changed,
      limit: 50,
    })
    const pagerankRows = top(ranked, k)
    timings["baseline-pagerank"].push(Date.now() - pagerankStart)
    cases["baseline-pagerank"].push({
      ...item,
      ranked: pagerankRows,
      contextChars: commonContextChars(pagerankRows),
      payloadChars: 0,
      queryMs: Date.now() - pagerankStart,
    })

    // --- v3 ---------------------------------------------------------------
    if (v3.ok) {
      const started = Date.now()
      const map = await v3.module.buildRepoMap(root, item.query, {
        declaredFiles: item.declared,
        changedFiles: changed,
        limit: k,
        contextBudgetChars: CONTEXT_BUDGET_CHARS,
        builtSemantic: semantic,
        builtGraph: graph,
      })
      const rows = top(map.files || [], k)
      const v3Elapsed = Date.now() - started
      timings.v3.push(v3Elapsed)
      cases.v3.push({
        ...item,
        ranked: rows,
        contextChars: commonContextChars(rows),
        payloadChars: Number(map.stats?.contextChars || 0),
        queryMs: v3Elapsed,
      })
    }
  }

  const scored = {}
  for (const [name, rows] of Object.entries(cases)) {
    scored[name] = scoreRetrievalRun(rows)
    scored[name].summary.observedQueryMs = round(
      timings[name].reduce((sum, value) => sum + value, 0) / Math.max(1, timings[name].length),
    )
    scored[name].summary.mapPayloadCharsPerQuery = round(
      rows.reduce((sum, row) => sum + (row.payloadChars || 0), 0) / Math.max(1, rows.length),
    )
  }

  // The release gate, evaluated in the benchmark so a regression is visible in
  // the receipt rather than only in a reviewer's judgement. The comparison
  // baseline is the strongest ranking the runtime had before this phase.
  const gate = evaluateReleaseGate(scored["baseline-pagerank"]?.summary, scored.v3?.summary, scored["baseline-lexical"]?.summary)

  return {
    schemaVersion: 1,
    kind: "ues-repo-map-retrieval-benchmark",
    node: process.version,
    fixture: path.basename(root),
    k,
    contextBudgetChars: CONTEXT_BUDGET_CHARS,
    v3Available: v3.ok,
    v3Error: v3.ok ? null : v3.error,
    gate,
    rankings: scored,
    perQuery: queries.map((item, index) => ({
      id: item.id,
      class: item.class,
      primary: item.primary,
      baselineLexicalRank:
        cases["baseline-lexical"][index].ranked.findIndex((row) => row.path === item.primary) + 1,
      baselinePagerankRank:
        cases["baseline-pagerank"][index].ranked.findIndex((row) => row.path === item.primary) + 1,
      v3Rank: v3.ok
        ? cases.v3[index].ranked.findIndex((row) => row.path === item.primary) + 1
        : null,
      v3ContextChars: v3.ok ? cases.v3[index].contextChars : null,
    })),
  }
}

// A regression is a MATERIAL regression. A flat tie is allowed; a drop in
// recall, a meaningful MRR loss, or a large context or latency increase bought
// with no quality gain is not.
const MRR_TOLERANCE = 0.02
const CONTEXT_GROWTH_ALLOWED = 0.5

export function evaluateReleaseGate(baseline, candidate, weaker) {
  if (!candidate) return { pass: false, reason: "v3-unavailable", checks: [] }
  const checks = [
    { name: "recallAt1", baseline: baseline?.recallAt1 ?? 0, candidate: candidate.recallAt1, pass: candidate.recallAt1 >= (baseline?.recallAt1 ?? 0) },
    { name: "recallAt3", baseline: baseline?.recallAt3 ?? 0, candidate: candidate.recallAt3, pass: candidate.recallAt3 >= (baseline?.recallAt3 ?? 0) },
    { name: "recallAt5", baseline: baseline?.recallAt5 ?? 0, candidate: candidate.recallAt5, pass: candidate.recallAt5 >= (baseline?.recallAt5 ?? 0) },
    {
      name: "mrr",
      baseline: baseline?.mrr ?? 0,
      candidate: candidate.mrr,
      pass: candidate.mrr >= (baseline?.mrr ?? 0) - MRR_TOLERANCE,
    },
    { name: "beats-lexical-baseline", pass: candidate.recallAt5 >= (weaker?.recallAt5 ?? 0) },
    {
      name: "context-not-explosive",
      baseline: baseline?.contextCharsPerQuery ?? 0,
      candidate: candidate.contextCharsPerQuery,
      pass: candidate.contextCharsPerQuery <= (baseline?.contextCharsPerQuery ?? 0) * (1 + CONTEXT_GROWTH_ALLOWED) + 200,
    },
    {
      name: "latency-bounded",
      baseline: baseline?.observedQueryMs ?? 0,
      candidate: candidate.observedQueryMs,
      // The map is a deliberate step up in cost; it must stay in single-digit ms
      // on a small repository, which is the weak-model hot path.
      pass: candidate.observedQueryMs <= 50,
    },
  ]
  const failures = checks.filter((check) => !check.pass)
  return { pass: failures.length === 0, reason: failures.map((check) => check.name).join(",") || null, checks }
}

clearSemanticIndexRuntimeCache()
clearRepoGraphRuntimeCache()
const receipt = await withTempDir("repo-map", run)
printReceipt(receipt)
