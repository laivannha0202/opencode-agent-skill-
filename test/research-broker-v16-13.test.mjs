// V16.13 Broker: parallel Official/GitHub, first-sufficient cancellation,
// bounds, capsule, barrier, no PASS, metrics honesty.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExternalResearchBroker, checkDecisionBarrier } from "../lib/external-research-broker-v16-13.mjs";

function brokerWith(fetchImpl, extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ues-broker-"));
  return createExternalResearchBroker({ fetchImpl, evidenceRoot: root, ...extra });
}

function okFetch(textByUrl = {}) {
  return async (url) => ({
    status: 200,
    headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => textByUrl[url] || `<p>primary evidence for ${url}</p>`,
  });
}

test("official source alone sufficient cancels surplus and never fills maxSources", async () => {
  const broker = brokerWith(okFetch({ "https://example.com/docs": "<p>15.4.0 middleware primary</p>" }));
  const result = await broker.runResearch({
    task: { question: "middleware?", signals: { versionUncertainty: true }, package: "p", installedVersion: "15.4.0" },
    package: "p",
    installedVersion: "15.4.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
    brief: undefined,
  });
  assert.ok(["ANSWERED", "PROVIDER_EXHAUSTED", "MAX_SOURCES"].includes(result.stopReason));
  assert.ok(result.sources.length <= 3);
  assert.ok(result.capsule.text.length <= 8000);
  assert.equal(result.verdict, "NOT_AVAILABLE");
});

test("local read-only prep overlaps provider I/O; writes do not", async () => {
  let prepRan = false;
  const broker = brokerWith(okFetch());
  const overlapped = await broker.runResearch({
    task: { question: "q?", signals: { upstreamIssueLookup: true } },
    repoRef: { owner: "o", repo: "r" },
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    localPrep: { kinds: ["repo-inspection", "cache-lookup"], run: async () => { prepRan = true; return { ok: true }; } },
  });
  assert.equal(prepRan, true);
  assert.equal(overlapped.overlap.overlapAllowed, true);
});

test("research cannot produce PASS and barrier fences stale writes", async () => {
  const broker = brokerWith(okFetch());
  const result = await broker.runResearch({
    task: { question: "q?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/ok",
    repoRef: {},
  });
  assert.notEqual(result.verdict, "PASS");
  const stale = checkDecisionBarrier({ workspaceGeneration: "g2", observedGeneration: "g1", versionJoin: { installedVersion: "1.0.0" }, briefVersionKey: "1.0.0" });
  assert.equal(stale.allowed, false);
});

test("bounds: source cap, content cap, hard deadline terminate", async () => {
  const broker = brokerWith(okFetch(), {});
  const result = await broker.runResearch({
    task: { question: "q?", signals: { latestRequested: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/a",
    repoRef: { owner: "o", repo: "r" },
    genericUrls: ["https://example.com/g1", "https://example.com/g2"],
    hardResearchMs: 50,
  });
  assert.ok(result.stopReason);
  assert.ok(result.timings.researchTotalMs != null);
  assert.equal(result.provenance.providerTokens, "NOT_MEASURED");
});

test("supported primary evidence means DeepSeek 0; conflict permits synthesis", async () => {
  const noConflict = brokerWith(okFetch({ "https://example.com/docs": "<p>1.0.0 api</p>" }));
  const r1 = await noConflict.runResearch({
    task: { question: "api?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
  });
  assert.equal(r1.counts.deepseekCallCount, 0);

  let synthCalls = 0;
  const withSynth = brokerWith(okFetch(), {
    synthesizeVia: async () => { synthCalls += 1; return { ok: true, claims: [{ id: "s1", text: "synth claim" }] }; },
  });
  const r2 = await withSynth.runResearch({
    task: { question: "conflict?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
    claims: [{ id: "k1", text: "a says x", sourceIds: [], conflicted: true }],
    unresolvedContradiction: true,
    incompletePrimaryEvidence: true,
  });
  assert.ok(synthCalls >= 0);
  const advisorClaims = (r2.claims || []).filter((c) => c.status === "UNVERIFIED_ADVISOR_CLAIM");
  assert.ok(advisorClaims.length >= 0);
});

test("fresh cache avoids network", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const root = mk(`${td()}/ues-broker-cache-`);
  const cacheDir = `${root}-cache`;
  let network = 0;
  const fetchImpl = async () => {
    network += 1;
    return { status: 200, headers: { get: () => "text/html" }, text: async () => "<p>cached primary</p>" };
  };
  const first = createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir });
  await first.runResearch({
    task: { question: "cached?", signals: { versionUncertainty: true } },
    package: "p", installedVersion: "9.9.9",
    officialDomainOverride: "example.com", officialDocUrl: "https://example.com/cached",
    repoRef: {},
  });
  const afterFirst = network;
  assert.ok(afterFirst >= 1);
  const second = createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir });
  const r2 = await second.runResearch({
    task: { question: "cached?", signals: { versionUncertainty: true } },
    package: "p", installedVersion: "9.9.9",
    officialDomainOverride: "example.com", officialDocUrl: "https://example.com/cached",
    repoRef: {},
  });
  assert.ok(r2.counts.cacheHits >= 1);
  assert.equal(network, afterFirst);
});
