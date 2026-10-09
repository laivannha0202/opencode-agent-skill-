// V16.13 External research broker — POLICY OWNER C.
//
// Owns: production research composition, concurrent provider orchestration,
// first-sufficient-evidence cancellation, research cache policy,
// claim/source view, contradiction state, final ResearchCapsule, stop
// reason. Does NOT own: raw evidence bytes (EvidenceStore), PASS (local
// verifier), second metrics system (Metrics V2).
//
// SPEED-FIRST: smallest high-value provider set, safe overlap with
// read-only local prep, soft/hard deadlines, dedup, cache-first,
// first-sufficient cancellation, bounded 8000-char capsule.

import { createHash } from "node:crypto";
import {
  RESEARCH_CLASS,
  RESEARCH_STOP_REASON,
  RESEARCH_BUDGETS,
  RESEARCH_CAPSULE_MAX_CHARS,
  RESEARCH_BRIEF_POLICY,
  decideResearchAdmission,
  buildResearchBrief,
  isSufficientEvidence,
  shouldCallDeepSeek,
  planSafeOverlap,
} from "./research-brief-v16-13.mjs";
import { routeProviders, selectFallback } from "./research-provider-router-v16-13.mjs";
import { resolveOfficialTarget, buildOfficialQueries, evaluateOfficialVersionMatch, resolveOfficialDocUrl } from "./research-provider-official-v16-13.mjs";
import { buildGitHubQueries, classifyGitHubFailure, authHeadersForHost } from "./research-provider-github-v16-13.mjs";
import { fetchAndNormalize, ensureVisited, toCandidateSource } from "./research-page-fetch-v16-13.mjs";
import { researchCacheKey, ttlForFreshness, readResearchCache, writeResearchCache, revalidationHeadersFor, touchResearchCache } from "./research-cache-helper-v16-13.mjs";
import { canonicalizeUrl, checkUrlAllowed, classifyOutboundQuery } from "./research-network-policy-v16-13.mjs";
import { joinVersions } from "./research-version-join-v16-13.mjs";
// V16.17 (§10): the ONE provider usage authority. Imported under a local alias so
// this module's exported wrapper name (`normalizeProviderUsage`) keeps its shape
// for existing callers while the interpretation logic lives in exactly one file.
import { normalizeProviderUsage as normalizeProviderUsageCanonical } from "./provider-usage-normalizer-v16-17.mjs";

export const RESEARCH_BROKER_POLICY = "external-research-broker-v16-13";
export const RESEARCH_BROKER_SCHEMA_VERSION = 1;
export const RESEARCH_METRIC_KIND = "external-research";
export const RESEARCH_BROKER_CAPSULE_MAX_CHARS = RESEARCH_CAPSULE_MAX_CHARS;

// Waste signals V16.13 feeds into the EXISTING V16.12 Waste Detector via
// detector.record(op, identity, wallMs, generation). This module never
// aggregates; it only names the operations.
export const RESEARCH_WASTE_SIGNAL = Object.freeze({
  UNNECESSARY_RESEARCH: "unnecessary-research",
  DUPLICATE_FETCH: "duplicate-fetch",
  RESEARCH_AFTER_SUFFICIENT_EVIDENCE: "research-after-sufficient-evidence",
  UNNECESSARY_BROWSER_START: "unnecessary-browser-start",
  UNNECESSARY_DEEPSEEK_CALL: "unnecessary-deepseek-call",
  STALE_CACHE_REFETCH: "stale-cache-refetch",
  DUPLICATE_SOURCE_NORMALIZATION: "duplicate-source-normalization",
  OVER_BUDGET_CAPSULE: "over-budget-capsule",
});

/**
 * V16.14 DeepSeek economy gate (LAW P7 made operational).
 *
 * `shouldCallDeepSeek` (research-brief-v16-13) answers "is synthesis ALLOWED?".
 * This answers the stricter question the token economy actually needs: "does the
 * bounded input we are about to pay for contain ANYTHING to synthesize?"
 *
 * The bounded synthesis input is exactly: verified facts, conflicts, unknowns,
 * version facts and source IDs. When facts, conflicts AND unknowns are all empty
 * the prompt degenerates to the bare question, so the model could only answer
 * from its own priors - the "model confidence" V16.13 forbids treating as
 * evidence. Paying a model turn for that is pure waste, so the broker records
 * `UNNECESSARY_DEEPSEEK_CALL` and keeps the call count at 0.
 *
 * The gate REFUSES ONLY an input with no substance. Any captured fact, any
 * unresolved conflict and any recorded unknown is enough to allow the call, so
 * this can never weaken a legitimate synthesis request that has evidence.
 */
export function planDeepSeekEconomy({
  needsSynthesis = false,
  conflicted = 0,
  unknowns = 0,
  verifiedFacts = 0,
  hardArchitecturalUncertainty = false,
  multipleCredibleAlternatives = false,
  userRequestedDeepResearch = false,
} = {}) {
  const conflicts = Math.max(0, Number(conflicted) || 0);
  const unknownCount = Math.max(0, Number(unknowns) || 0);
  const facts = Math.max(0, Number(verifiedFacts) || 0);
  const inputs = { conflicts, unknowns: unknownCount, verifiedFacts: facts };
  if (!needsSynthesis) {
    return { call: false, reason: "synthesis-not-needed", wasteSignal: null, inputs };
  }
  if (conflicts > 0) {
    return { call: true, reason: "unresolved-conflict-present", wasteSignal: null, inputs };
  }
  if (unknownCount > 0) {
    return { call: true, reason: "unknowns-present", wasteSignal: null, inputs };
  }
  if (facts > 0) {
    return { call: true, reason: "verified-facts-present", wasteSignal: null, inputs };
  }
  return {
    call: false,
    reason: "empty-synthesis-input",
    wasteSignal: RESEARCH_WASTE_SIGNAL.UNNECESSARY_DEEPSEEK_CALL,
    inputs,
    requestedBy: userRequestedDeepResearch
      ? "explicit-request"
      : (hardArchitecturalUncertainty ? "architectural-uncertainty" : (multipleCredibleAlternatives ? "credible-alternatives" : "unspecified")),
  };
}

export const CLAIM_STATUS = Object.freeze({
  SUPPORTED: "SUPPORTED",
  PARTIALLY_SUPPORTED: "PARTIALLY_SUPPORTED",
  CONFLICTED: "CONFLICTED",
  UNSUPPORTED: "UNSUPPORTED",
  UNVERIFIED_ADVISOR_CLAIM: "UNVERIFIED_ADVISOR_CLAIM",
});

// V16.14: a provider token count is MEASURED ONLY when the provider itself
// returned usage telemetry. There is no other source of truth: a char count is
// not a token count, and a chars/4 heuristic is an ESTIMATE that must never be
// presented as a measurement.
export const PROVIDER_TOKEN_PROVENANCE = Object.freeze({
  MEASURED: "MEASURED",
  NOT_MEASURED: "NOT_MEASURED",
});

export const BYTE_METRIC_PROVENANCE = Object.freeze({
  MEASURED: "MEASURED",
  NOT_MEASURED: "NOT_MEASURED",
});

/**
 * The run's provenance block. `providerTokens` is MEASURED only when the
 * provider reported real usage for THIS run; the default branch is the explicit
 * NOT_MEASURED record, never an omission and never a char-derived guess.
 */
export function buildResearchProvenance(counts = {}) {
  if (counts?.providerTokenProvenance === PROVIDER_TOKEN_PROVENANCE.MEASURED) {
    return {
      timing: "MEASURED",
      providerTokens: "MEASURED",
      providerTokensReason: "provider-reported-usage",
      bytes: BYTE_METRIC_PROVENANCE.MEASURED,
      chars: BYTE_METRIC_PROVENANCE.MEASURED,
    };
  }
  return {
    timing: "MEASURED",
    providerTokens: "NOT_MEASURED",
    providerTokensReason: "provider-usage-not-reported",
    bytes: BYTE_METRIC_PROVENANCE.MEASURED,
    chars: BYTE_METRIC_PROVENANCE.MEASURED,
  };
}

/**
 * Normalize whatever a synthesizer returned into an honest token record.
 *
 * Accepts ONLY real provider usage shapes (`usage.prompt_tokens`,
 * `usage.completion_tokens`, `usage.total_tokens`, or the camelCase variants a
 * provider adapter may forward). Anything else - including a char count, a word
 * count, or a locally computed approximation - is NOT_MEASURED.
 */
export function normalizeProviderUsage(usage) {
  const empty = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    provenance: PROVIDER_TOKEN_PROVENANCE.NOT_MEASURED,
    reason: "provider-usage-not-reported",
  };
  if (!usage || typeof usage !== "object") return empty;
  // V16.17 (§10): interpretation of provider usage is OWNED by the canonical
  // normalizer. This function no longer keeps a second alias table / total
  // derivation that could drift from it. Only the OUTPUT SHAPE is preserved for
  // existing callers (prompt/completion naming + the NOT_MEASURED reason tag).
  const normalized = normalizeProviderUsageCanonical({ usage });
  if (normalized.provenance !== "MEASURED") return empty;
  return {
    promptTokens: normalized.inputTokens.value,
    completionTokens: normalized.outputTokens.value,
    totalTokens: normalized.totalTokens.value,
    provenance: PROVIDER_TOKEN_PROVENANCE.MEASURED,
    reason: "provider-reported-usage",
  };
}

function stableId(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 12);
}

function sha256Hex(text) {
  return createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

// V16.14 measurement honesty: a byte count is a REAL byte count, and a char
// count is a REAL char count. They are never interchangeable, and a JS string
// length is never reported as "bytes".
function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// V16.14: claim classes whose truth can change an implementation decision. A
// claim in one of these classes must be bound to evidence by CONTENT HASH, not
// merely by a sourceId string that could be hand-written or stale.
export const HIGH_RISK_CLAIM_CLASSES = Object.freeze([
  "security",
  "version",
  "breaking",
  "install",
  "auth",
  "config",
  "migration",
  "api-surface",
]);

/**
 * A soft/hard deadline that also ABORTS the underlying work when it fires. A
 * plain `Promise.race` timeout leaves an orphan request running; V16.14 requires
 * true cancellation, so the timeout callback aborts the operation's controller.
 */
function withTimeoutAbort(promise, ms, kind, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* ignore */ }
      reject(Object.assign(new Error(kind), { researchFailure: kind }));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** A child controller that aborts when its parent aborts. */
function linkedController(parent) {
  const controller = new AbortController();
  if (parent?.signal) {
    if (parent.signal.aborted) controller.abort(parent.signal.reason);
    else parent.signal.addEventListener("abort", () => controller.abort(parent.signal.reason), { once: true });
  }
  return controller;
}

/**
 * Track claims against captured sources. Every implementation-affecting claim
 * needs captured evidence for security/version/breaking topics. Model
 * confidence is NOT evidence; unsourced DeepSeek claims stay UNVERIFIED.
 *
 * V16.14 HARDENING: a claim is bound to evidence by CONTENT HASH, not by a
 * sourceId string alone. A high-risk claim class (security/version/breaking/
 * install/...) that is supported ONLY by a sourceId string (no hash that
 * matches a captured source) is DOWNGRADED to PARTIALLY_SUPPORTED with
 * `binding: "sourceId-only"` so it can never be presented as fully SUPPORTED.
 */
export function trackClaims(claims = [], sources = []) {
  const byId = new Map();
  const byHash = new Map();
  for (const s of sources) {
    if (s?.sourceId) byId.set(s.sourceId, s);
    if (s?.contentHash) {
      byHash.set(s.contentHash, s);
      byId.set(String(s.contentHash).slice(0, 16), s);
    }
    if (s?.excerptHash) byHash.set(s.excerptHash, s);
  }
  const hashKeysOf = (claim) => {
    const out = [];
    const push = (v) => { if (v != null && v !== "") out.push(String(v)); };
    for (const key of ["evidenceHash", "excerptHash", "contentHash", "sourceHash"]) push(claim[key]);
    for (const key of ["evidenceHashes", "excerptHashes", "contentHashes", "sourceHashes"]) {
      if (Array.isArray(claim[key])) for (const v of claim[key]) push(v);
    }
    return out;
  };
  const claimClassOf = (claim) => String(claim.claimClass || claim.topic || claim.category || "").toLowerCase();
  return claims.map((claim, index) => {
    const id = claim.id || `claim-${index}`;
    const text = String(claim.text || "").slice(0, 500);
    const sourceIds = Array.isArray(claim.sourceIds) ? claim.sourceIds : [];
    const declaredHashes = hashKeysOf(claim);
    const supporting = new Set();
    for (const sid of sourceIds) {
      const s = byId.get(sid);
      if (s) supporting.add(s);
    }
    for (const h of declaredHashes) {
      const s = byHash.get(h) || byId.get(String(h).slice(0, 16));
      if (s) supporting.add(s);
    }
    const supportingList = [...supporting];
    const hashBound = declaredHashes.some((h) => byHash.has(h) || byId.has(String(h).slice(0, 16)));
    const claimClass = claimClassOf(claim);
    const highRisk = claim.highRisk === true || HIGH_RISK_CLAIM_CLASSES.includes(claimClass);
    const binding = hashBound ? "content-hash" : (supportingList.length ? "sourceId-only" : "none");
    const base = {
      id,
      text,
      sourceIds,
      claimClass: claimClass || null,
      highRisk,
      binding,
      boundSourceIds: supportingList.map((s) => s.sourceId || s.contentHash?.slice(0, 16)).filter(Boolean),
    };
    if (claim.fromDeepSeek === true && supportingList.length === 0) {
      return { ...base, status: CLAIM_STATUS.UNVERIFIED_ADVISOR_CLAIM };
    }
    if (supportingList.length === 0) return { ...base, status: CLAIM_STATUS.UNSUPPORTED };
    if (claim.conflicted === true) return { ...base, sourceIds: supportingList.map((s) => s.sourceId).filter(Boolean), status: CLAIM_STATUS.CONFLICTED };
    // A high-risk claim that is bound only by a sourceId string cannot be
    // presented as fully SUPPORTED: downgrade to PARTIALLY_SUPPORTED.
    if (highRisk && !hashBound) {
      return { ...base, sourceIds: supportingList.map((s) => s.sourceId).filter(Boolean), status: CLAIM_STATUS.PARTIALLY_SUPPORTED };
    }
    if (supportingList.length < sourceIds.length || claim.partial === true) {
      return { ...base, sourceIds: supportingList.map((s) => s.sourceId).filter(Boolean), status: CLAIM_STATUS.PARTIALLY_SUPPORTED };
    }
    return { ...base, sourceIds: supportingList.map((s) => s.sourceId).filter(Boolean), status: CLAIM_STATUS.SUPPORTED };
  });
}

/**
 * Contradiction resolution order: exact installed-version primary ->
 * official release/docs -> upstream GitHub -> one bounded extra primary
 * fetch -> DeepSeek synthesis only if still useful -> expose unresolved.
 */
export function resolveContradictions(claims = [], sources = [], versionJoin = {}) {
  const tracked = trackClaims(claims, sources);
  const conflicted = tracked.filter((c) => c.status === CLAIM_STATUS.CONFLICTED);
  if (!conflicted.length) return { tracked, conflicted: [], resolution: "no-conflict", needsSynthesis: false };
  const hasVersionMatched = sources.some((s) => s.versionMatch === true || s.versionMatch === "MATCHED");
  if (hasVersionMatched) {
    return { tracked, conflicted, resolution: "exact-installed-version-primary-wins", needsSynthesis: false };
  }
  const hasOfficial = sources.some((s) => s.provider === "official-docs");
  if (hasOfficial) {
    return { tracked, conflicted, resolution: "official-release-docs-preferred", needsSynthesis: conflicted.length > 1 };
  }
  const hasGitHub = sources.some((s) => s.provider === "github" || /github/.test(s.domain || ""));
  if (hasGitHub) {
    return { tracked, conflicted, resolution: "upstream-github-preferred", needsSynthesis: true };
  }
  return { tracked, conflicted, resolution: "one-bounded-extra-fetch-then-synthesis", needsSynthesis: true };
}

/**
 * Build the bounded ResearchCapsule (default hard cap 8000 chars, prefer much
 * smaller: 2-5 facts, 1-3 source IDs, version relation, recommendation, risk).
 * Full bytes stay in EvidenceStore; the model sees a bounded extract.
 */
export function buildResearchCapsule({ brief, versionJoin, sources = [], claims = [], conflicts = [], recommendation = "", risks = [], stopReason = "ANSWERED" } = {}) {
  const facts = trackClaims(claims, sources)
    .filter((c) => c.status === CLAIM_STATUS.SUPPORTED || c.status === CLAIM_STATUS.PARTIALLY_SUPPORTED)
    .slice(0, 5);
  const sourceIds = sources.filter((s) => !s.deduped).map((s) => s.sourceId || s.contentHash?.slice(0, 16)).filter(Boolean).slice(0, 3);
  const lines = [
    `research:${brief?.briefId || "nobrief"} class:${brief?.researchClass || "LOCAL_ONLY"} stop:${stopReason}`,
    `version:${versionJoin?.package || "?"} installed:${versionJoin?.installedVersion ?? "?"} latest:${versionJoin?.latestVersion ?? "?"} relation:${versionJoin?.versionRelation || "UNKNOWN"}`,
    ...facts.map((f) => `- ${f.text} [${f.status} ${f.sourceIds.join(",")}]`),
    `sources:${sourceIds.join(",") || "none"}`,
    `recommendation:${String(recommendation || "follow-installed-version").slice(0, 400)}`,
    ...(risks.length ? [`risks:${risks.slice(0, 2).join("; ").slice(0, 300)}`] : []),
    ...(conflicts.length ? [`conflicts:${conflicts.length}-unresolved-exposed`] : []),
  ];
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > RESEARCH_BROKER_CAPSULE_MAX_CHARS) {
    text = text.slice(0, RESEARCH_BROKER_CAPSULE_MAX_CHARS);
    truncated = true;
  }
  return {
    schemaVersion: RESEARCH_BROKER_SCHEMA_VERSION,
    policy: RESEARCH_BROKER_POLICY,
    capsuleChars: text.length,
    truncated,
    overBudget: truncated,
    text,
    facts: facts.length,
    sourcesUsed: sourceIds,
    pinned: true,
  };
}

/**
 * Decision Barrier: before source mutation when external research matters,
 * verify workspace generation, version facts, task match, run freshness.
 */
export function checkDecisionBarrier({ workspaceGeneration, observedGeneration, versionJoin, briefVersionKey, runCancelled = false, runStale = false } = {}) {
  if (runCancelled) return { allowed: false, reason: "STALE:run-cancelled", failure: "STALE" };
  if (runStale) return { allowed: false, reason: "STALE:research-run-stale", failure: "STALE" };
  if (workspaceGeneration != null && observedGeneration != null && workspaceGeneration !== observedGeneration) {
    return { allowed: false, reason: "STALE:workspace-mutated-during-research", failure: "STALE" };
  }
  if (briefVersionKey != null && versionJoin?.installedVersion != null && briefVersionKey !== String(versionJoin.installedVersion)) {
    return { allowed: false, reason: "STALE:version-facts-changed", failure: "STALE" };
  }
  return { allowed: true, reason: "decision-barrier-satisfied" };
}

export function createExternalResearchBroker(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    evidenceRoot = process.cwd(),
    cacheDir = null,
    now = () => Date.now(),
    synthesizeVia = null,
    githubToken = process.env.UES_RESEARCH_GITHUB_TOKEN || null,
    onEvent = null,
  } = options;
  const emit = (event) => {
    try {
      onEvent?.(event);
    } catch {
      // never throw from telemetry
    }
  };

  async function runProviderFetch(url, meta = {}) {
    // Cache policy: fresh cache avoids network, normalization, synthesis.
    const freshnessClass = meta.freshnessClass || "VERSIONED_DOC";
    const key = researchCacheKey({
      canonicalUrl: (() => {
        try {
          return canonicalizeUrl(url);
        } catch {
          return String(url);
        }
      })(),
      provider: meta.provider || "page-fetch",
      freshnessClass,
      installedVersion: meta.installedVersion || "",
      contentTarget: meta.contentTarget || "",
    });
    if (cacheDir && meta.forceFresh !== true) {
      try {
        const cached = await readResearchCache(cacheDir, key, {
          now: typeof now === "function" ? now() : Date.now(),
          revalidate: meta.revalidate === true,
        });
        if (cached.hit) {
          emit({ type: "cache-hit", key, provider: meta.provider });
          return {
            ok: true,
            fromCache: true,
            cacheKey: key,
            source: {
              sourceId: cached.entry.contentHash?.slice(0, 16) || key.slice(-12),
              provider: meta.provider,
              sourceType: "EXTERNAL_EVIDENCE",
              canonicalUrl: cached.entry.canonicalUrl,
              title: "cached-source",
              domain: (() => {
                try {
                  return new URL(cached.entry.canonicalUrl).hostname;
                } catch {
                  return "";
                }
              })(),
              contentHash: cached.entry.contentHash,
              excerptHash: cached.entry.excerptHash,
              excerpt: cached.entry.excerpt,
              fullContentEvidenceRef: cached.entry.evidenceRef,
              freshness: cached.entry.freshnessClass,
              etag: cached.entry.etag || null,
              lastModified: cached.entry.lastModified || null,
              trustClass: "external-data",
              instructionAuthority: "none",
            },
          };
        }
        // STALE entry with a validator: attempt a cheap conditional GET so an
        // unchanged body becomes a 304 (reuse) instead of a full re-download.
        if (
          cached.entry
          && meta.revalidate !== false
          && (cached.entry.etag || cached.entry.lastModified)
          && cached.reason === "STALE"
        ) {
          const conditional = revalidationHeadersFor(cached.entry);
          const probe = await fetchAndNormalize(url, {
            fetchImpl,
            evidenceRoot,
            visited: meta.visited,
            requestId: meta.requestId,
            queryId: meta.queryId,
            provider: meta.provider,
            now: () => new Date().toISOString(),
            githubToken: meta.githubToken ?? null,
            signal: meta.signal ?? null,
            conditionalHeaders: conditional,
          });
          if (probe.ok && probe.notModified) {
            const touched = await touchResearchCache(cacheDir, key, { now: typeof now === "function" ? now() : Date.now() });
            const entry = touched.entry || cached.entry;
            emit({ type: "cache-revalidated-304", key, provider: meta.provider });
            return {
              ok: true,
              fromCache: true,
              revalidated: true,
              cacheKey: key,
              source: {
                sourceId: entry.contentHash?.slice(0, 16) || key.slice(-12),
                provider: meta.provider,
                sourceType: "EXTERNAL_EVIDENCE",
                canonicalUrl: entry.canonicalUrl,
                title: "revalidated-source",
                domain: (() => {
                  try {
                    return new URL(entry.canonicalUrl).hostname;
                  } catch {
                    return "";
                  }
                })(),
                contentHash: entry.contentHash,
                excerptHash: entry.excerptHash,
                excerpt: entry.excerpt,
                fullContentEvidenceRef: entry.evidenceRef,
                freshness: entry.freshnessClass,
                etag: entry.etag || null,
                lastModified: entry.lastModified || null,
                trustClass: "external-data",
                instructionAuthority: "none",
              },
            };
          }
        }
      } catch {
        // corruption -> MISS is handled inside the helper; a throw here is
        // treated as MISS too.
      }
    }
    const started = typeof now === "function" ? now() : Date.now();
    const result = await fetchAndNormalize(url, {
      fetchImpl,
      evidenceRoot,
      visited: meta.visited,
      requestId: meta.requestId,
      queryId: meta.queryId,
      provider: meta.provider,
      now: () => new Date().toISOString(),
      githubToken: meta.githubToken ?? null,
      signal: meta.signal ?? null,
    });
    const wallMs = (typeof now === "function" ? now() : Date.now()) - started;
    if (result.ok && !result.deduped && cacheDir && result.source) {
      try {
        await writeResearchCache(cacheDir, key, {
          freshnessClass,
          canonicalUrl: result.source.canonicalUrl,
          provider: meta.provider,
          evidenceRef: result.source.fullContentEvidenceRef,
          contentHash: result.source.contentHash,
          excerptHash: result.source.excerptHash,
          excerpt: result.source.excerpt,
          etag: result.source.etag || null,
          lastModified: result.source.lastModified || null,
        }, { now: typeof now === "function" ? now() : Date.now(), ttlMs: ttlForFreshness(freshnessClass) });
      } catch {
        // cache write failure never fails research
      }
    }
    return { ...result, cacheKey: key, wallMs };
  }

  /**
   * Production research composition. LOCAL_ONLY returns zero-network
   * immediately. Otherwise: version join -> route -> parallel Official+GitHub
   * with soft/hard deadlines -> first-sufficient cancellation -> generic
   * fallback only if needed -> DeepSeek synthesis only on conflict ->
   * ResearchCapsule + stop reason.
   */
  async function runResearch(input = {}) {
    const startedAt = typeof now === "function" ? now() : Date.now();
    const timings = {};
    const counts = {
      networkCalls: 0,
      providerCalls: 0,
      candidateCount: 0,
      fetchedCount: 0,
      cancelledFetchCount: 0,
      cancelledProviderCalls: 0,
      cancelLatencyMs: null,
      dedupedCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      // V16.14 byte/char honesty: `bytesRetrieved` and `bytesSentToModel` are
      // UTF-8 BYTE counts (Buffer.byteLength). The matching `chars*` fields are
      // JS string lengths. They are separate numbers on purpose: a char is not a
      // byte and neither is a token.
      bytesRetrieved: 0,
      charsRetrieved: 0,
      bytesSentToModel: 0,
      charsSentToModel: 0,
      sourcesUsed: 0,
      browserLaunchCount: 0,
      deepseekCallCount: 0,
      deepseekSkippedCount: 0,
      providerTokenProvenance: PROVIDER_TOKEN_PROVENANCE.NOT_MEASURED,
      providerPromptTokens: null,
      providerCompletionTokens: null,
      providerTotalTokens: null,
      synthesisInputBytes: 0,
    };
    const task = input.task || {};
    const admissionT0 = typeof now === "function" ? now() : Date.now();
    const admission = input.admission || decideResearchAdmission(task);
    timings.admissionMs = (typeof now === "function" ? now() : Date.now()) - admissionT0;

    // LAW P1 + PI_ONLY zero egress: LOCAL_ONLY hydrates nothing and calls nothing.
    if (admission.researchClass === RESEARCH_CLASS.LOCAL_ONLY || task.piOnly === true) {
      return {
        policy: RESEARCH_BROKER_POLICY,
        admission,
        brief: null,
        versionJoin: null,
        sources: [],
        claims: [],
        capsule: null,
        stopReason: "LOCAL_PROOF_SUPERSEDES",
        counts,
        timings: { ...timings, researchTotalMs: 0 },
        provenance: buildResearchProvenance(counts),
        wasteSignals: [],
        verdict: "NOT_AVAILABLE",
      };
    }

    const brief = input.brief || buildResearchBrief({ ...input, task, researchClass: admission.researchClass });
    const budget = RESEARCH_BUDGETS[brief.researchClass] || RESEARCH_BUDGETS[RESEARCH_CLASS.CURRENT_WEB_RESEARCH];
    const versionT0 = typeof now === "function" ? now() : Date.now();
    const versionJoin = input.versionJoin || joinVersions({
      package: input.package || task.package,
      installedVersion: input.installedVersion || task.installedVersion,
      latestVersion: input.latestVersion || task.latestVersion,
      latestSource: input.latestSource,
      versionMatchedSource: input.versionMatchedSource,
      upgradeRequested: task.upgradeRequested === true,
    });
    timings.versionJoinMs = (typeof now === "function" ? now() : Date.now()) - versionT0;

    // Outbound privacy gate on the question before any egress.
    const privacy = classifyOutboundQuery(brief.question || task.question || "");
    if (privacy.verdict === "DENY_EXTERNAL") {
      return {
        policy: RESEARCH_BROKER_POLICY,
        admission,
        brief,
        versionJoin,
        sources: [],
        claims: [],
        capsule: null,
        stopReason: "CANCELLED",
        cancelReason: `privacy-deny:${privacy.reason}`,
        counts,
        timings: { ...timings, researchTotalMs: 0 },
        provenance: buildResearchProvenance(counts),
        wasteSignals: [],
        verdict: "NOT_AVAILABLE",
      };
    }

    const visited = ensureVisited(input.visited);
    const hardDeadlineMs = Number(input.hardResearchMs ?? brief.maxWallMs ?? budget.hardResearchMs ?? 30000);
    const hardStarted = typeof now === "function" ? now() : Date.now();
    const hardExpired = () => (typeof now === "function" ? now() : Date.now()) - hardStarted > hardDeadlineMs;

    // Local read-only prep overlaps provider I/O (LAW P3). Writes are fenced.
    const overlap = planSafeOverlap(brief, input.localPrep || { kinds: ["repo-inspection", "package-detection", "cache-lookup"] });
    let localPrepResult = null;
    const localPrepT0 = typeof now === "function" ? now() : Date.now();
    const localPrepPromise = (async () => {
      if (typeof input.localPrep?.run === "function" && overlap.overlapAllowed) {
        return input.localPrep.run();
      }
      return null;
    })();

    const routing = routeProviders(brief, {
      githubRelevant: input.githubRelevant,
      genericNeeded: false,
      primaryInsufficient: false,
      synthesisNeeded: false,
    });
    const sources = [];
    const candidates = [];
    let contentChars = 0;
    let stopReason = null;
    const wasteSignals = [];
    const controller = new AbortController();
    const outstanding = new Set();
    // V16.17 hard-deadline guard: once the provider phase is terminal (hard
    // deadline fired, or provider I/O completed), late-settling provider work
    // must not mutate the run. captureSource/noteSourcesChanged below honor it.

    const sufficiency = () => isSufficientEvidence({
      versionMatched: versionJoin.exactVersionMatched || sources.some((s) => s.versionMatch === true || s.versionMatch === "MATCHED") || versionJoin.versionRelation === "EQUAL" || undefined,
      primarySourceObtained: sources.length > 0,
      importantClaimsSupported: sources.length > 0 && !sources.every((s) => s.deduped),
      noUnresolvedContradiction: input.unresolvedContradiction !== true,
      freshnessSatisfied: brief.freshnessRequirement === "UNKNOWN" || sources.some((s) => s.freshness),
    });

    /**
     * Capture a normalized source under the run's content budget.
     *
     * V16.14: the excerpt is bounded by CHARS (the capsule budget is a char
     * budget) while `bytesRetrieved` is a UTF-8 BYTE count of what the NETWORK
     * actually returned. Both numbers are recorded, separately and honestly, so
     * a downstream report can never mistake one for the other, and a cache hit
     * (zero network bytes) never inflates the byte total.
     */
    let providerPhaseOpen = true;
    function captureSource(source, { fromNetwork = true } = {}) {
      // Late provider callbacks after the terminal state are ignored, never
      // merged into a completed/cancelled run.
      if (!providerPhaseOpen) return null;
      const remaining = Math.max(0, brief.maxContentChars - contentChars);
      const excerpt = String(source?.excerpt || "").slice(0, Math.min(4000, remaining));
      contentChars += excerpt.length;
      source.excerpt = excerpt;
      counts.charsRetrieved += excerpt.length;
      if (fromNetwork) counts.bytesRetrieved += utf8Bytes(excerpt);
      sources.push(source);
      return source;
    }

    async function runOfficial() {
      const target = resolveOfficialTarget({
        packageName: versionJoin.package,
        repository: input.repository,
        homepage: input.homepage,
        registry: input.registry,
        officialDomainOverride: input.officialDomainOverride,
      });
      if (target.unknown) return { skipped: true, reason: target.reason };
      const queries = buildOfficialQueries(brief, versionJoin, target).slice(0, brief.maxQueries);
      const out = [];
      const jobController = linkedController(controller);
      for (const q of queries) {
        if (hardExpired()) { jobController.abort("hard-deadline"); break; }
        if (sufficiency() && sources.length) {
          counts.cancelledFetchCount += 1;
          wasteSignals.push(RESEARCH_WASTE_SIGNAL.RESEARCH_AFTER_SUFFICIENT_EVIDENCE);
          break;
        }
        counts.providerCalls += 1;
        // Official resolution is metadata-driven. V16.14 NEVER fabricates a
        // `/docs/<version>` path unless a curated/explicit template proves the
        // convention; when no exact-version URL is known we record it honestly.
        const resolvedUrl = resolveOfficialDocUrl(target, versionJoin, input);
        if (!resolvedUrl) {
          out.push({ ok: false, failure: "EMPTY_RESULT", reason: "exact-version-doc-url-unavailable" });
          continue;
        }
        const url = resolvedUrl;
        const check = checkUrlAllowed(url);
        if (!check.allowed) {
          out.push({ ok: false, failure: "BLOCKED_POLICY", reason: check.reason });
          continue;
        }
        const task1 = runProviderFetch(url, {
          provider: "official-docs",
          visited,
          requestId: brief.briefId,
          queryId: stableId([q.query]),
          freshnessClass: "VERSIONED_DOC",
          installedVersion: versionJoin.installedVersion || "",
          forceFresh: input.forceFresh === true,
          revalidate: input.revalidate === true,
          signal: jobController.signal,
          githubToken: null,
        });
        outstanding.add(task1);
        try {
          const softMs = budget.softProviderMs || 2500;
          const res = await withTimeoutAbort(task1, softMs + 2000, "TIMEOUT", () => jobController.abort("soft-deadline"));
          // Terminal state: a late-settling provider task is ignored entirely
          // (no sources, no counts, no fallback) once the phase is closed.
          if (!providerPhaseOpen) break;
          if (res.deduped) {
            counts.dedupedCount += 1;
          } else if (res.fromCache && res.ok && res.source) {
            counts.cacheHits += 1;
            captureSource(res.source, { fromNetwork: false });
            noteSourcesChanged();
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else if (res.ok && res.source) {
            counts.networkCalls += 1;
            counts.cacheMisses += 1;
            const vm = evaluateOfficialVersionMatch(res.source, versionJoin);
            res.source.versionMatch = vm.versionMatch === "MATCHED";
            captureSource(res.source);
            counts.fetchedCount += 1;
            noteSourcesChanged();
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else {
            if (res.failure === "CANCELLED") { counts.cancelledFetchCount += 1; break; }
            counts.networkCalls += 1;
            const fallback = selectFallback("official-docs", brief, { kind: res.failure, idempotent: true, attempts: 0 });
            emit({ type: "provider-fallback", from: "official-docs", fallback });
          }
        } catch (error) {
          out.push({ ok: false, failure: error?.researchFailure || "TIMEOUT", reason: String(error?.message || error) });
        } finally {
          outstanding.delete(task1);
        }
        if (contentChars >= brief.maxContentChars) {
          stopReason = stopReason || RESEARCH_STOP_REASON.CONTENT_BUDGET;
          break;
        }
      }
      return { results: out };
    }

    async function runGitHub() {
      const repoRef = input.repoRef || {};
      const queries = buildGitHubQueries(brief, repoRef).slice(0, brief.maxQueries);
      const out = [];
      const jobController = linkedController(controller);
      for (const q of queries) {
        if (hardExpired()) { jobController.abort("hard-deadline"); break; }
        if (sufficiency() && sources.length) {
          counts.cancelledFetchCount += 1;
          wasteSignals.push(RESEARCH_WASTE_SIGNAL.RESEARCH_AFTER_SUFFICIENT_EVIDENCE);
          break;
        }
        if (!q.url) {
          candidates.push(toCandidateSource({ title: q.query, url: "", snippet: q.query, provider: "github", queryId: brief.briefId }));
          counts.candidateCount += 1;
          continue;
        }
        counts.providerCalls += 1;
        // The GitHub token is attached ONLY to approved GitHub hosts. The token
        // is scoped INSIDE page-fetch (researchHeadersForUrl), which applies the
        // header to the actual request. A cross-host redirect strips it.
        const task1 = runProviderFetch(q.url, {
          provider: "github",
          visited,
          requestId: brief.briefId,
          queryId: stableId([q.kind, q.url]),
          freshnessClass: q.kind === "issues" ? "ISSUE" : "RELEASE",
          installedVersion: versionJoin.installedVersion || "",
          forceFresh: input.forceFresh === true,
          revalidate: input.revalidate === true,
          signal: jobController.signal,
          githubToken,
        });
        outstanding.add(task1);
        try {
          const softMs = budget.softProviderMs || 4000;
          const res = await withTimeoutAbort(task1, softMs + 2000, "TIMEOUT", () => jobController.abort("soft-deadline"));
          // Terminal state: a late-settling provider task is ignored entirely.
          if (!providerPhaseOpen) break;
          if (res.deduped) {
            counts.dedupedCount += 1;
          } else if (res.fromCache && res.ok && res.source) {
            counts.cacheHits += 1;
            captureSource(res.source, { fromNetwork: false });
            noteSourcesChanged();
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else if (res.ok && res.source && !res.fromCache) {
            counts.networkCalls += 1;
            counts.cacheMisses += 1;
            captureSource(res.source);
            counts.fetchedCount += 1;
            noteSourcesChanged();
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else if (res.failure === "RATE_LIMIT") {
            counts.networkCalls += 1;
            emit({ type: "github-rate-limit-fallback" });
            break;
          } else if (res.failure === "CANCELLED") {
            counts.cancelledFetchCount += 1;
            break;
          } else {
            counts.networkCalls += 1;
            const failure = classifyGitHubFailure({ status: 0, body: res.reason });
            void failure;
          }
        } catch (error) {
          out.push({ ok: false, failure: error?.researchFailure || "TIMEOUT", reason: String(error?.message || error) });
        } finally {
          outstanding.delete(task1);
        }
        if (contentChars >= brief.maxContentChars) {
          stopReason = stopReason || RESEARCH_STOP_REASON.CONTENT_BUDGET;
          break;
        }
      }
      return { results: out };
    }

    // Parallel provider rule: Official + GitHub may execute concurrently
    // when both read-only, relevant, budgets permit. Bounded race of 2.
    //
    // V16.14 TRUE CANCELLATION: we do NOT wait for every provider to settle
    // before using already-sufficient evidence. A sufficiency watcher aborts the
    // shared controller the MOMENT the first sufficient source is captured, so
    // surplus provider work (and its sockets) stops immediately.
    const parallelT0 = typeof now === "function" ? now() : Date.now();
    const wantOfficial = routing.ordered.some((r) => r.provider === "official-docs");
    const wantGitHub = routing.ordered.some((r) => r.provider === "github");
    let resolveSufficient = null;
    const sufficientPromise = new Promise((resolve) => { resolveSufficient = resolve; });
    const noteSourcesChanged = () => {
      if (!providerPhaseOpen) return;
      if (!stopReason && sufficiency() && sources.length) {
        stopReason = RESEARCH_STOP_REASON.ANSWERED;
        const cancelT0 = typeof now === "function" ? now() : Date.now();
        try { controller.abort("first-sufficient-evidence"); } catch { /* ignore */ }
        counts.cancelLatencyMs = Math.max(0, (typeof now === "function" ? now() : Date.now()) - cancelT0);
        resolveSufficient?.({ reason: "first-sufficient-evidence" });
      }
    };
    const jobs = [];
    if (wantOfficial) jobs.push(runOfficial());
    if (wantGitHub) jobs.push(runGitHub());
    // V16.17 HARD-DEADLINE ENFORCEMENT: the hard deadline used to be polled
    // only at provider-loop tops, so a hung provider (a fetch that never
    // settles and ignores abort) parked runResearch forever and even drained
    // the event loop through an unref'd soft timer. The deadline is now a
    // real once-only owner: it fires exactly once, aborts every owned
    // outstanding request, closes the provider phase against late writes,
    // and settles this race so runResearch ALWAYS returns. The timer is
    // intentionally REF'd (the operation is logically pending until the
    // deadline settles it) and is cleared the moment the race settles, so it
    // never holds the loop open past this run.
    let hardDeadlineFired = false;
    let hardTimer = null;
    const hardDeadlinePromise = new Promise((resolve) => {
      const fire = () => {
        hardTimer = null;
        if (hardDeadlineFired) return;
        hardDeadlineFired = true;
        try { controller.abort("hard-deadline"); } catch { /* ignore: abort is idempotent */ }
        resolve({ reason: "hard-deadline" });
      };
      const ms = hardDeadlineMs;
      hardTimer = setTimeout(fire, Number.isFinite(ms) && ms > 0 ? ms : 0);
    });
    // Race: whichever happens first - all providers settling, the first
    // sufficient evidence arriving (which aborts the rest), or the hard
    // deadline firing (which aborts everything and closes the phase).
    let raceOutcome = null;
    try {
      raceOutcome = await Promise.race([
        Promise.allSettled([...jobs]).then(() => "providers-settled"),
        sufficientPromise,
        hardDeadlinePromise.then(() => "hard-deadline"),
      ]);
    } finally {
      if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
    }
    if (raceOutcome === "hard-deadline" && !stopReason) {
      stopReason = RESEARCH_STOP_REASON.HARD_DEADLINE;
      counts.cancelledFetchCount += outstanding.size;
      outstanding.clear();
      emit({ type: "hard-deadline", deadlineMs: hardDeadlineMs, briefId: brief.briefId });
    }
    // From here on, late-settling provider work is owned by nobody: the
    // phase is closed on the deadline path, and closed again after the
    // generic fallback below so the sufficiency path cannot leak late writes
    // into the returned result either.
    if (raceOutcome === "hard-deadline") providerPhaseOpen = false;
    // local prep is read-only and independent: settle it without blocking on it.
    localPrepResult = await Promise.resolve(localPrepPromise).catch(() => null);
    timings.localPrepMs = (typeof now === "function" ? now() : Date.now()) - localPrepT0;
    timings.searchMs = (typeof now === "function" ? now() : Date.now()) - parallelT0;
    void localPrepResult;

    // First-sufficient check: Official (+GitHub) sufficient -> generic web
    // never starts; maxSources is not auto-filled.
    if (!stopReason && sufficiency()) stopReason = RESEARCH_STOP_REASON.ANSWERED;
    if (stopReason === RESEARCH_STOP_REASON.ANSWERED && outstanding.size) {
      counts.cancelledFetchCount += outstanding.size;
      try {
        controller.abort("first-sufficient-evidence");
      } catch {
        // ignore
      }
      outstanding.clear();
    }

    // Generic fallback only if primary insufficient and budget remains.
    let genericStarted = false;
    if (!stopReason && input.genericUrls?.length && sources.length < brief.maxSources && contentChars < brief.maxContentChars && !hardExpired()) {
      genericStarted = true;
      for (const url of input.genericUrls.slice(0, brief.maxQueries)) {
        if (hardExpired() || contentChars >= brief.maxContentChars || sources.length >= brief.maxSources) {
          stopReason = stopReason || (sources.length >= brief.maxSources ? RESEARCH_STOP_REASON.MAX_SOURCES : RESEARCH_STOP_REASON.CONTENT_BUDGET);
          break;
        }
        if (sufficiency()) {
          stopReason = RESEARCH_STOP_REASON.ANSWERED;
          counts.cancelledFetchCount += 1;
          break;
        }
        counts.providerCalls += 1;
        const genericController = linkedController(controller);
        const res = await withTimeoutAbort(
          runProviderFetch(url, {
            provider: "generic-search",
            visited,
            requestId: brief.briefId,
            freshnessClass: "CURRENT_WEB",
            installedVersion: versionJoin.installedVersion || "",
            forceFresh: input.forceFresh === true,
            revalidate: input.revalidate === true,
            signal: genericController.signal,
            githubToken: null,
          }),
          budget.softProviderMs || 5000,
          "TIMEOUT",
          () => genericController.abort("soft-deadline"),
        ).catch((error) => ({ ok: false, failure: error?.researchFailure || "TIMEOUT", reason: String(error?.message || error) }));
        if (res.deduped) {
          counts.dedupedCount += 1;
          continue;
        }
        if (res.failure === "CANCELLED") {
          counts.cancelledFetchCount += 1;
          break;
        }
        if (res.fromCache && res.ok && res.source) {
          counts.cacheHits += 1;
          captureSource(res.source, { fromNetwork: false });
          continue;
        }
        if (res.ok && res.source) {
          counts.networkCalls += 1;
          counts.cacheMisses += 1;
          captureSource(res.source);
          counts.fetchedCount += 1;
          continue;
        }
        counts.networkCalls += 1;
      }
      if (!stopReason && sufficiency()) stopReason = RESEARCH_STOP_REASON.ANSWERED;
    }
    void genericStarted;
    // Provider I/O is over: close the phase so any still-parked provider task
    // that settles later cannot mutate the returned run.
    providerPhaseOpen = false;

    // Claims + contradictions from captured evidence.
    const claims = trackClaims(input.claims || [], sources);
    const resolution = resolveContradictions(input.claims || [], sources, versionJoin);
    const needsSynthesis = shouldCallDeepSeek({
      unresolvedContradiction: resolution.conflicted.length > 0,
      hardArchitecturalUncertainty: input.hardArchitecturalUncertainty === true,
      incompletePrimaryEvidence: input.incompletePrimaryEvidence === true || (sources.length === 0 && !stopReason),
      multipleCredibleAlternatives: input.multipleCredibleAlternatives === true,
      userRequestedDeepResearch: brief.researchClass === RESEARCH_CLASS.DEEP_RESEARCH || brief.researchClass === RESEARCH_CLASS.ADVISOR_SYNTHESIS,
    }) && (resolution.needsSynthesis || resolution.conflicted.length > 0 || input.userRequestedDeepResearch === true);

    let synthesis = null;
    if (needsSynthesis) {
      // V16.14 economy gate: `shouldCallDeepSeek` says synthesis is ALLOWED.
      // Before paying for a model turn we require the bounded input to actually
      // carry something to synthesize. An empty input is recorded as waste and
      // the call count stays 0.
      const economy = planDeepSeekEconomy({
        needsSynthesis: true,
        conflicted: resolution.conflicted.length,
        unknowns: Array.isArray(brief.unknowns) ? brief.unknowns.length : 0,
        verifiedFacts: sources.filter((s) => !s.deduped).length,
        hardArchitecturalUncertainty: input.hardArchitecturalUncertainty === true,
        multipleCredibleAlternatives: input.multipleCredibleAlternatives === true,
        userRequestedDeepResearch: input.userRequestedDeepResearch === true,
      });
      if (economy.wasteSignal) wasteSignals.push(economy.wasteSignal);
      if (economy.call && typeof synthesizeVia === "function" && !hardExpired()) {
        // DeepSeek gets ONLY small verified inputs: question, facts, version
        // facts, conflicts, unknowns, source IDs, small excerpts. Never full
        // pages, repos, browser state, or credentials.
        const synthT0 = typeof now === "function" ? now() : Date.now();
        const smallInput = {
          role: "RESEARCH_SYNTHESIZER",
          question: brief.question.slice(0, 1000),
          verifiedFacts: sources.slice(0, 3).map((s) => ({ sourceId: s.sourceId, excerpt: String(s.excerpt || "").slice(0, 800) })),
          versionFacts: { installed: versionJoin.installedVersion, latest: versionJoin.latestVersion, relation: versionJoin.versionRelation },
          conflicts: resolution.conflicted.slice(0, 4),
          unknowns: Array.isArray(brief.unknowns) ? brief.unknowns.slice(0, 8) : [],
          sourceIds: sources.slice(0, 3).map((s) => s.sourceId),
        };
        // The synthesis prompt is a CHAR string; the honest size metric is its
        // UTF-8 BYTE length. We record both so neither is mistaken for a token.
        const smallInputJson = JSON.stringify(smallInput);
        counts.synthesisInputBytes += utf8Bytes(smallInputJson);
        counts.bytesSentToModel += utf8Bytes(smallInputJson);
        counts.charsSentToModel += smallInputJson.length;
        try {
          const synthController = linkedController(controller);
          const out = await withTimeoutAbort(
            Promise.resolve().then(() => synthesizeVia(smallInput, { signal: synthController.signal })),
            budget.softSynthesisMs || 10000,
            "TIMEOUT",
            () => synthController.abort("soft-synthesis-deadline"),
          );
          counts.deepseekCallCount += 1;
          timings.synthesisMs = (typeof now === "function" ? now() : Date.now()) - synthT0;
          synthesis = out;
          // Provider token telemetry is MEASURED only when the synthesizer
          // reported real usage. A char count is never promoted to tokens.
          const usage = normalizeProviderUsage(out?.usage);
          if (usage.provenance === PROVIDER_TOKEN_PROVENANCE.MEASURED) {
            counts.providerTokenProvenance = PROVIDER_TOKEN_PROVENANCE.MEASURED;
            counts.providerPromptTokens = usage.promptTokens;
            counts.providerCompletionTokens = usage.completionTokens;
            counts.providerTotalTokens = usage.totalTokens;
          }
          if (Array.isArray(out?.claims)) {
            for (const c of out.claims) {
              claims.push({ id: c.id || stableId([c.text]), text: String(c.text || "").slice(0, 500), status: CLAIM_STATUS.UNVERIFIED_ADVISOR_CLAIM, sourceIds: [], fromDeepSeek: true });
            }
          }
        } catch {
          synthesis = { ok: false, failure: "TIMEOUT" };
        }
      } else if (economy.call && (input.userRequestedDeepResearch === true || resolution.conflicted.length > 0)) {
        // Synthesis permitted but no synthesizer wired: expose conflict.
        synthesis = { ok: false, reason: "synthesizer-not-wired-conflict-exposed" };
      } else if (!economy.call) {
        counts.deepseekSkippedCount += 1;
        synthesis = { ok: false, reason: economy.reason, skipped: true };
      }
    }
    if (!needsSynthesis) {
      // Supported primary evidence -> DeepSeek call count stays 0.
      counts.deepseekCallCount = 0;
    }

    if (!stopReason) {
      if (hardExpired()) stopReason = RESEARCH_STOP_REASON.HARD_DEADLINE;
      else if (sources.length >= brief.maxSources && brief.maxSources > 0) stopReason = RESEARCH_STOP_REASON.MAX_SOURCES;
      else if (sources.length) stopReason = RESEARCH_STOP_REASON.ANSWERED;
      else stopReason = RESEARCH_STOP_REASON.PROVIDER_EXHAUSTED;
    }

    counts.sourcesUsed = sources.filter((s) => !s.deduped).length;
    // Research NEVER produces PASS and never launches a browser on the
    // ordinary docs path.
    counts.browserLaunchCount = 0;

    const capsule = buildResearchCapsule({
      brief,
      versionJoin,
      sources,
      claims: input.claims || [],
      conflicts: resolution.conflicted,
      recommendation: input.recommendation || `implement-against-installed-${versionJoin.installedVersion || "unknown"}`,
      risks: input.risks || [],
      stopReason,
    });
    counts.bytesSentToModel += utf8Bytes(capsule.text);
    counts.charsSentToModel += capsule.text.length;
    // V16.14: an over-budget capsule is a real waste signal, not a silent clamp.
    if (capsule.overBudget) wasteSignals.push(RESEARCH_WASTE_SIGNAL.OVER_BUDGET_CAPSULE);

    const barrierT0 = typeof now === "function" ? now() : Date.now();
    const barrier = checkDecisionBarrier({
      workspaceGeneration: input.workspaceGeneration,
      observedGeneration: input.observedGeneration,
      versionJoin,
      briefVersionKey: String(versionJoin.installedVersion || ""),
      runCancelled: input.runCancelled === true,
      runStale: input.runStale === true,
    });
    timings.decisionBarrierMs = (typeof now === "function" ? now() : Date.now()) - barrierT0;
    timings.researchTotalMs = (typeof now === "function" ? now() : Date.now()) - startedAt;

    return {
      policy: RESEARCH_BROKER_POLICY,
      schemaVersion: RESEARCH_BROKER_SCHEMA_VERSION,
      admission,
      brief,
      versionJoin,
      routing,
      overlap,
      sources,
      candidates,
      claims,
      conflicts: resolution.conflicted,
      conflictResolution: resolution.resolution,
      synthesis,
      capsule,
      stopReason,
      barrier,
      counts,
      timings,
      // V16.14 honesty: `providerTokens` is MEASURED only when the provider
      // reported real usage for this run. Otherwise it stays NOT_MEASURED -
      // there is no char-derived fallback that could be mistaken for it.
      provenance: buildResearchProvenance(counts),
      wasteSignals,
      verdict: "NOT_AVAILABLE",
    };
  }

  /** Metric observations for Metrics V2 (producer only, never aggregates). */
  function toEfficiencyEvents(result = {}) {
    const c = result.counts || {};
    const t = result.timings || {};
    const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const events = [];
    const push = (operation, metrics, provenance) => {
      events.push({ kind: RESEARCH_METRIC_KIND, operation, metrics, provenance });
    };
    if (finite(c.networkCalls) != null) push("research-network-calls", { count: c.networkCalls }, { count: "MEASURED" });
    if (finite(c.fetchedCount) != null) push("research-fetched", { count: c.fetchedCount }, { count: "MEASURED" });
    if (finite(c.cacheHits) != null) push("research-cache-hits", { count: c.cacheHits }, { count: "MEASURED" });
    if (finite(c.cacheMisses) != null) push("research-cache-misses", { count: c.cacheMisses }, { count: "MEASURED" });
    if (finite(c.dedupedCount) != null) push("research-deduped", { count: c.dedupedCount }, { count: "MEASURED" });
    if (finite(c.deepseekCallCount) != null) push("research-deepseek-calls", { count: c.deepseekCallCount }, { count: "MEASURED" });
    if (finite(c.deepseekSkippedCount) != null) push("research-deepseek-skipped", { count: c.deepseekSkippedCount }, { count: "MEASURED" });
    if (finite(c.cancelledProviderCalls) != null) push("research-cancelled-provider-calls", { count: c.cancelledProviderCalls }, { count: "MEASURED" });
    if (finite(c.browserLaunchCount) != null) push("research-browser-launches", { count: c.browserLaunchCount }, { count: "MEASURED" });
    if (finite(t.researchTotalMs) != null) push("research-total-ms", { count: 1, wallMs: t.researchTotalMs }, { count: "MEASURED", wallMs: "MEASURED" });
    // Bytes are UTF-8 byte counts (Buffer.byteLength). Chars are separate rows:
    // a char is not a byte, and neither is a token.
    if (finite(c.bytesSentToModel) != null) push("research-bytes-to-model", { count: 1, bytes: c.bytesSentToModel }, { count: "MEASURED", bytes: "MEASURED" });
    if (finite(c.bytesRetrieved) != null) push("research-bytes-retrieved", { count: 1, bytes: c.bytesRetrieved }, { count: "MEASURED", bytes: "MEASURED" });
    if (finite(c.charsSentToModel) != null) push("research-chars-to-model", { count: 1, chars: c.charsSentToModel }, { count: "MEASURED", chars: "MEASURED" });
    // Provider tokens are emitted ONLY when the provider reported usage. An
    // unmeasured run produces NO token row at all (never a zero row, which a
    // downstream aggregate could mistake for "measured zero").
    if (c.providerTokenProvenance === PROVIDER_TOKEN_PROVENANCE.MEASURED && finite(c.providerTotalTokens) != null) {
      push("research-provider-tokens", {
        count: 1,
        inputTokens: finite(c.providerPromptTokens) ?? 0,
        outputTokens: finite(c.providerCompletionTokens) ?? 0,
        totalTokens: finite(c.providerTotalTokens),
      }, { count: "MEASURED", inputTokens: "MEASURED", outputTokens: "MEASURED", totalTokens: "MEASURED" });
    }
    // V16.14: a waste signal is an OBSERVATION, not a verdict. Each distinct
    // signal the run produced is emitted once with the occurrence count the run
    // MEASURED, so the V16.12 waste detector and Metrics V2 can see that the
    // runtime NOTICED this waste instead of the signal dying inside the broker.
    // This is still a producer row: aggregation stays in efficiency-metrics-v16-10,
    // and no row here carries a verdict.
    const signalCounts = new Map();
    for (const signal of Array.isArray(result.wasteSignals) ? result.wasteSignals : []) {
      const name = String(signal || "");
      if (!name) continue;
      signalCounts.set(name, (signalCounts.get(name) || 0) + 1);
    }
    for (const [signal, count] of signalCounts) {
      push(`research-waste:${signal}`, { count }, { count: "MEASURED" });
    }
    return events;
  }

  return {
    policy: RESEARCH_BROKER_POLICY,
    runResearch,
    toEfficiencyEvents,
  };
}

export const externalResearchBrokerExports = Object.freeze({
  createExternalResearchBroker,
  trackClaims,
  resolveContradictions,
  buildResearchCapsule,
  checkDecisionBarrier,
  planDeepSeekEconomy,
  normalizeProviderUsage,
  buildResearchProvenance,
  PROVIDER_TOKEN_PROVENANCE,
  HIGH_RISK_CLAIM_CLASSES,
});
