// Ranking feature trace (15.3 ranking repair, Phase 1).
//
//   node scripts/trace-repo-map.mjs --family family-b --query "..." [--json]
//   node scripts/trace-repo-map.mjs --diagnose            # the three regressing classes
//
// Read-only diagnosis. It re-computes the ranking's own feature contributions
// from the public scoring weights and prints, for the top N candidates, every
// term that produced the score -- plus the graph paths that explain any
// propagated portion.
//
// This is deliberately not a hook into the module. It re-derives the arithmetic
// from REPO_MAP_WEIGHTS and the reasons the map reports, so a discrepancy
// between the trace and the map is itself a finding rather than something the
// trace inherits by construction.

import path from "node:path"
import { REPO_MAP_WEIGHTS } from "../lib/repo-map.mjs"
import { buildSemanticIndex, clearSemanticIndexRuntimeCache } from "../lib/semantic-index.mjs"
import { buildRepoGraph, clearRepoGraphRuntimeCache } from "../lib/repo-graph.mjs"
import { buildRepoMap, clearRepoMapRuntimeCache } from "../lib/repo-map.mjs"
import { rankContextGraph } from "../lib/context-graph-rank.mjs"
import { querySemanticIndex } from "../lib/semantic-index.mjs"
import { argValue, printReceipt, round, withTempDir } from "./bench-common.mjs"
import { writeHoldoutFamily, HOLDOUT_FAMILIES } from "../evals/retrieval/holdout-fixtures.mjs"

// Which reason maps to which weight, and therefore what each row's score is
// made of. Kept explicit rather than derived so a new weight cannot be added
// without the trace noticing.
const REASON_WEIGHT = new Map([
  ["exact-symbol", "exactSymbol"],
  ["local-binding", "localBinding"],
  ["symbol-prefix", "symbolPrefix"],
  ["symbol-mention", "symbolMention"],
  ["path-basename", "pathBasename"],
  ["path-segment", "pathSegment"],
  ["path-partial", "pathPartial"],
  ["declared", "declared"],
  ["changed-file", "changedFile"],
  ["affected-test", "affectedTest"],
  ["direct-import", "directImport"],
  ["reverse-reference", "reverseReference"],
  ["identifier-reference", "identifierReference"],
  ["module-sibling", "moduleSibling"],
  ["hotspot", "hotspot"],
  ["propagated", "propagated"],
  ["memory-affinity", "memoryAffinity"],
  ["graph-propagated", "propagated"],
])

const KEY_ORDER = [
  "exact-symbol", "local-binding", "symbol-prefix", "symbol-mention",
  "path-basename", "path-segment", "path-partial", "identifier-reference",
  "direct-import", "reverse-reference", "declared", "changed-file",
  "affected-test", "module-sibling", "hotspot", "graph-propagated",
  "memory-affinity", "test-of-target", "test-requested",
]

function contribution(row) {
  const parts = {}
  let sum = 0
  for (const reason of row.reasons || []) {
    const key = REASON_WEIGHT.get(reason)
    if (!key) continue
    // `hotspot` and `graph-propagated` are not flat: they are weighted by
    // centrality / page rank. The map reports the components separately, so the
    // trace uses them rather than assuming the flat weight.
    let value = REPO_MAP_WEIGHTS[key] || 0
    if (reason === "hotspot" && row.__centrality != null) value *= row.__centrality
    if (reason === "graph-propagated" && row.propagated != null) value *= row.propagated
    parts[reason] = round(value, 4)
    sum += value
  }
  return { parts, sum: round(sum, 4) }
}

// The graph paths that explain a propagated score: which neighbours carry the
// page-rank mass, and in which direction the edge points.
function propagationPaths(file, graph, ranked) {
  const rows = []
  const incoming = []
  const outgoing = []
  for (const edge of graph.edges || []) {
    if (edge.to === file) incoming.push(edge.from)
    if (edge.from === file) outgoing.push(edge.to)
  }
  for (const neighbour of new Set([...incoming, ...outgoing])) {
    const hit = ranked.find((item) => item.path === neighbour)
    if (!hit) continue
    rows.push({
      neighbour,
      direction: incoming.includes(neighbour) ? "incoming" : "outgoing",
      neighbourRank: ranked.indexOf(hit) + 1,
      neighbourScore: round(hit.score, 3),
      neighbourPageRank: round(hit.pageRank ?? 0, 8),
    })
  }
  return rows.sort((a, b) => b.neighbourScore - a.neighbourScore || a.neighbour.localeCompare(b.neighbour)).slice(0, 6)
}

async function traceOne(familyRoot, item, top) {
  clearSemanticIndexRuntimeCache()
  clearRepoGraphRuntimeCache()
  clearRepoMapRuntimeCache()

  const semantic = await buildSemanticIndex(familyRoot, { rebuild: true, maxFiles: 500 })
  const graph = await buildRepoGraph(familyRoot, { maxFiles: 500 })
  const lexical = await querySemanticIndex(familyRoot, item.query, { builtIndex: semantic, limit: 60 })
  const baseline = rankContextGraph(graph, {
    semanticResults: lexical.results,
    declared: item.declared || [],
    changed: item.changed || [],
    limit: 60,
  })
  const map = await buildRepoMap(familyRoot, item.query, {
    declaredFiles: item.declared || [],
    changedFiles: item.changed || [],
    limit: 50,
    contextBudgetChars: 60_000,
    builtSemantic: semantic,
    builtGraph: graph,
  })

  const expected = new Set(item.expect || [])
  const lexicalRank = (file) => lexical.results.findIndex((r) => r.path === file) + 1
  const baselineRank = (file) => baseline.findIndex((r) => r.path === file) + 1

  const centrality = new Map()
  const incomingCounts = new Map()
  for (const edge of graph.edges || []) {
    incomingCounts.set(edge.to, (incomingCounts.get(edge.to) || 0) + 1)
  }
  const maxIncoming = Math.max(0, ...incomingCounts.values())
  for (const [file, count] of incomingCounts) {
    centrality.set(file, maxIncoming > 0 ? count / maxIncoming : 0)
  }

  return {
    id: item.id,
    class: item.class,
    query: item.query,
    primary: item.primary,
    changed: item.changed || [],
    declared: item.declared || [],
    ranks: {
      v3: map.files.findIndex((r) => r.path === item.primary) + 1,
      baselinePageRank: baselineRank(item.primary),
      baselineLexical: lexicalRank(item.primary),
    },
    selectedCount: map.files.length,
    droppedByBudget: map.stats.dropped,
    contextChars: map.stats.contextChars,
    candidates: map.files.slice(0, top).map((row, index) => {
      const c = contribution({ ...row, __centrality: centrality.get(row.path) || 0 })
      return {
        rank: index + 1,
        path: row.path,
        score: round(row.score, 4),
        tier: row.tier,
        isExpectedTarget: expected.has(row.path),
        isPrimary: row.path === item.primary,
        contribution: c.parts,
        contributionSum: c.sum,
        unexplainedResidual: round(row.score - c.sum, 4),
        reasons: row.reasons,
        relationToPrimary: row.path === item.primary
          ? "self"
          : (graph.edges || []).some((e) => e.from === item.primary && e.to === row.path)
            ? "imported-by-primary"
            : (graph.edges || []).some((e) => e.to === item.primary && e.from === row.path)
              ? "imports-primary"
              : "unrelated",
        propagationPaths: row.propagated > 0 ? propagationPaths(row.path, graph, baseline) : [],
        lexicalRank: lexicalRank(row.path),
        baselineRank: baselineRank(row.path),
      }
    }),
  }
}

const DIAGNOSTIC_QUERIES = [
  {
    family: "family-b-flat-js-app",
    id: "b-cross-module-table-to-money",
    class: "cross-module-dependency",
    query: "how does the table render amounts",
    primary: "src/components/LedgerTable.js",
    expect: ["src/components/LedgerTable.js", "src/utils/money.js"],
  },
  {
    family: "family-b-flat-js-app",
    id: "b-test-amount",
    class: "test-lookup",
    query: "test that formatAmount rounds cents",
    primary: "test/formatAmount.test.js",
    expect: ["test/formatAmount.test.js", "src/utils/money.js"],
  },
  {
    family: "family-b-flat-js-app",
    id: "b-mentions-only-panel",
    class: "mentions-without-declaration",
    query: "formatAmount used to render a panel",
    primary: "src/components/LedgerPanel.js",
    expect: ["src/components/LedgerPanel.js", "src/utils/money.js"],
  },
  {
    family: "family-a-python-services",
    id: "a-test-router",
    class: "test-lookup",
    query: "test for dispatch_route",
    primary: "tests/test_router.py",
    expect: ["tests/test_router.py", "services/gateway/src/gateway/router.py"],
  },
  {
    family: "family-a-python-services",
    id: "a-mentions-only-reports",
    class: "mentions-without-declaration",
    query: "post_entry report summary",
    primary: "services/gateway/src/gateway/reports.py",
    expect: ["services/gateway/src/gateway/reports.py", "services/ledger/src/ledger/posting.py"],
  },
  {
    family: "family-a-python-services",
    id: "a-reports-vs-declaration",
    class: "mentions-without-declaration",
    query: "where is post_entry defined",
    primary: "services/ledger/src/ledger/posting.py",
    expect: ["services/ledger/src/ledger/posting.py"],
  },
];

async function main(root) {
  const top = Math.max(1, Number(argValue("--top", 5)))
  const familyArg = argValue("--family", null)
  const queryArg = argValue("--query", null)

  const roots = new Map()
  for (const family of HOLDOUT_FAMILIES) {
    const familyRoot = path.join(root, family.id)
    await writeHoldoutFamily(familyRoot, family.id)
    roots.set(family.id, familyRoot)
  }

  let items;
  if (queryArg) {
    const familyId = familyArg || HOLDOUT_FAMILIES[0].id
    const family = HOLDOUT_FAMILIES.find((f) => f.id === familyId)
    items = [{
      id: "ad-hoc",
      class: "ad-hoc",
      family: familyId,
      query: queryArg,
      primary: null,
      expect: [],
    }];
    void family;
  } else {
    items = DIAGNOSTIC_QUERIES;
  }

  const traces = [];
  for (const item of items) {
    const familyRoot = roots.get(item.family);
    if (!familyRoot) continue;
    traces.push(await traceOne(familyRoot, item, top));
  }
  return { schemaVersion: 1, kind: "ues-repo-map-feature-trace", top, traces };
}

clearSemanticIndexRuntimeCache()
clearRepoGraphRuntimeCache()
clearRepoMapRuntimeCache()
printReceipt(await withTempDir("trace", main));
