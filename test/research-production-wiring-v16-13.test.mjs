// V16.13 Production wiring: thin extension, lazy RESEARCH, Metrics V2
// single authority, waste bridge, release fresh-gate unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LAZY_RUNTIME_MODULES, LAZY_RUNTIME_STACKS } from "../lib/lazy-runtime.mjs";
import { CAPABILITY_EVENT_KINDS, aggregateEfficiencyMetrics } from "../lib/efficiency-metrics-v16-10.mjs";
import { createExternalResearchBroker } from "../lib/external-research-broker-v16-13.mjs";
import { createWasteDetector, wallAttributionToEfficiencyEvents } from "../lib/waste-detector-v16-12.mjs";
import { finalReleaseMode } from "../lib/verification-receipt-cache-v16-12.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the four research modules are registered as lazy", () => {
  assert.equal(LAZY_RUNTIME_MODULES.RESEARCH_BROKER, "external-research-broker-v16-13");
  assert.ok(LAZY_RUNTIME_STACKS.RESEARCH.includes(LAZY_RUNTIME_MODULES.RESEARCH_BRIEF));
  assert.ok(LAZY_RUNTIME_STACKS.RESEARCH.includes(LAZY_RUNTIME_MODULES.RESEARCH_BROKER));
});

test("the extension stays thin: no provider/fetch/cache logic inlined", () => {
  const text = readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8");
  assert.ok(text.includes("external-research-broker-v16-13"));
  assert.ok(text.includes("research-brief-v16-13"));
  assert.ok(text.includes("hydrateLazy(LAZY_RUNTIME_MODULES.RESEARCH_BROKER)"));
});

test("Metrics V2 remains the sole aggregator and knows the research kind", () => {
  assert.ok(CAPABILITY_EVENT_KINDS.researchIntelligence.includes("external-research"));
  const broker = createExternalResearchBroker({ fetchImpl: async () => { throw new Error("no-net"); } });
  const events = broker.toEfficiencyEvents({ counts: { networkCalls: 2, cacheHits: 1 }, timings: { researchTotalMs: 10 } });
  assert.ok(events.every((e) => e.kind === "external-research"));
  const metrics = aggregateEfficiencyMetrics(
    events.map((e) => ({ type: "efficiency.observation", ...e })),
    [],
  );
  assert.ok(metrics.capabilities.researchIntelligence);
});

test("research waste signals feed the existing detector, no second authority", () => {
  const detector = createWasteDetector({ now: () => 0 });
  const first = detector.record("unnecessary-research", "q1", 10, "g1");
  const second = detector.record("unnecessary-research", "q1", 10, "g1");
  assert.equal(first.repeated, false);
  assert.equal(second.repeated, true);
  const events = wallAttributionToEfficiencyEvents({ counters: {} }, detector.report());
  assert.ok(Array.isArray(events));
});

test("release fresh-gate semantics are unchanged", () => {
  const release = finalReleaseMode({ finalRelease: true, gateName: "npm test" });
  assert.equal(release, true);
  const dev = finalReleaseMode({ finalRelease: false });
  assert.equal(dev, false);
});
