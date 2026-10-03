// V16.3 DeepSeek answer-region acquisition (answer-wait blocker fix).
//
// The FIRST answer read failed and the failure was collapsed into
// `deepseek-no-answer-extracted:answer-wait`, hiding whether the worker timed
// out, the session aborted, the locator went stale, or auth was required. The
// generic SNAPSHOT path also read `document.body.innerText` (whole-page text
// including sidebar/history chrome) as the "answer".
//
// This module owns the READ-ONLY answer-region contract:
//
//   - allowlisted selector keys only, never arbitrary selectors
//   - per-family visible counts, never sidebar/history text
//   - answer text ONLY from the selected NEW assistant region, bounded <=40k
//   - baseline ownership (old regions rejected)
//   - streaming-aware polling states
//   - bounded read-only recovery (no new fill/click/submit)
//   - exact infrastructure failure preservation (no collapsing)
//
// WHAT THIS MODULE MUST NEVER DO
//   - read document.body.innerText for answers
//   - return sidebar/history/account text, cookies/storage, input values,
//     raw HTML/SVG, conversation-list text
//   - click, fill, submit, navigate or retry a side effect

export const DEEPSEEK_ANSWER_MAX_CHARS = 40_000;

export const DEEPSEEK_ANSWER_POLL_INTERVAL_MS = 500;

export const DEEPSEEK_ANSWER_MAX_CONSECUTIVE_READ_FAILURES = 2;

// Text unchanged for this long but still invalid => stabilized invalid.
export const DEEPSEEK_ANSWER_STABLE_MS = 4_000;

export const DEEPSEEK_ANSWER_SELECTOR_KEYS = Object.freeze([
  "data-message-role-assistant",
  "data-role-assistant",
  "ds-markdown",
  "assistant-class",
]);

export const DEEPSEEK_ANSWER_SELECTOR_BY_KEY = Object.freeze({
  "data-message-role-assistant": "[data-message-role='assistant']",
  "data-role-assistant": "[data-role='assistant']",
  "ds-markdown": ".ds-markdown",
  "assistant-class": "[class*='assistant']",
});

export const DEEPSEEK_ANSWER_BASELINE_KEYS = Object.freeze([
  "dataMessageRoleAssistant",
  "dataRoleAssistant",
  "dsMarkdown",
  "assistantClass",
]);

const KEY_TO_BASELINE = Object.freeze({
  "data-message-role-assistant": "dataMessageRoleAssistant",
  "data-role-assistant": "dataRoleAssistant",
  "ds-markdown": "dsMarkdown",
  "assistant-class": "assistantClass",
});

const BASELINE_TO_KEY = Object.freeze({
  dataMessageRoleAssistant: "data-message-role-assistant",
  dataRoleAssistant: "data-role-assistant",
  dsMarkdown: "ds-markdown",
  assistantClass: "assistant-class",
});

export const DEEPSEEK_ANSWER_POLL_STATE = Object.freeze({
  NO_REGION_YET: "NO_REGION_YET",
  NEW_REGION_EMPTY: "NEW_REGION_EMPTY",
  NEW_REGION_STREAMING: "NEW_REGION_STREAMING",
  NEW_REGION_TEXT: "NEW_REGION_TEXT",
  PARTIAL_JSON: "PARTIAL_JSON",
  VALID_COMPLETE_JSON: "VALID_COMPLETE_JSON",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  WORKER_CLOSED: "WORKER_CLOSED",
  UI_CHANGED: "UI_CHANGED",
});

function boundedCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10_000, Math.trunc(n)));
}

function boundedChars(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(DEEPSEEK_ANSWER_MAX_CHARS, Math.trunc(n)));
}

/**
 * Empty baseline: counts only, no content.
 */
export function emptyAnswerBaseline() {
  return {
    dataMessageRoleAssistant: 0,
    dataRoleAssistant: 0,
    dsMarkdown: 0,
    assistantClass: 0,
  };
}

/**
 * Normalize any count map (hyphen keys, camel keys, or raw selector strings)
 * into the canonical baseline shape. Counts only.
 */
export function normalizeAnswerBaseline(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const out = emptyAnswerBaseline();
  const selectorToBaseline = {
    "[data-message-role='assistant']": "dataMessageRoleAssistant",
    "[data-role='assistant']": "dataRoleAssistant",
    ".ds-markdown": "dsMarkdown",
    "[class*='assistant']": "assistantClass",
  };
  for (const [key, value] of Object.entries(raw)) {
    const trimmed = String(key);
    if (Object.hasOwn(out, trimmed)) {
      out[trimmed] = boundedCount(value);
    } else if (Object.hasOwn(KEY_TO_BASELINE, trimmed)) {
      out[KEY_TO_BASELINE[trimmed]] = boundedCount(value);
    } else if (Object.hasOwn(selectorToBaseline, trimmed)) {
      out[selectorToBaseline[trimmed]] = boundedCount(value);
    }
  }
  return out;
}

/**
 * Baseline from a sanitized answer observation ({ counts } or vicinity answers).
 */
export function baselineFromAnswerCounts(counts = {}) {
  return normalizeAnswerBaseline(counts);
}

/**
 * Whether an observation carries evidence newer than the baseline.
 *
 * Preferred ownership evidence (any one suffices):
 *   - selected assistant-region count increased, OR
 *   - worker-held same-node/new-node observation proves a new region
 *     (newRegionObserved === true), OR
 *   - another equally strong measured DOM transition
 *     (transitionUnique === true / regionCountIncreased === true).
 *
 * Never assumes "latest existing assistant text" belongs to this request.
 */
export function isNewAnswerObserved(observation = {}, baseline = {}) {
  const base = normalizeAnswerBaseline(baseline);
  if (observation?.newRegionObserved === true) return true;
  if (observation?.transitionUnique === true) return true;
  const counts = observation?.counts && typeof observation.counts === "object"
    ? observation.counts
    : observation?.answerSelectorCounts && typeof observation.answerSelectorCounts === "object"
      ? observation.answerSelectorCounts
      : null;
  if (counts) {
    const norm = normalizeAnswerBaseline(counts);
    for (const key of DEEPSEEK_ANSWER_BASELINE_KEYS) {
      if (norm[key] > base[key]) return true;
    }
    return false;
  }
  // Explicit worker flag only when no counts map is available; never infer
  // from a default baselineCount of 0.
  if (observation?.regionCountIncreased === true) return true;
  if (typeof observation?.visibleCount === "number" && typeof observation?.baselineCount === "number") {
    // Only when the caller supplied an explicit comparable baseline count
    // (worker-enriched observation). A default 0 must not count.
    if (observation?.baselineCountExplicit === true) {
      return Number(observation.visibleCount) > Number(observation.baselineCount);
    }
    return false;
  }
  return false;
}

/**
 * Sanitize a worker answer-region observation. Only allowlisted fields survive.
 * Answer text ONLY for the selected new assistant response, bounded <=40k.
 * Never bodyText, never sidebar/history/account text, never raw HTML/SVG.
 */
export function sanitizeAnswerObservation(input = {}) {
  const raw = input && typeof input === "object" ? input : {};
  const key = String(raw.selectorKey || raw.selectorkey || "");
  const selectorKey = DEEPSEEK_ANSWER_SELECTOR_KEYS.includes(key) ? key : null;
  const visibleCount = boundedCount(raw.visibleCount ?? raw.count ?? 0);
  const baselineCount = boundedCount(raw.baselineCount ?? 0);
  const textChars = boundedChars(raw.textChars ?? (typeof raw.answerText === "string" ? raw.answerText.length : 0));
  let answerText = typeof raw.answerText === "string" ? raw.answerText : "";
  if (answerText.length > DEEPSEEK_ANSWER_MAX_CHARS) answerText = answerText.slice(0, DEEPSEEK_ANSWER_MAX_CHARS);
  // Counts per family when present (numbers only).
  let counts = null;
  const rawCounts = raw.counts || raw.answerSelectorCounts || null;
  if (rawCounts && typeof rawCounts === "object") {
    counts = normalizeAnswerBaseline(rawCounts);
  }
  return {
    schemaVersion: 1,
    kind: "ues-deepseek-answer-observation",
    selectorKey,
    visibleCount,
    baselineCount,
    newRegionObserved: raw.newRegionObserved === true,
    regionCountIncreased: raw.regionCountIncreased === true,
    transitionUnique: raw.transitionUnique === true,
    textChars,
    answerText,
    counts,
    disclosure: {
      pageTextRead: false,
      bodyTextRead: false,
      sidebarTextRead: false,
      historyTextRead: false,
      accountTextRead: false,
      cookiesRead: false,
      storageRead: false,
      inputValuesRead: false,
      rawHtmlRead: false,
      acted: false,
    },
  };
}

/**
 * Preserve the EXACT first-read failure. Never collapses distinct causes into
 * `deepseek-no-answer-extracted`.
 *
 * Distinct causes that must stay distinct:
 *   browser-session-aborted, browser-worker-timeout,
 *   browser-worker-provider-error, stale-locator, auth-required,
 *   target-not-found, plus bounded pass-through for others.
 *
 * Returns safe bounded fields only. NO page content.
 */
export function preserveAnswerReadFailure(read = {}, attempt = 1) {
  const outcome = String(read?.outcome || (read?.ok === true ? "completed" : "failed")).slice(0, 40);
  const reasonRaw = String(read?.reason || read?.error || read?.failure?.kind || read?.failure || "unknown").slice(0, 160);
  const recoveryRaw = String(read?.recoveryReason || "").slice(0, 160);
  const lower = `${reasonRaw} ${recoveryRaw} ${String(read?.failure?.kind || "")}`.toLowerCase();
  let failure = reasonRaw;
  // Classify without collapsing: keep the specific token.
  if (lower.includes("browser-session-aborted") || lower.includes("session-aborted") || lower.includes("session refused")) {
    failure = "browser-session-aborted";
  } else if (lower.includes("browser-worker-timeout") || (lower.includes("browser-worker") && lower.includes("timeout"))) {
    failure = "browser-worker-timeout";
  } else if (lower.includes("browser-worker-provider-error") || lower.includes("provider-error")) {
    failure = "browser-worker-provider-error";
  } else if (lower.includes("stale-locator") || lower.includes("stale element") || lower.includes("no longer attached") || lower.includes("detached")) {
    failure = "stale-locator";
  } else if (lower.includes("browser-auth-required") || lower.includes("auth-required") || lower.includes("auth-probe") && lower.includes("needs")) {
    // Keep explicit auth token.
    if (lower.includes("auth-required") || lower.includes("browser-auth-required")) failure = "auth-required";
    else failure = reasonRaw;
  } else if (lower.includes("target-not-found") || lower.includes("target not found") || lower.includes("matches 0") || lower.includes("selector matches 0") || lower.includes("css target not found")) {
    failure = "target-not-found";
  } else if (lower.includes("no-allowed-locator-strategy")) {
    failure = "no-allowed-locator-strategy";
  } else if (lower.includes("duplicate-submit-refused")) {
    failure = "duplicate-submit-refused";
  } else if (lower.includes("browser-worker-closed") || lower.includes("worker-process-exited") || lower.includes("transport-closed")) {
    failure = "browser-worker-closed";
  }
  // Strategy is a bounded allowlisted label, never a selector with content.
  const strategyRaw = String(read?.strategy || read?.answerReadTargetStrategy || "deepseek-answer-regions").slice(0, 80);
  return {
    answerReadOutcome: outcome,
    answerReadReason: reasonRaw,
    answerReadFailure: String(failure).slice(0, 160),
    answerReadRecoveryReason: recoveryRaw || null,
    answerReadAttempts: Math.max(1, Math.min(1_000, Number(attempt) || 1)),
    answerReadTargetStrategy: strategyRaw,
  };
}

/**
 * Heuristic: does this text look like truncated/incomplete JSON that may still
 * be streaming? True => keep polling, do not fail parse immediately.
 */
export function isPartialJson(text = "") {
  const value = String(text ?? "").trim();
  if (!value) return false;
  // Must look like the start of a JSON object/array to be "partial JSON".
  if (!value.includes("{") && !value.includes("[")) return false;
  try {
    JSON.parse(stripFences(value));
    return false; // Parses => not partial.
  } catch {
    // Fall through to structural hints.
  }
  const openBraces = (value.match(/\{/g) || []).length;
  const closeBraces = (value.match(/\}/g) || []).length;
  const openBrackets = (value.match(/\[/g) || []).length;
  const closeBrackets = (value.match(/\]/g) || []).length;
  if (openBraces > closeBraces) return true;
  if (openBrackets > closeBrackets) return true;
  // Ends mid-token: trailing comma, colon, quote, or opener.
  if (/[,:{[]"']\s*$/.test(value)) return true;
  // Fenced but unclosed.
  if (value.startsWith("```") && !value.trimEnd().endsWith("```")) return true;
  return false;
}

function stripFences(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Classify one poll observation into a streaming state.
 * Pure function for tests: no I/O, no timers.
 */
export function classifyAnswerPoll({ observation = null, baseline = null, parseResult = null } = {}) {
  if (!observation) return DEEPSEEK_ANSWER_POLL_STATE.NO_REGION_YET;
  const total = totalVisible(observation, baseline);
  if (total === 0) return DEEPSEEK_ANSWER_POLL_STATE.NO_REGION_YET;
  const isNew = isNewAnswerObserved(observation, baseline || emptyAnswerBaseline());
  if (!isNew) {
    // Regions exist but none is newer than baseline => old answer only.
    // Caller treats as continue (not success); state reports no new region yet.
    return DEEPSEEK_ANSWER_POLL_STATE.NO_REGION_YET;
  }
  const text = typeof observation?.answerText === "string" ? observation.answerText : "";
  if (!text.trim()) {
    // New region exists but empty => streaming not yet started.
    return DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_EMPTY;
  }
  if (parseResult && parseResult.ok === true) return DEEPSEEK_ANSWER_POLL_STATE.VALID_COMPLETE_JSON;
  if (isPartialJson(text)) return DEEPSEEK_ANSWER_POLL_STATE.PARTIAL_JSON;
  if (parseResult && parseResult.ok === false) {
    // Non-partial parse failure with text present => present-but-invalid.
    // Caller continues until stabilization, then reports answer-parse.
    return DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_TEXT;
  }
  // Text present, no parse attempted yet => streaming or complete, keep polling.
  return DEEPSEEK_ANSWER_POLL_STATE.NEW_REGION_STREAMING;
}

function totalVisible(observation, baseline) {
  if (observation?.counts && typeof observation.counts === "object") {
    return Object.values(observation.counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  }
  if (typeof observation?.visibleCount === "number") return Number(observation.visibleCount) || 0;
  return 0;
}

/**
 * Whether a consecutive read failure should recover with a read-only retry.
 * Policy: consecutiveReadFailures <= 2 => retry read only.
 * Third consecutive infrastructure failure => fail with exact reason.
 */
export function shouldRecoverAnswerRead(consecutiveFailures = 1) {
  return Number(consecutiveFailures) <= DEEPSEEK_ANSWER_MAX_CONSECUTIVE_READ_FAILURES;
}
