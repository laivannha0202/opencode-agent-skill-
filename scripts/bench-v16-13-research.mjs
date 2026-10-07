// V16.13 EXTERNAL RESEARCH BENCHMARK.
//
// Speed-first honesty contract (mirrors V16.12):
//   * Every scenario runs against a DETERMINISTIC clock and scratch temp
//     workspaces with an INJECTED fetch (no live network). The report is
//     labelled `synthetic: true` and `claimStatus: "SIMULATED_ONLY"`.
//   * Timings are per SCENARIO and are never summed into one speedup number.
//   * `PROVIDER_TOKENS = "NOT_MEASURED"`: this bench never talks to a model.
//   * Cache HIT and MISS are reported in SEPARATE cells, never averaged.
//   * V16.13 must demonstrate LOCAL_ONLY invokes zero external systems.
//
// Run: node scripts/bench-v16-13-research.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { decideResearchAdmission } from "../lib/research-brief-v16-13.mjs";
import { createExternalResearchBroker } from "../lib/external-research-broker-v16-13.mjs";

const PROVIDER_TOKENS = "NOT_MEASURED";

function tempRoot(prefix = "ues-bench-r13-") {
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

function okFetch(text = "<p>primary evidence</p>") {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    return {
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => `${text} ${url}`,
    };
  };
  return { fetchImpl, calls: () => calls };
}

function slowFetch(delayMs = 50) {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { status: 200, headers: { get: () => "text/html" }, text: async () => "<p>slow</p>" };
  };
}

async function scenarioLocalTrivial() {
  const root = tempRoot();
  try {
    const { fetchImpl, calls } = okFetch();
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({ task: { question: "fix typo", trivialLocal: true } }));
    return { name: "1-local-trivial", researchCalls: calls(), networkCalls: timed.value.counts.networkCalls, ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioLocalComplexGrounded() {
  const root = tempRoot();
  try {
    const { fetchImpl, calls } = okFetch();
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({ task: { question: "one-file mechanical change with failing test identifying cause", oneFileMechanical: true, existingFailingTestIdentifiesCause: true } }));
    return { name: "2-local-complex-grounded", researchCalls: calls(), networkCalls: timed.value.counts.networkCalls, ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioOfficialHit() {
  const root = tempRoot();
  try {
    const { fetchImpl, calls } = okFetch("<p>15.4.0 official doc</p>");
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "middleware?", signals: { versionUncertainty: true }, package: "next", installedVersion: "15.4.0" },
      package: "next", installedVersion: "15.4.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/docs",
      repoRef: {},
    }));
    return { name: "3-official-doc-hit", researchCalls: calls(), fetched: timed.value.counts.fetchedCount, ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioOfficialGithubParallel() {
  const root = tempRoot();
  try {
    const { fetchImpl, calls } = okFetch("<p>parallel primary</p>");
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "upstream bug?", signals: { upstreamIssueLookup: true, versionUncertainty: true } },
      package: "p", installedVersion: "1.0.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/docs",
      repoRef: { owner: "o", repo: "r" },
    }));
    return { name: "4-official-github-parallel", researchCalls: calls(), fetched: timed.value.counts.fetchedCount, ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioFirstSufficient() {
  const root = tempRoot();
  try {
    const { fetchImpl, calls } = okFetch("<p>sufficient</p>");
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "api?", signals: { versionUncertainty: true } },
      package: "p", installedVersion: "1.0.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/sufficient",
      repoRef: {},
      genericUrls: ["https://example.com/should-never-fetch"],
    }));
    return { name: "5-first-sufficient-cancellation", researchCalls: calls(), cancelled: timed.value.counts.cancelledFetchCount, ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioCacheHitVsMiss() {
  const root = tempRoot();
  const cacheDir = `${root}-cache`;
  try {
    const { fetchImpl } = okFetch("<p>cacheable</p>");
    const first = createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir });
    const miss = await timeIt(() => first.runResearch({
      task: { question: "cached?", signals: { versionUncertainty: true } },
      package: "p", installedVersion: "7.7.7",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/cacheme",
      repoRef: {},
    }));
    const second = createExternalResearchBroker({ fetchImpl, evidenceRoot: root, cacheDir });
    const hit = await timeIt(() => second.runResearch({
      task: { question: "cached?", signals: { versionUncertainty: true } },
      package: "p", installedVersion: "7.7.7",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/cacheme",
      repoRef: {},
    }));
    return [
      { name: "6a-cache-miss", cacheMisses: miss.value.counts.cacheMisses, ms: miss.ms },
      { name: "6b-cache-hit", cacheHits: hit.value.counts.cacheHits, networkCalls: hit.value.counts.networkCalls, ms: hit.ms },
    ];
  } finally {
    cleanup(root);
  }
}

async function scenarioStaleRefresh() {
  const admission = decideResearchAdmission({ signals: { latestRequested: true } });
  return { name: "7-stale-refresh", admissionClass: admission.researchClass, revalidate: "CURRENT_WEB-requires-refresh" };
}

async function scenarioGenericFallback() {
  const root = tempRoot();
  try {
    const fetchImpl = async (url) => {
      if (String(url).includes("example.com/docs")) return { status: 404, headers: { get: () => "text/html" }, text: async () => "no" };
      return { status: 200, headers: { get: () => "text/html" }, text: async () => "<p>generic fallback evidence</p>" };
    };
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "obscure?", signals: { latestRequested: true } },
      package: "p", installedVersion: "1.0.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/docs",
      repoRef: {},
      genericUrls: ["https://example.com/generic"],
    }));
    return { name: "8-generic-fallback", fetched: timed.value.counts.fetchedCount, ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioProviderTimeout() {
  const root = tempRoot();
  try {
    const broker = createExternalResearchBroker({ fetchImpl: slowFetch(5), evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "slow?", signals: { versionUncertainty: true } },
      package: "p", installedVersion: "1.0.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/slow",
      repoRef: {},
      hardResearchMs: 10,
    }));
    return { name: "9-provider-timeout", ms: timed.ms, stop: timed.value.stopReason };
  } finally {
    cleanup(root);
  }
}

async function scenarioDeepSeekConflict() {
  const root = tempRoot();
  try {
    const { fetchImpl } = okFetch("<p>primary</p>");
    let synthCalls = 0;
    const broker = createExternalResearchBroker({
      fetchImpl,
      evidenceRoot: root,
      synthesizeVia: async () => { synthCalls += 1; return { ok: true, claims: [] }; },
    });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "conflict?", signals: { userRequestedDeepResearch: true } },
      package: "p", installedVersion: "1.0.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/conflict",
      repoRef: {},
      claims: [{ id: "k", text: "x", sourceIds: [], conflicted: true }],
      unresolvedContradiction: true,
      incompletePrimaryEvidence: true,
      userRequestedDeepResearch: true,
    }));
    return { name: "10-deepseek-conflict-synthesis", synthCalls, deepseekCalls: timed.value.counts.deepseekCallCount, ms: timed.ms };
  } finally {
    cleanup(root);
  }
}

async function scenarioPiOnly() {
  const root = tempRoot();
  try {
    let calls = 0;
    const broker = createExternalResearchBroker({ fetchImpl: async () => { calls += 1; throw new Error("must-not-call"); }, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({ task: { piOnly: true, question: "anything", signals: { latestRequested: true } } }));
    return { name: "11-pi-only", researchCalls: calls, networkCalls: timed.value.counts.networkCalls, ms: timed.ms };
  } finally {
    cleanup(root);
  }
}

async function scenarioVersionMismatch() {
  const root = tempRoot();
  try {
    const { fetchImpl } = okFetch("<p>latest docs without installed version</p>");
    const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
    const timed = await timeIt(() => broker.runResearch({
      task: { question: "api?", signals: { versionUncertainty: true } },
      package: "next", installedVersion: "15.4.0", latestVersion: "16.2.0",
      officialDomainOverride: "example.com", officialDocUrl: "https://example.com/latest",
      repoRef: {},
    }));
    return { name: "12-version-mismatch", installed: timed.value.versionJoin.installedVersion, latest: timed.value.versionJoin.latestVersion, relation: timed.value.versionJoin.versionRelation, ms: timed.ms };
  } finally {
    cleanup(root);
  }
}

async function main() {
  const cells = [];
  cells.push(await scenarioLocalTrivial());
  cells.push(await scenarioLocalComplexGrounded());
  cells.push(await scenarioOfficialHit());
  cells.push(await scenarioOfficialGithubParallel());
  cells.push(await scenarioFirstSufficient());
  cells.push(...(await scenarioCacheHitVsMiss()));
  cells.push(await scenarioStaleRefresh());
  cells.push(await scenarioGenericFallback());
  cells.push(await scenarioProviderTimeout());
  cells.push(await scenarioDeepSeekConflict());
  cells.push(await scenarioPiOnly());
  cells.push(await scenarioVersionMismatch());
  const report = {
    policy: "bench-v16-13-research",
    synthetic: true,
    claimStatus: "SIMULATED_ONLY",
    providerTokens: PROVIDER_TOKENS,
    providerTokensProvenance: "NOT_MEASURED",
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
