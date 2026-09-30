// HOLDOUT D -- the second independent retrieval audit for 15.3, run EXACTLY ONCE.
//
//   npm run bench:holdout-d
//
// THE CONTRACT THIS FILE ENFORCES
//
//   1. It refuses to run unless freeze receipt V3b exists and EVERY
//      implementation hash still matches it. A retrieval benchmark that can run
//      against a modified implementation is a tuning loop with extra steps.
//   2. It validates the holdout BEFORE scoring: >= 120 queries, >= 5 structurally
//      distinct families, all ten classes represented with >= 10 examples each,
//      every expected file present in the generated fixture, every primary inside
//      its own expect set, and NO answer path shared with the DEV corpus, with
//      holdout A or with holdout B.
//   3. It writes an ORDERING RECEIPT -- freeze timestamp, query hash, fixture
//      hash, runner hash, implementation hashes, run timestamp -- BEFORE it
//      evaluates anything, so the receipt proves the inputs were fixed before
//      they were seen.
//   4. There is no --rerun, no --tune and no repair path. If the gate fails,
//      15.3 is BLOCKED and the evidence is preserved.
//
// Holdout B was scored once, failed, and is DIAGNOSTIC ONLY: its construction
// exposed defects that changed production code before its scored run, so it can
// never be release evidence. A draft holdout C was contaminated during fixture
// construction, was never scored, and is preserved under
// .ues-evals/v15.3/contaminated/.

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
  HOLDOUT_D_CLASSES,
  HOLDOUT_D_FAMILIES,
  holdoutDFiles,
  writeHoldoutDFamily,
} from "../evals/retrieval/holdout-d-fixtures.mjs"
import { scoreRetrievalRun } from "../evals/retrieval/score.mjs"
import { round, withTempDir } from "./bench-common.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const RUNNER = path.join(HERE, "bench-holdout-d.mjs")
const QUERY_FILE = path.join(ROOT, "evals/retrieval/holdout-d-queries.json")
const FIXTURE_FILE = path.join(ROOT, "evals/retrieval/holdout-d-fixtures.mjs")
const FREEZE_FILE = path.join(ROOT, ".ues-evals/v15.3/freeze-receipt-v3.json")
const RECEIPT_FILE = path.join(ROOT, ".ues-evals/v15.3/holdout-d.json")
const ORDERING_FILE = path.join(ROOT, ".ues-evals/v15.3/holdout-d-ordering.json")

const K = 10
const CONTEXT_BUDGET_CHARS = 6_000
const MRR_TOLERANCE = 0.02
const MIN_QUERIES = 120
const MIN_FAMILIES = 5
const MIN_PER_CLASS = 10

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

async function main(root) {
  // ---- 1. the freeze must hold ------------------------------------------
  const freezeRaw = await readFile(FREEZE_FILE, "utf8").catch(() => "")
  if (!freezeRaw) {
    return { pass: false, verdict: "holdout-d-blocked", reason: "missing-freeze-receipt", checks: [] }
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
      verdict: "holdout-d-blocked",
      reason: drift.length ? "implementation-drifted-after-freeze" : "dev-gate-not-passed",
      drift,
      checks: [],
    }
  }

  // ---- 2. freeze the inputs BEFORE scoring them -------------------------
  const queryBytes = await readFile(QUERY_FILE)
  const fixtureBytes = await readFile(FIXTURE_FILE)
  const frozen = {
    queriesSha256: sha256(queryBytes),
    fixturesSha256: sha256(fixtureBytes),
    runnerSha256: sha256(await readFile(RUNNER)),
    freezeReceiptSha256: sha256(freezeRaw),
    implementation: freeze.implementation,
    devGatePassedAt: freeze.frozenAt,
    holdoutCreatedAfterFreeze: new Date().toISOString(),
  }
  const queries = JSON.parse(queryBytes.toString("utf8")).queries

  // ---- 3. validation ---------------------------------------------------
  const problems = []
  if (queries.length < MIN_QUERIES) problems.push(`holdout D must have at least ${MIN_QUERIES} queries, found ${queries.length}`)
  if (HOLDOUT_D_FAMILIES.length < MIN_FAMILIES) problems.push(`holdout D must have at least ${MIN_FAMILIES} families, found ${HOLDOUT_D_FAMILIES.length}`)

  const roots = new Map()
  for (const family of HOLDOUT_D_FAMILIES) {
    const familyRoot = path.join(root, family.id)
    await writeHoldoutDFamily(familyRoot, family.id)
    roots.set(family.id, familyRoot)
  }
  for (const item of queries) {
    if (!roots.has(item.family)) { problems.push(`${item.id}: unknown family ${item.family}`); continue }
    const known = new Set(holdoutDFiles(item.family))
    for (const file of item.expect || []) {
      if (!known.has(file)) problems.push(`${item.id}: expected file absent from fixture: ${file}`)
    }
    if (item.primary && !(item.expect || []).includes(item.primary)) problems.push(`${item.id}: primary not in expect`)
    if (!HOLDOUT_D_CLASSES.includes(item.class)) problems.push(`${item.id}: unlabelled class ${item.class}`)
  }
  const perClass = new Map()
  for (const item of queries) perClass.set(item.class, (perClass.get(item.class) || 0) + 1)
  for (const cls of HOLDOUT_D_CLASSES) {
    const count = perClass.get(cls) || 0
    if (count < MIN_PER_CLASS) problems.push(`class ${cls} has ${count} queries, at least ${MIN_PER_CLASS} required`)
  }

  // No answer may be shared with the DEV corpus or with either earlier holdout.
  const answerPaths = new Set()
  for (const item of queries) {
    if (item.primary) answerPaths.add(item.primary)
    for (const file of item.expect || []) answerPaths.add(file)
  }
  for (const [label, file] of [
    ["DEV", path.join(ROOT, "evals/retrieval/dev-queries.json")],
    ["holdout A", path.join(ROOT, "evals/retrieval/holdout-queries.json")],
    ["holdout B", path.join(ROOT, "evals/retrieval/holdout-b-queries.json")],
  ]) {
    const other = JSON.parse(await readFile(file, "utf8")).queries
    for (const item of other) {
      for (const answer of [item.primary, ...(item.expect || []), ...(item.changed || [])]) {
        if (answer && answerPaths.has(answer)) problems.push(`answer path ${answer} is shared with ${label} (${item.id})`)
      }
    }
  }
  if (problems.length) {
    return { pass: false, verdict: "holdout-d-invalid", frozen, validation: { ok: false, problems }, checks: [] }
  }

  // ---- 4. the ordering receipt is persisted BEFORE anything is scored ----
  const ordering = {
    schemaVersion: 1,
    kind: "ues-15.3-holdout-d-ordering",
    note: "Written before any ranking was evaluated. Nothing below is a result; it is the proof that the inputs were fixed first.",
    queriesSha256: frozen.queriesSha256,
    fixturesSha256: frozen.fixturesSha256,
    runnerSha256: frozen.runnerSha256,
    freezeReceiptSha256: frozen.freezeReceiptSha256,
    implementation: frozen.implementation,
    frozenAt: freeze.frozenAt,
    lockedAt: new Date().toISOString(),
    queries: queries.length,
    families: HOLDOUT_D_FAMILIES.length,
    classes: Object.fromEntries(perClass),
  }
  await writeFile(ORDERING_FILE, JSON.stringify(ordering, null, 2) + "\n")

  // ---- 5. build once per family ----------------------------------------
  clearSemanticIndexRuntimeCache()
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
    })
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

  const byClass = {}
  for (const cls of HOLDOUT_D_CLASSES) {
    const entry = { queries: cases["frozen-v3"].filter((row) => row.class === cls).length }
    for (const name of ["baseline-lexical", "baseline-pagerank", "frozen-v3"]) {
      const summary = scoreRetrievalRun(cases[name].filter((row) => row.class === cls)).summary
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

  const losses = []
  for (let index = 0; index < queries.length; index += 1) {
    const id = queries[index].id
    const v3 = cases["frozen-v3"][index]
    for (const name of ["baseline-lexical", "baseline-pagerank"]) {
      const base = cases[name][index]
      if (v3.reciprocalRank >= base.reciprocalRank - MRR_TOLERANCE) continue
      losses.push({
        id,
        class: v3.class,
        family: v3.family,
        primary: v3.primary,
        vs: name,
        lexicalRank: perQuery[index].lexical,
        pagerankRank: perQuery[index].pagerank,
        v3Rank: perQuery[index].frozenV3,
        reciprocalRankBaseline: base.reciprocalRank,
        reciprocalRankV3: v3.reciprocalRank,
      })
    }
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
    { name: "holdout-d-at-least-120-queries", pass: queries.length >= MIN_QUERIES, value: queries.length },
    { name: "holdout-d-at-least-5-families", pass: HOLDOUT_D_FAMILIES.length >= MIN_FAMILIES, value: HOLDOUT_D_FAMILIES.length },
    { name: "holdout-d-all-10-classes-with-10-examples", pass: HOLDOUT_D_CLASSES.every((cls) => (perClass.get(cls) || 0) >= MIN_PER_CLASS), value: Object.fromEntries(perClass) },
    { name: "holdout-d-global-recall@1-not-worse", pass: global.recallAt1 >= strongest.recallAt1, detail: { strongest: strongest.recallAt1, frozen: global.recallAt1 } },
    { name: "holdout-d-global-recall@3-not-worse", pass: global.recallAt3 >= strongest.recallAt3, detail: { strongest: strongest.recallAt3, frozen: global.recallAt3 } },
    { name: "holdout-d-global-recall@5-not-worse", pass: global.recallAt5 >= strongest.recallAt5, detail: { strongest: strongest.recallAt5, frozen: global.recallAt5 } },
    { name: "holdout-d-global-mrr-not-worse", pass: global.mrr >= strongest.mrr, detail: { strongest: strongest.mrr, frozen: global.mrr } },
    { name: "holdout-d-no-systematic-class-regression", pass: Object.values(byClass).every((entry) => entry.losses.length === 0), detail: Object.entries(byClass).filter(([, e]) => e.losses.length).map(([cls, e]) => ({ cls, losses: e.losses })) },
    { name: "holdout-d-candidates-bounded", pass: (global.meanCandidatesPerQuery || 0) <= 240, detail: global.meanCandidatesPerQuery },
    { name: "holdout-d-payload-bounded", pass: global.mapPayloadCharsPerQuery <= CONTEXT_BUDGET_CHARS, detail: global.mapPayloadCharsPerQuery },
  ]
  const failures = checks.filter((check) => !check.pass)
  assert.ok(HOLDOUT_D_CLASSES.length === 10, "holdout D must declare ten retrieval classes")

  return {
    schemaVersion: 1,
    kind: "ues-holdout-d-benchmark",
    node: process.version,
    frozen,
    orderingReceipt: path.relative(ROOT, ORDERING_FILE),
    validation: { ok: true, problems: [] },
    queries: queries.length,
    families: HOLDOUT_D_FAMILIES.map((family) => ({ id: family.id, files: holdoutDFiles(family.id).length })),
    classes: HOLDOUT_D_CLASSES,
    perClass,
    k: K,
    rankings: scored,
    byClass,
    perQuery,
    losses,
    checks,
    tuningAfterHoldoutD: false,
    runOnce: true,
    pass: failures.length === 0,
    verdict: failures.length === 0 ? "holdout-d-pass" : "15.3 BLOCKED",
  }
}

clearSemanticIndexRuntimeCache()
clearRepoGraphRuntimeCache()
clearRepoMapRuntimeCache()
const receipt = await withTempDir("holdoutd", main)
await writeFile(RECEIPT_FILE, JSON.stringify(receipt, null, 2) + "\n")
process.stdout.write(JSON.stringify(receipt) + "\n")
process.exitCode = receipt.pass ? 0 : 1
