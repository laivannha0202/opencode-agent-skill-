// V16.13 ResearchBrief + deterministic admission — POLICY OWNER A.
//
// Owns: ResearchBrief schema, deterministic research class, bounded query
// plan, budgets, stop conditions. Does NOT own: network, cache bytes,
// provider execution, PASS.
//
// SPEED LAW: the fastest operation is the operation that does not run.
// Admission is DETERMINISTIC. Model confidence alone NEVER triggers research.

import { createHash } from "node:crypto";

export const RESEARCH_BRIEF_POLICY = "research-brief-v16-13";
export const RESEARCH_BRIEF_SCHEMA_VERSION = 1;
export const RESEARCH_SCHEMA_ID = "research-brief-v1";
export const RESEARCH_CAPSULE_MAX_CHARS = 8_000;

export const RESEARCH_CLASS = Object.freeze({
  LOCAL_ONLY: "LOCAL_ONLY",
  OFFICIAL_DOC_REQUIRED: "OFFICIAL_DOC_REQUIRED",
  GITHUB_RESEARCH: "GITHUB_RESEARCH",
  CURRENT_WEB_RESEARCH: "CURRENT_WEB_RESEARCH",
  DEEP_RESEARCH: "DEEP_RESEARCH",
  ADVISOR_SYNTHESIS: "ADVISOR_SYNTHESIS",
});

export const RESEARCH_STOP_REASON = Object.freeze({
  ANSWERED: "ANSWERED",
  MAX_QUERIES: "MAX_QUERIES",
  MAX_DEPTH: "MAX_DEPTH",
  MAX_SOURCES: "MAX_SOURCES",
  HARD_DEADLINE: "HARD_DEADLINE",
  CONTENT_BUDGET: "CONTENT_BUDGET",
  NO_NOVELTY: "NO_NOVELTY",
  DUPLICATE_RATIO: "DUPLICATE_RATIO",
  REPEATED_CLAIMS: "REPEATED_CLAIMS",
  PROVIDER_EXHAUSTED: "PROVIDER_EXHAUSTED",
  LOCAL_PROOF_SUPERSEDES: "LOCAL_PROOF_SUPERSEDES",
  CANCELLED: "CANCELLED",
  STALE: "STALE",
});

export const RESEARCH_FAILURE = Object.freeze({
  TIMEOUT: "TIMEOUT",
  RATE_LIMIT: "RATE_LIMIT",
  HTTP_5XX: "HTTP_5XX",
  BAD_SCHEMA: "BAD_SCHEMA",
  EMPTY_RESULT: "EMPTY_RESULT",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  NETWORK_UNAVAILABLE: "NETWORK_UNAVAILABLE",
  BLOCKED_POLICY: "BLOCKED_POLICY",
  OVERSIZED: "OVERSIZED",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE",
  CANCELLED: "CANCELLED",
  STALE: "STALE",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
});

// Speed-first budgets: TWO deadline layers. Soft = stop waiting/fallback when
// enough alternatives exist. Hard = absolute anti-hang boundary. Soft is
// latency policy, NOT a correctness deadline.
export const RESEARCH_BUDGETS = Object.freeze({
  [RESEARCH_CLASS.OFFICIAL_DOC_REQUIRED]: Object.freeze({
    softProviderMs: 2500,
    hardResearchMs: 15000,
    maxQueries: 2,
    maxSources: 3,
    maxDepth: 1,
    maxContentChars: 24000,
  }),
  [RESEARCH_CLASS.GITHUB_RESEARCH]: Object.freeze({
    softProviderMs: 4000,
    hardResearchMs: 30000,
    maxQueries: 3,
    maxSources: 5,
    maxDepth: 1,
    maxContentChars: 48000,
  }),
  [RESEARCH_CLASS.CURRENT_WEB_RESEARCH]: Object.freeze({
    softProviderMs: 5000,
    hardResearchMs: 30000,
    maxQueries: 3,
    maxSources: 5,
    maxDepth: 1,
    maxContentChars: 48000,
  }),
  [RESEARCH_CLASS.DEEP_RESEARCH]: Object.freeze({
    softProviderMs: 10000,
    softSynthesisMs: 10000,
    hardResearchMs: 90000,
    maxQueries: 6,
    maxSources: 8,
    maxDepth: 2,
    maxContentChars: 120000,
  }),
  [RESEARCH_CLASS.ADVISOR_SYNTHESIS]: Object.freeze({
    softProviderMs: 10000,
    softSynthesisMs: 10000,
    hardResearchMs: 90000,
    maxQueries: 6,
    maxSources: 8,
    maxDepth: 2,
    maxContentChars: 120000,
  }),
  [RESEARCH_CLASS.LOCAL_ONLY]: Object.freeze({
    softProviderMs: 0,
    hardResearchMs: 0,
    maxQueries: 0,
    maxSources: 0,
    maxDepth: 0,
    maxContentChars: 0,
  }),
});

const LOCAL_ONLY_PATTERNS = [
  /\btypo\b/i,
  /\bui label\b/i,
  /\btext label\b/i,
  /\bknown import error\b/i,
  /\bmechanical change\b/i,
  /\bone-?file\b/i,
  /\bobvious local bug\b/i,
  /\bfailing test.*identif/i,
];

function hasLocalSufficientSignal(task = {}) {
  const text = `${task.question || ""} ${task.taskText || ""} ${task.title || ""}`;
  if (task.trivialLocal === true || task.localGrounded === true) return true;
  if (task.piOnly === true) return true;
  if (task.existingFailingTestIdentifiesCause === true) return true;
  if (task.oneFileMechanical === true) return true;
  return LOCAL_ONLY_PATTERNS.some((re) => re.test(text)) && task.localEvidenceSufficient !== false
    && !hasExternalSignal(task);
}

function hasExternalSignal(task = {}) {
  const s = task.signals || task;
  return Boolean(
    s.unknownExternalApi
    || s.versionUncertainty
    || s.installedDependencyUncertainty
    || s.latestRequested
    || s.currentRequested
    || s.upstreamBugSuspected
    || s.releaseBreaking
    || s.breakingChangeInvestigation
    || s.cveQuestion
    || s.securityVersionQuestion
    || s.upstreamIssueLookup
    || s.localInsufficient
    || s.localEvidenceInsufficient
    || s.externalBehaviorUnknown
    || s.userRequestedDeepResearch
    || s.userRequestedResearch,
  );
}

/**
 * Deterministic admission. NEVER uses an LLM. Model confidence alone is NOT a
 * valid trigger and is ignored unless accompanied by a deterministic signal.
 *
 * @returns {{ researchClass: string, reason: string, briefNeeded: boolean, externalRequired: boolean }}
 */
export function decideResearchAdmission(task = {}) {
  // PI_ONLY and trivial/local-grounded tasks never research (LAW P1).
  if (task.piOnly === true || task.mode === "PI_ONLY") {
    return { researchClass: RESEARCH_CLASS.LOCAL_ONLY, reason: "pi-only-zero-egress", briefNeeded: false, externalRequired: false };
  }
  if (hasLocalSufficientSignal(task)) {
    return { researchClass: RESEARCH_CLASS.LOCAL_ONLY, reason: "local-evidence-sufficient", briefNeeded: false, externalRequired: false };
  }
  const s = task.signals || task;
  // Model confidence alone cannot trigger research.
  const onlyConfidence = Boolean(s.modelUncertain || s.modelConfidenceLow)
    && !hasExternalSignal({ signals: { ...s, modelUncertain: false, modelConfidenceLow: false } })
    && !hasExternalSignal(task);
  if (onlyConfidence) {
    return { researchClass: RESEARCH_CLASS.LOCAL_ONLY, reason: "model-confidence-alone-insufficient", briefNeeded: false, externalRequired: false };
  }
  if (s.userRequestedDeepResearch === true || s.deepResearchRequested === true) {
    return { researchClass: RESEARCH_CLASS.DEEP_RESEARCH, reason: "user-requested-deep-research", briefNeeded: true, externalRequired: true };
  }
  if (s.userRequestedAdvisorSynthesis === true) {
    return { researchClass: RESEARCH_CLASS.ADVISOR_SYNTHESIS, reason: "user-requested-synthesis", briefNeeded: true, externalRequired: true };
  }
  const wantsCurrent = Boolean(s.latestRequested || s.currentRequested);
  const wantsUpstream = Boolean(s.upstreamBugSuspected || s.upstreamIssueLookup || s.releaseBreaking || s.breakingChangeInvestigation);
  const wantsVersion = Boolean(s.versionUncertainty || s.installedDependencyUncertainty || s.securityVersionQuestion || s.cveQuestion);
  const wantsExternal = Boolean(s.unknownExternalApi || s.externalBehaviorUnknown || s.localInsufficient || s.localEvidenceInsufficient);
  if ((wantsCurrent || wantsUpstream) && (wantsVersion || wantsExternal)) {
    return { researchClass: RESEARCH_CLASS.DEEP_RESEARCH, reason: "current-plus-version-or-upstream", briefNeeded: true, externalRequired: true };
  }
  if (wantsCurrent || s.currentWebNeeded === true) {
    return { researchClass: RESEARCH_CLASS.CURRENT_WEB_RESEARCH, reason: "current-web-signal", briefNeeded: true, externalRequired: true };
  }
  if (wantsUpstream) {
    return { researchClass: RESEARCH_CLASS.GITHUB_RESEARCH, reason: "upstream-signal", briefNeeded: true, externalRequired: true };
  }
  if (wantsVersion || wantsExternal) {
    // Default external class prefers exact-version primary evidence first;
    // the router orders Official before GitHub before generic web.
    if (s.officialDocSignal === true || s.versionUncertainty === true || s.installedDependencyUncertainty === true) {
      return { researchClass: RESEARCH_CLASS.OFFICIAL_DOC_REQUIRED, reason: "version-or-official-doc-signal", briefNeeded: true, externalRequired: true };
    }
    return { researchClass: RESEARCH_CLASS.GITHUB_RESEARCH, reason: "external-evidence-signal", briefNeeded: true, externalRequired: true };
  }
  return { researchClass: RESEARCH_CLASS.LOCAL_ONLY, reason: "no-deterministic-external-signal", briefNeeded: false, externalRequired: false };
}

export function briefIdFor(question = "", researchClass = RESEARCH_CLASS.LOCAL_ONLY, versionKey = "") {
  const canonical = JSON.stringify([String(question || "").trim(), String(researchClass), String(versionKey || "")]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/**
 * Build a bounded ResearchBrief v1. Deterministic; no LLM.
 */
export function buildResearchBrief(input = {}) {
  const admission = input.researchClass
    ? { researchClass: input.researchClass, reason: input.admissionReason || "explicit-class" }
    : decideResearchAdmission(input.task || input);
  const researchClass = admission.researchClass;
  const budget = RESEARCH_BUDGETS[researchClass] || RESEARCH_BUDGETS[RESEARCH_CLASS.LOCAL_ONLY];
  const maxQueries = Math.max(0, Math.min(6, Number(input.maxQueries ?? budget.maxQueries ?? 0)));
  const maxDepth = Math.max(0, Math.min(2, Number(input.maxDepth ?? budget.maxDepth ?? 0)));
  const maxSources = Math.max(0, Math.min(8, Number(input.maxSources ?? budget.maxSources ?? 0)));
  const maxContentChars = Math.max(0, Number(input.maxContentChars ?? budget.maxContentChars ?? 0));
  const maxWallMs = Math.max(0, Number(input.maxWallMs ?? budget.hardResearchMs ?? 0));
  const question = String(input.question || input.task?.question || input.task?.taskText || "").slice(0, 2000);
  const versionKey = String(input.versionJoin?.installedVersion || input.task?.installedVersion || "");
  const briefId = briefIdFor(question, researchClass, versionKey);
  return {
    schemaVersion: RESEARCH_BRIEF_SCHEMA_VERSION,
    schemaId: RESEARCH_SCHEMA_ID,
    policy: RESEARCH_BRIEF_POLICY,
    briefId,
    question,
    researchClass,
    admissionReason: admission.reason,
    targetDomains: Array.isArray(input.targetDomains) ? input.targetDomains.slice(0, 12) : [],
    targetSourceClasses: Array.isArray(input.targetSourceClasses) ? input.targetSourceClasses.slice(0, 8) : [],
    freshnessRequirement: input.freshnessRequirement || "UNKNOWN",
    currentKnownFacts: Array.isArray(input.currentKnownFacts) ? input.currentKnownFacts.slice(0, 20) : [],
    unknowns: Array.isArray(input.unknowns) ? input.unknowns.slice(0, 20) : [],
    maxQueries,
    maxDepth,
    maxSources,
    maxWallMs,
    maxContentChars,
    stopConditions: Object.freeze([
      RESEARCH_STOP_REASON.ANSWERED,
      RESEARCH_STOP_REASON.MAX_QUERIES,
      RESEARCH_STOP_REASON.MAX_SOURCES,
      RESEARCH_STOP_REASON.HARD_DEADLINE,
      RESEARCH_STOP_REASON.CONTENT_BUDGET,
      RESEARCH_STOP_REASON.LOCAL_PROOF_SUPERSEDES,
      RESEARCH_STOP_REASON.STALE,
      RESEARCH_STOP_REASON.CANCELLED,
    ]),
    versionJoin: input.versionJoin || null,
    runId: String(input.runId || ""),
  };
}

/**
 * Deterministic sufficiency: first sufficient evidence wins (LAW P4).
 * maxSources is a maximum, not a target.
 */
export function isSufficientEvidence(state = {}) {
  return Boolean(
    state.versionMatched !== false
    && state.primarySourceObtained === true
    && state.importantClaimsSupported === true
    && state.noUnresolvedContradiction === true
    && state.freshnessSatisfied === true,
  );
}

/**
 * DeepSeek synthesis gate (LAW P7). DeepSeek is NOT default.
 */
export function shouldCallDeepSeek(state = {}) {
  return Boolean(
    state.unresolvedContradiction === true
    || state.hardArchitecturalUncertainty === true
    || state.incompletePrimaryEvidence === true
    || state.multipleCredibleAlternatives === true
    || state.userRequestedDeepResearch === true,
  );
}

/**
 * Browser gate (LAW P6). Ordinary docs lookup launches no browser.
 */
export function shouldLaunchBrowser(task = {}) {
  if (task.authenticatedSynthesis === true) return true;
  if (task.dynamicPageRequiresBrowser === true) return true;
  return false;
}

/**
 * Safe-overlap plan (LAW P3). Only deterministic/read-only local prep may
 * overlap provider I/O. Source writes never overlap when the barrier requires
 * research first.
 */
export function planSafeOverlap(brief, localPrep = {}) {
  const external = brief?.researchClass !== RESEARCH_CLASS.LOCAL_ONLY;
  const wantsWrite = localPrep.includesWrite === true || localPrep.effect === "SOURCE_WRITE";
  if (!external) return { overlapAllowed: true, reason: "local-only-no-barrier" };
  if (wantsWrite && localPrep.barrierRequired !== false) {
    return { overlapAllowed: false, reason: "source-write-fenced-behind-decision-barrier" };
  }
  const safeKinds = new Set(["repo-inspection", "package-detection", "file-discovery", "symbol-discovery", "evidence-retrieval", "affected-test-discovery", "cache-lookup"]);
  const kinds = Array.isArray(localPrep.kinds) ? localPrep.kinds : [];
  const unsafe = kinds.filter((k) => !safeKinds.has(String(k)));
  if (unsafe.length) return { overlapAllowed: false, reason: `unsafe-prep-kinds:${unsafe.join(",")}` };
  return { overlapAllowed: true, reason: "read-only-prep-may-overlap-provider-io" };
}

export const researchBriefExports = Object.freeze({
  decideResearchAdmission,
  buildResearchBrief,
  briefIdFor,
  isSufficientEvidence,
  shouldCallDeepSeek,
  shouldLaunchBrowser,
  planSafeOverlap,
});
