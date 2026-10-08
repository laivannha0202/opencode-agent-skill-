// V16.14 ULTRA-FAST TOKEN ECONOMY + RUNTIME CORRECTNESS HARDENING.
//
// Proves the V16.14 economy and honesty laws at the module boundary:
//
//   * BYTES are bytes (Buffer.byteLength) and CHARS are chars. A JS string
//     length is never reported as "bytes", and a char count is never promoted
//     into a token count.
//   * A provider token count is MEASURED only when the provider reported real
//     usage. A char-derived approximation stays ESTIMATED/NOT_MEASURED.
//   * DeepSeek synthesis is refused when the bounded input carries nothing to
//     synthesize, and the refusal is recorded as a waste signal.
//   * A cache hit performs zero network bytes; a cache miss counts real bytes.
//   * A high-risk claim bound only by a sourceId string can never be presented
//     as fully SUPPORTED.
//   * The bounded context/tool-output shapers never exceed the budget they were
//     given, INCLUDING the omission notice they append.
//   * A segment id is stable across identical inputs (no Math.random fallback).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createExternalResearchBroker,
  planDeepSeekEconomy,
  normalizeProviderUsage,
  buildResearchProvenance,
  trackClaims,
  CLAIM_STATUS,
  PROVIDER_TOKEN_PROVENANCE,
  RESEARCH_WASTE_SIGNAL,
} from "../lib/external-research-broker-v16-13.mjs";
import { compactDeterministically } from "../lib/context-kernel-v16-10.mjs";
import { shapeToolOutput } from "../lib/tool-output-budgeter-v16-10.mjs";
import { estimateTokensFromChars, PROVENANCE } from "../lib/measurement-provenance.mjs";

function tempRoot(prefix = "ues-v14-econ-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function okFetch(body = "<p>1.0.0 api</p>") {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => body,
    };
  };
  return { fetchImpl, calls: () => calls };
}

// A multi-byte body: a UTF-8 byte count and a char count MUST differ here, so a
// test that confuses them fails loudly instead of accidentally passing.
const MULTIBYTE = "<p>café ünïcødé 日本語 — evidence</p>";

test("V16.14 bytes are measured as UTF-8 bytes, not as JS string length", async () => {
  const root = tempRoot();
  const { fetchImpl } = okFetch(MULTIBYTE);
  const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
  const result = await broker.runResearch({
    task: { question: "api?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
  });
  assert.ok(result.counts.bytesRetrieved > 0, "a real fetch must report retrieved bytes");
  assert.ok(result.counts.charsRetrieved > 0, "chars are recorded separately");
  assert.notEqual(
    result.counts.bytesRetrieved,
    result.counts.charsRetrieved,
    "for multi-byte content the byte count and the char count must differ",
  );
  // The byte count is a true UTF-8 length, not a character count in disguise.
  const excerpt = result.sources[0].excerpt;
  assert.equal(result.counts.bytesRetrieved, Buffer.byteLength(excerpt, "utf8"));
  assert.equal(result.counts.charsRetrieved, excerpt.length);
  assert.equal(result.provenance.bytes, "MEASURED");
  assert.equal(result.provenance.chars, "MEASURED");
});

test("V16.14 a cache hit retrieves zero network bytes and a miss retrieves real bytes", async () => {
  const root = tempRoot();
  const cacheDir = `${root}-cache`;
  const { fetchImpl, calls } = okFetch("<p>cacheable evidence</p>");
  const args = {
    task: { question: "cached?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "9.9.9",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/cacheme",
    repoRef: {},
  };
  const missBroker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir });
  const miss = await missBroker.runResearch(args);
  assert.equal(miss.counts.cacheMisses, 1);
  assert.ok(miss.counts.bytesRetrieved > 0, "a miss reads bytes off the network");
  assert.ok(calls() > 0);

  const hitBroker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir });
  const hit = await hitBroker.runResearch(args);
  assert.equal(hit.counts.cacheHits, 1);
  assert.equal(hit.counts.bytesRetrieved, 0, "a cache hit performs zero network byte transfer");
  assert.ok(hit.counts.charsRetrieved > 0, "the cached chars are still counted honestly");
});

test("V16.14 provider tokens are MEASURED only from real provider usage", () => {
  const usage = normalizeProviderUsage({ prompt_tokens: 1200, completion_tokens: 300 });
  assert.equal(usage.provenance, PROVIDER_TOKEN_PROVENANCE.MEASURED);
  assert.equal(usage.promptTokens, 1200);
  assert.equal(usage.completionTokens, 300);
  assert.equal(usage.totalTokens, 1500);

  // A char count is NOT usage. It must never be accepted as a token measurement.
  for (const bogus of [{ chars: 4800 }, { text: "x".repeat(400) }, { tokens: 10 }, null, undefined, "MEASURED"]) {
    const row = normalizeProviderUsage(bogus);
    assert.equal(row.provenance, PROVIDER_TOKEN_PROVENANCE.NOT_MEASURED, `${JSON.stringify(bogus)} must not be measured`);
    assert.equal(row.totalTokens, null);
  }
});

test("V16.14 a char-derived token count is ESTIMATED, never MEASURED", () => {
  const est = estimateTokensFromChars(4000);
  assert.equal(est.provenance, PROVENANCE.ESTIMATED);
  assert.equal(est.value, 1000);
  assert.notEqual(est.provenance, PROVENANCE.MEASURED);
});

test("V16.14 a run without provider usage reports NOT_MEASURED, not zero", async () => {
  const root = tempRoot();
  const { fetchImpl } = okFetch();
  const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
  const result = await broker.runResearch({
    task: { question: "api?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
  });
  assert.equal(result.provenance.providerTokens, "NOT_MEASURED");
  assert.equal(result.provenance.providerTokensReason, "provider-usage-not-reported");
  assert.equal(result.counts.providerTotalTokens, null, "an unmeasured token count is null, never 0");
  // An unmeasured run emits NO provider-token observation at all.
  const tokenRows = broker.toEfficiencyEvents(result).filter((e) => e.operation === "research-provider-tokens");
  assert.equal(tokenRows.length, 0, "no token row is emitted without real provider usage");
});

test("V16.14 real provider usage is promoted to a MEASURED token observation", async () => {
  const root = tempRoot();
  const { fetchImpl } = okFetch();
  const broker = createExternalResearchBroker({
    fetchImpl,
    evidenceRoot: root,
    synthesizeVia: async () => ({ ok: true, claims: [], usage: { prompt_tokens: 900, completion_tokens: 100 } }),
  });
  const result = await broker.runResearch({
    task: { question: "conflict?", signals: { userRequestedDeepResearch: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/conflict",
    repoRef: {},
    claims: [{ id: "k", text: "x", sourceIds: [], conflicted: true }],
    unresolvedContradiction: true,
    userRequestedDeepResearch: true,
  });
  assert.equal(result.counts.providerTokenProvenance, "MEASURED");
  assert.equal(result.counts.providerTotalTokens, 1000);
  assert.equal(result.provenance.providerTokens, "MEASURED");
  const rows = broker.toEfficiencyEvents(result).filter((e) => e.operation === "research-provider-tokens");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].metrics.totalTokens, 1000);
  assert.equal(rows[0].provenance.totalTokens, "MEASURED");
});

test("V16.14 an empty synthesis input is refused and recorded as waste", () => {
  // Nothing to synthesize: no conflict, no unknown, no captured fact. The
  // bounded prompt would degenerate to the bare question, so the turn is refused.
  const refused = planDeepSeekEconomy({ needsSynthesis: true, conflicted: 0, unknowns: 0, verifiedFacts: 0 });
  assert.equal(refused.call, false);
  assert.equal(refused.reason, "empty-synthesis-input");
  assert.equal(refused.wasteSignal, RESEARCH_WASTE_SIGNAL.UNNECESSARY_DEEPSEEK_CALL);

  // ANY substance allows the call: a conflict...
  const conflict = planDeepSeekEconomy({ needsSynthesis: true, conflicted: 1, unknowns: 0, verifiedFacts: 0 });
  assert.equal(conflict.call, true);
  assert.equal(conflict.reason, "unresolved-conflict-present");
  assert.equal(conflict.wasteSignal, null);

  // ...an unknown...
  const unknowns = planDeepSeekEconomy({ needsSynthesis: true, conflicted: 0, unknowns: 2, verifiedFacts: 0 });
  assert.equal(unknowns.call, true);
  assert.equal(unknowns.reason, "unknowns-present");

  // ...or a captured fact.
  const facts = planDeepSeekEconomy({ needsSynthesis: true, conflicted: 0, unknowns: 0, verifiedFacts: 3 });
  assert.equal(facts.call, true);
  assert.equal(facts.reason, "verified-facts-present");

  const notNeeded = planDeepSeekEconomy({ needsSynthesis: false });
  assert.equal(notNeeded.call, false);
  assert.equal(notNeeded.reason, "synthesis-not-needed");
});

test("V16.14 the broker does not pay for a synthesis call with nothing to synthesize", async () => {
  const root = tempRoot();
  // Synthesis is explicitly requested, but the fetch fails so NO evidence is
  // captured: no fact, no conflict, no unknown. The bounded prompt would be the
  // bare question, so the model could only answer from its own priors.
  let synthCalls = 0;
  const broker = createExternalResearchBroker({
    fetchImpl: async () => ({ status: 404, headers: { get: () => "text/html" }, text: async () => "not found" }),
    evidenceRoot: root,
    synthesizeVia: async () => { synthCalls += 1; return { ok: true, claims: [] }; },
  });
  const result = await broker.runResearch({
    task: { question: "deep?", signals: { userRequestedDeepResearch: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/missing",
    repoRef: {},
    userRequestedDeepResearch: true,
  });
  assert.equal(synthCalls, 0, "an empty synthesis input must not cost a model turn");
  assert.equal(result.counts.deepseekCallCount, 0);
  assert.equal(result.counts.deepseekSkippedCount, 1);
  assert.ok(result.wasteSignals.includes(RESEARCH_WASTE_SIGNAL.UNNECESSARY_DEEPSEEK_CALL));
  assert.equal(result.synthesis?.reason, "empty-synthesis-input");
});

test("V16.14 a noticed waste signal reaches the metrics producer path as an observation, not a verdict", async () => {
  const root = tempRoot();
  const broker = createExternalResearchBroker({
    fetchImpl: async () => ({ status: 404, headers: { get: () => "text/html" }, text: async () => "not found" }),
    evidenceRoot: root,
    synthesizeVia: async () => ({ ok: true, claims: [] }),
  });
  const result = await broker.runResearch({
    task: { question: "deep?", signals: { userRequestedDeepResearch: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/missing",
    repoRef: {},
    userRequestedDeepResearch: true,
  });
  assert.ok(result.wasteSignals.includes(RESEARCH_WASTE_SIGNAL.UNNECESSARY_DEEPSEEK_CALL));

  // The signal must not die inside the broker: the run's waste signals are
  // emitted through the existing producer path so the V16.12 waste detector and
  // Metrics V2 can see them.
  const rows = broker.toEfficiencyEvents(result)
    .filter((e) => e.operation === `research-waste:${RESEARCH_WASTE_SIGNAL.UNNECESSARY_DEEPSEEK_CALL}`);
  assert.equal(rows.length, 1, "a noticed waste signal must be observable downstream");
  assert.equal(rows[0].kind, "external-research");
  assert.equal(rows[0].metrics.count, 1, "the occurrence count is MEASURED");
  assert.equal(rows[0].provenance.count, "MEASURED");
  // An observation is not a verdict: no verdict field may ride along.
  assert.equal(rows[0].verdict, undefined, "a waste observation never carries a verdict");

  // A run that noticed no waste emits no waste row at all.
  const clean = createExternalResearchBroker({ fetchImpl: okFetch().fetchImpl, evidenceRoot: root });
  const cleanResult = await clean.runResearch({
    task: { question: "api?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
  });
  assert.deepEqual(cleanResult.wasteSignals, []);
  const wasteRows = clean.toEfficiencyEvents(cleanResult).filter((e) => String(e.operation).startsWith("research-waste:"));
  assert.equal(wasteRows.length, 0, "no noticed waste means no waste row");
});

test("V16.14 the broker still pays for synthesis when real evidence exists", async () => {
  const root = tempRoot();
  const { fetchImpl } = okFetch();
  let synthCalls = 0;
  const broker = createExternalResearchBroker({
    fetchImpl,
    evidenceRoot: root,
    synthesizeVia: async () => { synthCalls += 1; return { ok: true, claims: [] }; },
  });
  const result = await broker.runResearch({
    task: { question: "conflict?", signals: { userRequestedDeepResearch: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/conflict",
    repoRef: {},
    claims: [{ id: "k", text: "x", sourceIds: [], conflicted: true }],
    unresolvedContradiction: true,
    userRequestedDeepResearch: true,
  });
  assert.equal(synthCalls, 1, "a real conflict must still be synthesized");
  assert.equal(result.counts.deepseekCallCount, 1);
  assert.equal(result.counts.deepseekSkippedCount, 0);
});

test("V16.14 a high-risk claim bound only by a sourceId string cannot be SUPPORTED", () => {
  const sources = [{ sourceId: "src-1", contentHash: "a".repeat(64), excerptHash: "b".repeat(64) }];
  const [byHash] = trackClaims(
    [{ id: "c1", text: "CVE fixed in 2.0", claimClass: "security", sourceIds: ["src-1"], evidenceHash: "a".repeat(64) }],
    sources,
  );
  assert.equal(byHash.status, CLAIM_STATUS.SUPPORTED);
  assert.equal(byHash.binding, "content-hash");

  const [byIdOnly] = trackClaims(
    [{ id: "c2", text: "CVE fixed in 2.0", claimClass: "security", sourceIds: ["src-1"] }],
    sources,
  );
  assert.equal(byIdOnly.binding, "sourceId-only");
  assert.equal(byIdOnly.status, CLAIM_STATUS.PARTIALLY_SUPPORTED, "sourceId-only binding cannot be fully SUPPORTED");
  assert.equal(byIdOnly.highRisk, true);

  // A non-high-risk claim keeps its old behaviour (no false downgrade).
  const [lowRisk] = trackClaims(
    [{ id: "c3", text: "docs mention caching", claimClass: "docs", sourceIds: ["src-1"] }],
    sources,
  );
  assert.equal(lowRisk.status, CLAIM_STATUS.SUPPORTED);
});

test("V16.14 the bounded context shaper honors its budget INCLUDING the notice", () => {
  const text = "line\n".repeat(4000);
  for (const maxChars of [200, 500, 1000, 4000]) {
    const out = compactDeterministically(text, { maxChars, handle: "ev-1" });
    assert.ok(out.text.length <= maxChars, `compacted text ${out.text.length} must fit maxChars ${maxChars}`);
  }
});

test("V16.14 the tool-output shaper honors its budget INCLUDING the notice", () => {
  const text = Array.from({ length: 3000 }, (_, i) => `row ${i} of unique tool output`).join("\n");
  for (const budgetChars of [512, 1000, 4000, 12000]) {
    const out = shapeToolOutput("read", text, { budgetChars });
    const rendered = String(out.text || "");
    assert.ok(
      rendered.length <= budgetChars,
      `shaped output ${rendered.length} must fit budgetChars ${budgetChars}`,
    );
    // The receipt must state the overhead the notice itself consumed.
    assert.ok(out.noticeOverheadChars >= 0);
    assert.equal(out.originalChars, text.length);
  }
});

test("V16.14 a segment id is stable across identical inputs (no random fallback)", async () => {
  const { applyContextKernel } = await import("../lib/context-kernel-v16-10.mjs");
  const segments = [{ tier: "evidence", text: "identical segment text" }];
  const scope = `stable-id-${process.pid}-${Date.now()}`;
  const first = await applyContextKernel("/tmp/ues-kernel-test", segments, { budgetChars: 5000, scope });
  const second = await applyContextKernel("/tmp/ues-kernel-test", segments, { budgetChars: 5000, scope });
  const idOf = (applied) => applied.segments?.[0]?.id;
  assert.ok(idOf(first), "the kernel must expose the applied segments");
  assert.equal(idOf(first), idOf(second), "identical input must produce an identical segment id");
  // The fallback id is derived from content, never from Math.random().
  assert.match(idOf(first), /^segment-[0-9a-f]{12}$/);
});

test("V16.14 the capsule never exceeds its 8000-char budget and reports over-budget honestly", async () => {
  const root = tempRoot();
  const { fetchImpl } = okFetch();
  const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
  const result = await broker.runResearch({
    task: { question: "api?", signals: { versionUncertainty: true } },
    package: "p",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
  });
  assert.ok(result.capsule.text.length <= 8000);
  assert.equal(result.capsule.overBudget, false);
  assert.equal(result.provenance.timing, "MEASURED");
  assert.equal(result.verdict, "NOT_AVAILABLE", "research never produces PASS");
});
