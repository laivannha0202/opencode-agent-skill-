// V16.13 Page fetch + normalize — NON-AUTHORITATIVE helper.
//
// SEARCH RESULT (title/url/snippet) is a CANDIDATE_SOURCE only. A candidate
// becomes EXTERNAL_EVIDENCE after: network policy accepted + actual source
// fetched + canonicalized + normalized + SHA-256 hash + provenance + freshness
// + bounded body persisted/referenced by EvidenceStore.
//
// Helpers MUST NOT become duplicate policy authorities: raw bytes live in
// EvidenceStore; this module returns a bounded source record with a ref.

import { createHash } from "node:crypto";
import { putEvidence } from "./evidence-store.mjs";
import {
  canonicalizeUrl,
  checkUrlAllowed,
  checkFetchLimits,
  scanInjection,
} from "./research-network-policy-v16-13.mjs";

export const PAGE_FETCH_POLICY = "research-page-fetch-v16-13";
export const PAGE_FETCH_SCHEMA_VERSION = 1;

function stableHash(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function guessSourceType(url, contentType) {
  const u = String(url || "");
  const ct = String(contentType || "").toLowerCase();
  if (/api\.github\.com/.test(u)) return "github-api";
  if (/github\.com/.test(u)) return "github-page";
  if (/CHANGELOG/i.test(u)) return "changelog";
  if (/releases|tags/.test(u)) return "release";
  if (ct.includes("json")) return "api-json";
  if (ct.includes("markdown")) return "doc";
  return "doc-page";
}

function guessFreshness(sourceType) {
  switch (sourceType) {
    case "release": return { freshness: "RELEASE", basis: "RETRIEVED_AT" };
    case "github-api": return { freshness: "PACKAGE_METADATA", basis: "RETRIEVED_AT" };
    case "changelog": return { freshness: "VERSIONED_DOC", basis: "RETRIEVED_AT" };
    default: return { freshness: "VERSIONED_DOC", basis: "RETRIEVED_AT" };
  }
}

function normalizeBodyToText(body, contentType) {
  const ct = String(contentType || "").toLowerCase();
  let text = typeof body === "string" ? body : String(body ?? "");
  if (ct.includes("html")) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
  }
  if (ct.includes("json")) {
    try {
      const parsed = JSON.parse(text);
      text = JSON.stringify(parsed, null, 2);
    } catch {
      // keep raw
    }
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Build a CANDIDATE_SOURCE from a search result. Never evidence.
 */
export function toCandidateSource({ title, url, snippet, provider, queryId } = {}) {
  return {
    sourceType: "CANDIDATE_SOURCE",
    provider: provider || "generic-search",
    originalUrl: String(url || ""),
    title: String(title || "").slice(0, 300),
    snippet: String(snippet || "").slice(0, 600),
    queryId: queryId || null,
    isEvidence: false,
  };
}

/**
 * Ensure a single visited/canonical set per run. If the caller provides
 * `new Set()`, do NOT replace it merely because it is empty: only create a
 * new set when visited == null (not on truthiness).
 */
export function ensureVisited(visited) {
  if (visited == null) return new Set();
  return visited;
}

/**
 * Fetch + normalize one URL into EXTERNAL_EVIDENCE. Consults `visited` for
 * canonical + content-hash dedup.
 */
export async function fetchAndNormalize(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    evidenceRoot = process.cwd(),
    visited = null,
    maxBytes = 2_000_000,
    maxExcerptChars = 4000,
    requestId = "",
    queryId = "",
    provider = "page-fetch",
    now = () => new Date().toISOString(),
    githubToken = null,
  } = options;
  const seen = ensureVisited(visited);
  const originalUrl = String(url || "");
  let canonicalUrl;
  try {
    canonicalUrl = canonicalizeUrl(originalUrl);
  } catch {
    return { ok: false, failure: "BLOCKED_POLICY", reason: "invalid-url", deduped: false };
  }
  const allowed = checkUrlAllowed(canonicalUrl);
  if (!allowed.allowed) {
    return { ok: false, failure: "BLOCKED_POLICY", reason: allowed.reason, deduped: false };
  }
  if (seen.has(`url:${canonicalUrl}`)) {
    return { ok: true, deduped: true, reason: "duplicate-url", canonicalUrl };
  }
  let response;
  try {
    const headers = { "User-Agent": "ues-research-v16-13" };
    // GitHub token is attached ONLY for GitHub hosts by the github helper's
    // rule; page-fetch never attaches credentials itself.
    void githubToken;
    response = await fetchImpl(canonicalUrl, { headers, redirect: "follow" });
  } catch (error) {
    return { ok: false, failure: "NETWORK_UNAVAILABLE", reason: String(error?.message || error), deduped: false };
  }
  const status = Number(response?.status || 0);
  const contentType = String(response?.headers?.get?.("content-type") || response?.contentType || "text/html");
  if (status >= 500 && status < 600) return { ok: false, failure: "HTTP_5XX", reason: `http-${status}`, deduped: false };
  if (status === 429) return { ok: false, failure: "RATE_LIMIT", reason: "http-429", deduped: false };
  if (status === 401 || status === 403) return { ok: false, failure: "AUTH_REQUIRED", reason: `http-${status}`, deduped: false };
  if (status === 404) return { ok: false, failure: "EMPTY_RESULT", reason: "http-404", deduped: false };
  if (!status || status >= 400) return { ok: false, failure: "PROVIDER_UNAVAILABLE", reason: `http-${status}`, deduped: false };
  const limits = checkFetchLimits({ bytes: Number(response?.headers?.get?.("content-length") || NaN) || null, contentType, maxBytes });
  if (!limits.allowed) return { ok: false, failure: limits.failure, reason: limits.reason, deduped: false };
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    return { ok: false, failure: "BAD_SCHEMA", reason: String(error?.message || error), deduped: false };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, failure: "OVERSIZED", reason: "body-exceeds-max-bytes", deduped: false };
  }
  const normalized = normalizeBodyToText(raw, contentType).slice(0, 200_000);
  const contentHash = stableHash(normalized);
  if (seen.has(`hash:${contentHash}`)) {
    seen.add(`url:${canonicalUrl}`);
    return { ok: true, deduped: true, reason: "duplicate-content-hash", canonicalUrl, contentHash };
  }
  const injection = scanInjection(normalized);
  const sourceType = guessSourceType(canonicalUrl, contentType);
  const fresh = guessFreshness(sourceType);
  const retrievedAt = typeof now === "function" ? now() : new Date().toISOString();
  let fullContentEvidenceRef = null;
  try {
    const meta = await putEvidence(evidenceRoot, normalized, {
      kind: "external-source",
      source: canonicalUrl,
      summary: `external-source ${provider} ${canonicalUrl}`.slice(0, 200),
      mediaType: "text/plain; charset=utf-8",
    });
    fullContentEvidenceRef = meta.ref;
  } catch (error) {
    return { ok: false, failure: "PROVIDER_UNAVAILABLE", reason: `evidence-store-failed:${error?.message || error}`, deduped: false };
  }
  seen.add(`url:${canonicalUrl}`);
  seen.add(`hash:${contentHash}`);
  let domain = "";
  try {
    domain = new URL(canonicalUrl).hostname.toLowerCase();
  } catch {
    domain = "";
  }
  const title = normalized.split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, 300) || domain;
  return {
    ok: true,
    deduped: false,
    source: {
      sourceId: contentHash.slice(0, 16),
      provider,
      sourceType: "EXTERNAL_EVIDENCE",
      canonicalUrl,
      originalUrl,
      title,
      domain,
      retrievedAt,
      httpStatus: status,
      contentType: contentType.split(";")[0].trim(),
      contentHash,
      excerpt: normalized.slice(0, maxExcerptChars),
      fullContentEvidenceRef,
      freshness: fresh.freshness,
      freshnessBasis: fresh.basis,
      trustClass: "external-data",
      instructionAuthority: "none",
      requestId: requestId || null,
      queryId: queryId || null,
      injectionScan: injection.injectionDetected ? "hits-recorded" : "clean",
      injectionHits: injection.hits,
    },
  };
}

export const pageFetchExports = Object.freeze({
  toCandidateSource,
  ensureVisited,
  fetchAndNormalize,
});
