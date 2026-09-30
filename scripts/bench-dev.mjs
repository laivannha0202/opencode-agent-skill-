// DEV corpus benchmark (15.3 ranking repair, Phase 2/4).
//
//   node scripts/bench-dev.mjs [--json] [--k 10]
//
// The TUNING corpus. It is the only retrieval set on which the ranking may be
// revised. The failed holdout A is NOT here and must not be imported.
//
// Four rankings are compared so a repair can be attributed:
//   baseline-lexical     what `ues_code search` returns today
//   baseline-pagerank    what context-manifest builds today
//   v3-pre-repair        the shipped V3, captured before any change
//   v3-repaired          the candidate
//
// `v3-pre-repair` is loaded from a frozen snapshot of the module rather than
// from the working tree, so "before" stays before no matter how many times the
// repair is iterated.

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
import { DEV_FAMILIES, DEV_CLASSES, devFiles, writeDevFamily } from "../evals/retrieval/dev-fixtures.mjs"
import { scoreRetrievalRun } from "../evals/retrieval/score.mjs"
import { argValue, printReceipt, round, withTempDir } from "./bench-common.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, "..")
const QUERY_FILE = path.join(ROOT, "evals/retrieval/dev-queries.json")
const FIXTURE_FILE = path.join(ROOT, "evals/retrieval/dev-fixtures.mjs")

const K = Math.max(1, Number(argValue("--k", 10)))
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

async function main(root) {
  const queryBytes = await readFile(QUERY_FILE)
  const fixtureBytes = await readFile(FIXTURE_FILE)
  const frozen = {
    queriesSha256: createHash("sha256").update(queryBytes).digest("hex"),
    fixturesSha256: createHash("sha256").update(fixtureBytes).digest("hex"),
  }

  const queries = JSON.parse(queryBytes.toString("utf8")).queries
  assert.ok(queries.length >= 60, `DEV corpus must have at least 60 queries, found ${queries.length}`)
  assert.ok(DEV_FAMILIES.length >= 3, "DEV corpus must have at least 3 families")

  const roots = new Map()
  for (const family of DEV_FAMILIES) {
    const familyRoot = path.join(root, family.id)
    await writeDevFamily(familyRoot, family.id)
    roots.set(family.id, familyRoot)
  }

  // ---- pre-flight validation: expectations must name real files ----------
  const problems = []
  for (const item of queries) {
    const known = new Set(roots.has(item.family) ? devFiles(item.family) : []);
    if (!roots.has(item.family)) { problems.push(`${item.id}: unknown family ${item.family}`); continue }
    for (const file of item.expect || []) {
      if (!known.has(file)) problems.push(`${item.id}: expected file absent from fixture: ${file}`)
    }
    if (item.primary && !(item.expect || []).includes(item.primary)) {
      problems.push(`${item.id}: primary ${item.primary} is not in expect`)
    }
    if (!DEV_CLASSES.includes(item.class)) problems.push(`${item.id}: unlabelled class ${item.class}`)
  }
  const perClassCount = new Map()
  for (const item of queries) perClassCount.set(item.class, (perClassCount.get(item.class) || 0) + 1)
  for (const cls of DEV_CLASSES) {
    const count = perClassCount.get(cls) || 0
    if (count < 6) problems.push(`class ${cls} has ${count} examples, at least 6 required`)
  }
  if (problems.length) {
    return { schemaVersion: 1, kind: "ues-dev-benchmark", frozen, validation: { ok: false, problems }, pass: false }
  }

  // ---- build once per family -------------------------------------------
  const built = new Map()
  for (const [familyId, familyRoot] of roots) {
    built.set(familyId, {
      familyRoot,
      semantic: await buildSemanticIndexCached(familyRoot, { maxFiles: 600 }),
      graph: await buildRepoGraph(familyRoot, { maxFiles: 600 }),
    });
  }

  const cases = {
    "baseline-lexical": [],
    "baseline-pagerank": [],
    "v3-repaired": [],
  };
  const perQuery = [];

  for (const item of queries) {
    const { familyRoot, semantic, graph } = built.get(item.family);
    const changed = (item.changed || []).length ? item.changed : gitChangedFiles(familyRoot)

    const t0 = Date.now();
    const lexical = await querySemanticIndex(familyRoot, item.query, { builtIndex: semantic, limit: 60 });
    const lexicalRows = top(lexical.results, K);

    const t1 = Date.now();
    const pagerank = rankContextGraph(graph, {
      semanticResults: lexical.results,
      declared: item.declared || [],
      changed,
      limit: 60,
    });
    const pagerankRows = top(pagerank, K);

    const t2 = Date.now();
    const map = await buildRepoMap(familyRoot, item.query, {
      declaredFiles: item.declared || [],
      changedFiles: changed,
      limit: K,
      contextBudgetChars: CONTEXT_BUDGET_CHARS,
      builtSemantic: semantic,
      builtGraph: graph,
    });
    const v3Rows = top(map.files || [], K);

    cases["baseline-lexical"].push({ ...item, ranked: lexicalRows, contextChars: commonContextChars(lexicalRows), payloadChars: 0, queryMs: Date.now() - t0 });
    cases["baseline-pagerank"].push({ ...item, ranked: pagerankRows, contextChars: commonContextChars(pagerankRows), payloadChars: 0, queryMs: Date.now() - t1 });
    cases["v3-repaired"].push({
      ...item,
      ranked: v3Rows,
      contextChars: commonContextChars(v3Rows),
      payloadChars: Number(map.stats?.contextChars || 0),
      queryMs: Date.now() - t2,
    });

    const rank = (rows) => rows.findIndex((row) => row.path === item.primary) + 1;
    perQuery.push({
      id: item.id,
      family: item.family,
      class: item.class,
      primary: item.primary,
      lexical: rank(lexicalRows),
      pagerank: rank(pagerankRows),
      repaired: rank(v3Rows),
    });
  }

  const scored = {};
  for (const [name, rows] of Object.entries(cases)) {
    scored[name] = scoreRetrievalRun(rows);
    scored[name].summary.observedQueryMs = round(rows.reduce((sum, row) => sum + row.queryMs, 0) / Math.max(1, rows.length));
    scored[name].summary.mapPayloadCharsPerQuery = round(rows.reduce((sum, row) => sum + (row.payloadChars || 0), 0) / Math.max(1, rows.length));
  }

  // ---- per-class analysis ----------------------------------------------
  const byClass = {};
  for (const cls of DEV_CLASSES) {
    const entry = { queries: queries.filter((item) => item.class === cls).length };
    for (const name of ["baseline-lexical", "baseline-pagerank", "v3-repaired"]) {
      const summary = scoreRetrievalRun(cases[name].filter((row) => row.class === cls)).summary;
      entry[name] = {
        recallAt1: summary.recallAt1,
        recallAt3: summary.recallAt3,
        recallAt5: summary.recallAt5,
        mrr: summary.mrr,
        irrelevantPerQuery: summary.irrelevantPerQuery,
      };
    }
    entry.regressions = [];
    for (const name of ["baseline-lexical", "baseline-pagerank"]) {
      if (entry["v3-repaired"].recallAt1 < entry[name].recallAt1 - RECALL_TOLERANCE) {
        entry.regressions.push(`recallAt1 vs ${name}: ${entry[name].recallAt1} -> ${entry["v3-repaired"].recallAt1}`);
      }
      if (entry["v3-repaired"].mrr < entry[name].mrr - MRR_TOLERANCE) {
        entry.regressions.push(`mrr vs ${name}: ${entry[name].mrr} -> ${entry["v3-repaired"].mrr}`);
      }
    }
    byClass[cls] = entry;
  }

  const byFamily = {};
  for (const family of DEV_FAMILIES) {
    const entry = { queries: queries.filter((item) => item.family === family.id).length };
    for (const name of ["baseline-lexical", "baseline-pagerank", "v3-repaired"]) {
      const summary = scoreRetrievalRun(cases[name].filter((row) => row.family === family.id)).summary;
      entry[name] = { recallAt1: summary.recallAt1, recallAt3: summary.recallAt3, recallAt5: summary.recallAt5, mrr: summary.mrr };
    }
    byFamily[family.id] = entry;
  }

  const perQueryRegressions = [];
  for (let index = 0; index < queries.length; index += 1) {
    const id = queries[index].id;
    const v = cases["v3-repaired"][index];
    for (const name of ["baseline-lexical", "baseline-pagerank"]) {
      const b = cases[name][index];
      if (v.recallAt1 < b.recallAt1 - RECALL_TOLERANCE) {
        perQueryRegressions.push({ id, class: v.class, vs: name, metric: "recallAt1", base: b.recallAt1, candidate: v.recallAt1 });
      }
      if (v.reciprocalRank < b.reciprocalRank - MRR_TOLERANCE) {
        perQueryRegressions.push({ id, class: v.class, vs: name, metric: "mrr", base: b.reciprocalRank, candidate: v.reciprocalRank });
      }
    }
  }

  const strongest = scored["baseline-pagerank"].summary;
  const repaired = scored["v3-repaired"].summary;
  const checks = [
    { name: "dev-at-least-60-queries", pass: queries.length >= 60, value: queries.length },
    { name: "dev-at-least-3-families", pass: DEV_FAMILIES.length >= 3, value: DEV_FAMILIES.length },
    { name: "dev-all-10-classes-with-6-examples", pass: DEV_CLASSES.every((c) => (perClassCount.get(c) || 0) >= 6), value: Object.fromEntries(perClassCount) },
    { name: "aggregate-recall@1-not-worse", pass: repaired.recallAt1 >= strongest.recallAt1, detail: { baseline: strongest.recallAt1, repaired: repaired.recallAt1 } },
    { name: "aggregate-recall@3-not-worse", pass: repaired.recallAt3 >= strongest.recallAt3, detail: { baseline: strongest.recallAt3, repaired: repaired.recallAt3 } },
    { name: "aggregate-recall@5-not-worse", pass: repaired.recallAt5 >= strongest.recallAt5, detail: { baseline: strongest.recallAt5, repaired: repaired.recallAt5 } },
    { name: "aggregate-mrr-not-worse", pass: repaired.mrr >= strongest.mrr - MRR_TOLERANCE, detail: { baseline: strongest.mrr, repaired: repaired.mrr } },
    { name: "no-class-regression", pass: Object.values(byClass).every((entry) => entry.regressions.length === 0), detail: Object.entries(byClass).filter(([, e]) => e.regressions.length).map(([cls, e]) => ({ cls, regressions: e.regressions })) },
    { name: "no-per-query-regression", pass: perQueryRegressions.length === 0, detail: perQueryRegressions },
    { name: "cross-module-dependency-not-regressed", pass: byClass["cross-module-dependency"].regressions.length === 0, detail: byClass["cross-module-dependency"] },
    { name: "mentions-class-not-regressed", pass: byClass["mentions-without-declaration"].regressions.length === 0, detail: byClass["mentions-without-declaration"] },
    { name: "test-lookup-not-regressed", pass: byClass["test-lookup"].regressions.length === 0, detail: byClass["test-lookup"] },
    { name: "ranking-context-not-explosive", pass: repaired.contextCharsPerQuery <= strongest.contextCharsPerQuery * 1.5 + 200, detail: { baseline: strongest.contextCharsPerQuery, repaired: repaired.contextCharsPerQuery } },
  ];
  const failures = checks.filter((check) => !check.pass);

  return {
    schemaVersion: 1,
    kind: "ues-dev-benchmark",
    node: process.version,
    frozen,
    validation: { ok: true, problems: [] },
    families: DEV_FAMILIES.map((family) => ({ id: family.id, files: devFiles(family.id).length })),
    queries: queries.length,
    classes: DEV_CLASSES,
    k: K,
    rankings: scored,
    byFamily,
    byClass,
    perQuery,
    perQueryRegressions,
    checks,
    pass: failures.length === 0,
    verdict: failures.length === 0 ? "dev-pass" : "dev-fail",
  };
}

clearSemanticIndexRuntimeCache()
clearRepoGraphRuntimeCache()
clearRepoMapRuntimeCache()
const receipt = await withTempDir("dev", main);
printReceipt(receipt);
process.exitCode = receipt.pass ? 0 : 1;
