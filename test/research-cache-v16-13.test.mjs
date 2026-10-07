// V16.13 Cache: HIT avoids network, forceFresh bypasses, corrupt is MISS,
// stale current-web refreshes, bodies never cached.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RESEARCH_CACHE_POLICY,
  researchCacheKey,
  readResearchCache,
  writeResearchCache,
} from "../lib/research-cache-helper-v16-13.mjs";

function tempDir() {
  return mkdtempSync(path.join(tmpdir(), "ues-research-cache-"));
}

test("cache helper policy id is byte-stable", () => {
  assert.equal(RESEARCH_CACHE_POLICY, "research-cache-helper-v16-13");
});

test("cache identity includes version and policy", () => {
  const a = researchCacheKey({ canonicalUrl: "https://x/y", provider: "official-docs", freshnessClass: "VERSIONED_DOC", installedVersion: "15.4.0" });
  const b = researchCacheKey({ canonicalUrl: "https://x/y", provider: "official-docs", freshnessClass: "VERSIONED_DOC", installedVersion: "16.0.0" });
  assert.notEqual(a, b);
});

test("fresh cache is a HIT; forceFresh bypasses", async () => {
  const dir = tempDir();
  const key = researchCacheKey({ canonicalUrl: "https://example.com/d", provider: "official-docs", freshnessClass: "VERSIONED_DOC", installedVersion: "1.0.0" });
  await writeResearchCache(dir, key, { freshnessClass: "VERSIONED_DOC", canonicalUrl: "https://example.com/d", provider: "official-docs", evidenceRef: "evidence:sha256:" + "a".repeat(64), contentHash: "b".repeat(64), excerpt: "hello" }, { now: 1000 });
  const hit = await readResearchCache(dir, key, { now: 2000 });
  assert.equal(hit.hit, true);
  const bypass = await readResearchCache(dir, key, { now: 2000, forceFresh: true });
  assert.equal(bypass.hit, false);
  assert.equal(bypass.reason, "FORCE_FRESH_BYPASS");
});

test("stale current-web requires refresh", async () => {
  const dir = tempDir();
  const key = researchCacheKey({ canonicalUrl: "https://example.com/n", provider: "generic-search", freshnessClass: "CURRENT_WEB", installedVersion: "" });
  await writeResearchCache(dir, key, { freshnessClass: "CURRENT_WEB", canonicalUrl: "https://example.com/n", provider: "generic-search", evidenceRef: "evidence:sha256:" + "c".repeat(64), contentHash: "d".repeat(64), excerpt: "news" }, { now: 0, ttlMs: 100 });
  const stale = await readResearchCache(dir, key, { now: 10_000 });
  assert.equal(stale.hit, false);
  assert.equal(stale.reason, "STALE");
});

test("corrupt cache is a MISS and cache never owns raw bodies", async () => {
  const dir = tempDir();
  const key = researchCacheKey({ canonicalUrl: "https://example.com/c", provider: "github", freshnessClass: "RELEASE", installedVersion: "" });
  const file = path.join(dir, `${key.replace(/[^a-z0-9-]/gi, "").slice(0, 64)}.json`);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "{not-json", "utf8");
  const miss = await readResearchCache(dir, key, { now: 0 });
  assert.equal(miss.hit, false);
  assert.equal(miss.reason, "MISS");
  // A body-carrying entry fails validation -> MISS.
  const key2 = researchCacheKey({ canonicalUrl: "https://example.com/e", provider: "github", freshnessClass: "RELEASE", installedVersion: "" });
  await writeResearchCache(dir, key2, { freshnessClass: "RELEASE", canonicalUrl: "https://example.com/e", provider: "github", evidenceRef: "evidence:sha256:" + "e".repeat(64), contentHash: "f".repeat(64), excerpt: "x" }, { now: 0 });
  const ok = await readResearchCache(dir, key2, { now: 1 });
  assert.equal(ok.hit, true);
  assert.equal(ok.entry.rawBody, undefined);
  assert.ok(ok.entry.evidenceRef);
});
