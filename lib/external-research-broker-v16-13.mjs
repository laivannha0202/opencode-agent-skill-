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
import { resolveOfficialTarget, buildOfficialQueries, evaluateOfficialVersionMatch } from "./research-provider-official-v16-13.mjs";
import { buildGitHubQueries, classifyGitHubFailure, authHeadersForHost } from "./research-provider-github-v16-13.mjs";
import { fetchAndNormalize, ensureVisited, toCandidateSource } from "./research-page-fetch-v16-13.mjs";
import { researchCacheKey, ttlForFreshness, readResearchCache, writeResearchCache } from "./research-cache-helper-v16-13.mjs";
import { canonicalizeUrl, checkUrlAllowed, classifyOutboundQuery } from "./research-network-policy-v16-13.mjs";
import { joinVersions } from "./research-version-join-v16-13.mjs";

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

export const CLAIM_STATUS = Object.freeze({
  SUPPORTED: "SUPPORTED",
  PARTIALLY_SUPPORTED: "PARTIALLY_SUPPORTED",
  CONFLICTED: "CONFLICTED",
  UNSUPPORTED: "UNSUPPORTED",
  UNVERIFIED_ADVISOR_CLAIM: "UNVERIFIED_ADVISOR_CLAIM",
});

function stableId(parts) {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 12);
}

function withTimeout(promise, ms, kind) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(kind), { researchFailure: kind })), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Track claims against captured sources. Every implementation-affecting claim
 * needs captured evidence for security/version/breaking topics. Model
 * confidence is NOT evidence; unsourced DeepSeek claims stay UNVERIFIED.
 */
export function trackClaims(claims = [], sources = []) {
  const byId = new Map(sources.map((s) => [s.sourceId || s.contentHash?.slice(0, 16), s]));
  return claims.map((claim, index) => {
    const sourceIds = Array.isArray(claim.sourceIds) ? claim.sourceIds : [];
    const supporting = sourceIds.filter((id) => byId.has(id));
    const text = String(claim.text || "").slice(0, 500);
    if (claim.fromDeepSeek === true && supporting.length === 0) {
      return { id: claim.id || `claim-${index}`, text, status: CLAIM_STATUS.UNVERIFIED_ADVISOR_CLAIM, sourceIds };
    }
    if (supporting.length === 0) return { id: claim.id || `claim-${index}`, text, status: CLAIM_STATUS.UNSUPPORTED, sourceIds };
    if (claim.conflicted === true) return { id: claim.id || `claim-${index}`, text, status: CLAIM_STATUS.CONFLICTED, sourceIds: supporting };
    if (supporting.length < sourceIds.length || claim.partial === true) {
      return { id: claim.id || `claim-${index}`, text, status: CLAIM_STATUS.PARTIALLY_SUPPORTED, sourceIds: supporting };
    }
    return { id: claim.id || `claim-${index}`, text, status: CLAIM_STATUS.SUPPORTED, sourceIds: supporting };
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
              excerpt: cached.entry.excerpt,
              fullContentEvidenceRef: cached.entry.evidenceRef,
              freshness: cached.entry.freshnessClass,
              trustClass: "external-data",
              instructionAuthority: "none",
            },
          };
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
          excerpt: result.source.excerpt,
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
      dedupedCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      bytesRetrieved: 0,
      bytesSentToModel: 0,
      sourcesUsed: 0,
      browserLaunchCount: 0,
      deepseekCallCount: 0,
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
        provenance: { timing: "MEASURED", providerTokens: "NOT_MEASURED" },
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
        provenance: { timing: "MEASURED", providerTokens: "NOT_MEASURED" },
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

    const sufficiency = () => isSufficientEvidence({
      versionMatched: versionJoin.exactVersionMatched || sources.some((s) => s.versionMatch === true || s.versionMatch === "MATCHED") || versionJoin.versionRelation === "EQUAL" || undefined,
      primarySourceObtained: sources.length > 0,
      importantClaimsSupported: sources.length > 0 && !sources.every((s) => s.deduped),
      noUnresolvedContradiction: input.unresolvedContradiction !== true,
      freshnessSatisfied: brief.freshnessRequirement === "UNKNOWN" || sources.some((s) => s.freshness),
    });

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
      for (const q of queries) {
        if (hardExpired()) break;
        if (sufficiency() && sources.length) {
          counts.cancelledFetchCount += 1;
          wasteSignals.push(RESEARCH_WASTE_SIGNAL.RESEARCH_AFTER_SUFFICIENT_EVIDENCE);
          break;
        }
        counts.providerCalls += 1;
        // Official resolution is metadata-driven; the fetch below is the
        // bounded primary fetch for the versioned doc URL when known.
        // Cache HIT and dedup avoid the network call entirely (LAW: cache HIT
        // must avoid network); only an actual fetch increments networkCalls.
        const url = input.officialDocUrl || `https://${target.domain}/docs/${versionJoin.installedVersion || ""}`.replace(/\/$/, "");
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
        });
        outstanding.add(task1);
        try {
          const softMs = budget.softProviderMs || 2500;
          const res = await withTimeout(task1, softMs + 2000, "TIMEOUT");
          if (res.deduped) {
            counts.dedupedCount += 1;
          } else if (res.fromCache && res.ok && res.source) {
            counts.cacheHits += 1;
            res.source.excerpt = String(res.source.excerpt || "").slice(0, Math.min(4000, Math.max(0, brief.maxContentChars - contentChars)));
            contentChars += res.source.excerpt.length;
            sources.push(res.source);
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
            res.source.excerpt = String(res.source.excerpt || "").slice(0, Math.min(4000, brief.maxContentChars - contentChars));
            contentChars += res.source.excerpt.length;
            counts.fetchedCount += 1;
            counts.bytesRetrieved += res.source.excerpt.length;
            sources.push(res.source);
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else {
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
      for (const q of queries) {
        if (hardExpired()) break;
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
        // Cache HIT and dedup avoid the network call entirely.
        const task1 = (async () => {
          const headers = authHeadersForHost(q.url, { token: githubToken });
          // Token scoping is enforced by authHeadersForHost; headers here
          // never carry credentials for non-GitHub hosts.
          void headers;
          return runProviderFetch(q.url, {
            provider: "github",
            visited,
            requestId: brief.briefId,
            queryId: stableId([q.kind, q.url]),
            freshnessClass: q.kind === "issues" ? "ISSUE" : "RELEASE",
            installedVersion: versionJoin.installedVersion || "",
            forceFresh: input.forceFresh === true,
          });
        })();
        outstanding.add(task1);
        try {
          const softMs = budget.softProviderMs || 4000;
          const res = await withTimeout(task1, softMs + 2000, "TIMEOUT");
          if (res.deduped) {
            counts.dedupedCount += 1;
          } else if (res.fromCache && res.ok && res.source) {
            counts.cacheHits += 1;
            res.source.excerpt = String(res.source.excerpt || "").slice(0, Math.min(4000, Math.max(0, brief.maxContentChars - contentChars)));
            contentChars += res.source.excerpt.length;
            sources.push(res.source);
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else if (res.ok && res.source && !res.fromCache) {
            counts.networkCalls += 1;
            counts.cacheMisses += 1;
            res.source.excerpt = String(res.source.excerpt || "").slice(0, Math.min(4000, Math.max(0, brief.maxContentChars - contentChars)));
            contentChars += res.source.excerpt.length;
            counts.fetchedCount += 1;
            counts.bytesRetrieved += res.source.excerpt.length;
            sources.push(res.source);
            out.push(res);
            if (sufficiency()) {
              stopReason = RESEARCH_STOP_REASON.ANSWERED;
              break;
            }
          } else if (res.failure === "RATE_LIMIT") {
            counts.networkCalls += 1;
            emit({ type: "github-rate-limit-fallback" });
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
    const parallelT0 = typeof now === "function" ? now() : Date.now();
    const wantOfficial = routing.ordered.some((r) => r.provider === "official-docs");
    const wantGitHub = routing.ordered.some((r) => r.provider === "github");
    const jobs = [];
    if (wantOfficial) jobs.push(runOfficial());
    if (wantGitHub) jobs.push(runGitHub());
    // Local prep overlaps here (read-only only); writes were fenced above.
    const prepAndProviders = await Promise.allSettled([localPrepPromise, ...jobs]);
    localPrepResult = prepAndProviders[0]?.status === "fulfilled" ? prepAndProviders[0].value : null;
    timings.localPrepMs = (typeof now === "function" ? now() : Date.now()) - localPrepT0;
    timings.searchMs = (typeof now === "function" ? now() : Date.now()) - parallelT0;
    void localPrepResult;

    // First-sufficient check: Official (+GitHub) sufficient -> generic web
    // never starts; maxSources is not auto-filled.
    if (!stopReason && sufficiency()) stopReason = RESEARCH_STOP_REASON.ANSWERED;
    if (stopReason === RESEARCH_STOP_REASON.ANSWERED && outstanding.size) {
      counts.cancelledFetchCount += outstanding.size;
      try {
        controller.abort();
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
        const res = await runProviderFetch(url, {
          provider: "generic-search",
          visited,
          requestId: brief.briefId,
          freshnessClass: "CURRENT_WEB",
          installedVersion: versionJoin.installedVersion || "",
          forceFresh: input.forceFresh === true,
        });
        if (res.deduped) {
          counts.dedupedCount += 1;
          continue;
        }
        if (res.fromCache && res.ok && res.source) {
          counts.cacheHits += 1;
          res.source.excerpt = String(res.source.excerpt || "").slice(0, Math.min(4000, Math.max(0, brief.maxContentChars - contentChars)));
          contentChars += res.source.excerpt.length;
          sources.push(res.source);
          continue;
        }
        if (res.ok && res.source) {
          counts.networkCalls += 1;
          counts.cacheMisses += 1;
          res.source.excerpt = String(res.source.excerpt || "").slice(0, Math.min(4000, Math.max(0, brief.maxContentChars - contentChars)));
          contentChars += res.source.excerpt.length;
          counts.fetchedCount += 1;
          counts.bytesRetrieved += res.source.excerpt.length;
          sources.push(res.source);
          continue;
        }
        counts.networkCalls += 1;
      }
      if (!stopReason && sufficiency()) stopReason = RESEARCH_STOP_REASON.ANSWERED;
    }
    void genericStarted;

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
      if (typeof synthesizeVia === "function" && !hardExpired()) {
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
        counts.bytesSentToModel += JSON.stringify(smallInput).length;
        try {
          const out = await withTimeout(
            Promise.resolve().then(() => synthesizeVia(smallInput, { signal: controller.signal })),
            budget.softSynthesisMs || 10000,
            "TIMEOUT",
          );
          counts.deepseekCallCount += 1;
          timings.synthesisMs = (typeof now === "function" ? now() : Date.now()) - synthT0;
          synthesis = out;
          if (Array.isArray(out?.claims)) {
            for (const c of out.claims) {
              claims.push({ id: c.id || stableId([c.text]), text: String(c.text || "").slice(0, 500), status: CLAIM_STATUS.UNVERIFIED_ADVISOR_CLAIM, sourceIds: [], fromDeepSeek: true });
            }
          }
        } catch {
          synthesis = { ok: false, failure: "TIMEOUT" };
        }
      } else if (input.userRequestedDeepResearch === true || resolution.conflicted.length > 0) {
        // Synthesis permitted but no synthesizer wired: expose conflict.
        synthesis = { ok: false, reason: "synthesizer-not-wired-conflict-exposed" };
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
    counts.bytesSentToModel += capsule.text.length;

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
      provenance: { timing: "MEASURED", providerTokens: "NOT_MEASURED" },
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
    if (finite(c.browserLaunchCount) != null) push("research-browser-launches", { count: c.browserLaunchCount }, { count: "MEASURED" });
    if (finite(t.researchTotalMs) != null) push("research-total-ms", { count: 1, wallMs: t.researchTotalMs }, { count: "MEASURED", wallMs: "MEASURED" });
    if (finite(c.bytesSentToModel) != null) push("research-bytes-to-model", { count: 1, bytes: c.bytesSentToModel }, { count: "MEASURED", bytes: "MEASURED" });
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
});
