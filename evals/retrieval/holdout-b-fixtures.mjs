// HOLDOUT B FIXTURES -- frozen retrieval audit, written AFTER the 15.3 freeze.
//
// Constraints honoured, and the reason each one exists:
//
//   - No name, path, symbol or topology is shared with the DEV corpus or with
//     holdout A. Every family below is a different language mix and a different
//     module layout from every family in `dev-fixtures.mjs` and
//     `holdout-fixtures.mjs`.
//   - Structurally DIFFERENT families from each other, not three dialects of one
//     idea: a Java/Kotlin-style two-package tree with an interface re-export, a
//     Python service mesh with a package `__init__` chain and a relative-import
//     cycle, and a Go flat tree with a fan-in hub and a same-named symbol.
//   - Every one of the ten retrieval classes is represented, because the gate is
//     per class and an unrepresented class is a class with no evidence.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// ---------------------------------------------------------------------------
// Family H1 -- "harbour": a Java-flavoured two-package tree.
//
// Shapes: an INTERFACE re-exported through a facade package, a same-named
// record in two packages, a component that only CALLS the port, and a JUnit-style
// test that lives in the consumer's package rather than the producer's.
// ---------------------------------------------------------------------------
const H1 = {
  "go.mod": "module harbour\n\ngo 1.22\n",
  "package.json": JSON.stringify({ name: "harbour-root", private: true, workspaces: ["modules/*", "tools/*"] }, null, 2) + "\n",

  "modules/quay/package.json": JSON.stringify({ name: "@harbour/quay", private: true, exports: "./src/api.ts" }, null, 2) + "\n",
  "modules/quay/src/api.ts": [
    'export interface Manifest { id: string }',
    "",
    "export class BerthRegistry {",
    "  private readonly berths: Manifest[] = []",
    "  register(m: Manifest): number {",
    "    this.berths.push(m)",
    "    return this.berths.length",
    "  }",
    "}",
    "",
  ].join("\n"),
  // The facade re-exports the producer's port.
  "modules/quay/src/port.ts": [
    'export { BerthRegistry, Manifest } from "./api.ts";',
    "",
  ].join("\n"),

  // A same-named class in a DIFFERENT package.
  "modules/dockyard/package.json": JSON.stringify({ name: "@harbour/dockyard", private: true, exports: "./src/api.ts" }, null, 2) + "\n",
  "modules/dockyard/src/api.ts": [
    "export class BerthRegistry {",
    "  rows: string[] = []",
    "  register(row: string): number {",
    "    this.rows.push(row)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
  ].join("\n"),

  // Only CALLS the port; declares nothing named BerthRegistry.
  "modules/dockyard/src/mooring.ts": [
    'import { BerthRegistry } from "@harbour/quay";',
    "",
    "export function moorVessel(registry: BerthRegistry, name: string): number {",
    "  return registry.register({ id: name })",
    "}",
    "",
  ].join("\n"),

  // A report that NAMES the registry many times and defines nothing of it.
  "modules/dockyard/src/manifest.ts": [
    'import { BerthRegistry } from "@harbour/quay";',
    "",
    "export function berthRegistryRollup(registry: BerthRegistry): number {",
    "  let berth_registry_total = 0",
    "  for (const row of registry.rows) berth_registry_total += berth_registry_total + 1",
    "  return berth_registry_total",
    "}",
    "",
  ].join("\n"),

  "modules/quay/test/quay.spec.ts": [
    'import { BerthRegistry } from "@harbour/quay";',
    "",
    "export function testBerthRegistryRegisterReturnsCount() {",
    "  return new BerthRegistry().register({ id: \"a\" }) === 1",
    "}",
    "",
  ].join("\n"),

  "tools/dispatch/dispatch.ts": [
    'import { BerthRegistry } from "@harbour/quay";',
    "",
    "export class BerthRegistry {",
    "  public queue: string[] = []",
    "}",
    "",
    "export function dispatchBerths(ids: string[]): number {",
    "  return ids.length",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family H2 -- "lighthouse": a Python service mesh.
//
// Shapes: a package `__init__` that re-exports a grandchild module, a RELATIVE
// import cycle, a same-named helper in two packages, a component module that
// only references the helper, and a pytest-style test under a `tests/` directory
// that imports through the package chain rather than the leaf.
// ---------------------------------------------------------------------------
const H2 = {
  "keeper/__init__.py": [
    "from .keeperutil import stamp_keeper",
    "from .keeperutil import wind_keeper",
    "",
    '__all__ = ["stamp_keeper", "wind_keeper"]',
    "",
  ].join("\n"),

  "keeper/keeperutil.py": [
    "import time",
    "",
    "def stamp_keeper(mark):",
    "    return int(time.time()) - mark",
    "",
    "def wind_keeper(loops):",
    "    return loops + 1",
    "",
  ].join("\n"),

  "keeper/beacon.py": [
    "from .keeperutil import wind_keeper",
    "",
    "def rotate_beacon(loops):",
    "    return wind_keeper(loops) * 3",
    "",
  ].join("\n"),

  // The relative-import CYCLE: beacon <-> lamp.
  "keeper/lamp.py": [
    "from .keeperutil import stamp_keeper",
    "",
    "def light_lamp(mark):",
    "    return stamp_keeper(mark)",
    "",
  ].join("\n"),

  "keeper/gauge.py": [
    "from .lamp import light_lamp",
    "",
    "def read_gauge(mark):",
    "    return light_lamp(mark) + 1",
    "",
  ].join("\n"),

  // Mentions stamp_keeper repeatedly; declares nothing named stamp_keeper.
  "keeper/report.py": [
    "from .keeperutil import stamp_keeper",
    "",
    "def build_keeper_report(mark):",
    "    stamp_keeper_rows = 0",
    "    for _ in range(3):",
    "        stamp_keeper_rows += stamp_keeper(mark)",
    "    return stamp_keeper_rows",
    "",
  ].join("\n"),

  // Same-named helper in a sibling package.
  "keeper/extra/__init__.py": "",
  "keeper/extra/wind.py": [
    "def wind_keeper(loops):",
    "    return loops * 2",
    "",
  ].join("\n"),
  "keeper/extra/use.py": [
    "from .wind import wind_keeper",
    "",
    "def use_extra(loops):",
    "    return wind_keeper(loops)",
    "",
  ].join("\n"),

  "tests/test_keeper_beacon.py": [
    "from keeper import wind_keeper",
    "from keeper.beacon import rotate_beacon",
    "",
    "def test_rotate_beacon_uses_wind_keeper():",
    "    return rotate_beacon(2) == 9",
    "",
  ].join("\n"),
  "tests/test_keeperutil.py": [
    "from keeper import stamp_keeper",
    "",
    "def test_stamp_keeper_is_non_negative():",
    "    return stamp_keeper(0) >= 0",
    "",
  ].join("\n"),
  "tests/conftest_helpers.py": [
    "def keeper_fixture():",
    "    return {\"mark\": 0}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family H3 -- "foundry": a Go flat tree with a fan-in hub.
//
// Shapes: a hub imported by nearly everything (the centrality decoy), a fan-in
// file that combines two lower stages, a same-named function in two packages,
// and table-driven tests that live beside their source.
// ---------------------------------------------------------------------------
const H3 = {
  "go.mod": "module foundry\n\ngo 1.22\n",

  "cmd/forgectl/main.go": 'package main\n\nimport "foundry/internal/pour"\n\nfunc main() { _ = pour.Pour(1) }\n',

  // The hub: imported by almost everything, and the answer to nothing.
  "internal/ledger/book.go": [
    "package ledger",
    "",
    "var entries []string",
    "",
    "func Note(name string) {",
    "\tentries = append(entries, name)",
    "}",
    "",
    "func Count() int { return len(entries) }",
    "",
  ].join("\n"),

  "internal/pour/pour.go": [
    "package pour",
    "",
    'import "foundry/internal/ledger"',
    "",
    "func Pour(batches int) float64 {",
    "\tledger.Note(\"pour\")",
    "\treturn float64(batches) * 1.5",
    "}",
    "",
  ].join("\n"),

  "internal/melt/melt.go": [
    "package melt",
    "",
    'import "foundry/internal/ledger"',
    "",
    "func Melt(batches int) float64 {",
    "\tledger.Note(\"melt\")",
    "\treturn float64(batches) * 0.5",
    "}",
    "",
  ].join("\n"),

  // The fan-in: depends on TWO lower stages at once.
  "internal/cast/cast.go": [
    "package cast",
    "",
    "import (",
    "\t\"foundry/internal/melt\"",
    "\t\"foundry/internal/pour\"",
    ")",
    "",
    "func Cast(batches int) float64 {",
    "\treturn melt.Melt(batches) + pour.Pour(batches)",
    "}",
    "",
  ].join("\n"),

  "internal/cast/cast_test.go": [
    "package cast",
    "",
    "func TestCastAddsBothStages(t *testing.T) {",
    "\tif Cast(2) != 4 {",
    "\t\tt.Fatal(\"cast\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/pour/pour_test.go": [
    "package pour",
    "",
    "func TestPourScalesBatches(t *testing.T) {",
    "\tif Pour(2) != 3 {",
    "\t\tt.Fatal(\"pour\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/melt/melt_test.go": [
    "package melt",
    "",
    "func TestMeltHalvesBatches(t *testing.T) {",
    "\tif Melt(4) != 2 {",
    "\t\tt.Fatal(\"melt\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/ledger/book_test.go": [
    "package ledger",
    "",
    "func TestNoteIncreasesCount(t *testing.T) {",
    "\tbefore := Count()",
    "\tNote(\"x\")",
    "\tif Count() != before+1 {",
    "\t\tt.Fatal(\"count\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  // Same function name in two packages.
  "internal/cast/mix.go": [
    "package cast",
    "",
    "func Blend(value int) int { return value + 1 }",
    "",
  ].join("\n"),
  "internal/melt/mix.go": [
    "package melt",
    "",
    "func Blend(value int) int { return value * 5 }",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family H4 -- "kiln-yard": a flat ES-module app with a deep relative barrel.
//
// A fourth TOPOLOGY, in a module system the repaired graph already supports:
//   - a three-leaf `export *` barrel two directories deep, so a symbol is
//     reachable only through a chain of relative re-exports;
//   - a CYCLE between two leaves of that barrel;
//   - the SAME export name in two leaves of the same barrel;
//   - a mention-only consumer and a test named after the subject;
//   - a hub module imported by several unrelated files.
//
// The family count exists to test generalisation of the repaired machinery, not
// to force support for a language the development corpus never required.
// ---------------------------------------------------------------------------
const H4 = {
  "app/boot.mjs": [
    'import { sparkCount } from "./stack/deep/barrel.mjs";',
    "",
    "export function bootStack(rows) {",
    "  return rows.map((row) => sparkCount(row)).length",
    "}",
    "",
  ].join("\n"),

  // The deep barrel: three `export *` leaves, nothing else.
  "app/stack/deep/barrel.mjs": [
    'export * from "./leafA.mjs";',
    'export * from "./leafB.mjs";',
    'export * from "./leafC.mjs";',
    "",
  ].join("\n"),

  "app/stack/deep/leafA.mjs": [
    'import { emberCount } from "./leafC.mjs";',
    "",
    "export function sparkCount(row) {",
    "  return emberCount(row)",
    "}",
    "",
  ].join("\n"),

  // The SAME export name in a different leaf of the same barrel.
  "app/stack/deep/leafB.mjs": [
    "export function sparkCount(row) {",
    "  return String(row).length * 2",
    "}",
    "",
  ].join("\n"),

  // The CYCLE: leafA <-> leafC.
  "app/stack/deep/leafC.mjs": [
    'import { sparkCount } from "./leafA.mjs";',
    "",
    "export function emberCount(row) {",
    "  return typeof sparkCount === \"function\" ? 1 : 0",
    "}",
    "",
  ].join("\n"),

  // Only REFERENCES sparkCount; declares nothing named sparkCount.
  "app/stack/panel.mjs": [
    'import { sparkCount } from "./deep/barrel.mjs";',
    "",
    "export function buildStackPanel(rows) {",
    "  const spark_count = 0",
    "  for (const row of rows) spark_count += sparkCount(row)",
    "  return spark_count",
    "}",
    "",
  ].join("\n"),

  "app/stack/panel.test.mjs": [
    'import { sparkCount } from "./deep/barrel.mjs";',
    "",
    "export function testSparkCountReturnsEmber() {",
    "  return sparkCount(\"a\") === 1",
    "}",
    "",
  ].join("\n"),

  // The hub: imported by several files, and the answer to nothing.
  "app/util/marks.mjs": [
    "const marks = []",
    "",
    "export function markStack(name) {",
    "  marks.push(name)",
    "  return marks.length",
    "}",
    "",
  ].join("\n"),
  "app/util/quench.mjs": [
    'import { markStack } from "./marks.mjs";',
    "",
    "export function quenchStack(rows) {",
    "  return rows.map((row) => markStack(row)).length",
    "}",
    "",
  ].join("\n"),
  "app/stack/warm.mjs": [
    'import { markStack } from "../util/marks.mjs";',
    "",
    "export function warmStack(rows) {",
    "  return rows.map((row) => markStack(row)).length",
    "}",
    "",
  ].join("\n"),
};

export const HOLDOUT_B_FAMILIES = Object.freeze([
  Object.freeze({ id: "hb-h1-harbour", root: "hb-h1", files: H1 }),
  Object.freeze({ id: "hb-h2-lighthouse", root: "hb-h2", files: H2 }),
  Object.freeze({ id: "hb-h3-foundry", root: "hb-h3", files: H3 }),
  Object.freeze({ id: "hb-h4-kiln-yard", root: "hb-h4", files: H4 }),
])

// Reuse the DEV class vocabulary so the per-class comparison is like-for-like.
export const HOLDOUT_B_CLASSES = Object.freeze([
  "exact-symbol",
  "ambiguous-symbol",
  "same-name-symbols-in-different-modules",
  "cross-module-dependency",
  "reverse-dependency",
  "mentions-without-declaration",
  "test-lookup",
  "changed-file",
  "monorepo-locality",
  "generic-hotspot-distractor",
])

export function holdoutBFiles(familyId) {
  const family = HOLDOUT_B_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown holdout B family: " + familyId)
  return Object.keys(family.files).sort()
}

export async function writeHoldoutBFamily(root, familyId) {
  const family = HOLDOUT_B_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown holdout B family: " + familyId)
  for (const relative of Object.keys(family.files).sort()) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, family.files[relative], "utf8")
  }
  return { familyId, files: Object.keys(family.files).length }
}