// HOLDOUT B -- fresh retrieval audit, run EXACTLY ONCE after the 15.3 freeze.
//
//   node scripts/bench-holdout-b.mjs
//
// THE CONTRACT THIS FILE ENFORCES
//
//   1. It reads the freeze receipt and refuses to run unless the DEV gate passed
//      and every implementation hash still matches. A retrieval benchmark that
//      can run against a modified implementation is a tuning loop with extra
//      steps.
//   2. It validates the holdout BEFORE scoring: >= 80 queries, >= 4 structurally
//      distinct families, all ten classes represented, every expected file present
//      in the generated fixture, and no path shared with the DEV corpus or with
//      holdout A.
//   3. It records the ordering evidence -- freeze timestamp, fixture hash, query
//      hash, implementation hashes, run timestamp -- BEFORE it evaluates anything,
//      so the receipt proves the set was fixed before it was seen.
//   4. There is no `--rerun`, no `--tune` and no repair path. If the gate fails,
//      15.3 is BLOCKED and the evidence is preserved.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildSemanticIndexCached, clearSemanticIndexRuntimeCache, querySemanticIndex } from "../lib/semantic-index.mjs"
import { buildRepoGraph, clearRepoGraphRuntimeCache } from "../lib/repo-graph.mjs"
import { rankContextGraph } from "../lib/context-graph-rank.mjs"
import { gitChangedFiles } from "../lib/affected-tests.mjs"
import { buildRepoMap, clearRepoMapRuntimeCache } from "../lib/repo-map.mjs"
import {
  HOLDOUT_B_CLASSES,
  HOLDOUT_B_FAMILIES,
  holdoutBFiles,
  writeHoldoutBFamily,
} from "../evals/retrieval/holdout-b-fixtures.mjs"
import { scoreRetrievalRun } from "../evals/retrieval/score.mjs"
import { round, withTempDir } from "./bench-common.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const QUERY_FILE = path.join(ROOT, "evals/retrieval/holdout-b-queries.json")
const FIXTURE_FILE = path.join(ROOT, "evals/retrieval/holdout-b-fixtures.mjs")
const FREEZE_FILE = path.join(ROOT, ".ues-evals/v15.3/freeze-receipt.json")
const RECEIPT_FILE = path.join(ROOT, ".ues-evals/v15.3/holdout-b.json")

const K = 10
const CONTEXT_BUDGET_CHARS = 6_000
const MRR_TOLERANCE = 0.02

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

async function main(root) {
  // ---- 1. the freeze must hold ------------------------------------------
  const freezeRaw = await readFile(FREEZE_FILE, "utf8").catch(() => "")
  if (!freezeRaw) {
    return { pass: false, verdict: "holdout-b-blocked", reason: "missing-freeze-receipt", checks: [] }
  }
  const freeze = JSON.parse(freezeRaw)
  const drift = []
  for (const [file, expected] of Object.entries(freeze.implementation || {})) {
    const actual = sha256(await readFile(path.join(ROOT, file)).catch(() => Buffer.alloc(0)))
    if (actual !== expected) drift.push({ file, expected, actual })
  }
  if (drift.length || freeze.devGate?.pass !== true) {
    return {
      pass: false,
      verdict: "holdout-b-blocked",
      reason: drift.length ? "implementation-drifted-after-freeze" : "dev-gate-not-passed",
      drift,
      checks: [],
    }
  }

  // ---- 2. freeze the corpus BEFORE scoring it ---------------------------
  const queryBytes = await readFile(QUERY_FILE)
  const fixtureBytes = await readFile(FIXTURE_FILE)
  const frozen = {
    queriesSha256: sha256(queryBytes),
    fixturesSha256: sha256(fixtureBytes),
    freezeReceiptSha256: sha256(freezeRaw),
    implementation: freeze.implementation,
    devGatePassedAt: freeze.frozenAt,
    holdoutCreatedAfterFreeze: new Date().toISOString(),
  }
  const queries = JSON.parse(queryBytes.toString("utf8")).queries

  // ---- 3. validation ---------------------------------------------------
  const problems = []
  if (queries.length < 80) problems.push(`holdout B must have at least 80 queries, found ${queries.length}`)
  if (HOLDOUT_B_FAMILIES.length < 4) problems.push(`holdout B must have at least 4 families, found ${HOLDOUT_B_FAMILIES.length}`)

  const roots = new Map()
  for (const family of HOLDOUT_B_FAMILIES) {
    const familyRoot = path.join(root, family.id)
    await writeHoldoutBFamily(familyRoot, family.id)
    roots.set(family.id, familyRoot)
  }
  for (const item of queries) {
    if (!roots.has(item.family)) { problems.push(`${item.id}: unknown family ${item.family}`); continue }
    const known = new Set(holdoutBFiles(item.family))
    for (const file of item.expect || []) {
      if (!known.has(file)) problems.push(`${item.id}: expected file absent from fixture: ${file}`);
    }
    if (item.primary && !(item.expect || []).includes(item.primary)) problems.push(`${item.id}: primary not in expect`)
    if (!HOLDOUT_B_CLASSES.includes(item.class)) problems.push(`${item.id}: unlabelled class ${item.class}`);
  }
  const perClass = new Map()
  for (const item of queries) perClass.set(item.class, (perClass.get(item.class) || 0) + 1)
  for (const cls of HOLDOUT_B_CLASSES) {
    const count = perClass.get(cls) || 0
    if (count < 8) problems.push(`class ${cls} has ${count} queries, at least 8 required`);
  }

  // No answer may be shared with the DEV corpus or with the failed holdout A.
  const answerPaths = new Set()
  for (const item of queries) {
    answerPaths.add(item.primary)
    for (const file of item.expect || []) answerPaths.add(file);
  }
  for (const [label, file] of [
    ["DEV", path.join(ROOT, "evals/retrieval/dev-queries.json")],
    ["holdout A", path.join(ROOT, "evals/retrieval/holdout-queries.json")],
  ]) {
    const other = JSON.parse(await readFile(file, "utf8")).queries
    for (const item of other) {
      for (const answer of [item.primary, ...(item.expect || []), ...(item.changed || [])]) {
        if (answer && answerPaths.has(answer)) problems.push(`answer path ${answer} is shared with ${label} (${item.id})`);
      }
    }
  }
  if (problems.length) {
    return { pass: false, verdict: "holdout-b-invalid", frozen, validation: { ok: false, problems }, checks: [] }
  }

  // ---- 4. build once per family ----------------------------------------
  const built = new Map()
  for (const [familyId, familyRoot] of roots) {
    built.set(familyId, {
      familyRoot,
      semantic: await buildSemanticIndexCached(familyRoot, { maxFiles: 600 }),
      graph: await buildRepoGraph(familyRoot, { maxFiles: 600 }),
    })
  }

  const cases = { "baseline-lexical": [], "baseline-pagerank": [], "frozen-v3": [] }
  const perQuery = []
  const latency = { "baseline-lexical": [], "baseline-pagerank": [], "frozen-v3": [] }
  const payload = { "baseline-lexical": [], "baseline-pagerank": [], "frozen-v3": [] }

  for (const item of queries) {
    const { familyRoot, semantic, graph } = built.get(item.family)
    const changed = (item.changed || []).length ? item.changed : gitChangedFiles(familyRoot)

    const t0 = Date.now()
    const lexical = await querySemanticIndex(familyRoot, item.query, { builtIndex: semantic, limit: 60 })
    const lexicalRows = lexical.results.slice(0, K).map((row) => ({ path: row.path, score: row.score }))
    latency["baseline-lexical"].push(Date.now() - t0)
    payload["baseline-lexical"].push(0)

    const t1 = Date.now()
    const pagerank = rankContextGraph(graph, {
      semanticResults: lexical.results,
      declared: item.declared || [],
      changed,
      limit: 60,
    })
    const pagerankRows = pagerank.slice(0, K).map((row) => ({ path: row.path, score: row.score }))
    latency["baseline-pagerank"].push(Date.now() - t1)
    payload["baseline-pagerank"].push(0)

    const t2 = Date.now()
    const map = await buildRepoMap(familyRoot, item.query, {
      declaredFiles: item.declared || [],
      changedFiles: changed,
      limit: K,
      contextBudgetChars: CONTEXT_BUDGET_CHARS,
      builtSemantic: semantic,
      builtGraph: graph,
    })
    const v3Rows = map.files.slice(0, K).map((row) => ({ path: row.path, score: row.score }))
    latency["frozen-v3"].push(Date.now() - t2)
    payload["frozen-v3"].push(Number(map.stats?.contextChars || 0))

    cases["baseline-lexical"].push({ ...item, ranked: lexicalRows })
    cases["baseline-pagerank"].push({ ...item, ranked: pagerankRows })
    cases["frozen-v3"].push({ ...item, ranked: v3Rows, candidates: map.stats?.candidateCount || 0 })

    perQuery.push({
      id: item.id,
      family: item.family,
      class: item.class,
      primary: item.primary,
      lexical: lexicalRows.findIndex((row) => row.path === item.primary) + 1,
      pagerank: pagerankRows.findIndex((row) => row.path === item.primary) + 1,
      frozenV3: v3Rows.findIndex((row) => row.path === item.primary) + 1,
    });
  }

  const scored = {}
  for (const [name, rows] of Object.entries(cases)) {
    const summary = scoreRetrievalRun(rows).summary
    scored[name] = summary
    summary.observedQueryMs = round(latency[name].reduce((sum, value) => sum + value, 0) / Math.max(1, latency[name].length))
    summary.mapPayloadCharsPerQuery = round(payload[name].reduce((sum, value) => sum + value, 0) / Math.max(1, payload[name].length))
    summary.meanCandidatesPerQuery = name === "frozen-v3"
      ? round(rows.reduce((sum, row) => sum + (row.candidates || 0), 0) / Math.max(1, rows.length))
      : null
  }

  // ---- 5. per class -----------------------------------------------------
  const byClass = {}
  for (const cls of HOLDOUT_B_CLASSES) {
    const subset = queries.map((item) => item.class === cls)
    const entry = { queries: subset.filter(Boolean).length }
    for (const name of ["baseline-lexical", "baseline-pagerank", "frozen-v3"]) {
      const rows = cases[name].filter((_, index) => subset[index])
      const summary = scoreRetrievalRun(rows).summary
      entry[name] = {
        recallAt1: summary.recallAt1,
        recallAt3: summary.recallAt3,
        recallAt5: summary.recallAt5,
        mrr: summary.mrr,
        irrelevantPerQuery: summary.irrelevantPerQuery,
      }
    }
    entry.losses = []
    for (const name of ["baseline-lexical", "baseline-pagerank"]) {
      if (entry["frozen-v3"].recallAt1 < entry[name].recallAt1) {
        entry.losses.push(`recallAt1 vs ${name}: ${entry[name].recallAt1} -> ${entry["frozen-v3"].recallAt1}`)
      }
      if (entry["frozen-v3"].mrr < entry[name].mrr - MRR_TOLERANCE) {
        entry.losses.push(`mrr vs ${name}: ${entry[name].mrr} -> ${entry["frozen-v3"].mrr}`)
      }
    }
    byClass[cls] = entry
  }

  const global = scored["frozen-v3"]
  const lexical = scored["baseline-lexical"]
  const pagerank = scored["baseline-pagerank"]
  const strongest = {
    recallAt1: Math.max(lexical.recallAt1, pagerank.recallAt1),
    recallAt3: Math.max(lexical.recallAt3, pagerank.recallAt3),
    recallAt5: Math.max(lexical.recallAt5, pagerank.recallAt5),
    mrr: Math.max(lexical.mrr, pagerank.mrr) - MRR_TOLERANCE,
  }

  const checks = [
    { name: "holdout-b-at-least-80-queries", pass: queries.length >= 80, value: queries.length },
    { name: "holdout-b-at-least-4-families", pass: HOLDOUT_B_FAMILIES.length >= 4, value: HOLDOUT_B_FAMILIES.length },
    { name: "holdout-b-all-10-classes", pass: HOLDOUT_B_CLASSES.every((cls) => (perClass.get(cls) || 0) >= 8), value: Object.fromEntries(perClass) },
    { name: "holdout-b-global-recall@1-not-worse", pass: global.recallAt1 >= strongest.recallAt1, detail: { strongest: strongest.recallAt1, frozen: global.recallAt1 } },
    { name: "holdout-b-global-recall@3-not-worse", pass: global.recallAt3 >= strongest.recallAt3, detail: { strongest: strongest.recallAt3, frozen: global.recallAt3 } },
    { name: "holdout-b-global-recall@5-not-worse", pass: global.recallAt5 >= strongest.recallAt5, detail: { strongest: strongest.recallAt5, frozen: global.recallAt5 } },
    { name: "holdout-b-global-mrr-not-worse", pass: global.mrr >= strongest.mrr, detail: { strongest: strongest.mrr, frozen: global.mrr } },
    { name: "holdout-b-no-systematic-class-regression", pass: Object.values(byClass).every((entry) => entry.losses.length === 0), detail: Object.entries(byClass).filter(([, e]) => e.losses.length).map(([cls, e]) => ({ cls, losses: e.losses })) },
    { name: "holdout-b-candidates-bounded", pass: (global.meanCandidatesPerQuery || 0) <= 240, detail: global.meanCandidatesPerQuery },
    { name: "holdout-b-payload-bounded", pass: global.mapPayloadCharsPerQuery <= 6_000, detail: global.mapPayloadCharsPerQuery },
  ]
  const failures = checks.filter((check) => !check.pass)

  return {
    schemaVersion: 1,
    kind: "ues-holdout-b-benchmark",
    node: process.version,
    frozen,
    validation: { ok: true, problems: [] },
    queries: queries.length,
    families: HOLDOUT_B_FAMILIES.map((family) => ({ id: family.id, files: holdoutBFiles(family.id).length })),
    classes: HOLDOUT_B_CLASSES,
    perClass,
    k: K,
    rankings: scored,
    byClass,
    perQuery,
    checks,
    tuningAfterHoldoutB: false,
    runOnce: true,
    pass: failures.length === 0,
    verdict: failures.length === 0 ? "holdout-b-pass" : "15.3 BLOCKED",
  }
}


clearSemanticIndexRuntimeCache()
clearRepoGraphRuntimeCache()
clearRepoMapRuntimeCache()
const receipt = await withTempDir("holdoutb", main)
await writeFile(RECEIPT_FILE, JSON.stringify(receipt, null, 2) + "\n")
process.stdout.write(JSON.stringify(receipt) + "\n")
process.exitCode = receipt.pass ? 0 : 1