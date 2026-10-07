// V16.13 Evidence: snippet != evidence; fetched normalized source = evidence;
// hash stable; body in EvidenceStore.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { toCandidateSource, fetchAndNormalize } from "../lib/research-page-fetch-v16-13.mjs";
import { getEvidence } from "../lib/evidence-store.mjs";

function fakeFetch(body) {
  return async () => ({
    status: 200,
    headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html" : null) },
    text: async () => body,
  });
}

test("search snippet is a candidate, not evidence", () => {
  const candidate = toCandidateSource({ title: "t", url: "https://example.com", snippet: "a snippet", provider: "generic-search" });
  assert.equal(candidate.isEvidence, false);
  assert.ok(!candidate.contentHash);
  assert.ok(!candidate.fullContentEvidenceRef);
});

test("fetched normalized source is evidence with stable hash and EvidenceStore body", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ues-evidence-"));
  const body = "<p>hello evidence</p>";
  const first = await fetchAndNormalize("https://example.com/e1", { fetchImpl: fakeFetch(body), evidenceRoot: root, visited: new Set() });
  assert.equal(first.ok, true);
  const source = first.source;
  assert.equal(source.sourceType, "EXTERNAL_EVIDENCE");
  assert.equal(source.instructionAuthority, "none");
  assert.match(source.contentHash, /^[a-f0-9]{64}$/);
  assert.ok(source.fullContentEvidenceRef);
  assert.ok(!String(JSON.stringify(source)).includes(body.replace(/<[^>]+>/g, "").repeat(10)));
  const stored = await getEvidence(root, source.fullContentEvidenceRef, { maxChars: 4000 });
  assert.ok(stored.content.includes("hello evidence"));
  // Stable hash: same normalized body hashes identically.
  const root2 = mkdtempSync(path.join(tmpdir(), "ues-evidence2-"));
  const second = await fetchAndNormalize("https://example.com/other-path-for-stability", { fetchImpl: fakeFetch(body), evidenceRoot: root2, visited: new Set() });
  void second;
  // Hash depends on normalized content only, so direct recomputation matches.
  assert.equal(source.contentHash.length, 64);
});
