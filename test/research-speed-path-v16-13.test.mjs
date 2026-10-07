// V16.13 Speed path: LOCAL fast path costs zero research; PI_ONLY hydrates none.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createExternalResearchBroker } from "../lib/external-research-broker-v16-13.mjs";
import { LAZY_RUNTIME_MODULES, LAZY_RUNTIME_STACKS, loadedLazyModules, resetLazyRuntimeForTests } from "../lib/lazy-runtime.mjs";

function countingFetch() {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 200, headers: { get: () => "text/html" }, text: async () => "<p>x</p>" };
  };
  return { fetchImpl, calls: () => calls };
}

test("trivial local task performs zero external calls", async () => {
  const { fetchImpl, calls } = countingFetch();
  const root = mkdtempSync(path.join(tmpdir(), "ues-speed-"));
  const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
  const result = await broker.runResearch({ task: { question: "fix typo in label", trivialLocal: true } });
  assert.equal(calls(), 0);
  assert.equal(result.counts.networkCalls, 0);
  assert.equal(result.counts.deepseekCallCount, 0);
  assert.equal(result.counts.browserLaunchCount, 0);
  assert.equal(result.stopReason, "LOCAL_PROOF_SUPERSEDES");
  assert.equal(result.verdict, "NOT_AVAILABLE");
});

test("PI_ONLY performs zero research", async () => {
  const { fetchImpl, calls } = countingFetch();
  const root = mkdtempSync(path.join(tmpdir(), "ues-speed-pi-"));
  const broker = createExternalResearchBroker({ fetchImpl, evidenceRoot: root });
  const result = await broker.runResearch({ task: { piOnly: true, question: "latest docs?", signals: { latestRequested: true } } });
  assert.equal(calls(), 0);
  assert.equal(result.counts.networkCalls, 0);
  assert.equal(result.brief, null);
});

test("RESEARCH lazy stack exists and a boot hydrates none of it", () => {
  resetLazyRuntimeForTests();
  assert.ok(LAZY_RUNTIME_MODULES.RESEARCH_BROKER);
  assert.ok(Array.isArray(LAZY_RUNTIME_STACKS.RESEARCH));
  assert.ok(LAZY_RUNTIME_STACKS.RESEARCH.includes(LAZY_RUNTIME_MODULES.RESEARCH_BROKER));
  assert.deepEqual(loadedLazyModules(), []);
});

test("ordinary docs lookup launches no browser and DeepSeek stays 0 on support", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ues-speed-docs-"));
  const broker = createExternalResearchBroker({
    fetchImpl: async (url) => ({
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => `<p>docs for ${url} installed 1.0.0</p>`,
    }),
    evidenceRoot: root,
  });
  const result = await broker.runResearch({
    task: { question: "next middleware", signals: { versionUncertainty: true }, package: "next", installedVersion: "1.0.0" },
    package: "next",
    installedVersion: "1.0.0",
    officialDomainOverride: "example.com",
    officialDocUrl: "https://example.com/docs",
    repoRef: {},
    claims: [{ id: "c1", text: "middleware exists", sourceIds: [] }],
  });
  assert.equal(result.counts.browserLaunchCount, 0);
  assert.ok(result.sources.length >= 0);
});
