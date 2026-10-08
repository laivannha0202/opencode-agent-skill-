// V16.14 ULTRA-FAST TOKEN ECONOMY BENCHMARK.
//
// Honesty contract (inherited from V16.12/V16.13, NOT weakened):
//   * Every cell runs against a deterministic scratch workspace with an INJECTED
//     fetch. The report is labelled `synthetic: true` and
//     `claimStatus: "SIMULATED_ONLY"`. No live network, no live model.
//   * `PROVIDER_TOKENS = "NOT_MEASURED"`: this bench never talks to a provider,
//     so it CANNOT report a provider token count. The token columns below are
//     explicitly ESTIMATED from chars and are labelled as such.
//   * Timings are per SCENARIO and are NEVER summed into one speedup claim.
//   * Cache HIT and MISS are reported in SEPARATE cells, never averaged.
//   * BYTES and CHARS are reported as separate columns. A JS string length is
//     never reported as "bytes".
//
// Run: node scripts/bench-v16-14-economy.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExternalResearchBroker } from "../lib/external-research-broker-v16-13.mjs";
import { compactDeterministically } from "../lib/context-kernel-v16-10.mjs";
import { shapeToolOutput } from "../lib/tool-output-budgeter-v16-10.mjs";
import { createWasteDetector } from "../lib/waste-detector-v16-12.mjs";
import { estimateTokensFromChars } from "../lib/measurement-provenance.mjs";

const PROVIDER_TOKENS = "NOT_MEASURED";
const TOKEN_COLUMNS_PROVENANCE = "ESTIMATED";

function tempRoot(prefix = "ues-bench-e14-") {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

async function timeIt(fn) {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms: Number(ms.toFixed(3)), value };
}

function bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function okFetch(body = "<p>primary evidence</p>") {
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

// Multi-byte content so a byte/char confusion in the report is visible.
const MULTIBYTE_BODY = "<p>café ünïcødé 日本語 documentation evidence</p>";

async function cellByteVsCharHonesty() {
  const root = tempRoot();
  try {
    const { fetchImpl } = okFetch(MULTIBYTE_BODY);
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "api?", signals: { versionUncertainty: true } },
      package: "p",
      installedVersion: "1.0.0",
      officialDomainOverride: "example.com",
      officialDocUrl: "https://example.com/docs",
      repoRef: {},
    }));
    const c = timed.value.counts;
    const excerpt = timed.value.sources?.[0]?.excerpt || "";
    return {
      name: "1-byte-vs-char-honesty",
      bytesRetrieved: c.bytesRetrieved,
      charsRetrieved: c.charsRetrieved,
      byteCountIsRealUtf8Length: c.bytesRetrieved === bytes(excerpt),
      charCountIsRealStringLength: c.charsRetrieved === excerpt.length,
      bytesAndCharsDiffer: c.bytesRetrieved !== c.charsRetrieved,
      ms: timed.ms,
    };
  } finally {
    cleanup(root);
  }
}

async function cellCacheHitVsMiss() {
  const root = tempRoot();
  const cacheDir = `${root}-cache`;
  try {
    const { fetchImpl } = okFetch("<p>cacheable evidence body</p>");
    const args = {
      task: { question: "cached?", signals: { versionUncertainty: true } },
      package: "p",
      installedVersion: "7.7.7",
      officialDomainOverride: "example.com",
      officialDocUrl: "https://example.com/cacheme",
      repoRef: {},
    };
    const miss = await timeIt(() => createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir }).runResearch(args));
    const hit = await timeIt(() => createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir }).runResearch(args));
    // HIT and MISS are SEPARATE cells. They are never averaged into one number.
    return [
      {
        name: "2a-cache-miss",
        cacheMisses: miss.value.counts.cacheMisses,
        bytesRetrieved: miss.value.counts.bytesRetrieved,
        charsRetrieved: miss.value.counts.charsRetrieved,
        ms: miss.ms,
      },
      {
        name: "2b-cache-hit",
        cacheHits: hit.value.counts.cacheHits,
        bytesRetrieved: hit.value.counts.bytesRetrieved,
        charsRetrieved: hit.value.counts.charsRetrieved,
        networkBytesSavedVsMiss: Math.max(0, miss.value.counts.bytesRetrieved - hit.value.counts.bytesRetrieved),
        ms: hit.ms,
      },
    ];
  } finally {
    cleanup(root);
  }
}

async function cellDeepSeekEconomyRefusal() {
  const root = tempRoot();
  try {
    // Synthesis is ALLOWED (explicit deep-research request) but NO evidence was
    // captured, so the bounded input carries no fact, no conflict and no unknown.
    // Paying for that turn would buy an answer built only from model priors.
    let synthCalls = 0;
    const broker = createExternalResearchBroker({
      fetchImpl: async () => ({ status: 404, headers: { get: () => "text/html" }, text: async () => "not found" }),
      evidenceRoot: root,
      synthesizeVia: async () => { synthCalls += 1; return { ok: true, claims: [] }; },
    });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "deep?", signals: { userRequestedDeepResearch: true } },
      package: "p",
      installedVersion: "1.0.0",
      officialDomainOverride: "example.com",
      officialDocUrl: "https://example.com/missing",
      repoRef: {},
      userRequestedDeepResearch: true,
    }));
    return {
      name: "3-deepseek-economy-refusal",
      synthesisAllowedButInputEmpty: true,
      synthCallsActuallyMade: synthCalls,
      deepseekCallCount: timed.value.counts.deepseekCallCount,
      deepseekSkippedCount: timed.value.counts.deepseekSkippedCount,
      synthesis: timed.value.synthesis,
      wasteSignals: timed.value.wasteSignals,
      ms: timed.ms,
    };
  } finally {
    cleanup(root);
  }
}

async function cellDeepSeekAllowedWithEvidence() {
  const root = tempRoot();
  try {
    // The same gate must NOT block a synthesis request that has real evidence.
    const { fetchImpl } = okFetch();
    let synthCalls = 0;
    const broker = createExternalResearchBroker({
      fetchImpl,
      evidenceRoot: root,
      synthesizeVia: async () => { synthCalls += 1; return { ok: true, claims: [] }; },
    });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "conflict?", signals: { userRequestedDeepResearch: true } },
      package: "p",
      installedVersion: "1.0.0",
      officialDomainOverride: "example.com",
      officialDocUrl: "https://example.com/conflict",
      repoRef: {},
      claims: [{ id: "k", text: "x", sourceIds: [], conflicted: true }],
      unresolvedContradiction: true,
      userRequestedDeepResearch: true,
    }));
    return {
      name: "3b-deepseek-allowed-with-evidence",
      synthCallsActuallyMade: synthCalls,
      deepseekCallCount: timed.value.counts.deepseekCallCount,
      wasteSignals: timed.value.wasteSignals,
      ms: timed.ms,
    };
  } finally {
    cleanup(root);
  }
}

async function cellDeepSeekMeasuredUsage() {
  const root = tempRoot();
  try {
    const { fetchImpl } = okFetch();
    const broker = createExternalResearchBroker({
      fetchImpl,
      evidenceRoot: root,
      synthesizeVia: async () => ({ ok: true, claims: [], usage: { prompt_tokens: 900, completion_tokens: 100 } }),
    });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "conflict?", signals: { userRequestedDeepResearch: true } },
      package: "p",
      installedVersion: "1.0.0",
      officialDomainOverride: "example.com",
      officialDocUrl: "https://example.com/conflict",
      repoRef: {},
      claims: [{ id: "k", text: "x", sourceIds: [], conflicted: true }],
      unresolvedContradiction: true,
      userRequestedDeepResearch: true,
    }));
    return {
      name: "4-deepseek-provider-usage-measured",
      providerTokenProvenance: timed.value.counts.providerTokenProvenance,
      providerTotalTokens: timed.value.counts.providerTotalTokens,
      synthesisInputBytes: timed.value.counts.synthesisInputBytes,
      ms: timed.ms,
    };
  } finally {
    cleanup(root);
  }
}

function cellContextKernelBudget() {
  // Non-repeating content: a repeated line is collapsed by the dedupe pass, which
  // would mask the head/tail budget behavior this cell exists to measure.
  const text = Array.from({ length: 2000 }, (_, i) => `line ${i} of unique context content`).join("\n");
  const cells = [];
  for (const maxChars of [500, 2000, 8000]) {
    const out = compactDeterministically(text, { maxChars, handle: "ev-bench" });
    cells.push({
      name: `5-context-kernel-maxChars-${maxChars}`,
      originalBytes: bytes(text),
      originalChars: text.length,
      shapedBytes: bytes(out.text),
      shapedChars: out.text.length,
      withinBudget: out.text.length <= maxChars,
      savedChars: Math.max(0, text.length - out.text.length),
      savedTokensEstimate: estimateTokensFromChars(Math.max(0, text.length - out.text.length)).value,
    });
  }
  return cells;
}

function cellToolOutputBudget() {
  // Same reasoning: unique rows so the head/tail shaper is what runs. The
  // signature is shapeToolOutput(toolName, text, options).
  const text = Array.from({ length: 3000 }, (_, i) => `row ${i} of unique tool output`).join("\n");
  const cells = [];
  for (const budgetChars of [1000, 4000, 12000]) {
    const out = shapeToolOutput("read", text, { budgetChars });
    const rendered = String(out.text || "");
    cells.push({
      name: `6-tool-output-budget-${budgetChars}`,
      strategy: out.strategy,
      originalBytes: bytes(text),
      originalChars: text.length,
      shapedBytes: bytes(rendered),
      shapedChars: rendered.length,
      withinBudget: rendered.length <= budgetChars,
      noticeOverheadChars: out.noticeOverheadChars,
      savedChars: Math.max(0, text.length - rendered.length),
    });
  }
  return cells;
}

function cellWasteDetectorRepeat() {
  const detector = createWasteDetector({ now: () => 1000 });
  detector.record("gate", "full-suite", 1200, 7);
  detector.record("gate", "full-suite", 1200, 7);
  detector.record("read", "src/a.ts", 40, 7);
  const report = detector.report();
  return {
    name: "7-waste-detector-repeat",
    operationsObserved: report.operationsObserved,
    wastedOperations: report.wastedOperations,
    wasted: report.wasted.map((row) => ({
      operation: row.operation,
      identity: row.identity,
      count: row.count,
      wastedWallMs: row.wastedWallMs?.value ?? null,
      wastedWallMsProvenance: row.wastedWallMs?.provenance || "NOT_MEASURED",
    })),
  };
}

async function cellLocalOnlyZeroEgress() {
  const root = tempRoot();
  try {
    let calls = 0;
    const broker = createExternalResearchBroker({
      fetchImpl: async () => { calls += 1; throw new Error("must-not-call"); },
      evidenceRoot: root,
    });
    const timed = await timeIt(() => broker.runResearch({ task: { question: "fix typo", trivialLocal: true } }));
    return {
      name: "8-local-only-zero-egress",
      fetchCalls: calls,
      networkCalls: timed.value.counts.networkCalls,
      bytesRetrieved: timed.value.counts.bytesRetrieved,
      ms: timed.ms,
    };
  } finally {
    cleanup(root);
  }
}

async function main() {
  const cells = [];
  cells.push(await cellByteVsCharHonesty());
  cells.push(...(await cellCacheHitVsMiss()));
  cells.push(await cellDeepSeekEconomyRefusal());
  cells.push(await cellDeepSeekAllowedWithEvidence());
  cells.push(await cellDeepSeekMeasuredUsage());
  cells.push(...cellContextKernelBudget());
  cells.push(...cellToolOutputBudget());
  cells.push(cellWasteDetectorRepeat());
  cells.push(await cellLocalOnlyZeroEgress());
  const report = {
    policy: "bench-v16-14-economy",
    synthetic: true,
    claimStatus: "SIMULATED_ONLY",
    providerTokens: PROVIDER_TOKENS,
    providerTokensProvenance: "NOT_MEASURED",
    // Every token column in this report is derived from a char delta by the
    // documented heuristic. It is an ESTIMATE and is never a measurement.
    tokenColumnsProvenance: TOKEN_COLUMNS_PROVENANCE,
    summedSpeedupClaim: null,
    summedSpeedupReason: "cells-are-per-scenario-and-are-never-summed",
    measured: true,
    cells,
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

export { main };

const isMain = Boolean(process.argv[1]) && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
