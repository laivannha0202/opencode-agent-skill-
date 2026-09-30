// Deterministic retrieval fixture repository.
//
// Phase 3 has a release gate: graph-ranked repo map must not lower recall. That
// gate is only meaningful against a fixture whose correct answers are known in
// advance and never change, so this module writes an exact-content miniature
// monorepo. Every file is byte-stable across runs and platforms (LF only, no
// timestamps, no locale-dependent ordering) so a before/after comparison is a
// diff of scores, not of noise.
//
// The shape deliberately contains the failure modes that matter for ranking:
//   - one exact, unambiguous symbol target per domain;
//   - a lexical decoy that shares a stem with a real target (pricing);
//   - a high-centrality hotspot imported by many files but never a query answer;
//   - module-local symbols repeated across packages (so path locality matters);
//   - a per-domain test file that must rank near its source.

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const FILES = {
  "package.json": JSON.stringify({
    name: "ues-retrieval-fixture",
    private: true,
    type: "module",
    workspaces: ["packages/*", "apps/*"],
  }, null, 2) + "\n",

  "AGENTS.md": [
    "# Retrieval fixture",
    "",
    "Deterministic miniature monorepo used to gate UES repo-map ranking quality.",
    "",
  ].join("\n"),

  "packages/core/package.json": JSON.stringify({
    name: "@fixture/core", private: true, type: "module", exports: "./src/index.mjs",
  }, null, 2) + "\n",

  "packages/core/src/pricing.mjs": [
    "import { roundCurrency } from \"./utils/money.mjs\"",
    "",
    "export const BASE_TAX_RATE = 0.08",
    "",
    "export function calculateOrderTotal(items, discount) {",
    "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0)",
    "  return roundCurrency(subtotal * (1 - (discount || 0)))",
    "}",
    "",
    "export function applyPromotion(orderTotal, promotion) {",
    "  return roundCurrency(orderTotal * (1 - promotion.rate))",
    "}",
    "",
  ].join("\n"),

  "packages/core/src/inventory.mjs": [
    "export function reserveInventory(sku, quantity) {",
    "  return { sku, quantity, reserved: quantity > 0 }",
    "}",
    "",
    "export function releaseInventory(reservation) {",
    "  return { ...reservation, released: true }",
    "}",
    "",
  ].join("\n"),

  "packages/core/src/orders.mjs": [
    "import { calculateOrderTotal, applyPromotion } from \"./pricing.mjs\"",
    "import { reserveInventory } from \"./inventory.mjs\"",
    "import { auditTrail } from \"@fixture/shared\"",
    "",
    "export function placeOrder(cart, promotion) {",
    "  const total = applyPromotion(calculateOrderTotal(cart.items, cart.discount), promotion)",
    "  const reservation = reserveInventory(cart.sku, cart.quantity)",
    "  auditTrail(\"order.placed\", { total })",
    "  return { total, reservation }",
    "}",
    "",
  ].join("\n"),

  "packages/core/src/legacy/pricing-legacy.mjs": [
    "export function legacyPricingSheet(season) {",
    "  return { season, factor: 0.9 }",
    "}",
    "",
  ].join("\n"),

  "packages/core/src/utils/money.mjs": [
    "export function roundCurrency(value) {",
    "  return Math.round(value * 100) / 100",
    "}",
    "",
  ].join("\n"),

  "packages/core/src/index.mjs": [
    "export { calculateOrderTotal, applyPromotion } from \"./pricing.mjs\"",
    "export { placeOrder } from \"./orders.mjs\"",
    "export { reserveInventory } from \"./inventory.mjs\"",
    "",
  ].join("\n"),

  "packages/billing/package.json": JSON.stringify({
    name: "@fixture/billing", private: true, type: "module", exports: "./src/index.mjs",
  }, null, 2) + "\n",

  "packages/billing/src/tax.mjs": [
    "export function computeTaxRate(region) {",
    "  return region === \"EU\" ? 0.21 : 0.08",
    "}",
    "",
    "export function applyTax(amount, rate) {",
    "  return Math.round(amount * (1 + rate) * 100) / 100",
    "}",
    "",
  ].join("\n"),

  "packages/billing/src/invoice.mjs": [
    "import { computeTaxRate, applyTax } from \"./tax.mjs\"",
    "",
    "export function buildInvoiceSummary(order, region) {",
    "  const rate = computeTaxRate(region)",
    "  return { order, rate, due: applyTax(order.total, rate) }",
    "}",
    "",
  ].join("\n"),

  "packages/billing/src/refunds.mjs": [
    "import { buildInvoiceSummary } from \"./invoice.mjs\"",
    "",
    "export function refundInvoice(order, region) {",
    "  return { summary: buildInvoiceSummary(order, region), refunded: true }",
    "}",
    "",
  ].join("\n"),

  "packages/billing/src/index.mjs": [
    "export { buildInvoiceSummary } from \"./invoice.mjs\"",
    "export { computeTaxRate } from \"./tax.mjs\"",
    "",
  ].join("\n"),

  "packages/shared/package.json": JSON.stringify({
    name: "@fixture/shared", private: true, type: "module", exports: "./src/index.mjs",
  }, null, 2) + "\n",

  // Deliberate high-centrality decoy: many modules import it, so a purely
  // graph-centrality rank would float it to the top of every query. It is never
  // a correct answer for any fixture query.
  "packages/shared/src/telemetry.mjs": [
    "const counters = new Map()",
    "",
    "export function auditTrail(event, payload) {",
    "  counters.set(event, (counters.get(event) || 0) + 1)",
    "  return { event, payload, count: counters.get(event) }",
    "}",
    "",
    "export function telemetrySnapshot() {",
    "  return Object.fromEntries(counters.entries())",
    "}",
    "",
  ].join("\n"),

  "packages/shared/src/index.mjs": [
    "export { auditTrail, telemetrySnapshot } from \"./telemetry.mjs\"",
    "",
  ].join("\n"),

  "apps/api/package.json": JSON.stringify({
    name: "@fixture/api", private: true, type: "module", exports: "./src/index.mjs",
  }, null, 2) + "\n",

  "apps/api/src/checkout.mjs": [
    "import { placeOrder } from \"@fixture/core\"",
    "import { buildInvoiceSummary } from \"@fixture/billing\"",
    "import { auditTrail } from \"@fixture/shared\"",
    "",
    "export function checkout(cart, promotion, region) {",
    "  const order = placeOrder(cart, promotion)",
    "  auditTrail(\"checkout\", { total: order.total })",
    "  return { order, invoice: buildInvoiceSummary(order, region) }",
    "}",
    "",
  ].join("\n"),

  "apps/api/src/handlers.mjs": [
    "import { checkout } from \"./checkout.mjs\"",
    "",
    "export function handleCheckoutRequest(request) {",
    "  return checkout(request.cart, request.promotion, request.region)",
    "}",
    "",
  ].join("\n"),

  "apps/web/package.json": JSON.stringify({
    name: "@fixture/web", private: true, type: "module", exports: "./src/index.mjs",
  }, null, 2) + "\n",

  "apps/web/src/cart.mjs": [
    "import { handleCheckoutRequest } from \"@fixture/api/src/handlers.mjs\"",
    "",
    "export function submitCart(cart) {",
    "  return handleCheckoutRequest({ cart, promotion: { rate: 0 }, region: \"US\" })",
    "}",
    "",
  ].join("\n"),

  "test/pricing.test.mjs": [
    "import { calculateOrderTotal, applyPromotion } from \"../packages/core/src/pricing.mjs\"",
    "",
    "export function testCalculateOrderTotal() {",
    "  return calculateOrderTotal([{ price: 10, qty: 2 }], 0) === 20",
    "}",
    "",
    "export function testApplyPromotion() {",
    "  return applyPromotion(100, { rate: 0.1 }) === 90",
    "}",
    "",
  ].join("\n"),

  "test/orders.test.mjs": [
    "import { placeOrder } from \"../packages/core/src/orders.mjs\"",
    "",
    "export function testPlaceOrder() {",
    "  return placeOrder({ items: [], sku: \"x\", quantity: 1 }, { rate: 0 }).total === 0",
    "}",
    "",
  ].join("\n"),

  "test/invoice.test.mjs": [
    "import { buildInvoiceSummary } from \"../packages/billing/src/invoice.mjs\"",
    "",
    "export function testBuildInvoiceSummary() {",
    "  return buildInvoiceSummary({ total: 100 }, \"US\").due === 108",
    "}",
    "",
  ].join("\n"),

  "test/checkout.test.mjs": [
    "import { checkout } from \"../apps/api/src/checkout.mjs\"",
    "",
    "export function testCheckout() {",
    "  return checkout({ items: [], sku: \"x\", quantity: 0, discount: 0 }, { rate: 0 }, \"US\")",
    "}",
    "",
  ].join("\n"),
}

export const RETRIEVAL_FIXTURE_FILES = Object.freeze(
  Object.keys(FILES).sort().map((relative) => relative),
)

export async function writeRetrievalFixture(root) {
  for (const relative of RETRIEVAL_FIXTURE_FILES) {
    const absolute = path.join(root, ...relative.split("/"))
    await mkdir(path.dirname(absolute), { recursive: true })
    await writeFile(absolute, FILES[relative], "utf8")
  }
  return { root, files: RETRIEVAL_FIXTURE_FILES.length }
}
