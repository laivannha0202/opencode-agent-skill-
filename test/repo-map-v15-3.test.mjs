// V15.3 Phase 3 - graph-ranked repo map.
//
// Fifteen behaviours, each of which is a way the map can quietly become worse
// than no map. The fixtures are generated in-test (not hand-built trees) so the
// graph, the symbols and the expected answers cannot drift apart, and every
// assertion is on order and bounds rather than on a specific score.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  buildRepoMap,
  clearRepoMapRuntimeCache,
  isRankableScore,
  queryTerms,
  repoMapRowChars,
  REPO_MAP_TIER,
} from "../lib/repo-map.mjs"
import { writeRetrievalFixture } from "../evals/retrieval/fixture.mjs"
import { loadRetrievalQueries } from "../evals/retrieval/score.mjs"

async function fixture(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-repo-map-" + label + "-"))
  await writeRetrievalFixture(root)
  return root
}

async function custom(label, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-repo-map-" + label + "-"))
  for (const [relative, source] of Object.entries(files)) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, source, "utf8")
  }
  return root
}

const paths = (map) => map.files.map((row) => row.path)
const rankOf = (map, file) => paths(map).indexOf(file) + 1

test("V15.3 repo map: an exact symbol definition ranks first", async () => {
  const root = await fixture("exact")
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "calculateOrderTotal")
    assert.equal(rankOf(map, "packages/core/src/pricing.mjs"), 1)
    const top = map.files[0]
    assert.equal(top.score > 0, true)
    assert.equal(isRankableScore(top.score), true)
    assert.ok(top.reasons.includes("exact-symbol"), JSON.stringify(top.reasons))
    assert.ok(top.importantSymbols.includes("calculateOrderTotal"))
    assert.equal(top.tier, REPO_MAP_TIER.TARGET)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: the file a target imports appears as a neighbour", async () => {
  const root = await fixture("neighbour")
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "calculateOrderTotal", { declaredFiles: ["packages/core/src/orders.mjs"] })
    const order = map.files.find((row) => row.path === "packages/core/src/orders.mjs")
    assert.ok(order, "the declared file must be on the map")
    assert.ok(order.reasons.includes("declared"))
    assert.ok(order.relationship?.importsFromAnchor?.length >= 0)
    const pricing = map.files.find((row) => row.path === "packages/core/src/pricing.mjs")
    assert.ok(pricing, "an imported dependency must be on the map")
    assert.ok(pricing.reasons.includes("direct-import") || pricing.reasons.includes("exact-symbol"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: reverse dependencies are reachable from a changed file", async () => {
  const root = await fixture("reverse")
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "pricing rules", { changedFiles: ["packages/core/src/pricing.mjs"] })
    const changed = map.files.find((row) => row.path === "packages/core/src/pricing.mjs")
    assert.ok(changed?.reasons.includes("changed-file"), JSON.stringify(changed?.reasons))
    const caller = map.files.find((row) => row.path === "packages/core/src/orders.mjs")
    assert.ok(caller, "a caller of a changed file must be on the map")
    assert.ok(caller.reasons.includes("reverse-reference"), JSON.stringify(caller.reasons))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: a relevant test ranks near its source and never above it", async () => {
  const root = await fixture("tests")
  try {
    clearRepoMapRuntimeCache()
    const map = await buildRepoMap(root, "buildInvoiceSummary")
    const source = rankOf(map, "packages/billing/src/invoice.mjs")
    const test = rankOf(map, "test/invoice.test.mjs")
    assert.ok(source > 0, "the source must be present")
    assert.ok(test > 0, "its test must be present")
    assert.ok(test > source, `test rank ${test} must follow source rank ${source}`)
    const row = map.files.find((item) => item.path === "packages/billing/src/invoice.mjs")
    assert.ok(row.testLinks.includes("test/invoice.test.mjs"), JSON.stringify(row.testLinks))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: a task that asks about tests lifts the test back to the top", async () => {
  const root = await fixture("test-intent")
  try {
    clearRepoMapRuntimeCache()
    const withoutIntent = await buildRepoMap(root, "invoice")
    const withIntent = await buildRepoMap(root, "tests for invoice")
    assert.ok(
      rankOf(withIntent, "test/invoice.test.mjs") <= rankOf(withoutIntent, "test/invoice.test.mjs"),
      "an explicit test request must not rank the test lower",
    )
    const row = withIntent.files.find((item) => item.path === "test/invoice.test.mjs")
    assert.ok(row?.reasons.includes("test-requested"), JSON.stringify(row?.reasons))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: an unrelated hotspot never outranks an exact target", async () => {
  // telemetry.mjs is imported by several modules, so centrality alone would put
  // it near the top of every query. It must not.
  const root = await fixture("hotspot")
  try {
    clearRepoMapRuntimeCache()
    for (const [query, target] of [
      ["calculateOrderTotal", "packages/core/src/pricing.mjs"],
      ["computeTaxRate", "packages/billing/src/tax.mjs"],
      ["refundInvoice", "packages/billing/src/refunds.mjs"],
    ]) {
      const map = await buildRepoMap(root, query)
      assert.equal(rankOf(map, target), 1, query)
      const hotspot = rankOf(map, "packages/shared/src/telemetry.mjs")
      assert.ok(hotspot === 0 || hotspot > 1, `${query}: telemetry ranked ${hotspot}`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: a changed-file boost is bounded and never beats an exact symbol", async () => {
  const root = await fixture("changed-boost")
  try {
    clearRepoMapRuntimeCache()
    const scoreOf = (map, file) => map.files.find((row) => row.path === file)?.score
    const plain = await buildRepoMap(root, "computeTaxRate")
    const boosted = await buildRepoMap(root, "computeTaxRate", { changedFiles: ["packages/billing/src/tax.mjs"] })
    assert.ok(scoreOf(boosted, "packages/billing/src/tax.mjs") > scoreOf(plain, "packages/billing/src/tax.mjs"), "a changed file must gain score")
    // The boost is additive and applied once: repeating the same path must not
    // scale it, or a duplicated git listing would dominate the ranking.
    const twice = await buildRepoMap(root, "computeTaxRate", { changedFiles: ["packages/billing/src/tax.mjs", "packages/billing/src/tax.mjs"] })
    assert.equal(scoreOf(twice, "packages/billing/src/tax.mjs"), scoreOf(boosted, "packages/billing/src/tax.mjs"))
    assert.equal(rankOf(twice, "packages/billing/src/tax.mjs"), 1)
    // A changed file that the query has no evidence for must not climb into the
    // lead just because it changed.
    const unrelated = await buildRepoMap(root, "computeTaxRate", { changedFiles: ["packages/web/src/cart.mjs"] })
    assert.ok(rankOf(unrelated, "packages/billing/src/tax.mjs") === 1, "the exact target still leads")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: an ambiguous lexical query is resolved by the file, not by the mentions", async () => {
  const root = await fixture("ambiguous")
  try {
    clearRepoMapRuntimeCache()
    // pricing.mjs, pricing-legacy.mjs and index.mjs all contain the word.
    const map = await buildRepoMap(root, "pricing")
    assert.equal(rankOf(map, "packages/core/src/pricing.mjs"), 1)
    const winner = map.files[0]
    assert.ok(winner.reasons.includes("path-basename"), JSON.stringify(winner.reasons))
    const legacy = map.files.find((row) => row.path === "packages/core/src/legacy/pricing-legacy.mjs")
    assert.ok(legacy, "the decoy must still be reachable")
    assert.ok(legacy.score < winner.score)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: a cyclic import graph is stable and terminates", async () => {
  const root = await custom("cycle", {
    "src/a.mjs": 'import { bFn } from "./b.mjs"\nexport function aFn() { return bFn() }\nexport const anchorSymbol = 1\n',
    "src/b.mjs": 'import { aFn } from "./a.mjs"\nexport function bFn() { return aFn() }\n',
    "src/c.mjs": 'import { aFn } from "./a.mjs"\nexport function cFn() { return aFn() }\n',
  })
  try {
    clearRepoMapRuntimeCache()
    const first = await buildRepoMap(root, "anchorSymbol")
    const second = await buildRepoMap(root, "anchorSymbol")
    assert.deepEqual(paths(first), paths(second))
    assert.deepEqual(first.files.map((row) => row.score), second.files.map((row) => row.score))
    assert.equal(rankOf(first, "src/a.mjs"), 1)
    assert.ok(first.stats.graphExpansionCount >= 1)
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: LSP is optional and its absence changes nothing about the map", async () => {
  const root = await fixture("lsp")
  try {
    clearRepoMapRuntimeCache()
    const withoutLsp = await buildRepoMap(root, "placeOrder")
    const unavailable = await buildRepoMap(root, "placeOrder", {
      enrichLsp: true,
      lsp: async () => { throw new Error("no language server") },
    })
    assert.deepEqual(paths(unavailable), paths(withoutLsp))
    assert.equal(unavailable.stats.lspEnriched, 0)

    let calls = 0
    const enriched = await buildRepoMap(root, "placeOrder", {
      enrichLsp: true,
      limits: { maxEnrichedFiles: 2 },
      lsp: async () => {
        calls += 1
        return { relatedSymbols: ["relatedOne"], references: 3, definitions: 1 }
      },
    })
    assert.ok(calls > 0 && calls <= 2, `enrichment must be bounded, saw ${calls} calls`)
    assert.ok(enriched.stats.lspEnriched > 0)
    const row = enriched.files.find((item) => item.reasons.includes("lsp-enriched"))
    assert.ok(row, "an enriched row must say so")
    assert.ok(row.importantSymbols.includes("relatedOne"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: verified memory is a bounded nudge and never outranks direct evidence", async () => {
  const root = await fixture("memory")
  try {
    clearRepoMapRuntimeCache()
    const scoreOf = (map, file) => map.files.find((row) => row.path === file)?.score
    const base = await buildRepoMap(root, "buildInvoiceSummary")
    assert.equal(rankOf(base, "packages/billing/src/invoice.mjs"), 1, "sanity: the exact target leads")
    const targetScore = scoreOf(base, "packages/billing/src/invoice.mjs")
    // refunds.mjs is a genuine but weaker candidate: it mentions the symbol.
    assert.ok(base.files.some((row) => row.path === "packages/billing/src/refunds.mjs"), "sanity: a weaker candidate exists")
    const weakScore = scoreOf(base, "packages/billing/src/refunds.mjs")

    const boosted = await buildRepoMap(root, "buildInvoiceSummary", {
      verifiedMemoryRows: [{ file: "packages/billing/src/refunds.mjs", confidence: 1, verified: true }],
    })
    const boost = scoreOf(boosted, "packages/billing/src/refunds.mjs") - weakScore
    assert.ok(boost > 0, "a verified record must contribute something")
    assert.ok(boost < 5, `the bonus must stay tiny, saw ${boost}`)
    assert.equal(scoreOf(boosted, "packages/billing/src/invoice.mjs"), targetScore, "memory must not touch the exact target")
    assert.equal(rankOf(boosted, "packages/billing/src/invoice.mjs"), 1, "memory must not reorder the lead")

    // Memory may not introduce a file the query did not already surface.
    const outsider = await buildRepoMap(root, "buildInvoiceSummary", {
      verifiedMemoryRows: [{ file: "packages/web/src/cart.mjs", confidence: 1, verified: true }],
    })
    assert.equal(
      outsider.files.some((row) => row.path === "packages/web/src/cart.mjs"),
      false,
      "memory must never add a file that direct evidence did not justify",
    )

    // Unverified, superseded and expired records contribute nothing at all.
    for (const row of [
      { file: "packages/billing/src/refunds.mjs", confidence: 1, verified: false },
      { file: "packages/billing/src/refunds.mjs", confidence: 1, verified: true, superseded: true },
      { file: "packages/billing/src/refunds.mjs", confidence: 1, verified: true, expired: true },
    ]) {
      const map = await buildRepoMap(root, "buildInvoiceSummary", { verifiedMemoryRows: [row] })
      assert.equal(scoreOf(map, "packages/billing/src/refunds.mjs"), weakScore, JSON.stringify(row))
      assert.equal(
        map.files.find((item) => item.path === "packages/billing/src/refunds.mjs")?.reasons.includes("memory-affinity") ?? false,
        false,
        JSON.stringify(row),
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: the character budget is enforced and rows are never truncated mid-record", async () => {
  const root = await fixture("budget")
  try {
    clearRepoMapRuntimeCache()
    const generous = await buildRepoMap(root, "checkout order", { contextBudgetChars: 100_000, limit: 50 })
    const tight = await buildRepoMap(root, "checkout order", { contextBudgetChars: 500, limit: 50 })
    assert.ok(tight.files.length < generous.files.length, "a tight budget must select fewer files")
    assert.ok(tight.stats.contextChars <= 500 + 400, `budget overshot: ${tight.stats.contextChars}`)
    for (const row of tight.files) {
      assert.ok(row.path && typeof row.score === "number")
      assert.equal(isRankableScore(row.score), true, `non-finite score for ${row.path}`)
      assert.ok(row.chars > 0 && row.chars === repoMapRowChars(row))
    }
    // The first row is always kept: an empty map helps nobody.
    assert.equal(tight.files[0].path, generous.files[0].path)
    assert.equal(tight.stats.dropped > 0, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: repeated runs over identical inputs are byte-identical", async () => {
  const root = await fixture("determinism")
  try {
    clearRepoMapRuntimeCache()
    const a = await buildRepoMap(root, "where is checkout order total computed", { changedFiles: ["packages/core/src/orders.mjs"] })
    const b = await buildRepoMap(root, "where is checkout order total computed", { changedFiles: ["packages/core/src/orders.mjs"] })
    const strip = (map) => map.files.map((row) => ({ ...row }))
    assert.deepEqual(strip(a), strip(b))
    assert.equal(JSON.stringify(a.files), JSON.stringify(b.files))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: a large graph stays bounded in work and output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-repo-map-large-"))
  try {
    clearRepoMapRuntimeCache()
    const files = {}
    const count = 400
    for (let index = 0; index < count; index += 1) {
      const next = index + 1 < count ? index + 1 : 0
      files[`src/mod${String(index).padStart(3, "0")}.mjs`] =
        `import { fn${String(next).padStart(3, "0")} } from "./mod${String(next).padStart(3, "0")}.mjs"\n` +
        `export function fn${String(index).padStart(3, "0")}() { return ${index} }\n`
    }
    files["src/target.mjs"] = 'export function uniqueNeedleSymbol() { return "needle" }\n'
    for (const [relative, source] of Object.entries(files)) {
      const full = path.join(root, ...relative.split("/"))
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, source, "utf8")
    }

    const map = await buildRepoMap(root, "uniqueNeedleSymbol", { contextBudgetChars: 4_000, limit: 40 })
    assert.equal(rankOf(map, "src/target.mjs"), 1)
    assert.ok(map.files.length <= 40, `limit must hold, saw ${map.files.length}`)
    assert.ok(map.stats.candidateCount <= 500, `candidate set must stay bounded, saw ${map.stats.candidateCount}`)
    assert.ok(map.stats.contextChars <= 4_000 + 400)
    // A dense graph must not turn into a full-repository dump.
    assert.ok(map.files.length < count / 4, `map is too broad: ${map.files.length} of ${count}`)
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: a monorepo query stays inside its module neighbourhood", async () => {
  const root = await fixture("monorepo")
  try {
    clearRepoMapRuntimeCache()
    const billing = await buildRepoMap(root, "computeTaxRate")
    const topFive = paths(billing).slice(0, 5)
    // The lead must be the owning module. Its test file is a legitimate fifth
    // result, but an unrelated package must not appear at all.
    assert.ok(topFive[0].startsWith("packages/billing/"), `module locality lost: ${JSON.stringify(topFive)}`)
    const foreign = topFive.filter((file) =>
      file.startsWith("packages/core/") || file.startsWith("packages/web/") || file.startsWith("packages/shared/"))
    assert.deepEqual(foreign, [], `unrelated modules leaked in: ${JSON.stringify(foreign)}`)
    assert.ok(topFive.filter((file) => file.startsWith("packages/billing/")).length >= 3, JSON.stringify(topFive))
    const core = await buildRepoMap(root, "roundCurrency")
    assert.equal(rankOf(core, "packages/core/src/utils/money.mjs"), 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: no returned path escapes the workspace or a runtime artifact directory", async () => {
  const root = await fixture("containment")
  try {
    clearRepoMapRuntimeCache()
    for (const dir of [".ues-work", ".ues-cache", ".ues-traces", ".git"]) {
      await mkdir(path.join(root, ...dir.split("/")), { recursive: true })
      await writeFile(path.join(root, ...dir.split("/"), "leak.mjs"), "export function leakSymbol() { return 1 }\n")
    }
    const map = await buildRepoMap(root, "leakSymbol roundCurrency", { changedFiles: ["../outside.ts", "/etc/passwd"] })
    assert.ok(map.files.length > 0)
    for (const row of map.files) {
      assert.equal(path.isAbsolute(row.path), false, row.path)
      assert.equal(row.path.includes(".."), false, row.path)
      assert.equal(/^[A-Za-z]:/.test(row.path), false, row.path)
      assert.equal(row.path.split("/").some((part) => part.startsWith(".ues-") || part === ".git"), false, row.path)
      assert.equal(row.path.startsWith("/"), false, row.path)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: every retrieval fixture query still names a file that exists", async () => {
  // Guards the gate itself: a fixture that drifted from its generator would make
  // every recall number meaningless.
  const root = await fixture("fixtures-intact")
  try {
    clearRepoMapRuntimeCache()
    const queries = await loadRetrievalQueries()
    assert.ok(queries.length >= 15, `expected at least 15 query fixtures, found ${queries.length}`)
    const known = new Set((await buildRepoMap(root, "zzz-no-such-symbol-zzz")).files.map((row) => row.path))
    const all = new Set()
    for (const item of queries) {
      for (const file of item.expect) {
        assert.ok(file && !file.includes(".."), `${item.id}: bad expectation ${file}`)
        all.add(file)
      }
      assert.ok(item.primary == null || item.expect.includes(item.primary), `${item.id}: primary not in expect`)
    }
    // The map only knows files it indexed; assert expectations are a subset of
    // the repository's real source files rather than of one query's output.
    const { readdir } = await import("node:fs/promises")
    const collected = new Set()
    const walk = async (dir, prefix = "") => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".")) continue
          await walk(path.join(dir, entry.name), prefix + entry.name + "/")
        } else if (/\.(mjs|js|ts|py)$/.test(entry.name)) {
          collected.add(prefix + entry.name)
        }
      }
    }
    await walk(root)
    for (const file of all) {
      assert.ok(collected.has(file), `${file} is expected by a query but absent from the fixture`)
    }
    void known
  } finally {
    clearRepoMapRuntimeCache()
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.3 repo map: query terms drop stop words and stay deterministic", async () => {
  assert.deepEqual(queryTerms("where is the checkout order total computed"), ["checkout", "order", "total", "computed"])
  assert.deepEqual(queryTerms("the the the"), [])
  assert.deepEqual(queryTerms(""), [])
  assert.deepEqual(queryTerms("a b"), [])
  assert.deepEqual(queryTerms("checkout checkout"), ["checkout"])
  assert.deepEqual(queryTerms("packages/core/src/pricing.mjs"), ["packages/core/src/pricing.mjs"])
})
