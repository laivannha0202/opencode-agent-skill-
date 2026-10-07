// V16.13 Freshness: classes preserved, UNKNOWN stays UNKNOWN, no fabrication.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchAndNormalize } from "../lib/research-page-fetch-v16-13.mjs";
import { FRESHNESS_CLASS } from "../lib/research-cache-helper-v16-13.mjs";
import { buildResearchBrief } from "../lib/research-brief-v16-13.mjs";

test("freshness classes are stable", () => {
  assert.deepEqual(Object.keys(FRESHNESS_CLASS), ["STATIC_DOC", "VERSIONED_DOC", "RELEASE", "ISSUE", "PACKAGE_METADATA", "CURRENT_WEB", "NEWS", "UNKNOWN"]);
});

test("fetched evidence carries freshness basis, never fabricated timestamps", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ues-fresh-"));
  const res = await fetchAndNormalize("https://example.com/docs", {
    fetchImpl: async () => ({
      status: 200,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => "<p>versioned doc</p>",
    }),
    evidenceRoot: root,
    visited: new Set(),
  });
  assert.equal(res.ok, true);
  assert.ok(res.source.freshness);
  assert.equal(res.source.freshnessBasis, "RETRIEVED_AT");
  assert.equal(res.source.publishedAt, undefined);
  assert.equal(res.source.updatedAt, undefined);
});

test("brief freshness requirement defaults to UNKNOWN", () => {
  const brief = buildResearchBrief({ question: "x", task: { signals: { versionUncertainty: true } } });
  assert.equal(brief.freshnessRequirement, "UNKNOWN");
});
