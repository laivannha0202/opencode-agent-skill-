// V15.3 structural retrieval repair -- the three defect classes.
//
// Holdout B was scored once, failed, and is DIAGNOSTIC ONLY. Its findings are
// the reason this file exists, but nothing in it is copied from that holdout: the
// symbols, the package names and the topology here are new, and each test states
// an INVARIANT rather than a fixture answer.
//
//   HB-D1  a test file must never be the resolved subject of a NON-test query
//   HB-D2  a module term must break a same-symbol tie, from a DECLARED boundary
//   HB-D3  path grading is a hierarchy: a shared parent directory is not a module
//
// Each invariant is written so that the plausible future "fix" breaks it: a
// blanket test penalty, a directory-name module guess, and a per-segment path
// match are all exactly the shapes these tests refuse.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { analyzeQuery, buildRepoMap, clearRepoMapRuntimeCache, queryTerms, REPO_MAP_WEIGHTS } from "../lib/repo-map.mjs"
import { buildRepoGraph, clearRepoGraphRuntimeCache } from "../lib/repo-graph.mjs"
import { createModuleResolver, gradePathToken, isUsableRelativePath, normalizeRelativePath } from "../lib/module-identity.mjs"

async function repo(label, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-153s-" + label + "-"))
  for (const [relative, source] of Object.entries(files)) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, source, "utf8")
  }
  return root
}

const rankOf = (map, file) => map.files.findIndex((row) => row.path === file) + 1
const rowOf = (map, file) => map.files.find((row) => row.path === file)
const reasonsOf = (map, file) => rowOf(map, file)?.reasons || []

async function mapFor(root, query, options = {}) {
  clearRepoGraphRuntimeCache()
  clearRepoMapRuntimeCache()
  const graph = await buildRepoGraph(root, { maxFiles: 300 })
  return buildRepoMap(root, query, { limit: 12, builtGraph: graph, ...options })
}

// Two sibling packages under a shared parent, the same class in both, a test in
// each whose FUNCTION NAME restates the production subject, and a second test
// file that repeats it. Every defect class has a shape here that a plausible
// fix would paper over.
const SIBLING_FIXTURE = {
  "package.json": JSON.stringify({ name: "sibling-root", private: true, workspaces: ["halls/*"] }, null, 2) + "\n",

  "halls/northgate/src/registry.ts": [
    "export class GantryLedger {",
    "  private readonly rows: string[] = []",
    "  append(name: string): number {",
    "    this.rows.push(name)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
    "export function recordArrival(berth: string): string {",
    "  return `north:${berth}`",
    "}",
    "",
    "export function gantrySpan(berth: string): string {",
    "  return `span:${berth}`",
    "}",
    "",
  ].join("\n"),

  "halls/northgate/src/index.ts": [
    'export { GantryLedger, recordArrival, gantrySpan } from "./registry"',
    "",
  ].join("\n"),

  "halls/southgate/src/registry.ts": [
    "export class GantryLedger {",
    "  private readonly rows: string[] = []",
    "  append(name: string): number {",
    "    this.rows.push(name)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
    "export function recordArrival(berth: string): string {",
    "  return `south:${berth}`",
    "}",
    "",
    "export function gantrySpan(berth: string): string {",
    "  return `span:${berth}`",
    "}",
    "",
  ].join("\n"),

  "halls/southgate/src/index.ts": [
    'export { GantryLedger, recordArrival, gantrySpan } from "./registry"',
    "",
  ].join("\n"),

  // Test stem IDENTICAL to the source stem, and the test function name contains
  // the production class name verbatim.
  "halls/northgate/test/registry.spec.ts": [
    'import { GantryLedger, recordArrival } from "../src/index"',
    "",
    "export function testGantryLedgerRecordArrivalCounts() {",
    "  return new GantryLedger().append(\"n1\") === 1 && recordArrival(\"n1\") !== \"\"",
    "}",
    "",
  ].join("\n"),

  // A SECOND test file repeating the same symbol, so no single test can be
  // special-cased into being the exception.
  "halls/northgate/test/registry-again.spec.ts": [
    'import { GantryLedger } from "../src/index"',
    "",
    "export function testGantryLedgerRecordArrivalCounts() {",
    "  return new GantryLedger().append(\"n2\") === 1",
    "}",
    "",
  ].join("\n"),

  "halls/southgate/test/registry.spec.ts": [
    'import { GantryLedger, recordArrival } from "../src/index"',
    "",
    "export function testGantryLedgerRecordArrivalCounts() {",
    "  return new GantryLedger().append(\"s1\") === 1 && recordArrival(\"s1\") !== \"\"",
    "}",
    "",
  ].join("\n"),
}

// ---------------------------------------------------------------------------
// HB-D1 -- a test file is never the subject of a non-test query
// ---------------------------------------------------------------------------

test("HB-D1 a test declaration that restates the subject is not the query subject", async () => {
  const root = await repo("hb-d1", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "gantry berth arrival")
    const north = rankOf(map, "halls/northgate/src/registry.ts")
    assert.ok(north > 0, "the production file must be on the map")
    // No TEST file leads, and no test file carries the resolved-subject bonus.
    for (const row of map.files) {
      if (!/\/test\/|\.spec\.|\.test\./.test(row.path)) continue
      assert.equal(row.resolvedSubject, undefined, `${row.path} must not be the resolved subject`)
      assert.equal(row.reasons.includes("explicit-path-target"), false, `${row.path} must not be the subject`)
    }
    assert.ok(
      rankOf(map, "halls/northgate/test/registry.spec.ts") > north,
      "a test never leads its source for a query that never mentioned a test",
    )
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D1 test coverage is still evidence, and it is still published", async () => {
  const root = await repo("hb-d1-evidence", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "gantry berth arrival")
    const spec = rowOf(map, "halls/northgate/test/registry.spec.ts")
    assert.ok(spec, "the test must stay reachable")
    assert.equal(spec.reasons.includes("test-covers-subject"), true, "coverage evidence is retained")
    // The two coverage measures are separate facts and must both be published:
    // the test covers the subject (derivedCoverage) without explaining it
    // (subjectCoverage).
    assert.ok(spec.derivedCoverage >= 2, `derivedCoverage ${spec.derivedCoverage}`)
    assert.equal(spec.subjectCoverage, 0, "a test declaration may not count as subject coverage")
    const source = rowOf(map, "halls/northgate/src/registry.ts")
    assert.ok(source.subjectCoverage >= 2, "the production file does explain the subject")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D1 an explicit test query lifts the test, and does so by its own evidence", async () => {
  const root = await repo("hb-d1-intent", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "test that recordArrival counts arrivals")
    assert.equal(analyzeQuery("test that recordArrival counts arrivals").testIntent, true)
    assert.ok(rankOf(map, "halls/northgate/test/registry.spec.ts") > 0, "the test must be reachable")
    assert.ok(
      reasonsOf(map, "halls/northgate/test/registry.spec.ts").includes("test-requested"),
      JSON.stringify(reasonsOf(map, "halls/northgate/test/registry.spec.ts")),
    )
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D1 an explicit path to a TEST overrides the exclusion", async () => {
  const root = await repo("hb-d1-explicit", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "halls/northgate/test/registry.spec.ts")
    assert.equal(rankOf(map, "halls/northgate/test/registry.spec.ts"), 1, "an explicit path names the file")
    assert.equal(rowOf(map, "halls/northgate/test/registry.spec.ts").resolvedSubject, true)
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D1 a test is not blanket-demoted: it keeps its coverage and its own score", async () => {
  const root = await repo("hb-d1-no-blanket", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "gantry berth arrival")
    const spec = rowOf(map, "halls/northgate/test/registry.spec.ts")
    const plain = await mapFor(root, "gantrySpan")
    // The penalty that used to exist (`testDemotion`) must not be applied as a
    // score: the rule is expressed by ORDER, not by subtraction.
    assert.ok(spec.score > 0, "a test with real evidence still scores")
    assert.ok(!spec.contributions.some((item) => item.reason === "test-demotion"), JSON.stringify(spec.contributions))
    assert.ok(REPO_MAP_WEIGHTS.testDemotion > 0)
    void plain
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HB-D2 -- query-module-match
// ---------------------------------------------------------------------------

test("HB-D2 a module term breaks a same-symbol tie in both directions", async () => {
  const root = await repo("hb-d2", SIBLING_FIXTURE)
  try {
    for (const [query, target, other] of [
      ["northgate GantryLedger", "halls/northgate/src/registry.ts", "halls/southgate/src/registry.ts"],
      ["southgate GantryLedger", "halls/southgate/src/registry.ts", "halls/northgate/src/registry.ts"],
    ]) {
      const map = await mapFor(root, query)
      assert.equal(rankOf(map, target), 1, `${query}: the named module must lead`)
      assert.ok(rankOf(map, other) > 1, `${query}: the other module must not lead`)
      assert.equal(
        reasonsOf(map, target).includes("query-module-match"),
        true,
        `${query}: the winner must say why -- ${JSON.stringify(reasonsOf(map, target))}`,
      )
      assert.equal(
        reasonsOf(map, other).includes("query-module-match"),
        false,
        `${query}: the loser must not collect module evidence`,
      )
    }
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D2 the module contribution is bounded and fully reconstructable", async () => {
  const root = await repo("hb-d2-bounded", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "northgate GantryLedger")
    const row = rowOf(map, "halls/northgate/src/registry.ts")
    const points = row.contributions.filter((item) => item.reason === "query-module-match")
    assert.equal(points.length, 1, "awarded at most once")
    assert.equal(points[0].points, REPO_MAP_WEIGHTS.queryModuleMatch)
    // A tie-breaker may not overturn a declaration.
    assert.ok(REPO_MAP_WEIGHTS.queryModuleMatch < REPO_MAP_WEIGHTS.exactSymbol)
    assert.ok(REPO_MAP_WEIGHTS.queryModuleMatch < REPO_MAP_WEIGHTS.explicitPathTarget)
    assert.ok(REPO_MAP_WEIGHTS.queryModuleMatch < REPO_MAP_WEIGHTS.derivedDefinitionCeiling)
    const summed = row.contributions.reduce((total, item) => total + Number(item.points || 0), 0)
    assert.ok(Math.abs(summed - row.score) <= 1e-6, "score must still equal the sum of its reasons")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D2 a module term binds only to a DECLARED boundary, never to an arbitrary ancestor", async () => {
  const root = await repo("hb-d2-boundary", SIBLING_FIXTURE)
  try {
    // "halls" is the grouping directory that holds both packages. It is not a
    // module and naming it must credit neither of them.
    const map = await mapFor(root, "halls GantryLedger")
    for (const file of ["halls/northgate/src/registry.ts", "halls/southgate/src/registry.ts"]) {
      assert.equal(
        reasonsOf(map, file).includes("query-module-match"),
        false,
        `${file}: a grouping directory is not a module`,
      )
    }
    // ...and the declared members are exactly the two packages.
    const graph = await buildRepoGraph(root, { maxFiles: 300 })
    const resolver = createModuleResolver(graph.moduleRoots)
    const north = resolver.rootFor("halls/northgate/src/registry.ts")
    assert.equal(north.dir, "halls/northgate")
    assert.ok(["container-child", "workspace-member"].includes(north.kind), north.kind)
    assert.equal(resolver.rootFor("halls/northgate/test/registry.spec.ts").dir, "halls/northgate")
    // The inside of a module is not a module of its own.
    assert.equal(resolver.rootFor("halls/northgate/src/index.ts").dir, "halls/northgate")
  } finally {
    clearRepoGraphRuntimeCache()
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D2 an explicit path still beats a module term", async () => {
  const root = await repo("hb-d2-explicit", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "halls/southgate/src/registry.ts northgate GantryLedger")
    // Both the exact path and the module term name southgate's file; the file
    // named by the path wins, and it is the same file either way.
    assert.equal(rankOf(map, "halls/southgate/src/registry.ts"), 1, JSON.stringify(map.files.map((r) => [r.path, r.score])))
    const wrong = await mapFor(root, "halls/northgate/src/registry.ts southgate GantryLedger")
    assert.equal(rankOf(wrong, "halls/northgate/src/registry.ts"), 1, "an exact path outranks a conflicting module term")
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// HB-D3 -- path grading is a hierarchy
// ---------------------------------------------------------------------------

test("HB-D3 a shared parent directory is not a module match", async () => {
  const root = await repo("hb-d3-parent", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "halls/northgate/src/registry.ts GantryLedger")
    const wrong = rowOf(map, "halls/southgate/src/registry.ts")
    if (wrong) {
      assert.equal(wrong.reasons.includes("path-prefix"), false, "a sibling module gets no prefix credit")
      assert.equal(wrong.reasons.includes("path-module-root"), false, "a sibling module gets no module-root credit")
    }
    const right = rowOf(map, "halls/northgate/src/registry.ts")
    assert.equal(right.reasons.includes("path-exact"), true)
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D3 a nested module prefix credits the nested module and nothing else", async () => {
  const root = await repo("hb-d3-nested", SIBLING_FIXTURE)
  try {
    const map = await mapFor(root, "halls/northgate package")
    assert.ok(reasonsOf(map, "halls/northgate/src/registry.ts").includes("path-prefix"))
    for (const row of map.files) {
      if (row.path.startsWith("halls/northgate/")) continue
      assert.equal(row.reasons.includes("path-prefix"), false, `${row.path}: prefix leaked outside the module`)
    }
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D3 the same basename in two packages is resolved by the module, not by the name", async () => {
  const root = await repo("hb-d3-basename", SIBLING_FIXTURE)
  try {
    const both = await mapFor(root, "registry")
    assert.ok(
      reasonsOf(both, "halls/northgate/src/registry.ts").includes("path-basename"),
      "the basename still earns its own grade in both packages",
    )
    assert.ok(reasonsOf(both, "halls/southgate/src/registry.ts").includes("path-basename"))
    const north = await mapFor(root, "halls/northgate registry")
    assert.equal(rankOf(north, "halls/northgate/src/registry.ts"), 1)
    assert.ok(rankOf(north, "halls/southgate/src/registry.ts") > 1)
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D3 Windows separators resolve exactly like slashes", async () => {
  const root = await repo("hb-d3-win", SIBLING_FIXTURE)
  try {
    assert.deepEqual(
      queryTerms("halls\\northgate\\src\\registry.ts"),
      queryTerms("halls/northgate/src/registry.ts"),
      "a backslash must not split a path into bare words",
    )
    const slash = await mapFor(root, "halls/northgate/src/registry.ts GantryLedger")
    const backslash = await mapFor(root, "halls\\northgate\\src\\registry.ts GantryLedger")
    assert.deepEqual(backslash.files.map((r) => r.path), slash.files.map((r) => r.path))
    assert.deepEqual(backslash.files.map((r) => r.score), slash.files.map((r) => r.score))
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D3 a traversal in a query never becomes path evidence", async () => {
  const root = await repo("hb-d3-traversal", SIBLING_FIXTURE)
  try {
    for (const token of ["../halls/northgate", "halls/../../etc", "halls/northgate/../../../outside"]) {
      assert.equal(isUsableRelativePath(token), false, token)
    }
    const map = await mapFor(root, "halls/../../etc GantryLedger")
    for (const row of map.files) {
      assert.equal(row.path.includes(".."), false, "no returned path may contain a traversal")
      for (const reason of ["path-exact", "path-prefix", "path-module-root"]) {
        assert.equal(row.reasons.includes(reason), false, `${row.path}: ${reason} fired on a traversal token`)
      }
    }
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("HB-D3 monorepo workspace identity comes from the manifest, not the folder name", async () => {
  const root = await repo("hb-d3-workspace", {
    "package.json": JSON.stringify({ name: "ws-root", private: true, workspaces: ["tools/*"] }, null, 2) + "\n",
    "tools/scanner/package.json": JSON.stringify({ name: "@ws/scanner", private: true, type: "module" }, null, 2) + "\n",
    "tools/scanner/src/entry.ts": 'export function scanTree(root: string): number { return root.length }\n',
    "tools/walker/package.json": JSON.stringify({ name: "@ws/walker", private: true, type: "module" }, null, 2) + "\n",
    "tools/walker/src/entry.ts": 'export function walkTree(root: string): number { return root.length }\n',
    "vendor/tools/package.json": JSON.stringify({ name: "third-party", private: true }, null, 2) + "\n",
    "vendor/tools/src/entry.ts": 'export function scanTree(root: string): number { return 0 }\n',
  })
  try {
    const graph = await buildRepoGraph(root, { maxFiles: 300 })
    const resolver = createModuleResolver(graph.moduleRoots)
    // A directory that merely shares the name "tools" is not the workspace member.
    assert.equal(resolver.rootFor("vendor/tools/src/entry.ts").dir, "vendor/tools")
    // The declared member is identified by its manifest name as well as its path.
    const declared = resolver.rootFor("tools/scanner/src/entry.ts")
    assert.equal(declared.dir, "tools/scanner")
    assert.equal(declared.kind, "npm-package")
    assert.equal(declared.identity, "@ws/scanner")

    const map = await mapFor(root, "scanner scanTree")
    assert.equal(rankOf(map, "tools/scanner/src/entry.ts"), 1, JSON.stringify(map.files.map((r) => [r.path, r.score])))
    assert.ok(rankOf(map, "vendor/tools/src/entry.ts") > 1, "an identically named third-party folder is not the module")
  } finally {
    clearRepoGraphRuntimeCache()
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// the grading primitive itself
// ---------------------------------------------------------------------------

test("HB-D3 path grading is ordered and every grade is reconstructable", () => {
  const resolver = createModuleResolver([
    { dir: "halls/northgate", identity: "northgate", kind: "container-child" },
    { dir: "top/src", identity: "src", kind: "source-root" },
  ])
  const helpers = { matchesName: (term, segment) => segment.toLowerCase().includes(String(term).toLowerCase()), stemOf: (leaf) => leaf.replace(/\.[^.]+$/, "") }
  const grade = (file, token) => gradePathToken({
    file,
    token,
    tokenSegments: String(token).toLowerCase().split("/").filter(Boolean),
    resolver,
    helpers,
  })?.grade ?? null

  assert.equal(grade("halls/northgate/src/registry.ts", "halls/northgate/src/registry.ts"), "path-exact")
  assert.equal(grade("halls/northgate/src/registry.ts", "halls/northgate"), "path-prefix")
  assert.equal(grade("halls/northgate/src/registry.ts", "northgate"), "path-module-root")
  assert.equal(grade("halls/northgate/src/registry.ts", "registry.ts"), "path-basename")
  assert.equal(grade("halls/southgate/src/registry.ts", "halls/northgate"), null, "a sibling is not a prefix")
  assert.equal(grade("halls/southgate/src/registry.ts", "northgate"), null, "a sibling module is not this module")
  // A multi-segment token that ends in the file's name earns at most the WEAK
  // basename grade, in every module that has such a file. It never confers
  // ownership of the parent directory -- that is the whole defect.
  const weak = grade("halls/northgate/src/registry.ts", "halls/registry")
  const weakSibling = grade("halls/southgate/src/registry.ts", "halls/registry")
  assert.equal(weak, "path-basename")
  assert.equal(weakSibling, "path-basename")
  assert.notEqual(weak, "path-prefix")
  assert.notEqual(weakSibling, "path-module-root")
  // A single-segment token may still earn the bounded segment grade -- but only
  // against a directory name, never against an ownership boundary.
  assert.equal(grade("top/src/entry.ts", "top"), "path-segment")
  assert.equal(normalizeRelativePath("a\\b\\c"), "a/b/c")
})

test("HB-D3 the evidence ladder keeps the new grades in order", () => {
  assert.ok(REPO_MAP_WEIGHTS.exactSymbol > REPO_MAP_WEIGHTS.explicitPathTarget)
  assert.ok(REPO_MAP_WEIGHTS.explicitPathTarget > REPO_MAP_WEIGHTS.pathExact)
  assert.ok(REPO_MAP_WEIGHTS.pathExact > REPO_MAP_WEIGHTS.pathBasename)
  assert.ok(REPO_MAP_WEIGHTS.pathBasename > REPO_MAP_WEIGHTS.pathPrefix)
  assert.ok(REPO_MAP_WEIGHTS.pathPrefix > REPO_MAP_WEIGHTS.pathModuleRoot)
  assert.ok(REPO_MAP_WEIGHTS.pathModuleRoot > REPO_MAP_WEIGHTS.pathSegment)
  assert.ok(REPO_MAP_WEIGHTS.pathSegment > REPO_MAP_WEIGHTS.pathPartial)
  assert.ok(REPO_MAP_WEIGHTS.pathModuleRoot > REPO_MAP_WEIGHTS.queryModuleMatch)
})

// ---------------------------------------------------------------------------
// CD-D1 / CD-D2 -- two defects that a draft Holdout C exposed during fixture
// construction. The draft was discarded, never scored, and the repairs live on
// DEV. These tests are why the next independent holdout is not contaminated.
// ---------------------------------------------------------------------------

test("CD-D1 a grouping directory makes its CHILDREN modules, not its siblings", async () => {
  const root = await repo("cd-d1", {
    "decks/keel/ledger.py": "class BilgeLedger:\n    pass\n\n\ndef note_trim(plank):\n    return plank\n",
    "decks/keel/__init__.py": "from .ledger import BilgeLedger, note_trim\n\n__all__ = [\"BilgeLedger\", \"note_trim\"]\n",
    "decks/bow/ledger.py": "class BilgeLedger:\n    pass\n\n\ndef note_trim(plank):\n    return plank\n",
    "decks/bow/__init__.py": "from .ledger import BilgeLedger, note_trim\n\n__all__ = [\"BilgeLedger\", \"note_trim\"]\n",
    "tools/one/only.py": "def only():\n    return 1\n",
  })
  try {
    const graph = await buildRepoGraph(root, { maxFiles: 200 })
    const resolver = createModuleResolver(graph.moduleRoots)
    // `decks` holds only directories and has two of them, so it is a container
    // and its children are modules. Counting SIBLINGS instead of CHILDREN (the
    // first implementation) missed this entirely: `decks` has one sibling,
    // `tools`, so nothing was ever recognised as a container.
    for (const file of ["decks/keel/ledger.py", "decks/bow/ledger.py"]) {
      const root2 = resolver.rootFor(file)
      assert.ok(root2, `${file} must belong to a declared module`)
      assert.equal(root2.dir, file.split("/")[1] === "keel" ? "decks/keel" : "decks/bow")
    }
    // A single-child grouping directory is NOT a container.
    assert.equal(resolver.rootFor("tools/one/only.py"), null, "one child is not a group")
    // ...and the map agrees.
    const map = await mapFor(root, "keel BilgeLedger")
    assert.equal(rankOf(map, "decks/keel/ledger.py"), 1)
    assert.ok(rankOf(map, "decks/bow/ledger.py") > 1)
  } finally {
    clearRepoGraphRuntimeCache()
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("CD-D2 a specifier relative to a PROJECT root still resolves to a local edge", async () => {
  const root = await repo("cd-d2", {
    "pyproject.toml": '[project]\nname = "decks"\n',
    "decks/keel/ledger.py": "def note_trim(plank):\n    return plank\n",
    "decks/keel/survey.py": "from keel.ledger import note_trim\n\n\ndef build_survey(rows):\n    return [note_trim(r) for r in rows]\n",
  })
  try {
    const graph = await buildRepoGraph(root, { maxFiles: 200 })
    const edges = new Set(graph.edges.map((edge) => `${edge.from} -> ${edge.to}`))
    assert.ok(
      edges.has("decks/keel/survey.py -> decks/keel/ledger.py"),
      `a project-root dotted specifier must resolve: ${[...edges].join(", ")}`,
    )
    // ...and the traversal it enables is visible in the map.
    const map = await mapFor(root, "note_trim")
    assert.equal(rankOf(map, "decks/keel/ledger.py"), 1)
    assert.ok(rankOf(map, "decks/keel/survey.py") > 1, "the importer is reachable through the edge")
  } finally {
    clearRepoGraphRuntimeCache()
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("CD-D2 an ambiguous package-root suffix resolves to nothing rather than guessing", async () => {
  const root = await repo("cd-d2-ambiguous", {
    "alpha/shared/ledger.py": "def alpha_trim():\n    return 1\n",
    "beta/shared/ledger.py": "def beta_trim():\n    return 2\n",
    "gamma/runner.py": "from shared.ledger import alpha_trim\n\n\ndef run():\n    return alpha_trim()\n",
  })
  try {
    const graph = await buildRepoGraph(root, { maxFiles: 200 })
    const edges = graph.edges.map((edge) => `${edge.from} -> ${edge.to}`)
    assert.deepEqual(edges, [], "an ambiguous suffix must not become an arbitrary edge")
    assert.ok(
      graph.externalImports.some((entry) => entry.name.includes("shared")),
      "an unresolved specifier stays external rather than being guessed",
    )
  } finally {
    clearRepoGraphRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})
