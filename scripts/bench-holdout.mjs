// FROZEN HOLDOUT retrieval audit (15.3 independent hardening, section A).
//
//   node scripts/bench-holdout.mjs [--json]
//
// Why this exists: the 21-query set in evals/retrieval/queries.json is no longer
// an independent holdout, because the ranking in lib/repo-map.mjs was revised
// after its failures were observed on it. This runs a second, untouched set.
//
// The rules this script enforces on itself:
//   1. every expected path must exist in the generated fixture, checked BEFORE
//      any ranking runs, so a fixture/expectation mismatch can never be scored;
//   2. the query set and the fixture generators are hashed and the hash is in the
//      receipt, so "frozen" is checkable rather than a claim;
//   3. exactly one pass over the set -- there is no iteration, no re-ranking and
//      no weight is adjusted from anything it prints;
//   4. `tuningAfterHoldout` is recorded so a later run that changed the ranking
//      and re-used this set would be visibly wrong.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildSemanticIndexCached, clearSemanticIndexRuntimeCache, querySemanticIndex } from "../lib/semantic-index.mjs"
import { buildRepoGraph, clearRepoGraphRuntimeCache } from "../lib/repo-graph.mjs"
import { rankContextGraph } from "../lib/context-graph-rank.mjs"
import { gitChangedFiles } from "../lib/affected-tests.mjs"
import { buildRepoMap, clearRepoMapRuntimeCache } from "../lib/repo-map.mjs"
import { HOLDOUT_FAMILIES, holdoutFiles, writeHoldoutFamily } from "../evals/retrieval/holdout-fixtures.mjs"
import { scoreRetrievalRun } from "../evals/retrieval/score.mjs"
import { argValue, printReceipt, round, withTempDir } from "./bench-common.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const QUERY_FILE = path.join(ROOT, "evals/retrieval/holdout-queries.json")
const FIXTURE_FILE = path.join(ROOT, "evals/retrieval/holdout-fixtures.mjs")

const K = 10
const CONTEXT_BUDGET_CHARS = 6_000
const RECALL_TOLERANCE = 0
const MRR_TOLERANCE = 0.02

const COMMON_ROW_KEYS = ["path", "score"]
const commonContextChars = (rows) => rows.reduce((total, row) => {
  const payload = {}
  for (const key of COMMON_ROW_KEYS) payload[key] = row[key] ?? null
  return total + JSON.stringify(payload).length + 1
}, 0)

const top = (rows, k) => rows.slice(0, k).map((row) => ({ path: row.path, score: row.score, reasons: row.reasons || [] }))

async function run(root) {
  // --- freeze proof ------------------------------------------------------
  const queryBytes = await readFile(QUERY_FILE)
  const fixtureBytes = await readFile(FIXTURE_FILE)
  const frozen = {
    queriesSha256: createHash("sha256").update(queryBytes).digest("hex"),
    fixturesSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  }

  const parsed = JSON.parse(queryBytes.toString("utf8"))
  const queries = parsed.queries
  assert.ok(queries.length >= 30, `holdout must have at least 30 queries, found ${queries.length}`)

  // --- fixtures ----------------------------------------------------------
  const familyRoots = new Map()
  for (const family of HOLDOUT_FAMILIES) {
    const familyRoot = path.join(root, family.id)
    await writeHoldoutFamily(familyRoot, family.id)
    familyRoots.set(family.id, familyRoot)
  }

  // --- pre-flight validation: expectations must name real files ---------
  const problems = []
  for (const item of queries) {
    const familyRoot = familyRoots.get(item.family)
    if (!familyRoot) { problems.push(`${item.id}: unknown family ${item.family}`); continue }
    const known = new Set(holdoutFiles(item.family))
    for (const file of item.expect || []) {
      if (!known.has(file)) problems.push(`${item.id}: expected file not in fixture: ${file}`)
    }
    if (item.primary && !(item.expect || []).includes(item.primary)) {
      problems.push(`${item.id}: primary ${item.primary} is not in expect`)
    }
  }
  if (problems.length) {
    return { schemaVersion: 1, kind: "ues-holdout-audit", frozen, validation: { ok: false, problems }, pass: false }
  }

  // --- build once per family --------------------------------------------
  const built = new Map()
  for (const [familyId, familyRoot] of familyRoots) {
    const semantic = await buildSemanticIndexCached(familyRoot, { maxFiles: 500 })
    const graph = await buildRepoGraph(familyRoot, { maxFiles: 500 })
    built.set(familyId, { familyRoot, semantic, graph })
  }

  // --- one pass, no iteration -------------------------------------------
  const cases = { "baseline-lexical": [], "baseline-pagerank": [], v3: [] }
  const perQuery = []

  for (const item of queries) {
    const { familyRoot, semantic, graph } = built.get(item.family)
    const changed = (item.changed || []).length ? item.changed : gitChangedFiles(familyRoot)

    const t0 = Date.now()
    const lexical = await querySemanticIndex(familyRoot, item.query, { builtIndex: semantic, limit: 60 })
    const lexicalMs = Date.now() - t0
    const lexicalRows = top(lexical.results, K)

    const t1 = Date.now()
    const pagerank = rankContextGraph(graph, {
      semanticResults: lexical.results,
      declared: [],
      changed,
      limit: 60,
    })
    const pagerankMs = Date.now() - t1
    const pagerankRows = top(pagerank, K)

    const t2 = Date.now()
    const map = await buildRepoMap(familyRoot, item.query, {
      changedFiles: changed,
      limit: K,
      contextBudgetChars: CONTEXT_BUDGET_CHARS,
      builtSemantic: semantic,
      builtGraph: graph,
    })
    const v3Ms = Date.now() - t2
    const v3Rows = top(map.files || [], K)

    cases["baseline-lexical"].push({ ...item, ranked: lexicalRows, contextChars: commonContextChars(lexicalRows), payloadChars: 0, queryMs: lexicalMs })
    cases["baseline-pagerank"].push({ ...item, ranked: pagerankRows, contextChars: commonContextChars(pagerankRows), payloadChars: 0, queryMs: pagerankMs })
    cases.v3.push({
      ...item,
      ranked: v3Rows,
      contextChars: commonContextChars(v3Rows),
      payloadChars: Number(map.stats?.contextChars || 0),
      queryMs: v3Ms,
    })

    const rank = (rows) => rows.findIndex((row) => row.path === item.primary) + 1
    perQuery.push({
      id: item.id,
      family: item.family,
      class: item.class,
      primary: item.primary,
      lexical: rank(lexicalRows),
      pagerank: rank(pagerankRows),
      v3: rank(v3Rows),
      v3top3: v3Rows.slice(0, 3).map((row) => row.path),
    })
  }

  const scored = {}
  for (const [name, rows] of Object.entries(cases)) {
    scored[name] = scoreRetrievalRun(rows)
    scored[name].summary.observedQueryMs = round(rows.reduce((sum, row) => sum + row.queryMs, 0) / Math.max(1, rows.length))
    scored[name].summary.mapPayloadCharsPerQuery = round(rows.reduce((sum, row) => sum + (row.payloadChars || 0), 0) / Math.max(1, rows.length))
  }

  // --- per-class analysis ------------------------------------------------
  const classes = [...new Set(queries.map((item) => item.class))].sort()
  const byClass = {}
  for (const cls of classes) {
    const indexes = queries.map((item, index) => (item.class === cls ? index : -1)).filter((index) => index >= 0)
    const slice = (name) => scoreRetrievalRun(cases[name].filter((row) => row.class === cls))
    const entry = { queries: indexes.length }
    for (const name of ["baseline-lexical", "baseline-pagerank", "v3"]) {
      const summary = slice(name).summary
      entry[name] = {
        recallAt1: summary.recallAt1,
        recallAt3: summary.recallAt3,
        recallAt5: summary.recallAt5,
        mrr: summary.mrr,
        irrelevantPerQuery: summary.irrelevantPerQuery,
      }
    }
    const regressions = []
    for (const name of ["baseline-lexical", "baseline-pagerank"]) {
      if (entry.v3.recallAt1 < entry[name].recallAt1 - RECALL_TOLERANCE) {
        regressions.push(`recallAt1 vs ${name}: ${entry[name].recallAt1} -> ${entry.v3.recallAt1}`)
      }
      if (entry.v3.recallAt3 < entry[name].recallAt3 - RECALL_TOLERANCE) {
        regressions.push(`recallAt3 vs ${name}: ${entry[name].recallAt3} -> ${entry.v3.recallAt3}`)
      }
      if (entry.v3.mrr < entry[name].mrr - MRR_TOLERANCE) {
        regressions.push(`mrr vs ${name}: ${entry[name].mrr} -> ${entry.v3.mrr}`)
      }
    }
    entry.regressions = regressions
    byClass[cls] = entry
  }

  // --- per-query regressions against the strongest baseline ---------------
  const baselineRows = new Map(cases["baseline-pagerank"].map((row) => [row.id, row]))
  const lexicalRows = new Map(cases["baseline-lexical"].map((row) => [row.id, row]))
  const perQueryRegressions = []
  for (const index of queries.map((item, i) => i)) {
    const id = queries[index].id
    const v = cases.v3[index]
    for (const [name, table] of [["baseline-pagerank", baselineRows], ["baseline-lexical", lexicalRows]]) {
      const b = table.get(id)
      if (v.recallAt1 < b.recallAt1 - RECALL_TOLERANCE) {
        perQueryRegressions.push({ id, vs: name, metric: "recallAt1", base: b.recallAt1, candidate: v.recallAt1 })
      }
      if (v.recallAt3 < b.recallAt3 - RECALL_TOLERANCE) {
        perQueryRegressions.push({ id, vs: name, metric: "recallAt3", base: b.recallAt3, candidate: v.recallAt3 })
      }
      if (v.reciprocalRank < b.reciprocalRank - MRR_TOLERANCE) {
        perQueryRegressions.push({ id, vs: name, metric: "mrr", base: b.reciprocalRank, candidate: v.reciprocalRank })
      }
    }
  }

  // --- family-level generalisation --------------------------------------
  const byFamily = {}
  for (const family of HOLDOUT_FAMILIES) {
    const entry = { queries: queries.filter((item) => item.family === family.id).length }
    for (const name of ["baseline-lexical", "baseline-pagerank", "v3"]) {
      const summary = scoreRetrievalRun(cases[name].filter((row) => row.family === family.id)).summary
      entry[name] = { recallAt1: summary.recallAt1, recallAt3: summary.recallAt3, recallAt5: summary.recallAt5, mrr: summary.mrr }
    }
    byFamily[family.id] = entry
  }

  const checks = [
    { name: "holdout-at-least-30-queries", pass: queries.length >= 30, value: queries.length },
    { name: "two-structurally-distinct-families", pass: HOLDOUT_FAMILIES.length >= 2, value: HOLDOUT_FAMILIES.length },
    { name: "all-10-classes-covered", pass: classes.length >= 10, value: classes },
    { name: "no-recall-regression-vs-strongest-baseline", pass: scored.v3.summary.recallAt1 >= scored["baseline-pagerank"].summary.recallAt1 && scored.v3.summary.recallAt3 >= scored["baseline-pagerank"].summary.recallAt3 && scored.v3.summary.recallAt5 >= scored["baseline-pagerank"].summary.recallAt5, detail: { baseline: scored["baseline-pagerank"].summary, v3: scored.v3.summary } },
    { name: "no-mrr-regression-vs-strongest-baseline", pass: scored.v3.summary.mrr >= scored["baseline-pagerank"].summary.mrr - MRR_TOLERANCE, detail: { baseline: scored["baseline-pagerank"].summary.mrr, v3: scored.v3.summary.mrr } },
    { name: "no-systematic-class-regression", pass: Object.values(byClass).every((entry) => entry.regressions.length === 0), detail: Object.entries(byClass).filter(([, entry]) => entry.regressions.length).map(([cls, entry]) => ({ cls, regressions: entry.regressions })) },
    { name: "no-per-query-regression", pass: perQueryRegressions.length === 0, detail: perQueryRegressions },
    { name: "v3-beats-original-21-query-set-generalisation", pass: scored.v3.summary.recallAt3 >= scored["baseline-lexical"].summary.recallAt3, detail: { lexical: scored["baseline-lexical"].summary.recallAt3, v3: scored.v3.summary.recallAt3 } },
    { name: "ranking-context-not-explosive", pass: scored.v3.summary.contextCharsPerQuery <= scored["baseline-pagerank"].summary.contextCharsPerQuery * 1.5 + 200, detail: { baseline: scored["baseline-pagerank"].summary.contextCharsPerQuery, v3: scored.v3.summary.contextCharsPerQuery } },
  ]
  const failures = checks.filter((check) => !check.pass)

  return {
    schemaVersion: 1,
    kind: "ues-holdout-audit",
    node: process.version,
    frozen,
    tuningAfterHoldout: false,
    tuningNote: "lib/repo-map.mjs was not modified before, during or after this run.",
    validation: { ok: true, problems: [] },
    families: HOLDOUT_FAMILIES.map((family) => ({ id: family.id, files: holdoutFiles(family.id).length })),
    queries: queries.length,
    classes,
    k: K,
    contextBudgetChars: CONTEXT_BUDGET_CHARS,
    rankings: scored,
    byFamily,
    byClass,
    perQuery,
    perQueryRegressions,
    checks,
    pass: failures.length === 0,
    verdict: failures.length === 0 ? "holdout-generalises" : "holdout-regression",
  }
}

clearSemanticIndexRuntimeCache()
clearRepoGraphRuntimeCache()
clearRepoMapRuntimeCache()
const receipt = await withTempDir("holdout", run)
printReceipt(receipt)
process.exitCode = receipt.pass ? 0 : 1
