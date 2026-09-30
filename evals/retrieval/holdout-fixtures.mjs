// FROZEN HOLDOUT FIXTURES (15.3 independent hardening audit, section A).
//
// These two families exist because the original 21-query retrieval set is no
// longer an independent holdout: the ranking was revised after its failures were
// observed. Nothing in `lib/repo-map.mjs` may be tuned in response to these
// fixtures, and the expected targets below were written from the design of the
// repositories, not from any ranking's output.
//
// The two families are deliberately structurally unlike each other AND unlike the
// original fixture:
//
//   family A  python services monorepo, snake_case, packages import by bare
//             module path, tests in a top-level tests/ directory, plus a
//             same-named symbol defined in two different services.
//   family B  flat single-package javascript app, camelCase, barrel index that
//             re-exports everything, a circular import pair, component-level
//             same-named symbols, and a file with many mentions of a symbol it
//             never declares.
//
// Both contain the two shapes that broke the original ranking during
// development: a symbol whose name is a substring of an unrelated longer symbol,
// and a barrel/module file that mentions a symbol many times without declaring
// it. A ranking that only works when the winner happens to be lexically obvious
// fails here.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const FAMILY_A = {
  "services/gateway/pyproject.toml": JSON.stringify({ name: "gateway", version: "1.0.0" }, null, 2) + "\n",

  "services/gateway/src/gateway/__init__.py": '"""gateway service."""\n',

  "services/gateway/src/gateway/router.py": [
    "from ledger.posting import post_entry",
    "from shared.telemetry import audit_span",
    "",
    "GATEWAY_ROUTES = (\"/entries\", \"/health\")",
    "",
    "def dispatch_route(path, payload):",
    "    audit_span(\"gateway.dispatch\", path)",
    "    return post_entry(payload)",
    "",
  ].join("\n"),

  "services/gateway/src/gateway/handlers.py": [
    "from gateway.router import dispatch_route",
    "from shared.telemetry import audit_span",
    "",
    "def handle_post_entry_request(request):",
    "    audit_span(\"gateway.handler\", request)",
    "    return dispatch_route(\"/entries\", request)",
    "",
  ].join("\n"),

  // Mentions post_entry five times and never defines it. The declaration lives
  // in services/ledger, so a mention-heavy file must not outrank it.
  "services/gateway/src/gateway/reports.py": [
    "from shared.telemetry import audit_span",
    "",
    "def build_post_entry_summary(rows):",
    "    total = 0",
    "    for row in rows:",
    "        total += row.get(\"post_entry_amount\", 0)",
    "    audit_span(\"gateway.report\", total)",
    "    return {\"post_entry_count\": len(rows), \"post_entry_total\": total}",
    "",
  ].join("\n"),

  "services/ledger/pyproject.toml": JSON.stringify({ name: "ledger", version: "1.0.0" }, null, 2) + "\n",

  "services/ledger/src/ledger/__init__.py": '"""ledger service."""\n',

  "services/ledger/src/ledger/posting.py": [
    "from ledger.entries import normalise_entry",
    "from shared.telemetry import audit_span",
    "",
    "class PostingRejected(Exception):",
    "    pass",
    "",
    "def post_entry(entry):",
    "    if not entry.get(\"amount\"):",
    "        raise PostingRejected(\"amount required\")",
    "    audit_span(\"ledger.post_entry\", entry)",
    "    return normalise_entry(entry)",
    "",
  ].join("\n"),

  "services/ledger/src/ledger/entries.py": [
    "def normalise_entry(entry):",
    "    return {\"amount\": round(float(entry[\"amount\"]), 2), \"currency\": entry.get(\"currency\", \"USD\")}",
    "",
    "def summarise_entries(entries):",
    "    return {\"count\": len(entries)}",
    "",
  ].join("\n"),

  // Same class name, different module, different behaviour. A query for
  // "PostingRejected" has two legitimate answers and the module context has to
  // break the tie.
  "services/ledger/src/ledger/posting_legacy.py": [
    "class PostingRejected(Exception):",
    "    pass",
    "",
    "def post_entry_legacy(entry):",
    "    return {\"amount\": entry.get(\"amount\", 0)}",
    "",
  ].join("\n"),

  "lib/shared/src/shared/__init__.py": '"""shared library."""\n',

  // Imported by nearly everything, so pure centrality would float it to the top
  // of every single query. It is never a correct answer.
  "lib/shared/src/shared/telemetry.py": [
    "_SPANS = []",
    "",
    "def audit_span(name, payload=None):",
    "    _SPANS.append((name, payload))",
    "    return {\"name\": name}",
    "",
    "def drain_spans():",
    "    out = list(_SPANS)",
    "    _SPANS.clear()",
    "    return out",
    "",
  ].join("\n"),

  "tests/test_posting.py": [
    "from ledger.posting import post_entry",
    "",
    "def test_post_entry_rejects_empty_amount():",
    "    return post_entry({\"amount\": 0}) is not None",
    "",
  ].join("\n"),

  "tests/test_router.py": [
    "from gateway.router import dispatch_route",
    "",
    "def test_dispatch_route_returns_entry():",
    "    return dispatch_route(\"/entries\", {\"amount\": 1}) is not None",
    "",
  ].join("\n"),

  "tests/test_normalise_entry.py": [
    "from ledger.entries import normalise_entry",
    "",
    "def test_normalise_entry_rounds_amount():",
    "    return normalise_entry({\"amount\": 1.005})[\"amount\"] == 1.0",
    "",
  ].join("\n"),
}

const FAMILY_B = {
  "package.json": JSON.stringify({ name: "holdout-flat-app", private: true, type: "module" }, null, 2) + "\n",

  // A barrel that re-exports every public symbol. It therefore MENTIONS most of
  // them many times while declaring none, and must never outrank a definition.
  "src/index.js": [
    "export { fetchLedger } from \"./api/client.js\";",
    "export { useLedger } from \"./hooks/useLedger.js\";",
    "export { renderLedgerTable } from \"./components/LedgerTable.js\";",
    "export { renderLedgerChart } from \"./components/LedgerChart.js\";",
    "export { formatAmount } from \"./utils/money.js\";",
    "export { readStore } from \"./core/store.js\";",
    "",
  ].join("\n"),

  "src/api/client.js": [
    'import { readStore } from "../core/store.js";',
    "",
    "export function fetchLedger(endpoint) {",
    "  const state = readStore();",
    "  return { endpoint, entries: state.ledger }",
    "}",
    "",
    "export function fetchLedgerLegacy(endpoint) {",
    "  return { endpoint, entries: [] }",
    "}",
    "",
  ].join("\n"),

  // Circular import pair: client <-> store.
  "src/core/store.js": [
    'import { fetchLedger } from "../api/client.js";',
    "",
    "const state = { ledger: [], hydrated: false };",
    "",
    "export function readStore() {",
    "  return state",
    "}",
    "",
    "export function hydrateStore() {",
    "  return fetchLedger(\"/ledger\")",
    "}",
    "",
  ].join("\n"),

  "src/hooks/useLedger.js": [
    'import { fetchLedger } from "../api/client.js";',
    "",
    "export function useLedger(intervalMs) {",
    "  return { data: fetchLedger(\"/ledger\"), intervalMs }",
    "}",
    "",
  ].join("\n"),

  "src/utils/money.js": [
    "export function formatAmount(cents) {",
    "  return (cents / 100).toFixed(2)",
    "}",
    "",
    "export function parseAmount(text) {",
    "  return Math.round(parseFloat(text) * 100)",
    "}",
    "",
  ].join("\n"),

  // formatAmount is declared here too. The two declarations are identical in
  // name, so only the file/module context can separate them.
  "src/components/LedgerTable.js": [
    'import { formatAmount } from "../utils/money.js";',
    "",
    "export function renderLedgerTable(entries) {",
    "  return entries.map((entry) => formatAmount(entry.cents)).join(\",\")",
    "}",
    "",
  ].join("\n"),

  "src/components/LedgerChart.js": [
    "export function formatAmount(value) {",
    "  return value.toFixed(0)",
    "}",
    "",
    "export function renderLedgerChart(entries) {",
    "  return entries.length",
    "}",
    "",
  ].join("\n"),

  // Mentions formatAmount four times, declares it zero times.
  "src/components/LedgerPanel.js": [
    'import { formatAmount } from "../utils/money.js";',
    "",
    "export function renderLedgerPanel(entries) {",
    "  const head = formatAmount(0);",
    "  const rows = entries.map((entry) => formatAmount(entry.cents));",
    "  return [head, ...rows].join(\" \")",
    "}",
    "",
  ].join("\n"),

  "src/legacy/client-legacy.js": [
    "export function fetchLedgerLegacyPage(page) {",
    "  return { page, rows: [] }",
    "}",
    "",
  ].join("\n"),

  "test/fetchLedger.test.js": [
    'import { fetchLedger } from "../src/api/client.js";',
    "",
    "export function testFetchLedgerReturnsEntries() {",
    "  return fetchLedger(\"/ledger\").entries !== null",
    "}",
    "",
  ].join("\n"),

  "test/formatAmount.test.js": [
    'import { formatAmount } from "../src/utils/money.js";',
    "",
    "export function testFormatAmountRoundsCents() {",
    "  return formatAmount(150) === \"1.50\"",
    "}",
    "",
  ].join("\n"),

  "test/renderLedgerTable.test.js": [
    'import { renderLedgerTable } from "../src/components/LedgerTable.js";',
    "",
    "export function testRenderLedgerTableJoins() {",
    "  return renderLedgerTable([{ cents: 100 }]) === \"1.00\"",
    "}",
    "",
  ].join("\n"),
}

export const HOLDOUT_FAMILIES = Object.freeze([
  Object.freeze({ id: "family-a-python-services", root: "family-a", files: FAMILY_A }),
  Object.freeze({ id: "family-b-flat-js-app", root: "family-b", files: FAMILY_B }),
])

export function holdoutFiles(familyId) {
  const family = HOLDOUT_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown holdout family: " + familyId)
  return Object.keys(family.files).sort()
}

export async function writeHoldoutFamily(root, familyId) {
  const family = HOLDOUT_FAMILIES.find((item) => item.id === familyId)
  if (!family) throw new Error("unknown holdout family: " + familyId)
  for (const relative of Object.keys(family.files).sort()) {
    const full = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, family.files[relative], "utf8")
  }
  return { familyId, files: Object.keys(family.files).length }
}
