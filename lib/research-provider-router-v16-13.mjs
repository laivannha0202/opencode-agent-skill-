// V16.13 Provider router — POLICY OWNER B.
//
// Owns: capability matching, deterministic provider ordering, fallback
// selection. Does NOT own: provider implementation, evidence authority,
// fetch bodies, verification.
//
// PRIMARY SOURCES FIRST: LOCAL -> OFFICIAL_DOCS version matched -> GITHUB
// source/releases/issues -> optional Context7 -> GENERIC SEARCH ->
// selective fetch -> DeepSeek synthesis.

import { RESEARCH_CLASS } from "./research-brief-v16-13.mjs";

export const RESEARCH_ROUTER_POLICY = "research-provider-router-v16-13";
export const RESEARCH_ROUTER_SCHEMA_VERSION = 1;

export const RESEARCH_PROVIDER = Object.freeze({
  OFFICIAL_DOCS: "official-docs",
  GITHUB: "github",
  GENERIC_SEARCH: "generic-search",
  PAGE_FETCH: "page-fetch",
  DEEPSEEK_SYNTHESIS: "deepseek-synthesis",
  LOCAL_FALLBACK: "local-fallback",
});

export const PROVIDER_CAPABILITY = Object.freeze({
  VERSIONED_DOCS: "versioned-docs",
  SOURCE_RELEASES: "source-releases",
  ISSUES_PRS: "issues-prs",
  CURRENT_WEB: "current-web",
  SYNTHESIS: "synthesis",
});

/**
 * Deterministic provider ordering for a brief. Starts only the smallest
 * high-value set (typically Official + GitHub = 2 concurrent). Generic web
 * begins only if needed; DeepSeek only on conflict/incomplete/alternatives.
 */
export function routeProviders(brief = {}, state = {}) {
  const researchClass = brief.researchClass || RESEARCH_CLASS.LOCAL_ONLY;
  if (researchClass === RESEARCH_CLASS.LOCAL_ONLY) {
    return { ordered: [], reason: "local-only-no-provider", maxConcurrent: 0 };
  }
  const ordered = [];
  const push = (provider, reason, capabilities) => {
    ordered.push({ provider, reason, capabilities: Object.freeze([...capabilities]) });
  };
  if (researchClass === RESEARCH_CLASS.OFFICIAL_DOC_REQUIRED) {
    push(RESEARCH_PROVIDER.OFFICIAL_DOCS, "exact-version-primary-first", [PROVIDER_CAPABILITY.VERSIONED_DOCS]);
    if (state.githubRelevant === true || brief.targetSourceClasses?.includes("github")) {
      push(RESEARCH_PROVIDER.GITHUB, "repo-metadata-may-disambiguate-version", [PROVIDER_CAPABILITY.SOURCE_RELEASES]);
    }
  } else if (researchClass === RESEARCH_CLASS.GITHUB_RESEARCH) {
    push(RESEARCH_PROVIDER.GITHUB, "upstream-source-required", [PROVIDER_CAPABILITY.SOURCE_RELEASES, PROVIDER_CAPABILITY.ISSUES_PRS]);
    push(RESEARCH_PROVIDER.OFFICIAL_DOCS, "version-match-for-upstream-claim", [PROVIDER_CAPABILITY.VERSIONED_DOCS]);
  } else if (researchClass === RESEARCH_CLASS.CURRENT_WEB_RESEARCH) {
    push(RESEARCH_PROVIDER.OFFICIAL_DOCS, "primary-source-first", [PROVIDER_CAPABILITY.VERSIONED_DOCS]);
    push(RESEARCH_PROVIDER.GITHUB, "upstream-source-parallel", [PROVIDER_CAPABILITY.SOURCE_RELEASES]);
    if (state.genericNeeded === true || state.primaryInsufficient === true) {
      push(RESEARCH_PROVIDER.GENERIC_SEARCH, "primary-insufficient-generic-fallback", [PROVIDER_CAPABILITY.CURRENT_WEB]);
    }
  } else if (researchClass === RESEARCH_CLASS.DEEP_RESEARCH || researchClass === RESEARCH_CLASS.ADVISOR_SYNTHESIS) {
    push(RESEARCH_PROVIDER.OFFICIAL_DOCS, "primary-source-first", [PROVIDER_CAPABILITY.VERSIONED_DOCS]);
    push(RESEARCH_PROVIDER.GITHUB, "upstream-source-parallel", [PROVIDER_CAPABILITY.SOURCE_RELEASES, PROVIDER_CAPABILITY.ISSUES_PRS]);
    if (state.genericNeeded === true || state.primaryInsufficient === true) {
      push(RESEARCH_PROVIDER.GENERIC_SEARCH, "bounded-generic-fallback", [PROVIDER_CAPABILITY.CURRENT_WEB]);
    }
    if (state.synthesisNeeded === true) {
      push(RESEARCH_PROVIDER.DEEPSEEK_SYNTHESIS, "conflict-or-incomplete-primary", [PROVIDER_CAPABILITY.SYNTHESIS]);
    }
  }
  // Never fan out to every provider: cap the initial concurrent set at 2.
  const maxConcurrent = ordered.length > 2 ? 2 : ordered.length;
  return { ordered, reason: "primary-sources-first", maxConcurrent };
}

/**
 * Fallback selection after a typed failure. Same-provider automatic retry is
 * MAX 1 and only for idempotent operations (enforced by caller); here we pick
 * the alternate capable provider, else local fallback, else NOT_AVAILABLE.
 */
export function selectFallback(failedProvider, brief = {}, failure = {}) {
  const routes = routeProviders(brief, { genericNeeded: true, primaryInsufficient: true });
  const candidates = routes.ordered.map((r) => r.provider).filter((p) => p !== failedProvider);
  const retryable = new Set(["TIMEOUT", "HTTP_5XX", "RATE_LIMIT", "NETWORK_UNAVAILABLE", "PROVIDER_UNAVAILABLE"]);
  const canRetrySame = failure.idempotent === true
    && Number(failure.attempts || 0) < 1
    && retryable.has(String(failure.kind || ""));
  if (canRetrySame) {
    return { action: "retry-same-provider-once", provider: failedProvider, reason: "idempotent-transient" };
  }
  if (candidates.length) {
    return { action: "alternate-provider", provider: candidates[0], reason: "fallback-to-alternate-capable" };
  }
  return { action: "local-fallback", provider: RESEARCH_PROVIDER.LOCAL_FALLBACK, reason: "provider-exhausted-local-proof", stopReason: "PROVIDER_EXHAUSTED" };
}

export const researchRouterExports = Object.freeze({
  routeProviders,
  selectFallback,
});
