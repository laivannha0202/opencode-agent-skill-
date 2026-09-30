// HOLDOUT D fixtures (15.3 second independent gate, post-freeze V3b).
//
// Created ONLY after freeze receipt V3b. Every package name, symbol, path,
// topology and test layout below is new: nothing is shared with the DEV corpus
// (forge / loom / kiln / quayworks / orchard / decks), with holdout A, with
// holdout B, or with the contaminated Holdout C draft.
//
// Why it exists in this shape. Holdout C's construction was contaminated by two
// resolver defects, so the independent gate is D. D therefore carries, for each
// structural class, a shape no earlier corpus used:
//
//   d1-lantern    `component/<name>` grouping with no manifest at all: module
//                 identity can only come from the structural container rule
//   d2-marlin     Python `service/<name>` packages reached through
//                 project-root dotted imports and a mention-heavy report
//   d3-basalt     Go with `apps/` + `libs/` and a real cycle plus a second hop
//   d4-cobalt     a JS monorepo with a FOUR-deep re-export chain
//   d5-trellis    `lib/<pkg>` plus a Go sub-tree and three test conventions
//
// Every family also carries the two decoys a graph ranker must not chase: a
// high-centrality helper that answers nothing, and a mention-only file that
// talks about the subject without declaring it.
//
// Only languages the runtime actually indexes appear here. A fixture written in
// a language the indexer does not read would score zero for a reason that has
// nothing to do with retrieval, which is exactly the failure mode the earlier
// drafts of these families had.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// ---------------------------------------------------------------------------
// d1-lantern -- `component/<name>` grouping, no manifests anywhere
// ---------------------------------------------------------------------------
const D1 = {
  "component/lantern/Registry.ts": [
    "export class LanternRegistry {",
    "  private readonly rows: string[] = []",
    "  admit(name: string): number {",
    "    this.rows.push(name)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
    "export function noteEntry(name: string): string {",
    "  return `lantern:${name}`",
    "}",
    "",
    "export function lanternSpan(): number {",
    "  return 3",
    "}",
    "",
  ].join("\n"),

  "component/lantern/Entries.ts": [
    'import { noteEntry } from "./Registry"',
    "",
    "export function admitEntries(names: string[]): string[] {",
    "  return names.map((name) => noteEntry(name))",
    "}",
    "",
  ].join("\n"),

  "component/lantern/index.ts": 'export { LanternRegistry, noteEntry } from "./Registry"\n',

  // The SAME class and function name in a sibling component.
  "component/wick/Registry.ts": [
    "export class LanternRegistry {",
    "  private readonly rows: string[] = []",
    "  admit(name: string): number {",
    "    this.rows.push(name)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
    "export function noteEntry(name: string): string {",
    "  return `wick:${name}`",
    "}",
    "",
    "export function wickReach(): number {",
    "  return 4",
    "}",
    "",
  ].join("\n"),

  "component/wick/Entries.ts": [
    'import { noteEntry } from "./Registry"',
    "",
    "export function dismissEntries(names: string[]): string[] {",
    "  return names.map((name) => noteEntry(name))",
    "}",
    "",
  ].join("\n"),

  "component/wick/index.ts": 'export { LanternRegistry, noteEntry } from "./Registry"\n',

  // Centrality decoy: imported by both components and by the console.
  "component/shared/Gauge.ts": [
    "const reads = new Map<string, number>()",
    "",
    "export function readGauge(label: string): number {",
    "  reads.set(label, (reads.get(label) || 0) + 1)",
    "  return reads.get(label) || 0",
    "}",
    "",
    "export function gaugeTotal(): number {",
    "  return reads.size",
    "}",
    "",
  ].join("\n"),

  // The console depends on BOTH components.
  "component/console/Dial.ts": [
    'import { LanternRegistry } from "../lantern/Registry"',
    'import { LanternRegistry as WickRegistry } from "../wick/Registry"',
    "",
    "export function renderDial(name: string): string {",
    "  const a = new LanternRegistry().admit(name)",
    "  const b = new WickRegistry().admit(name)",
    "  return String(a + b)",
    "}",
    "",
  ].join("\n"),

  "component/console/Boot.ts": [
    'import { admitEntries } from "../lantern/Entries"',
    'import { readGauge } from "../shared/Gauge"',
    'import { renderDial } from "./Dial"',
    "",
    "export function bootDial(name: string): string {",
    "  readGauge(\"boot\")",
    "  return admitEntries([name]).join(\"|\") + renderDial(name)",
    "}",
    "",
  ].join("\n"),

  // Mention-heavy: talks about the registry, declares something else.
  "component/console/Report.ts": [
    "export function buildDialReport(names: string[]): number {",
    "  let LanternRegistry_total = 0",
    "  for (const name of names) {",
    "    LanternRegistry_total += 1",
    "  }",
    "  return LanternRegistry_total",
    "}",
    "",
  ].join("\n"),

  "component/lantern/test/Registry.spec.ts": [
    'import { LanternRegistry, noteEntry } from "../Registry"',
    "",
    "export function testLanternRegistryAdmitNotesEntry() {",
    "  return new LanternRegistry().admit(\"l1\") === 1 && noteEntry(\"l1\") !== \"\"",
    "}",
    "",
  ].join("\n"),

  // A second test in the same component restating the same symbol.
  "component/lantern/test/Registry-again.spec.ts": [
    'import { LanternRegistry } from "../Registry"',
    "",
    "export function testLanternRegistryAdmitNotesEntry() {",
    "  return new LanternRegistry().admit(\"l2\") === 1",
    "}",
    "",
  ].join("\n"),

  "component/wick/test/Registry.spec.ts": [
    'import { LanternRegistry, noteEntry } from "../Registry"',
    "",
    "export function testLanternRegistryAdmitNotesEntry() {",
    "  return new LanternRegistry().admit(\"w1\") === 1 && noteEntry(\"w1\") !== \"\"",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// d2-marlin -- Python `service/<name>` packages, project-root dotted imports
// ---------------------------------------------------------------------------
const D2 = {
  "pyproject.toml": '[project]\nname = "marlin"\nversion = "0.9.0"\n',

  "service/plankton/__init__.py": [
    "from .manifest import PlanktonManifest, track_cell",
    "",
    '__all__ = ["PlanktonManifest", "track_cell"]',
    "",
  ].join("\n"),

  "service/plankton/manifest.py": [
    "class PlanktonManifest:",
    "    def __init__(self):",
    "        self.cells = []",
    "",
    "    def track(self, cell):",
    "        self.cells.append(cell)",
    "        return len(self.cells)",
    "",
    "",
    "def track_cell(cell):",
    "    return f\"plankton:{cell}\"",
    "",
    "",
    "def cell_depth():",
    "    return 2",
    "",
  ].join("\n"),

  // Mention-heavy: talks about the class, declares something else.
  "service/plankton/report.py": [
    "def build_plankton_manifest_report(rows):",
    "    PlanktonManifest_total = 0",
    "    for row in rows:",
    "        PlanktonManifest_total += 1",
    "    return {\"plankton_manifest_total\": PlanktonManifest_total}",
    "",
  ].join("\n"),

  "service/plankton/scan.py": [
    "from plankton.manifest import PlanktonManifest, track_cell",
    "",
    "def scan_plankton_cells(rows):",
    "    return [track_cell(row) for row in rows]",
    "",
  ].join("\n"),

  // The SAME class and function name in a sibling service.
  "service/kelp/__init__.py": [
    "from .manifest import PlanktonManifest, track_cell",
    "",
    '__all__ = ["PlanktonManifest", "track_cell"]',
    "",
  ].join("\n"),

  "service/kelp/manifest.py": [
    "class PlanktonManifest:",
    "    def __init__(self):",
    "        self.fronds = []",
    "",
    "    def track(self, cell):",
    "        self.fronds.append(cell)",
    "        return len(self.fronds)",
    "",
    "",
    "def track_cell(cell):",
    "    return f\"kelp:{cell}\"",
    "",
    "",
    "def frond_weight():",
    "    return 5",
    "",
  ].join("\n"),

  "service/kelp/sweep.py": [
    "from kelp.manifest import PlanktonManifest, track_cell",
    "",
    "def sweep_kelp_cells(rows):",
    "    return [track_cell(row) for row in rows]",
    "",
  ].join("\n"),

  "service/reef/runner.py": [
    "from plankton.manifest import PlanktonManifest",
    "from kelp.manifest import PlanktonManifest as KelpManifest",
    "",
    "def run_reef_cells(name):",
    "    a = PlanktonManifest().track(name)",
    "    b = KelpManifest().track(name)",
    "    return [a, b]",
    "",
  ].join("\n"),

  "service/plankton/tests/test_manifest.py": [
    "from plankton.manifest import PlanktonManifest, track_cell",
    "",
    "def test_plankton_manifest_track_cell_counts():",
    "    return PlanktonManifest().track(\"p1\") == 1 and track_cell(\"p1\")",
    "",
  ].join("\n"),

  "service/kelp/tests/test_manifest.py": [
    "from kelp.manifest import PlanktonManifest, track_cell",
    "",
    "def test_plankton_manifest_track_cell_counts():",
    "    return PlanktonManifest().track(\"k1\") == 1 and track_cell(\"k1\")",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// d3-basalt -- Go, apps/ + libs/, three-node cycle, second hop from the app
// ---------------------------------------------------------------------------
const D3 = {
  "go.mod": "module basalt\n\ngo 1.22\n",

  "apps/gateway/main.go": [
    "package main",
    "",
    'import "basalt/libs/mantle"',
    "",
    "func main() { _ = mantle.Shell(2) }",
    "",
  ].join("\n"),

  "libs/mantle/mantle.go": [
    "package mantle",
    "",
    "// Package mantle is the basalt shell library.",
    "",
  ].join("\n"),

  "libs/mantle/shell.go": [
    "package mantle",
    "",
    "func Shell(grams int) int { return grams * 2 }",
    "",
  ].join("\n"),

  "libs/mantle/crust.go": [
    "package mantle",
    "",
    'import "basalt/libs/core"',
    "",
    "func Crust(grams int) int { return core.Core(grams) + 3 }",
    "",
  ].join("\n"),

  "libs/mantle/layer.go": [
    "package mantle",
    "",
    "func Layer(grams int) int { return Crust(grams) + 1 }",
    "",
  ].join("\n"),

  "libs/core/core.go": [
    "package core",
    "",
    'import "basalt/libs/edge"',
    "",
    "func Core(grams int) int { return edge.Edge(grams) * 2 }",
    "",
  ].join("\n"),

  // CYCLE: core <-> edge.
  "libs/edge/edge.go": [
    "package edge",
    "",
    'import "basalt/libs/core"',
    "",
    "func Edge(grams int) int { return grams + 1 }",
    "",
  ].join("\n"),

  // Mentions Shell repeatedly, declares something else.
  "libs/mantle/report.go": [
    "package mantle",
    "",
    "func BuildShellReport(rows int) int {",
    "\tshellTotal := 0",
    "\tfor i := 0; i < rows; i++ {",
    "\t\tshellTotal += Shell(i)",
    "\t}",
    "\treturn shellTotal",
    "}",
    "",
  ].join("\n"),

  "libs/core/core_test.go": [
    "package core",
    "",
    "func TestCoreDoublesEdge(t *testing.T) {",
    "\tif Core(2) != 6 {",
    "\t\tt.Fatal(\"core\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "libs/mantle/shell_test.go": [
    "package mantle",
    "",
    "func TestShellDoublesGrams(t *testing.T) {",
    "\tif Shell(2) != 4 {",
    "\t\tt.Fatal(\"shell\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "libs/edge/edge_test.go": [
    "package edge",
    "",
    "func TestEdgeAddsOne(t *testing.T) {",
    "\tif Edge(2) != 3 {",
    "\t\tt.Fatal(\"edge\")",
    "\t}",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// d4-cobalt -- JS monorepo with a FOUR-deep re-export chain
// ---------------------------------------------------------------------------
const D4 = {
  "package.json": JSON.stringify({ name: "cobalt-root", private: true, workspaces: ["packages/*"] }, null, 2) + "\n",

  "packages/vaultroom/package.json": JSON.stringify({ name: "@cobalt/vaultroom", private: true, type: "module", exports: "./src/index.js" }, null, 2) + "\n",

  "packages/vaultroom/src/index.js": 'export { ShelfIndex, lockShelf } from "./surface"\n',
  "packages/vaultroom/src/surface.js": 'export { ShelfIndex, lockShelf } from "./entry"\n',
  "packages/vaultroom/src/entry.js": 'export { ShelfIndex, lockShelf } from "./shelf"\n',

  "packages/vaultroom/src/shelf.js": [
    "export class ShelfIndex {",
    "  constructor() { this.rows = [] }",
    "  add(name) {",
    "    this.rows.push(name)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
    "export function lockShelf(name) {",
    "  return `vaultroom:${name}`",
    "}",
    "",
    "export function shelfDepth() { return 2 }",
    "",
  ].join("\n"),

  // The only consumer, four hops from the declaration.
  "packages/vaultroom/src/consumer.js": [
    'import { ShelfIndex, lockShelf } from "./index"',
    "",
    "export function vaultEntry(name) {",
    "  return lockShelf(new ShelfIndex().add(name) + name)",
    "}",
    "",
  ].join("\n"),

  // Centrality decoy.
  "packages/vaultroom/src/meter.js": [
    "let used = 0",
    "",
    "export function useMeter(by = 1) {",
    "  used += by",
    "  return used",
    "}",
    "",
  ].join("\n"),

  "packages/stackyard/package.json": JSON.stringify({ name: "@cobalt/stackyard", private: true, type: "module", exports: "./src/index.js" }, null, 2) + "\n",

  "packages/stackyard/src/index.js": 'export { ShelfIndex, lockShelf } from "./surface"\n',
  "packages/stackyard/src/surface.js": 'export { ShelfIndex, lockShelf } from "./entry"\n',
  "packages/stackyard/src/entry.js": 'export { ShelfIndex, lockShelf } from "./shelf"\n',

  "packages/stackyard/src/shelf.js": [
    "export class ShelfIndex {",
    "  constructor() { this.rows = [] }",
    "  add(name) {",
    "    this.rows.push(name.length)",
    "    return this.rows.length",
    "  }",
    "}",
    "",
    "export function lockShelf(name) {",
    "  return `stackyard:${name}`",
    "}",
    "",
    "export function stackHeight() { return 9 }",
    "",
  ].join("\n"),

  "packages/vaultroom/test/shelf.spec.js": [
    'import { ShelfIndex, lockShelf } from "../src/index"',
    "",
    "export function testShelfIndexAddLocksShelf() {",
    "  return new ShelfIndex().add(\"v1\") === 1 && lockShelf(\"v1\") !== \"\"",
    "}",
    "",
  ].join("\n"),

  "packages/vaultroom/test/shelf-again.spec.js": [
    'import { ShelfIndex } from "../src/shelf"',
    "",
    "export function testShelfIndexAddLocksShelf() {",
    "  return new ShelfIndex().add(\"v2\") === 1",
    "}",
    "",
  ].join("\n"),

  "packages/stackyard/test/shelf.spec.js": [
    'import { ShelfIndex, lockShelf } from "../src/index"',
    "",
    "export function testShelfIndexAddLocksShelf() {",
    "  return new ShelfIndex().add(\"s1\") === 1 && lockShelf(\"s1\") !== \"\"",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// d5-trellis -- `lib/<pkg>` plus a Go sub-tree and three test conventions
// ---------------------------------------------------------------------------
const D5 = {
  "go.mod": "module trellis\n\ngo 1.22\n",

  "lib/trellisgate/__init__.py": [
    "from .registry import TrellisRegistry, latch_gate",
    "",
    '__all__ = ["TrellisRegistry", "latch_gate"]',
    "",
  ].join("\n"),

  "lib/trellisgate/registry.py": [
    "class TrellisRegistry:",
    "    def __init__(self):",
    "        self.rows = []",
    "",
    "    def latch(self, name):",
    "        self.rows.append(name)",
    "        return len(self.rows)",
    "",
    "",
    "def latch_gate(name):",
    "    return f\"trellisgate:{name}\"",
    "",
    "",
    "def gate_span():",
    "    return 2",
    "",
  ].join("\n"),

  // Mention-heavy, declares something else.
  "lib/trellisgate/report.py": [
    "def build_trellis_registry_report(rows):",
    "    TrellisRegistry_total = 0",
    "    for row in rows:",
    "        TrellisRegistry_total += 1",
    "    return {\"trellis_registry_total\": TrellisRegistry_total}",
    "",
  ].join("\n"),

  "lib/trellisgate/scan.py": [
    "from trellisgate.registry import TrellisRegistry, latch_gate",
    "",
    "def scan_trellis_latches(rows):",
    "    return [latch_gate(row) for row in rows]",
    "",
  ].join("\n"),

  // The SAME class and function name in a sibling package.
  "lib/vineyard/__init__.py": [
    "from .registry import TrellisRegistry, latch_gate",
    "",
    '__all__ = ["TrellisRegistry", "latch_gate"]',
    "",
  ].join("\n"),

  "lib/vineyard/registry.py": [
    "class TrellisRegistry:",
    "    def __init__(self):",
    "        self.rows = []",
    "",
    "    def latch(self, name):",
    "        self.rows.append(name.length)",
    "        return len(self.rows)",
    "",
    "",
    "def latch_gate(name):",
    "    return f\"vineyard:{name}\"",
    "",
    "",
    "def vine_reach():",
    "    return 6",
    "",
  ].join("\n"),

  "lib/vineyard/sweep.py": [
    "from vineyard.registry import TrellisRegistry, latch_gate",
    "",
    "def sweep_vineyard_latches(rows):",
    "    return [latch_gate(row) for row in rows]",
    "",
  ].join("\n"),

  // A TypeScript surface with its own spec -- the third test convention.
  "trellis/ui/panel.ts": [
    'import { TrellisRegistry } from "../../lib/trellisgate"',
    "",
    "export function renderTrellisPanel(name: string): string {",
    "  const registry = new TrellisRegistry()",
    "  return String(registry.latch(name) + registry.latch(name + \"-2\"))",
    "}",
    "",
  ].join("\n"),

  "trellis/ui/panel.spec.ts": [
    'import { renderTrellisPanel } from "./panel"',
    "",
    "export function testRenderTrellisPanelLatches() {",
    "  return renderTrellisPanel(\"t1\").length > 0",
    "}",
    "",
  ].join("\n"),

  // A Go sub-tree in the same repository.
  "trellis/internal/post/post.go": [
    "package post",
    "",
    "func Post(grams int) int { return grams + 4 }",
    "",
  ].join("\n"),

  "trellis/internal/post/post_test.go": [
    "package post",
    "",
    "func TestPostAddsFour(t *testing.T) {",
    "\tif Post(1) != 5 {",
    "\t\tt.Fatal(\"post\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "tests/test_trellisgate_registry.py": [
    "from trellisgate.registry import TrellisRegistry, latch_gate",
    "",
    "def test_trellis_registry_latch_gate_counts():",
    "    return TrellisRegistry().latch(\"t1\") == 1 and latch_gate(\"t1\")",
    "",
  ].join("\n"),

  "tests/test_vineyard_registry.py": [
    "from vineyard.registry import TrellisRegistry, latch_gate",
    "",
    "def test_trellis_registry_latch_gate_counts():",
    "    return TrellisRegistry().latch(\"v1\") == 1 and latch_gate(\"v1\")",
    "",
  ].join("\n"),
};

export const HOLDOUT_D_CLASSES = Object.freeze([
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

export const HOLDOUT_D_FAMILIES = Object.freeze([
  Object.freeze({ id: "d1-lantern", root: "d1", files: D1 }),
  Object.freeze({ id: "d2-marlin", root: "d2", files: D2 }),
  Object.freeze({ id: "d3-basalt", root: "d3", files: D3 }),
  Object.freeze({ id: "d4-cobalt", root: "d4", files: D4 }),
  Object.freeze({ id: "d5-trellis", root: "d5", files: D5 }),
])

export function holdoutDFiles(familyId) {
  const family = HOLDOUT_D_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown holdout D family: " + familyId)
  return Object.keys(family.files).sort()
}

export async function writeHoldoutDFamily(root, familyId) {
  const family = HOLDOUT_D_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown holdout D family: " + familyId)
  for (const relative of Object.keys(family.files).sort()) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, family.files[relative], "utf8")
  }
  return { familyId, files: Object.keys(family.files).length }
}
