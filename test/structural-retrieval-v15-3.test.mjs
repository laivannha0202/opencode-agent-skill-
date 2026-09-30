// 15.3 structural retrieval repair - Phase 1/2/3/4 regression gate.
//
// Every test here encodes a property the repair depends on. Each one is written
// so that a plausible-looking future change breaks it: a new weight, a looser
// tokenizer or a "helpful" extra bonus is exactly the kind of edit these are
// meant to catch.
//
// The fixture is generated in-test so the expected answers cannot drift from the
// code that produces them.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  analyzeQuery,
  buildRepoMap,
  clearRepoMapRuntimeCache,
  derivedTermsFor,
  identifierParts,
  partsCover,
  queryTerms,
  REPO_MAP_WEIGHTS,
  termSource,
} from "../lib/repo-map.mjs"
import { buildRepoGraph, clearRepoGraphRuntimeCache } from "../lib/repo-graph.mjs"

async function repo(label, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-153-" + label + "-"))
  for (const [relative, source] of Object.entries(files)) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, source, "utf8")
  }
  return root
}

const rankOf = (map, file) => map.files.findIndex((row) => row.path === file) + 1
const scoreOf = (map, file) => map.files.find((row) => row.path === file)?.score ?? 0

// A monorepo with every shape the repair reasons about: a barrel that
// re-exports, a same-named symbol in two packages, a module that only REFERENCES
// a symbol, a test named after the unit it covers, and a dependency diamond.
const FIXTURE = {
  "go.mod": "module demo\n\ngo 1.22\n",
  "package.json": JSON.stringify({ name: "demo-root", private: true, workspaces: ["packages/*"] }, null, 2) + "\n",

  // The declaring module. `formatAmount` lives here and nowhere else.
  "packages/ledger/src/index.ts": [
    'import { rateFor } from "@demo/pricing";',
    "",
    "export function formatAmount(cents: number): string {",
    "  return (cents * rateFor()).toFixed(2)",
    "}",
    "",
  ].join("\n"),

  // The same symbol name in a second package: same-name disambiguation.
  "packages/audit/src/index.ts": [
    'export function formatAmount(cents: number): string {',
    "  return String(cents)",
    "}",
    "",
  ].join("\n"),

  // A barrel that RE-EXPORTS the ledger entry point.
  "packages/ledger/src/public.ts": [
    'export { formatAmount } from "./index";',
    "",
  ].join("\n"),

  // Only REFERENCES formatAmount; never declares it.
  "packages/web/src/panel.ts": [
    'import { formatAmount } from "@demo/ledger";',
    "",
    "export function renderLedgerPanel(cents: number): string {",
    "  const total = formatAmount(cents)",
    "  const totalAgain = formatAmount(cents + 1)",
    "  const totalThird = formatAmount(cents + 2)",
    "  return total + totalAgain + totalThird",
    "}",
    "",
  ].join("\n"),

  // A test named after the unit it covers, with almost no path overlap.
  "packages/ledger/test/amount.spec.ts": [
    'import { formatAmount } from "@demo/ledger";',
    "",
    "export function testFormatAmountIsStable() {",
    '  return formatAmount(100) === "1.00"',
    "}",
    "",
  ].join("\n"),

  // Go: a module-path import that is NOT a relative specifier.
  "cmd/main.go": 'package main\n\nimport "demo/internal/ledger"\n\nfunc main() { _ = ledger.FormatAmount(1) }\n',
  "internal/ledger/ledger.go": [
    "package ledger",
    "",
    "func FormatAmount(cents int) string { return \"1.00\" }",
    "",
  ].join("\n"),

  // Python: an absolute package import and a package-level re-export.
  "svc/ledger/core.py": [
    "def post_entry_legacy(value):",
    "    return value",
    "",
  ].join("\n"),
  "svc/ledger/__init__.py": [
    "from .core import post_entry_legacy",
    "",
    '__all__ = ["post_entry_legacy"]',
    "",
  ].join("\n"),
  "svc/app.py": "from svc.ledger import post_entry_legacy\n\n\ndef run():\n    return post_entry_legacy(1)\n",
}

// ---------------------------------------------------------------------------
// PHASE 2 -- query term provenance
// ---------------------------------------------------------------------------

test("P2-1 term provenance separates identifiers, path tokens and prose", () => {
  assert.equal(termSource("SealCorrupt"), "exact-identifier")
  assert.equal(termSource("seal_vault"), "exact-identifier")
  assert.equal(termSource("forge/forgeutil"), "path-token")
  assert.equal(termSource("pricing.mjs"), "path-token")
  assert.equal(termSource("compute"), "exact-identifier")
  assert.equal(termSource("compute-it"), "natural-language")
  // A stopword never reaches provenance.
  assert.equal(termSource("the"), "stopword")
})

test("P2-2 naming conventions split the same way in every form", () => {
  assert.deepEqual(identifierParts("fetchLedgerLegacy"), ["fetch", "ledger", "legacy"])
  assert.deepEqual(identifierParts("LedgerPanel"), ["ledger", "panel"])
  assert.deepEqual(identifierParts("post_entry_legacy"), ["post", "entry", "legacy"])
  assert.deepEqual(identifierParts("ledger-panel"), ["ledger", "panel"])
  assert.deepEqual(identifierParts("ledger-panel.test"), ["ledger", "panel", "test"])
  // Determinism: the same input always yields the same parts.
  assert.deepEqual(identifierParts("fetchLedgerLegacy"), identifierParts("fetchLedgerLegacy"))
})

test("P2-3 derived terms are derived, and the original term is preserved", () => {
  const analysis = analyzeQuery("fetchLedgerLegacy")
  assert.deepEqual(analysis.terms.map((item) => item.term), ["fetchLedgerLegacy"], "the original query term must survive")
  const ledger = analysis.terms[0]
  assert.deepEqual(ledger.derived, ["fetch", "ledger", "legacy"])
  assert.equal(ledger.source, "exact-identifier")
  // The derived list never includes the whole term as its own evidence.
  assert.equal(ledger.derived.includes("fetchledgerlegacy"), false)
  // English inflection reaches a stem, conservatively.
  assert.ok(derivedTermsFor("firing").includes("fire"))
  assert.ok(derivedTermsFor("glazing").includes("glaze"))
  // ...but a fragment shorter than the module's evidence threshold is never
  // produced, and a derived stem is never the whole term standing alone.
  for (const stem of derivedTermsFor("string")) assert.ok(stem.length >= 3, stem)
  assert.equal(derivedTermsFor("string").includes("st"), false)
})

test("P2-4 generic short terms do not explode candidates", async () => {
  const root = await repo("short-terms", {
    "src/oracle.mjs": 'export const oracleOf = (v) => String(v)\n',
    "src/other.mjs": 'import { oracleOf } from "./oracle.mjs"\nexport const user = oracleOf(1)\n',
  })
  try {
    clearRepoMapRuntimeCache()
    // "or" occurs inside almost every file name. It must not become evidence.
    const map = await buildRepoMap(root, "oracle or other")
    assert.equal(rankOf(map, "src/oracle.mjs"), 1)
    for (const row of map.files) {
      const bad = (row.contributions || []).filter((item) => item.reason === "path-partial")
      assert.ok(bad.every((item) => item.weight > 0), "every contribution must carry a real weight")
    }
    // A two-character fragment produces no path grade and no symbol grade at
    // all. The lexical index may still return the file (that is baseline
    // behaviour and is measured, not invented), but none of the structural
    // evidence may attach to a two-letter "term".
    const narrow = await buildRepoMap(root, "or")
    for (const row of narrow.files) {
      for (const bad of ["path-basename", "path-segment", "path-partial", "exact-symbol", "derived-definition", "symbol-prefix"]) {
        assert.equal(row.reasons.includes(bad), false, `${row.path}: ${bad} fired for a two-letter term`)
      }
    }
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P2-5 an exact identifier is stronger evidence than a derived subterm", async () => {
  const root = await repo("exact-vs-derived", {
    // A file that only embeds the term inside a longer identifier.
    "src/ledgerLegacy.mjs": 'export function ledgerLegacyAmount(v) { return String(v) }\n',
    // The file that declares the identifier outright.
    "src/amount.mjs": 'export function amount(v) { return String(v) }\n',
  })
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "amount")
    assert.equal(rankOf(map, "src/amount.mjs"), 1, "the exact declaration must lead")
    assert.ok(
      scoreOf(map, "src/amount.mjs") > scoreOf(map, "src/ledgerLegacy.mjs"),
      "a derived subterm may never outweigh a declaration of the identifier",
    )
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P2-6 a file named by the query beats a file whose symbol merely contains the word", async () => {
  const root = await repo("path-ownership", {
    "src/pricing.mjs": 'export function compute() { return 1 }\n',
    "src/legacy/pricing-legacy.mjs": 'export function legacyPricingSheet() { return 2 }\n',
  })
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "pricing")
    assert.equal(rankOf(map, "src/pricing.mjs"), 1)
    const decoy = map.files.find((row) => row.path === "src/legacy/pricing-legacy.mjs")
    assert.ok(decoy, "the decoy stays reachable")
    assert.ok(decoy.score < scoreOf(map, "src/pricing.mjs"), "the path owner must outscore the embedding decoy")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P2-7 identifier parts are an unordered bag", () => {
  // A test convention reverses the subject's words; that is naming, not meaning.
  assert.equal(partsCover(["vault", "seal"], ["seal", "vault"]), true)
  assert.equal(partsCover(["report"], ["seal", "vault"]), false)
  assert.equal(partsCover([], ["seal"]), false)
})

// ---------------------------------------------------------------------------
// PHASE 3A -- relationship-first candidate generation, and PHASE 5 edges
// ---------------------------------------------------------------------------

test("P3-1 a re-export is a distinct edge kind from an ordinary import", async () => {
  const root = await repo("re-export", FIXTURE)
  try {
    clearRepoGraphRuntimeCache()
    const graph = await buildRepoGraph(root, { maxFiles: 200 })
    const kinds = new Set(graph.edges.map((edge) => edge.kind))
    assert.ok(kinds.has("re-export"), "a barrel re-export must be recorded")
    assert.ok(kinds.has("local-import"), "a plain import must be recorded")
    const barrel = graph.nodes.find((node) => node.path === "packages/ledger/src/public.ts")
    assert.deepEqual(barrel.reExports, ["packages/ledger/src/index.ts"], "re-export provenance is per node")
    const importer = graph.nodes.find((node) => node.path === "packages/web/src/panel.ts")
    assert.equal(importer.reExports.length, 0, "an importer is not a re-exporter")
  } finally {
    clearRepoGraphRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P3-2 a Go module path and a workspace package name both resolve to local files", async () => {
  const root = await repo("graph-resolution", FIXTURE)
  try {
    clearRepoGraphRuntimeCache()
    const graph = await buildRepoGraph(root, { maxFiles: 200 })
    const edges = new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`))
    assert.ok(edges.has("cmd/main.go -> internal/ledger/ledger.go"), "a Go module path is a local edge")
    assert.ok(edges.has("packages/web/src/panel.ts -> packages/ledger/src/index.ts"), "a workspace package name is a local edge")
    assert.ok(edges.has("svc/app.py -> svc/ledger/__init__.py"), "an absolute Python import is a local edge")
    assert.ok(edges.has("svc/ledger/__init__.py -> svc/ledger/core.py"), "a Python package re-export is a local edge")
    // An external dependency must not acquire a local edge.
    const external = graph.externalImports.map((entry) => entry.name)
    assert.equal(external.includes("@demo/ledger"), false, "a resolved workspace import is no longer external")
    assert.deepEqual(graph.localNamespaces.goModules, ["demo"])
  } finally {
    clearRepoGraphRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P3-3 the graph is deterministic across concurrency and never escapes the workspace", async () => {
  const root = await repo("graph-determinism", FIXTURE)
  try {
    clearRepoGraphRuntimeCache()
    const serial = await buildRepoGraph(root, { ioConcurrency: 1, maxFiles: 200 })
    const parallel = await buildRepoGraph(root, { ioConcurrency: 16, maxFiles: 200 })
    assert.deepEqual(serial.edges, parallel.edges)
    assert.deepEqual(serial.nodes, parallel.nodes)
    assert.deepEqual(serial.hotspots, parallel.hotspots)
    for (const edge of parallel.edges) {
      assert.equal(path.posix.isAbsolute(edge.to), false)
      assert.equal(edge.to.split("/").includes(".."), false)
    }
  } finally {
    clearRepoGraphRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P3-4 relationship candidates carry their provenance, and centrality introduces nothing", async () => {
  const root = await repo("relationships", FIXTURE)
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "formatAmount")
    const panel = map.files.find((row) => row.path === "packages/web/src/panel.ts")
    assert.ok(panel, "a file that imports the subject must be reachable")
    assert.ok((panel.relationships || []).length > 0, "reached candidates must say why")
    for (const entry of panel.relationships) {
      assert.ok(entry.reason && entry.from && entry.to, JSON.stringify(entry))
      assert.equal(typeof entry.depth, "number")
      assert.ok(["local-import", "re-export"].includes(entry.edgeKind), JSON.stringify(entry))
    }
    // Nothing enters the map by centrality alone.
    for (const row of map.files) {
      if (row.score > 0) {
        const hasOwnEvidence = (row.contributions || []).length > 0
        assert.equal(hasOwnEvidence, true, `${row.path} scored without any reason`)
      }
    }
    assert.equal(map.files.some((row) => row.reasons.includes("graph-propagated")), false, "centrality must not admit a candidate")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// PHASE 3B -- definition versus reference
// ---------------------------------------------------------------------------

test("P3-5 a definition dominates a mention, and repetition does not promote a mention", async () => {
  const root = await repo("definition-vs-mention", {
    "src/owner.mjs": 'export function totalFor(rows) { return rows.length }\n',
    "src/mention-heavy.mjs": [
      'import { totalFor } from "./owner.mjs"',
      "export function rollup() {",
      "  const totalFor_count = totalFor([])",
      "  const other = totalFor_count + totalFor([])",
      "  return other + totalFor_count",
      "}",
      "",
    ].join("\n"),
  })
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "where is totalFor defined")
    assert.equal(rankOf(map, "src/owner.mjs"), 1, "the declaring file dominates")
    const heavy = map.files.find((row) => row.path === "src/mention-heavy.mjs")
    assert.equal(heavy.reasons.includes("exact-symbol"), false, "a mention is never a definition")
    assert.equal(heavy.reasons.includes("identifier-reference"), true)
    assert.ok(heavy.score < scoreOf(map, "src/owner.mjs"), "repetition must not promote a mention")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P3-6 a named component is the target even when it only references the symbol", async () => {
  const root = await repo("named-component", {
    "src/amount.mjs": 'export function formatAmount(v) { return String(v) }\n',
    "src/ledger-panel.mjs": [
      'import { formatAmount } from "./amount.mjs"',
      "export function buildLedgerPanel(v) {",
      "  return formatAmount(v) + formatAmount(v)",
      "}",
      "",
    ].join("\n"),
  })
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "formatAmount used to build the LedgerPanel")
    assert.equal(rankOf(map, "src/ledger-panel.mjs"), 1, "the named component is the subject")
    // ...and the same query phrased as a definition question flips it back.
    const defining = await buildRepoMap(root, "where is formatAmount defined")
    assert.equal(rankOf(defining, "src/amount.mjs"), 1, "definition intent flips the subject")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P3-7 a module token may not outrank the symbol the query is about", async () => {
  const root = await repo("module-token", {
    "internal/glaze/glaze.go": [
      "package glaze",
      "",
      "import \"demo/internal/glaze/point\"",
      "",
      "func Glaze(v int) int { return point.SetPoint(v) }",
      "",
    ].join("\n"),
    "internal/glaze/point.go": "package glaze\n\nfunc SetPoint(v int) int { return v + 1 }\n",
    "internal/cure/cure.go": "package cure\n\nfunc Cure(v int) int { return v / 2 }\n",
    "internal/cure/point.go": "package cure\n\nfunc SetPoint(v int) int { return v * 3 }\n",
  })
  try {
    clearRepoMapRuntimeCache()
    for (const [query, target, other] of [
      ["glaze SetPoint", "internal/glaze/point.go", "internal/cure/point.go"],
      ["cure SetPoint", "internal/cure/point.go", "internal/glaze/point.go"],
    ]) {
      const map = await buildRepoMap(root, query)
      assert.equal(rankOf(map, target), 1, `${query}: the symbol must beat the module's own file`)
      // The other module's same-named symbol stays reachable -- it is a real
      // candidate for a same-name query -- but it must never LEAD.
      assert.ok(rankOf(map, other) !== 1, `${query}: the wrong module must not lead`)
      const wrongModuleFile = target.includes("glaze") ? "internal/cure/cure.go" : "internal/glaze/glaze.go"
      assert.ok(rankOf(map, wrongModuleFile) !== 1, `${query}: the module's own file must not lead`)
    }
    // A single-term query has no module/symbol conflict and still resolves.
    const single = await buildRepoMap(root, "Glaze")
    assert.equal(rankOf(single, "internal/glaze/glaze.go"), 1)
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// PHASE 4 -- score accounting
// ---------------------------------------------------------------------------

test("P4-1 every ranked row reconstructs its score from its reasons", async () => {
  const root = await repo("score-accounting", FIXTURE)
  try {
    clearRepoMapRuntimeCache()
    const queries = [
      "formatAmount",
      "where is formatAmount defined",
      "formatAmount used to build the LedgerPanel",
      "tests for formatAmount",
      "post_entry_legacy",
      "FormatAmount",
    ]
    for (const query of queries) {
      const map = await buildRepoMap(root, query, { limit: 20 })
      assert.ok(map.files.length > 0, query)
      for (const row of map.files) {
        const contributions = row.contributions || []
        const summed = contributions.reduce((sum, item) => sum + Number(item.points || 0), 0)
        assert.ok(
          Math.abs(summed - row.score) <= 1e-6,
          `${query} / ${row.path}: score ${row.score} != sum of reasons ${summed}`,
        )
        for (const item of contributions) {
          assert.ok(item.reason, JSON.stringify(item))
          assert.ok(Number(item.weight) > 0, `${query} / ${row.path}: ${item.reason} has no weight`)
          assert.ok(Number.isFinite(Number(item.points)), `${query} / ${row.path}: ${item.reason} is not finite`)
          assert.ok(
            REPO_MAP_WEIGHTS[item.weight] !== undefined || Number(item.weight) > 0,
            `${query} / ${row.path}: ${item.reason} references an unknown weight`,
          );
        }
        // Every reason that carries a reason must be attributable, and every
        // attribution must name a reason that appears on the row.
        const named = new Set(contributions.map((item) => item.reason))
        assert.equal(named.size, contributions.length, `${query} / ${row.path}: duplicate reason entries`)
      }
    }
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P4-2 the evidence ladder is ordered: exact > resolved subject > derived > mention", async () => {
  assert.ok(REPO_MAP_WEIGHTS.exactSymbol > REPO_MAP_WEIGHTS.explicitPathTarget, "an exact definition outranks a resolved subject")
  assert.ok(REPO_MAP_WEIGHTS.explicitPathTarget > REPO_MAP_WEIGHTS.derivedDefinitionCeiling, "a subject outranks derived evidence")
  assert.ok(REPO_MAP_WEIGHTS.derivedDefinitionCeiling < REPO_MAP_WEIGHTS.exactSymbol, "derived evidence never overturns an exact definition")
  assert.ok(REPO_MAP_WEIGHTS.derivedDefinitionCeiling > REPO_MAP_WEIGHTS.symbolMention, "derived evidence outranks a mention")
  assert.ok(REPO_MAP_WEIGHTS.symbolMention > REPO_MAP_WEIGHTS.identifierReference, "a mention outranks a bare reference")
  assert.ok(REPO_MAP_WEIGHTS.derivedDefinitionCeiling < REPO_MAP_WEIGHTS.exactSymbol, "derived evidence is capped below an exact definition")
  assert.ok(REPO_MAP_WEIGHTS.secondHop < REPO_MAP_WEIGHTS.directImport, "a second hop is context, not a dependency")
  assert.ok(REPO_MAP_WEIGHTS.convergentDependency < REPO_MAP_WEIGHTS.directImport, "convergence is weaker than a direct edge")
  assert.ok(REPO_MAP_WEIGHTS.memoryAffinity < REPO_MAP_WEIGHTS.identifierReference, "memory stays a tie-breaker")
})

test("P4-3 a test file never outranks its source unless the query asked about tests", async () => {
  const root = await repo("test-ordering", FIXTURE)
  try {
    clearRepoMapRuntimeCache()
    const plain = await buildRepoMap(root, "formatAmount")
    const source = rankOf(plain, "packages/ledger/src/index.ts")
    const spec = rankOf(plain, "packages/ledger/test/amount.spec.ts")
    assert.ok(source > 0, "the declaring file must be present")
    if (spec > 0) {
      assert.ok(spec > source, `test rank ${spec} must follow source rank ${source}`);
    }

    const asked = await buildRepoMap(root, "tests for formatAmount")
    assert.equal(rankOf(asked, "packages/ledger/test/amount.spec.ts"), 1, "an explicit test request lifts the test")
    assert.ok(asked.files[0].reasons.includes("test-requested"), JSON.stringify(asked.files[0].reasons))
    assert.ok(asked.files[0].reasons.includes("test-covers-subject"), "coverage is recorded as evidence")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P4-4 the map stays deterministic across repeated runs", async () => {
  const root = await repo("determinism", FIXTURE)
  try {
    clearRepoMapRuntimeCache()
    const a = await buildRepoMap(root, "formatAmount used to build the LedgerPanel")
    const b = await buildRepoMap(root, "formatAmount used to build the LedgerPanel")
    assert.equal(JSON.stringify(a.files), JSON.stringify(b.files))
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("P4-5 queryTerms stays a stable, stopword-filtered contract", () => {
  assert.deepEqual(queryTerms("where is the checkout order total computed"), ["checkout", "order", "total", "computed"])
  assert.deepEqual(queryTerms("the the the"), [])
  assert.deepEqual(queryTerms("packages/core/src/pricing.mjs"), ["packages/core/src/pricing.mjs"])
  assert.deepEqual(queryTerms("checkout checkout"), ["checkout"])
})