// DEV CORPUS fixtures (15.3 ranking repair, Phase 2).
//
// This is the TUNING corpus, and it is deliberately NOT the failed holdout.
//
// Constraints honoured here, because a tuning set built by peeking at failures
// teaches the ranking to pass tests rather than to rank:
//   - three structurally distinct families, none sharing a topology with the
//     failed holdout A families;
//   - no symbol or file name appears in both this corpus and holdout A;
//   - every family contains the hard shapes that broke the first ranking:
//     a barrel that re-exports, a diamond, a cycle, a test that imports a helper
//     instead of the source, an implementation reachable only through index,
//     one declaration faced with many mention-only files, identical symbol names
//     in separate packages, and source/test pairs with little lexical overlap.
//
// Every class has at least six examples so that a class-level regression cannot
// hide inside one or two lucky queries.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// ---------------------------------------------------------------------------
// Family D1 -- "forge": a Ruby-ish/Python-ish service mesh, snake_case, deep
// module paths, and one file per concept. No packages/ layout, no barrel.
// ---------------------------------------------------------------------------
const D1 = {
  "tools/forgectl.py": 'import os\nimport sys\n\nVERSION = "3.4.1"\n\ndef main(argv):\n    return 0\n',

  "forge/forgeutil.py": '"""Shared helpers for the forge services."""\n',

  "forge/forgeutil/signature.py": [
    "import hashlib",
    "",
    "def sign_payload(payload, secret):",
    "    return hashlib.sha256((secret + str(payload)).encode()).hexdigest()",
    "",
    "def verify_signature(payload, secret, digest):",
    "    return sign_payload(payload, secret) == digest",
    "",
  ].join("\n"),

  "forge/forgeutil/clock.py": [
    "import time",
    "",
    "def now_epoch():",
    "    return int(time.time())",
    "",
    "def elapsed_since(mark):",
    "    return now_epoch() - mark",
    "",
  ].join("\n"),

  // The declaration, reachable only through the package __init__ barrel.
  "forge/forgeutil/__init__.py": [
    "from .signature import sign_payload, verify_signature",
    "from .clock import now_epoch, elapsed_since",
    "",
    "__all__ = [\"sign_payload\", \"verify_signature\", \"now_epoch\", \"elapsed_since\"]",
    "",
  ].join("\n"),

  "forge/vault/seal.py": [
    "from forge.forgeutil import sign_payload",
    "from forge.forgeutil.clock import now_epoch",
    "",
    "class SealCorrupt(Exception):",
    "    pass",
    "",
    "def seal_vault(recipe, secret):",
    "    stamp = now_epoch()",
    "    return {\"recipe\": recipe, \"stamp\": stamp, \"sig\": sign_payload(recipe, secret)}",
    "",
    "def unseal_vault(sealed, secret):",
    "    if \"sig\" not in sealed:",
    "        raise SealCorrupt(\"missing signature\")",
    "    return sealed[\"recipe\"]",
    "",
  ].join("\n"),

  // Mentions seal_vault eight times and never defines it.
  "forge/vault/report.py": [
    "from forge.forgeutil.clock import now_epoch",
    "",
    "def build_seal_vault_rollup(rows):",
    "    seal_vault_count = 0",
    "    for row in rows:",
    "        seal_vault_count += 1",
    "    return {\"seal_vault_total\": seal_vault_count, \"seal_vault_at\": now_epoch()}",
    "",
  ].join("\n"),

  "forge/vault/rotate.py": [
    "from forge.vault.seal import seal_vault, unseal_vault",
    "",
    "def rotate_vault_seal(sealed, secret):",
    "    return seal_vault(unseal_vault(sealed, secret), secret)",
    "",
  ].join("\n"),

  "forge/quench/schedule.py": [
    "from forge.vault.rotate import rotate_vault_seal",
    "from forge.forgeutil.clock import elapsed_since",
    "",
    "def schedule_quench(plan, secret):",
    "    started = 0",
    "    return {\"plan\": plan, \"quench\": rotate_vault_seal(plan, secret), \"ran_for\": elapsed_since(started)}",
    "",
  ].join("\n"),

  "forge/quench/worker.py": [
    "from forge.quench.schedule import schedule_quench",
    "",
    "def run_quench_worker(plan, secret):",
    "    return schedule_quench(plan, secret)",
    "",
  ].join("\n"),

  "forge/telemetry/spans.py": [
    "SPANS = []",
    "",
    "def record_span(name, payload):",
    "    SPANS.append((name, payload))",
    "    return len(SPANS)",
    "",
    "def span_count():",
    "    return len(SPANS)",
    "",
  ].join("\n"),

  "forge/telemetry/counter.py": [
    "from forge.telemetry.spans import record_span",
    "",
    "def bump_counter(name, by=1):",
    "    record_span(\"counter\", {\"name\": name, \"by\": by})",
    "    return by",
    "",
  ].join("\n"),

  // Tests deliberately do NOT import the source directly; they go via the barrel.
  "specs/test_vault_seal.py": [
    "from forge.forgeutil import sign_payload",
    "from forge.vault.seal import seal_vault, unseal_vault",
    "",
    "def test_seal_vault_roundtrip():",
    "    return unseal_vault(seal_vault({\"a\": 1}, \"k\"), \"k\") == {\"a\": 1}",
    "",
  ].join("\n"),

  "specs/test_quench_schedule.py": [
    "from forge.quench.schedule import schedule_quench",
    "",
    "def test_schedule_quench_builds_plan():",
    "    return schedule_quench({\"p\": 1}, \"k\") is not None",
    "",
  ].join("\n"),

  "specs/test_forgeutil_signature.py": [
    "from forge.forgeutil.signature import sign_payload",
    "",
    "def test_sign_payload_is_stable():",
    "    return sign_payload(1, \"k\") == sign_payload(1, \"k\")",
    "",
  ].join("\n"),

  "specs/helpers/digest.py": 'from forge.forgeutil.signature import sign_payload\n\n\ndef digest_of(value):\n    return sign_payload(value, "spec")\n',
};

// ---------------------------------------------------------------------------
// Family D2 -- "loom": a TypeScript workspace with a diamond, a cycle, and
// identical symbol names in two separate packages.
// ---------------------------------------------------------------------------
const D2 = {
  "package.json": JSON.stringify({ name: "loom-workspace", private: true, type: "module", workspaces: ["packages/*", "apps/*"] }, null, 2) + "\n",

  // DIAMOND: weave -> both threads, and both threads -> spool. Nothing else.
  "packages/spool/src/index.ts": [
    "export interface Thread { id: string }",
    "",
    "export function windSpool(thread: Thread): number {",
    "  return thread.id.length",
    "}",
    "",
  ].join("\n"),

  "packages/warp/src/index.ts": [
    'import { windSpool, type Thread } from "@loom/spool";',
    "",
    "export function warpThread(thread: Thread): number {",
    "  return windSpool(thread) * 2",
    "}",
    "",
  ].join("\n"),

  "packages/weft/src/index.ts": [
    'import { windSpool, type Thread } from "@loom/spool";',
    "",
    "export function weftThread(thread: Thread): number {",
    "  return windSpool(thread) + 1",
    "}",
    "",
  ].join("\n"),

  "packages/weave/src/index.ts": [
    'import { warpThread } from "@loom/warp";',
    'import { weftThread } from "@loom/weft";',
    'import type { Thread } from "@loom/spool";',
    "",
    "export function weaveCloth(thread: Thread): number {",
    "  return warpThread(thread) + weftThread(thread)",
    "}",
    "",
  ].join("\n"),

  // CYCLE: shuttle -> bobbin -> shuttle.
  "packages/bobbin/src/index.ts": [
    "export function bobbinTurns(count: number): number {",
    "  return count + 1",
    "}",
    "",
  ].join("\n"),

  "packages/shuttle/src/index.ts": [
    'import { bobbinTurns } from "@loom/bobbin";',
    "",
    "export function flyShuttle(loops: number): number {",
    "  return bobbinTurns(loops)",
    "}",
    "",
  ].join("\n"),

  "packages/tension/src/index.ts": [
    'import { flyShuttle } from "@loom/shuttle";',
    "",
    "export function applyTension(loops: number): number {",
    "  return flyShuttle(loops) * 3",
    "}",
    "",
  ].join("\n"),

  // The same class and method name in two separate packages: a local `selvedge`
  // in loom-edge and a different one in loom-hem.
  "packages/edge/src/selvedge.ts": [
    "export class Selvedge {",
    "  constructor(private readonly stitch: number) {}",
    "  get Stitch() { return this.stitch }",
    "}",
    "",
  ].join("\n"),

  "packages/hem/src/selvedge.ts": [
    "export class Selvedge {",
    "  constructor(private readonly weave: string) {}",
    "  get Weave() { return this.weave }",
    "}",
    "",
  ].join("\n"),

  "packages/loomkit/src/index.ts": [
    'export { Selvedge } from "@loom/edge/src/selvedge";',
    "",
  ].join("\n"),

  "apps/studio/src/view.ts": [
    'import { weaveCloth } from "@loom/weave";',
    'import { Selvedge } from "@loom/edge/src/selvedge";',
    "",
    "export function renderStudioView(thread: { id: string }): string {",
    "  const edge = new Selvedge(weaveCloth(thread))",
    "  return String(edge.Stitch)",
    "}",
    "",
  ].join("\n"),

  // Mentions weaveCloth six times, defines nothing.
  "apps/studio/src/legend.ts": [
    "",
    "export function buildStudioLegend(weaveCloth: (t: { id: string }) => number): string[] {",
    "  return [",
    "    String(weaveCloth({ id: \"a\" })),",
    "    String(weaveCloth({ id: \"b\" })),",
    "    String(weaveCloth({ id: \"c\" })),",
    "  ]",
    "}",
    "",
  ].join("\n"),

  "apps/studio/src/manifest.ts": [
    'import { renderStudioView } from "./view";',
    "",
    "export function studioManifest(thread: { id: string }): string {",
    "  return renderStudioView(thread)",
    "}",
    "",
  ].join("\n"),

  "packages/tension/test/tension.spec.ts": [
    'import { applyTension } from "@loom/tension";',
    "",
    "export function testApplyTensionScales() {",
    "  return applyTension(2) === 9",
    "}",
    "",
  ].join("\n"),

  "packages/spool/test/spool.spec.ts": [
    'import { windSpool } from "@loom/spool";',
    "",
    "export function testWindSpoolUsesIdLength() {",
    "  return windSpool({ id: \"abc\" }) === 3",
    "}",
    "",
  ].join("\n"),

  "packages/edge/test/selvedge.spec.ts": [
    'import { Selvedge } from "@loom/edge/src/selvedge";',
    "",
    "export function testSelvedgeStitch() {",
    "  return new Selvedge(4).Stitch === 4",
    "}",
    "",
  ].join("\n"),

  "apps/studio/test/view.spec.ts": [
    'import { renderStudioView } from "../src/view";',
    "",
    "export function testRenderStudioView() {",
    "  return typeof renderStudioView({ id: \"xy\" }) === \"string\"",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family D3 -- "kiln": a Go-shaped flat tree, package-per-directory, no
// barrels at all, and hot utility files that are imported by nearly everything.
// ---------------------------------------------------------------------------
const D3 = {
  "go.mod": "module kiln\n\ngo 1.22\n",

  "cmd/kiln/main.go": 'package main\n\nimport "kiln/internal/smelt"\n\nfunc main() { _ = smelt.Smelt(1) }\n',

  "internal/trace/trace.go": [
    "package trace",
    "",
    "var events []string",
    "",
    "func Mark(name string) {",
    "\tevents = append(events, name)",
    "}",
    "",
    "func Depth() int { return len(events) }",
    "",
  ].join("\n"),

  "internal/trace/trace_test.go": [
    "package trace",
    "",
    "func TestMarkIncreasesDepth(t *testing.T) {",
    "\tbefore := Depth()",
    "\tMark(\"x\")",
    "\tif Depth() != before+1 {",
    "\t\tt.Fatal(\"depth\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/smelt/smelt.go": [
    "package smelt",
    "",
    "import \"kiln/internal/trace\"",
    "",
    "func Smelt(grams int) float64 {",
    "\ttrace.Mark(\"smelt\")",
    "\treturn float64(grams) * 0.5",
    "}",
    "",
  ].join("\n"),

  "internal/smelt/smelt_test.go": [
    "package smelt",
    "",
    "func TestSmeltHalvesGrams(t *testing.T) {",
    "\tif Smelt(4) != 2 {",
    "\t\tt.Fatal(\"smelt\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/glaze/glaze.go": [
    "package glaze",
    "",
    "import \"kiln/internal/smelt\"",
    "",
    "func Glaze(grams int) float64 {",
    "\treturn smelt.Smelt(grams) + 1",
    "}",
    "",
  ].join("\n"),

  "internal/glaze/glaze_test.go": [
    "package glaze",
    "",
    "func TestGlazeAddsOne(t *testing.T) {",
    "\tif Glaze(2) != 2 {",
    "\t\tt.Fatal(\"glaze\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/enamel/enamel.go": [
    "package enamel",
    "",
    "import \"kiln/internal/glaze\"",
    "",
    "func Enamel(grams int) float64 {",
    "\treturn glaze.Glaze(grams) * 2",
    "}",
    "",
  ].join("\n"),

  "internal/enamel/enamel_test.go": [
    "package enamel",
    "",
    "func TestEnamelDoubles(t *testing.T) {",
    "\tif Enamel(2) != 4 {",
    "\t\tt.Fatal(\"enamel\")",
    "}",
    "}",
    "",
  ].join("\n"),

  "internal/fire/fire.go": [
    "package fire",
    "",
    "import (",
    "\t\"kiln/internal/enamel\"",
    "\t\"kiln/internal/smelt\"",
    ")",
    "",
    "func Fire(grams int) float64 {",
    "\treturn enamel.Enamel(grams) - smelt.Smelt(grams)",
    "}",
    "",
  ].join("\n"),

  "internal/fire/fire_test.go": [
    "package fire",
    "",
    "func TestFireIsNonNegative(t *testing.T) {",
    "\tif Fire(2) < 0 {",
    "\t\tt.Fatal(\"fire\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  // Same function name in two packages: glaze.SetPoint and cure.SetPoint.
  "internal/glaze/point.go": [
    "package glaze",
    "",
    "func SetPoint(value int) int { return value + 1 }",
    "",
  ].join("\n"),

  "internal/cure/point.go": [
    "package cure",
    "",
    "func SetPoint(value int) int { return value * 3 }",
    "",
  ].join("\n"),

  "internal/cure/cure.go": [
    "package cure",
    "",
    "import \"kiln/internal/trace\"",
    "",
    "func Cure(grams int) float64 {",
    "\ttrace.Mark(\"cure\")",
    "\treturn float64(grams) / 2",
    "}",
    "",
  ].join("\n"),

  "internal/cure/cure_test.go": [
    "package cure",
    "",
    "func TestCureHalvesGrams(t *testing.T) {",
    "\tif Cure(4) != 2 {",
    "\t\tt.Fatal(\"cure\")",
    "\t}",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family D4 -- "quayworks": a TypeScript monorepo whose whole point is the
// three STRUCTURAL failure classes the 15.3 repair targets, in a topology that
// shares no symbol, no package name and no path with D1-D3:
//
//   * one symbol declared in two sibling packages under a shared parent
//     directory, disambiguated only by a module-qualified query;
//   * a test function whose name restates the production subject, in a test file
//     whose stem is IDENTICAL to the source file's stem, repeated by a SECOND
//     test file in the same module;
//   * an explicit path query, including a path query that names a test.
// ---------------------------------------------------------------------------
const D4 = {
  "package.json": JSON.stringify({
    name: "quayworks-workspace",
    private: true,
    type: "module",
    workspaces: ["platform/*", "apps/*"],
  }, null, 2) + "\n",

  // --- platform/ferry: the subject of the non-test queries ----------------
  "platform/ferry/src/registry.ts": [
    "export class BerthLedger {",
    "  private readonly entries: string[] = []",
    "  register(name: string): number {",
    "    this.entries.push(name)",
    "    return this.entries.length",
    "  }",
    "}",
    "",
    "export function logArrival(berth: string): string {",
    "  return `arrival:${berth}`",
    "}",
    "",
    "export function mooringLine(berth: string): string {",
    "  return `line:${berth}`",
    "}",
    "",
  ].join("\n"),

  "platform/ferry/src/telemetry.ts": [
    "const events: string[] = []",
    "",
    "export function recordEvent(name: string): number {",
    "  events.push(name)",
    "  return events.length",
    "}",
    "",
    "export function eventCount(): number {",
    "  return events.length",
    "}",
    "",
  ].join("\n"),

  // A barrel that re-exports the platform entry point.
  "platform/ferry/src/index.ts": [
    'export { BerthLedger, logArrival, mooringLine } from "./registry"',
    'export { recordEvent, eventCount } from "./telemetry"',
    "",
  ].join("\n"),

  // --- platform/trawler: the SAME symbols, a different package ------------
  "platform/trawler/src/registry.ts": [
    "export class BerthLedger {",
    "  private readonly holds: number[] = []",
    "  register(name: string): number {",
    "    this.holds.push(name.length)",
    "    return this.holds.length",
    "  }",
    "}",
    "",
    "export function logArrival(berth: string): string {",
    "  return `trawl:${berth}`",
    "}",
    "",
    "export function trawlDepth(berth: string): number {",
    "  return berth.length",
    "}",
    "",
  ].join("\n"),

  "platform/trawler/src/index.ts": [
    'export { BerthLedger, logArrival, trawlDepth } from "./registry"',
    "",
  ].join("\n"),

  // --- apps/gate: depends on BOTH platforms, and mentions a lot ----------
  "apps/gate/src/panel.ts": [
    'import { BerthLedger as FerryLedger } from "@quayworks/ferry"',
    'import { BerthLedger as TrawlerLedger } from "@quayworks/trawler"',
    "",
    "export function renderGatePanel(berth: string): string {",
    "  const ferry = new FerryLedger()",
    "  const trawler = new TrawlerLedger()",
    "  return [ferry.register(berth), trawler.register(berth)].join(\"/\")",
    "}",
    "",
  ].join("\n"),

  "apps/gate/src/index.ts": [
    'import { renderGatePanel } from "./panel"',
    'import { recordEvent } from "@quayworks/ferry"',
    "",
    "export function gateDispatch(berth: string): string {",
    "  recordEvent(\"gate\")",
    "  return renderGatePanel(berth)",
    "}",
    "",
  ].join("\n"),

  // A high-centrality file that is never the answer to anything.
  "apps/gate/src/audit.ts": [
    'import { recordEvent } from "@quayworks/ferry"',
    "",
    "export function gateAudit(event: string): number {",
    "  return recordEvent(event)",
    "}",
    "",
  ].join("\n"),

  // --- the tests. Test stem == source stem, and the test function name
  //     restates the production subject. A second test file repeats it.
  "platform/ferry/test/registry.spec.ts": [
    'import { BerthLedger, logArrival } from "../src/index"',
    "",
    "export function testBerthLedgerLogArrivalCounts() {",
    "  return new BerthLedger().register(\"a1\") === 1 && logArrival(\"a1\").length > 0",
    "}",
    "",
  ].join("\n"),

  "platform/ferry/test/registry-extra.spec.ts": [
    'import { BerthLedger } from "../src/index"',
    "",
    "export function testBerthLedgerLogArrivalCounts() {",
    "  return new BerthLedger().register(\"a2\") === 1",
    "}",
    "",
  ].join("\n"),

  "platform/trawler/test/registry.spec.ts": [
    'import { BerthLedger, logArrival } from "../src/index"',
    "",
    "export function testBerthLedgerLogArrivalCounts() {",
    "  return new BerthLedger().register(\"t1\") === 1 && logArrival(\"t1\").length > 0",
    "}",
    "",
  ].join("\n"),

  // Explicit-path subject: a test whose stem matches nothing in the source tree.
  "apps/gate/test/panel.spec.ts": [
    'import { renderGatePanel } from "../src/panel"',
    "",
    "export function testRenderGatePanel() {",
    "  return renderGatePanel(\"g1\").includes(\"/\")",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family D5 -- "orchard": a Python service tree under src/, with package
// barrels, two packages declaring the same class, and a Go sub-package tree
// that exercises the module-root rule in a second language.
//
// It also carries the Windows-separator and explicit-path shapes: the same
// module named with a backslash must resolve exactly like the slash form.
// ---------------------------------------------------------------------------
const D5 = {
  "pyproject.toml": '[project]\nname = "orchard"\nversion = "0.1.0"\n',

  "src/ledgerfarm/__init__.py": [
    "from .registry import OrchardLedger, log_pick",
    "",
    '__all__ = ["OrchardLedger", "log_pick"]',
    "",
  ].join("\n"),

  "src/ledgerfarm/registry.py": [
    "class OrchardLedger:",
    "    def __init__(self):",
    "        self.entries = []",
    "",
    "    def log_pick(self, crate):",
    "        self.entries.append(crate)",
    "        return len(self.entries)",
    "",
    "",
    "def log_pick(crate):",
    "    return f\"pick:{crate}\"",
    "",
    "",
    "def crate_label(crate):",
    "    return f\"label:{crate}\"",
    "",
  ].join("\n"),

  "src/picklejar/__init__.py": [
    "from .registry import OrchardLedger, log_pick",
    "",
    '__all__ = ["OrchardLedger", "log_pick"]',
    "",
  ].join("\n"),

  "src/picklejar/registry.py": [
    "class OrchardLedger:",
    "    def __init__(self):",
    "        self.jars = []",
    "",
    "    def log_pick(self, crate):",
    "        self.jars.append(crate)",
    "        return len(self.jars)",
    "",
    "",
    "def log_pick(crate):",
    "    return f\"jar:{crate}\"",
    "",
    "",
    "def jar_seal(crate):",
    "    return f\"seal:{crate}\"",
    "",
  ].join("\n"),

  // Mentions OrchardLedger repeatedly and declares something else.
  "src/picklejar/report.py": [
    "from src.ledgerfarm import OrchardLedger",
    "",
    "def build_orchard_ledger_report(rows):",
    "    OrchardLedger_count = 0",
    "    for row in rows:",
    "        OrchardLedger_count += 1",
    "    return {\"orchard_ledger_total\": OrchardLedger_count}",
    "",
  ].join("\n"),

  "src/picklejar/ferment.py": [
    "from src.picklejar.registry import OrchardLedger, log_pick",
    "",
    "def ferment_crate(crate):",
    "    return {\"jar\": OrchardLedger().log_pick(crate), \"pick\": log_pick(crate)}",
    "",
  ].join("\n"),

  "tests/test_picklejar_registry.py": [
    "from src.picklejar import OrchardLedger, log_pick",
    "",
    "def test_orchard_ledger_log_pick_counts():",
    "    return OrchardLedger().log_pick(\"p1\") == 1 and log_pick(\"p1\")",
    "",
  ].join("\n"),

  "tests/test_ledgerfarm_registry.py": [
    "from src.ledgerfarm import OrchardLedger, log_pick",
    "",
    "def test_orchard_ledger_log_pick_counts():",
    "    return OrchardLedger().log_pick(\"l1\") == 1 and log_pick(\"l1\")",
    "",
  ].join("\n"),

  "go.mod": "module orchard\n\ngo 1.22\n",

  "internal/cellar/cellar.go": [
    "package cellar",
    "",
    "func Cell(grams int) int { return grams / 2 }",
    "",
  ].join("\n"),

  "internal/press/press.go": [
    "package press",
    "",
    "import \"orchard/internal/cellar\"",
    "",
    "func Press(grams int) int { return cellar.Cell(grams) + 1 }",
    "",
  ].join("\n"),

  "internal/press/press_test.go": [
    "package press",
    "",
    "func TestPressAddsOne(t *testing.T) {",
    "\tif Press(4) != 3 {",
    "\t\tt.Fatal(\"press\")",
    "\t}",
    "}",
    "",
  ].join("\n"),

  "internal/press/press_extra_test.go": [
    "package press",
    "",
    "func TestPressAddsOne(t *testing.T) {",
    "\tif Press(2) != 2 {",
    "\t\tt.Fatal(\"press\")",
    "\t}",
    "}",
    "",
  ].join("\n"),
};

// ---------------------------------------------------------------------------
// Family D6 -- "decks": a Python project whose package root sits BELOW the
// workspace root, with sibling packages named by a grouping directory.
//
// It carries the two defects that Holdout C's construction exposed, reproduced
// here on the tuning corpus with different names:
//
//   * a grouping directory (`decks/`) that holds only directories is itself the
//     evidence that its children are modules -- with no manifest anywhere;
//   * a dotted specifier that is relative to the PROJECT root
//     (`from keel.ledger import ...`) must resolve to a local edge, or the
//     importer is discarded as an external dependency and the cross-module
//     class quietly becomes empty.
// ---------------------------------------------------------------------------
const D6 = {
  "pyproject.toml": '[project]\nname = "decks"\nversion = "2.1.0"\n',

  "decks/keel/__init__.py": [
    "from .ledger import BilgeLedger, note_trim",
    "",
    '__all__ = ["BilgeLedger", "note_trim"]',
    "",
  ].join("\n"),

  "decks/keel/ledger.py": [
    "class BilgeLedger:",
    "    def __init__(self):",
    "        self.entries = []",
    "",
    "    def note_trim(self, plank):",
    "        self.entries.append(plank)",
    "        return len(self.entries)",
    "",
    "",
    "def note_trim(plank):",
    "    return f\"trim:{plank}\"",
    "",
    "",
    "def keel_draft(plank):",
    "    return f\"draft:{plank}\"",
    "",
  ].join("\n"),

  "decks/keel/survey.py": [
    "from keel.ledger import BilgeLedger, note_trim",
    "",
    "def build_keel_survey(rows):",
    "    return [note_trim(row) for row in rows]",
    "",
  ].join("\n"),

  // Mentions note_trim many times and declares something else.
  "decks/keel/manifest.py": [
    "def build_keel_manifest(rows):",
    "    note_trim_total = 0",
    "    for row in rows:",
    "        note_trim_total += 1",
    "    return {\"keel_note_trim_total\": note_trim_total}",
    "",
  ].join("\n"),

  "decks/bow/__init__.py": [
    "from .ledger import BilgeLedger, note_trim",
    "",
    '__all__ = ["BilgeLedger", "note_trim"]',
    "",
  ].join("\n"),

  "decks/bow/ledger.py": [
    "class BilgeLedger:",
    "    def __init__(self):",
    "        self.entries = []",
    "",
    "    def note_trim(self, plank):",
    "        self.entries.append(plank)",
    "        return len(self.entries)",
    "",
    "",
    "def note_trim(plank):",
    "    return f\"bow:{plank}\"",
    "",
    "",
    "def bow_reach(plank):",
    "    return f\"reach:{plank}\"",
    "",
  ].join("\n"),

  "decks/bow/sweep.py": [
    "from bow.ledger import BilgeLedger, note_trim",
    "",
    "def sweep_bow_deck(rows):",
    "    return [note_trim(row) for row in rows]",
    "",
  ].join("\n"),

  "decks/bow/workshop.py": [
    "from keel.ledger import BilgeLedger as KeelLedger",
    "from bow.ledger import BilgeLedger as BowLedger",
    "",
    "def build_bow_workshop(plank):",
    "    return [KeelLedger().note_trim(plank), BowLedger().note_trim(plank)]",
    "",
  ].join("\n"),

  "decks/keel/tests/test_ledger.py": [
    "from keel.ledger import BilgeLedger, note_trim",
    "",
    "def test_bilge_ledger_note_trim_counts_every_trim():",
    "    return BilgeLedger().note_trim(\"k1\") == 1 and note_trim(\"k1\")",
    "",
  ].join("\n"),

  "decks/bow/tests/test_ledger.py": [
    "from bow.ledger import BilgeLedger, note_trim",
    "",
    "def test_bow_ledger_note_trim_counts():",
    "    return BilgeLedger().note_trim(\"b1\") == 1 and note_trim(\"b1\")",
    "",
  ].join("\n"),
};

export const DEV_FAMILIES = Object.freeze([
  Object.freeze({ id: "dev-d1-forge", root: "dev-d1", files: D1 }),
  Object.freeze({ id: "dev-d2-loom", root: "dev-d2", files: D2 }),
  Object.freeze({ id: "dev-d3-kiln", root: "dev-d3", files: D3 }),
  Object.freeze({ id: "dev-d4-quayworks", root: "dev-d4", files: D4 }),
  Object.freeze({ id: "dev-d5-orchard", root: "dev-d5", files: D5 }),
  Object.freeze({ id: "dev-d6-decks", root: "dev-d6", files: D6 }),
])

export const DEV_CLASSES = Object.freeze([
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

export function devFiles(familyId) {
  const family = DEV_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown dev family: " + familyId)
  return Object.keys(family.files).sort()
}

export async function writeDevFamily(root, familyId) {
  const family = DEV_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown dev family: " + familyId)
  for (const relative of Object.keys(family.files).sort()) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, family.files[relative], "utf8")
  }
  return { familyId, files: Object.keys(family.files).length }
}
