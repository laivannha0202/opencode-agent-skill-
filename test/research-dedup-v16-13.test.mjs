// V16.13 Dedup: one visited set per run, empty Set preserved, redirects + hash collapse.

import test from "node:test";
import assert from "node:assert/strict";

import { ensureVisited, toCandidateSource, fetchAndNormalize } from "../lib/research-page-fetch-v16-13.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function fakeFetch(body, contentType = "text/html") {
  return async () => ({
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  });
}

test("provided empty Set remains the same visited state", () => {
  const provided = new Set();
  const kept = ensureVisited(provided);
  assert.equal(kept, provided);
  const created = ensureVisited(null);
  assert.ok(created instanceof Set);
});

test("candidate sources are never evidence", () => {
  const candidate = toCandidateSource({ title: "t", url: "https://example.com", snippet: "snippet", provider: "generic-search" });
  assert.equal(candidate.isEvidence, false);
  assert.equal(candidate.sourceType, "CANDIDATE_SOURCE");
});

test("duplicate URLs collapse to deduped", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ues-dedup-"));
  const visited = new Set();
  const first = await fetchAndNormalize("https://example.com/docs?utm_source=x", { fetchImpl: fakeFetch("<p>hello</p>"), evidenceRoot: root, visited });
  assert.equal(first.ok, true);
  assert.equal(first.deduped, false);
  const second = await fetchAndNormalize("https://example.com/docs", { fetchImpl: fakeFetch("<p>hello</p>"), evidenceRoot: root, visited });
  assert.equal(second.deduped, true);
});

test("same content hash dedups across distinct URLs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ues-dedup-hash-"));
  const visited = new Set();
  await fetchAndNormalize("https://example.com/a", { fetchImpl: fakeFetch("<p>same body</p>"), evidenceRoot: root, visited });
  const second = await fetchAndNormalize("https://example.com/b", { fetchImpl: fakeFetch("<p>same body</p>"), evidenceRoot: root, visited });
  assert.equal(second.deduped, true);
  assert.match(second.reason, /duplicate-content-hash/);
});

test("blocked URLs never fetch", async () => {
  let called = 0;
  const root = mkdtempSync(path.join(tmpdir(), "ues-dedup-block-"));
  const res = await fetchAndNormalize("http://localhost:3000/x", {
    fetchImpl: async () => { called += 1; throw new Error("must-not-fetch"); },
    evidenceRoot: root,
    visited: new Set(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.failure, "BLOCKED_POLICY");
  assert.equal(called, 0);
});
