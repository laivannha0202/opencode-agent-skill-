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
import { isGitHubHost } from "./research-provider-github-v16-13.mjs";
import { createBoundedExternalTransport, toFetchLike } from "./research-transport-v16-14.mjs";

export const PAGE_FETCH_POLICY = "research-page-fetch-v16-13";
export const PAGE_FETCH_SCHEMA_VERSION = 1;

// The trusted production transport. It is created once and reused: it enforces
// manual bounded redirects, resolved-address SSRF validation, connection pinning
// and true cancellation. Tests inject their own `fetchImpl` and never touch it.
let defaultTransport = null;
function getDefaultFetchLike() {
  if (!defaultTransport) defaultTransport = toFetchLike(createBoundedExternalTransport());
  return defaultTransport;
}

/**
 * Headers for a research fetch. The Authorization header is attached ONLY when
 * the target is an approved GitHub host AND a token was supplied. A non-GitHub
 * host never receives the token. This is the ONLY place page-fetch builds
 * credentials, and it is applied to the actual request (never computed and
 * dropped).
 */
export function researchHeadersForUrl(url, { githubToken = null, extraHeaders = {} } = {}) {
  let host = "";
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const headers = { "User-Agent": "ues-research-v16-14", ...extraHeaders };
  if (host && isGitHubHost(host)) {
    headers.Accept = "application/vnd.github+json";
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  } else {
    headers.Accept = "text/html,application/xhtml+xml,application/json,text/plain;q=0.9";
  }
  return headers;
}

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
    fetchImpl = null,
    evidenceRoot = process.cwd(),
    visited = null,
    maxBytes = 2_000_000,
    maxExcerptChars = 4000,
    requestId = "",
    queryId = "",
    provider = "page-fetch",
    now = () => new Date().toISOString(),
    githubToken = null,
    signal = null,
    conditionalHeaders = null,
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
  // A cancelled generation must not even open a request.
  if (signal?.aborted) {
    return { ok: false, failure: "CANCELLED", reason: "aborted-before-fetch", deduped: false };
  }
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : getDefaultFetchLike();
  // The token is attached ONLY for approved GitHub hosts, and the resulting
  // headers are ACTUALLY applied to the request below.
  const baseHeaders = researchHeadersForUrl(canonicalUrl, { githubToken });
  const headers = conditionalHeaders && typeof conditionalHeaders === "object"
    ? { ...baseHeaders, ...conditionalHeaders }
    : baseHeaders;
  let response;
  try {
    response = await doFetch(canonicalUrl, { headers, redirect: "manual", signal });
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
      return { ok: false, failure: "CANCELLED", reason: "aborted", deduped: false };
    }
    return { ok: false, failure: "NETWORK_UNAVAILABLE", reason: String(error?.message || error), deduped: false };
  }
  // A bounded transport surfaces a policy refusal as a typed failure even though
  // it returns a response-shaped object (status 0).
  if (response?.__transportFailure === "BLOCKED_POLICY") {
    return { ok: false, failure: "BLOCKED_POLICY", reason: response.__transportReason || "blocked", deduped: false };
  }
  if (response?.__transportFailure === "CANCELLED") {
    return { ok: false, failure: "CANCELLED", reason: "aborted", deduped: false };
  }
  const status = Number(response?.status || 0);
  const contentType = String(response?.headers?.get?.("content-type") || response?.contentType || "text/html");
  // V16.14 conditional GET: 304 means the cached body is unchanged. We return a
  // typed not-modified result so the caller can reuse cache without re-reading
  // or re-normalizing a body.
  if (status === 304) {
    const etag = response?.headers?.get?.("etag") || null;
    const lastModified = response?.headers?.get?.("last-modified") || null;
    return { ok: true, notModified: true, status, canonicalUrl, etag, lastModified, deduped: false };
  }
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
  const etag = response?.headers?.get?.("etag") || null;
  const lastModified = response?.headers?.get?.("last-modified") || null;
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
      excerptHash: stableHash(normalized.slice(0, maxExcerptChars)),
      etag,
      lastModified,
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
  researchHeadersForUrl,
});
