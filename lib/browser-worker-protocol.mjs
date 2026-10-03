// V16.3 runtime integration: the managed browser worker protocol.
//
// The DeepSeek lane needs to drive a real page, and the Pi extension API cannot
// dispatch a tool (`getAllTools` exists, `callTool` does not). So the managed
// browser is a SEPARATE PROCESS and this file is its wire contract.
//
// Three properties make the boundary safe:
//
//   1. The protocol carries an ACTION, not a script. The worker executes only
//      actions the Phase A taxonomy knows, and a request naming anything else is
//      refused here -- before it becomes a `page.evaluate`.
//   2. Every response is redacted and bounded, because it is about to be handed
//      to a model and possibly to an external provider.
//   3. The protocol has NO result for a side effect it cannot attribute. A
//      response never claims success for an action that did not report an
//      observation.

import { classifyBrowserAction } from "./browser-action-taxonomy.mjs"
import { BROWSER_EXPECTED_STATE_KIND } from "./browser-evidence.mjs"
import { externalTrustContract } from "./browser-security.mjs"
import { redactStructure } from "./secret-redaction.mjs"

export const BROWSER_WORKER_PROTOCOL_VERSION = 1

export const BROWSER_WORKER_FAILURE = Object.freeze({
  UNKNOWN_ACTION: "browser-worker-unknown-action",
  INVALID_REQUEST: "browser-worker-invalid-request",
  UNSUPPORTED_VERSION: "browser-worker-unsupported-protocol",
  UNAVAILABLE: "browser-worker-unavailable",
  TRANSPORT: "browser-worker-transport-closed",
  TIMEOUT: "browser-worker-timeout",
  AUTH_REQUIRED: "browser-worker-auth-required",
  PROVIDER_ERROR: "browser-worker-provider-error",
  CLOSED: "browser-worker-closed",
})

export const BROWSER_WORKER_OPERATION = Object.freeze({
  CAPABILITY: "capability",
  NAVIGATE: "navigate",
  RELOAD: "reload",
  BACK: "back",
  FORWARD: "forward",
  SNAPSHOT: "snapshot",
  SCREENSHOT: "screenshot",
  CONSOLE_READ: "console-read",
  NETWORK_READ: "network-read",
  CLICK: "click",
  FILL: "fill",
  TYPE: "type",
  SELECT: "select",
  HOVER: "hover",
  PRESS: "press",
  WAIT: "wait",
  CLOSE: "close",
  // Read-only DOM/URL observation for the auth gate. It is an operation in the
  // protocol rather than a side channel so it is validated, bounded and redacted
  // exactly like every other response.
  AUTH_PROBE: "auth-probe",
  // Bounded, read-only structural inspection used to REPAIR selectors from real
  // evidence instead of guessing them. It reads structural attributes only.
  DOM_INSPECT: "dom-inspect",
})

const OPERATION_TO_ACTION = Object.freeze({
  [BROWSER_WORKER_OPERATION.NAVIGATE]: "navigate",
  [BROWSER_WORKER_OPERATION.RELOAD]: "reload",
  [BROWSER_WORKER_OPERATION.BACK]: "back",
  [BROWSER_WORKER_OPERATION.FORWARD]: "forward",
  [BROWSER_WORKER_OPERATION.SNAPSHOT]: "snapshot",
  [BROWSER_WORKER_OPERATION.SCREENSHOT]: "screenshot",
  [BROWSER_WORKER_OPERATION.CONSOLE_READ]: "console-read",
  [BROWSER_WORKER_OPERATION.NETWORK_READ]: "network-read",
  [BROWSER_WORKER_OPERATION.CLICK]: "click",
  [BROWSER_WORKER_OPERATION.FILL]: "fill",
  [BROWSER_WORKER_OPERATION.TYPE]: "type",
  [BROWSER_WORKER_OPERATION.SELECT]: "select",
  [BROWSER_WORKER_OPERATION.HOVER]: "hover",
  [BROWSER_WORKER_OPERATION.PRESS]: "press",
  [BROWSER_WORKER_OPERATION.WAIT]: "wait",
  [BROWSER_WORKER_OPERATION.CLOSE]: "close",
})

const MAX_RESPONSE_CHARS = 60_000

export function classifyWorkerOperation(operation) {
  const action = OPERATION_TO_ACTION[String(operation || "")] || null
  if (!action) return null
  return classifyBrowserAction({ action })
}

/**
 * Validate an inbound request. Returns `{ ok: false, failure }` rather than
 * throwing, because an unknown operation is an expected negative, not a crash.
 */
export function encodeWorkerRequest(request = {}) {
  const operation = String(request.operation || "")
  if (Number(request.protocolVersion || BROWSER_WORKER_PROTOCOL_VERSION) !== BROWSER_WORKER_PROTOCOL_VERSION) {
    return { ok: false, failure: BROWSER_WORKER_FAILURE.UNSUPPORTED_VERSION, operation }
  }
  if (operation === BROWSER_WORKER_OPERATION.CAPABILITY) {
    return {
      ok: true,
      operation,
      // Capability is a description, not an action: it executes nothing.
      payload: { protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION, requestId: String(request.requestId || "") },
    }
  }
  if (operation === BROWSER_WORKER_OPERATION.AUTH_PROBE) {
    // Read-only observation. Like CAPABILITY it maps to no taxonomy action, but it
    // IS routed to the worker, so it is validated here rather than falling through
    // to the unknown-action refusal.
    return {
      ok: true,
      operation,
      payload: {
        protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
        requestId: String(request.requestId || ""),
        answerSelectors: Array.isArray(request.answerSelectors)
          ? request.answerSelectors.slice(0, 8).map((selector) => String(selector).slice(0, 200))
          : [],
        composerSelector: request.composerSelector ? String(request.composerSelector).slice(0, 200) : "",
      },
    }
  }
  if (operation === BROWSER_WORKER_OPERATION.DOM_INSPECT) {
    // Read-only inspection modes share one routable operation:
    //   structure (default) - generic visible-element structure for repair
    //   composer-vicinity    - composer/send/answer candidates near the prompt
    //   send-transition-begin   - capture SAME-NODE handles for the Send
    //     candidates pre-fill (no content crosses, handles stay in worker)
    //   send-transition-measure - re-inspect THOSE SAME handles post-fill and
    //     report bounded changed/unchanged flags (booleans/counts only)
    //   deepseek-answer-regions - bounded assistant-answer candidate regions
    //     ONLY (counts per family + selected region text <=40k; never
    //     whole-page body text, sidebar/history/account text, or raw HTML)
    // All return shape-only evidence; none reads values, text or secrets
    // beyond the selected answer region's bounded text.
    const mode = String(request.mode || "structure").trim().toLowerCase();
    const allowedModes = new Set(["composer-vicinity", "send-transition-begin", "send-transition-measure", "deepseek-answer-regions"]);
    return {
      ok: true,
      operation,
      payload: {
        protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
        requestId: String(request.requestId || ""),
        limit: boundedInt(request.limit, 60, 1, 120),
        mode: allowedModes.has(mode) ? mode : "structure",
        answerSelectors: Array.isArray(request.answerSelectors)
          ? request.answerSelectors.slice(0, 8).map((selector) => String(selector).slice(0, 200))
          : [],
        nearbyLimit: boundedInt(request.nearbyLimit, 10, 1, 25),
        selector: request.selector ? String(request.selector).slice(0, 500) : null,
      },
    }
  }
  const taxonomy = classifyWorkerOperation(operation)
  if (!taxonomy) {
    return { ok: false, failure: BROWSER_WORKER_FAILURE.UNKNOWN_ACTION, operation }
  }
  if (taxonomy.unknownAction === true) {
    return { ok: false, failure: BROWSER_WORKER_FAILURE.UNKNOWN_ACTION, operation }
  }
  // The caller must declare the risk class it proved. A bare `click` on the wire
  // is INTERACTIVE, so without this flag a submit could cross the process boundary
  // looking like an ordinary click and skip the approval gate entirely.
  const declared = request.externalSideEffect === true
    ? classifyBrowserAction({ action: taxonomy.action, provenExternalSideEffect: true })
    : taxonomy
  if (declared.requiresExplicitApproval === true && request.approved !== true) {
    // The protocol enforces the same approval gate as the taxonomy. A side
    // effect cannot even be ENCODED without an explicit approval flag.
    return { ok: false, failure: BROWSER_WORKER_FAILURE.INVALID_REQUEST, operation, reason: "side-effect-not-approved" }
  }
  return {
    ok: true,
    operation,
    taxonomy: declared,
    payload: {
      protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
      requestId: String(request.requestId || ""),
      url: request.url ? String(request.url).slice(0, 2_000) : null,
      selector: request.selector ? String(request.selector).slice(0, 500) : null,
      role: request.role ? String(request.role).slice(0, 80) : null,
      name: request.name ? String(request.name).slice(0, 300) : null,
      // Same-node transition marker. Only the allowlisted marker crosses;
      // never an index, ordinal, or coordinate. The worker resolves it to the
      // stored transition-unique handle, or refuses when none was proven.
      transition: request.transition === "send-transition-unique" ? "send-transition-unique" : null,
      text: request.text !== undefined ? String(request.text).slice(0, 200_000) : null,
      timeoutMs: boundedInt(request.timeoutMs, 30_000, 100, 180_000),
      waitUntil: String(request.waitUntil || "domcontentloaded").slice(0, 40),
      fillChars: request.text ? String(request.text).length : 0,
      // Auth-probe arguments are SELECTORS, not values. Nothing secret is ever
      // passed across this boundary in either direction.
      answerSelectors: Array.isArray(request.answerSelectors)
        ? request.answerSelectors.slice(0, 8).map((selector) => String(selector).slice(0, 200))
        : [],
      composerSelector: request.composerSelector ? String(request.composerSelector).slice(0, 200) : "",
      // A side effect is always replay-guarded by the caller; the protocol
      // carries the key so the worker can echo it back in its receipt.
      idempotencyKey: request.idempotencyKey ? String(request.idempotencyKey).slice(0, 200) : null,
    },
  }
}

/**
 * Validate and sanitize a worker response. Every field the model will read passes
 * through the shared redactor here, so the worker cannot bypass Phase A security
 * by writing directly to stdout.
 */
export function decodeWorkerResponse(message = {}) {
  const raw = typeof message === "string" ? safeJson(message) : message
  if (!raw || typeof raw !== "object") {
    return { ok: false, failure: BROWSER_WORKER_FAILURE.TRANSPORT, text: String(message ?? "").slice(0, 400) }
  }
  if (Number(raw.protocolVersion || 0) !== BROWSER_WORKER_PROTOCOL_VERSION) {
    return { ok: false, failure: BROWSER_WORKER_FAILURE.UNSUPPORTED_VERSION }
  }
  const isError = raw.ok === false || raw.failure !== undefined && raw.ok !== true
  const scrubbed = redactStructure(raw.payload ?? null, { maxDepth: 6, maxKeys: 600 })
  const payload = scrubbed.value || {}
  const text = typeof payload.text === "string" ? payload.text : ""
  const boundedText = text.length > MAX_RESPONSE_CHARS
    ? `${text.slice(0, MAX_RESPONSE_CHARS)}...[truncated]`
    : text

  return {
    ok: !isError,
    failure: isError ? String(raw.failure || BROWSER_WORKER_FAILURE.PROVIDER_ERROR).slice(0, 200) : null,
    requestId: String(raw.requestId || ""),
    operation: String(raw.operation || ""),
    // `ok` here means "the worker reported success", NEVER "the outcome is
    // proven". Callers still have to satisfy post-action verification.
    result: {
      url: safeUrl(payload.url),
      beforeUrl: safeUrl(payload.beforeUrl),
      finalUrl: safeUrl(payload.finalUrl),
      // Worker-reported capability facts. These are the only fields the worker
      // may assert about ITSELF; they are booleans/short strings and carry no
      // page content, so they survive normalization. Without them the client
      // could not distinguish "ready" from "Playwright missing".
      browserState: payload.browserState ? String(payload.browserState).slice(0, 40) : null,
      playwright: payload.playwright ? String(payload.playwright).slice(0, 40) : null,
      interactive: payload.interactive === true,
      inspectOnly: payload.inspectOnly === true,
      // Profile metadata: a MODE, a PATH and a boolean. Never profile contents.
      profileMode: payload.profileMode ? String(payload.profileMode).slice(0, 40) : null,
      profileDir: payload.profileDir ? String(payload.profileDir).slice(0, 400) : null,
      profileReason: payload.profileReason ? String(payload.profileReason).slice(0, 80) : null,
      profileExists: payload.profileExists === true,
      headless: payload.headless !== false,
      // Auth observations. Bounded text, a URL, and two booleans -- no cookie,
      // no token, no storage value, no input value.
      // Structural DOM inspection for selector repair. Carried through RAW and
      // bounded here; `sanitizeDomInspection` in the client is the layer that
      // actually strips anything not on the structural allowlist, so a worker
      // cannot smuggle account text through by nesting it here.
      dom: payload.dom && typeof payload.dom === "object"
        ? {
          url: safeUrl(payload.dom.url),
          aggregates: payload.dom.aggregates && typeof payload.dom.aggregates === "object" ? payload.dom.aggregates : {},
          rows: Array.isArray(payload.dom.rows) ? payload.dom.rows.slice(0, 120) : [],
        }
        : null,
      // Composer-vicinity evidence for locator repair. Carried through RAW and
      // bounded here; `sanitizeComposerVicinity` in the client is the layer
      // that actually strips anything not on the structural allowlist.
      vicinity: payload.vicinity && typeof payload.vicinity === "object"
        ? {
          url: safeUrl(payload.vicinity.url),
          composers: Array.isArray(payload.vicinity.composers) ? payload.vicinity.composers.slice(0, 4) : [],
          composerContext: payload.vicinity.composerContext && typeof payload.vicinity.composerContext === "object"
            ? payload.vicinity.composerContext
            : null,
          sendNearby: Array.isArray(payload.vicinity.sendNearby) ? payload.vicinity.sendNearby.slice(0, 25) : [],
          sendTotal: boundedInt(payload.vicinity.sendTotal, 0, 0, 10_000),
          answers: payload.vicinity.answers && typeof payload.vicinity.answers === "object" ? payload.vicinity.answers : {},
          sendMatches: payload.vicinity.sendMatches && typeof payload.vicinity.sendMatches === "object" ? payload.vicinity.sendMatches : {},
          semanticCounts: payload.vicinity.semanticCounts && typeof payload.vicinity.semanticCounts === "object"
            ? Object.fromEntries(
              ["sendExact", "sendGeneric", "submitGeneric", "stopGeneric", "attachGeneric", "uploadGeneric", "fileGeneric", "voiceGeneric", "microphoneGeneric"]
                .map((key) => [key, boundedInt(payload.vicinity.semanticCounts[key], 0, 0, 1000)]),
            )
            : null,
          // Pre/post-fill transition summary. Numbers/booleans and
          // allowlisted category names only; never positions used as locators.
          transition: payload.vicinity.transition && typeof payload.vicinity.transition === "object"
            ? sanitizeTransitionLike(payload.vicinity.transition)
            : null,
        }
        : null,
      auth: payload.auth && typeof payload.auth === "object"
        ? {
          url: safeUrl(payload.auth.url),
          title: String(payload.auth.title || "").slice(0, 200),
          // Body text is NOT carried. It contains every conversation title in the
          // sidebar, so login-wall evidence arrives as a precomputed boolean.
          loginEvidence: payload.auth.loginEvidence === true,
          composerVisible: payload.auth.composerVisible === true,
          answerRegions: boundedInt(payload.auth.answerRegions, 0, 0, 10_000),
          accountSignal: payload.auth.accountSignal === true,
          // A COUNT only. Conversation titles/snippets never cross this boundary.
          historyCount: boundedInt(payload.auth.historyCount, 0, 0, 10_000),
        }
        : null,
      answer: boundedText || null,
      // Dedicated answer-region observation (deepseek-answer-regions mode).
      // Carried through RAW and bounded here; `sanitizeAnswerRegions` in the
      // client is the layer that strips anything not on the answer allowlist.
      // Answer text ONLY for the selected new assistant region (<=40k); never
      // bodyText, sidebar/history/account text, or raw HTML.
      answerRegions: payload.answerRegions && typeof payload.answerRegions === "object"
        ? {
          families: Array.isArray(payload.answerRegions.families) ? payload.answerRegions.families.slice(0, 8) : [],
          selected: payload.answerRegions.selected && typeof payload.answerRegions.selected === "object"
            ? {
              selectorKey: String(payload.answerRegions.selected.selectorKey || "").slice(0, 80),
              visibleCount: boundedInt(payload.answerRegions.selected.visibleCount, 0, 0, 10_000),
              textChars: boundedInt(payload.answerRegions.selected.textChars, 0, 0, 40_000),
              answerText: typeof payload.answerRegions.selected.answerText === "string"
                ? payload.answerRegions.selected.answerText.slice(0, 40_000)
                : "",
            }
            : null,
          counts: payload.answerRegions.counts && typeof payload.answerRegions.counts === "object"
            ? payload.answerRegions.counts
            : null,
          totalVisible: boundedInt(payload.answerRegions.totalVisible, 0, 0, 10_000),
        }
        : null,
      // Same-node transition probe result (begin/measure modes). Sanitized
      // here; the client re-sanitizes with the locators allowlist.
      transition: payload.transition && typeof payload.transition === "object"
        ? sanitizeTransitionLike(payload.transition)
        : null,
      elements: Array.isArray(payload.elements) ? payload.elements.slice(0, 120) : [],
      consoleErrors: boundedArray(payload.consoleErrors, 20),
      networkFailures: boundedArray(payload.networkFailures, 20),
      filledChars: boundedInt(payload.filledChars, 0, 0, 1_000_000),
      inputCleared: payload.inputCleared === true,
      documentChanged: payload.documentChanged === true,
      redirected: payload.redirected === true,
      loadState: payload.loadState ? String(payload.loadState).slice(0, 40) : null,
      screenshotRef: payload.screenshotRef ? String(payload.screenshotRef).slice(0, 400) : null,
      snapshotRef: payload.snapshotRef ? String(payload.snapshotRef).slice(0, 400) : null,
    },
    // The expected-state observations the caller may verify against. The worker
    // reports what it SAW; it never asserts a check passed.
    observations: normalizeObservations(payload.observations),
    redacted: scrubbed.redacted,
    redactionHits: scrubbed.hits,
    trustLevel: "untrusted-external",
    security: externalTrustContract("browser-worker"),
  }
}

function normalizeObservations(input) {
  const rows = Array.isArray(input) ? input : []
  return rows
    .filter((row) => row && typeof row === "object")
    .slice(0, 8)
    .map((row) => ({
      kind: String(row.kind || ""),
      expected: row.expected === undefined ? null : String(row.expected).slice(0, 400),
      observed: row.observed === undefined ? null : String(row.observed).slice(0, 400),
      required: row.required === true,
      knownKind: Object.hasOwn(BROWSER_EXPECTED_STATE_KIND, String(row.kind || "").toUpperCase()),
    }))
}

export function encodeWorkerResponse(message = {}) {
  return {
    protocolVersion: BROWSER_WORKER_PROTOCOL_VERSION,
    ok: message.ok === true,
    requestId: String(message.requestId || ""),
    operation: String(message.operation || ""),
    failure: message.ok === true ? undefined : String(message.failure || BROWSER_WORKER_FAILURE.PROVIDER_ERROR),
    // The INNER payload only. Naming the parameter `payload` and returning it by
    // shorthand nested the whole envelope inside itself, so every decoded
    // response read one level too deep -- see browser-worker-client.mjs, which
    // then reported a healthy worker as lacking its own capability fields.
    payload: message.payload ?? null,
  }
}

function sanitizeTransitionLike(value) {
  const raw = value && typeof value === "object" ? value : {};
  const categories = Array.isArray(raw.changedCategories) ? raw.changedCategories : [];
  const allow = new Set([
    "disabledChanged", "tabIndexChanged", "ariaHasPopupChanged", "ariaExpandedChanged",
    "ariaControlsChanged", "dataStatePresenceChanged", "childCountChanged", "descendantCountChanged",
    "svgCountChanged", "pathCountChanged", "subtreeShapeChanged", "pointerEventsChanged",
    "opacityBucketChanged", "visibilityChanged", "cursorChanged", "backgroundStateChanged",
    "classTokenCountChanged",
  ]);
  return {
    preFillCandidateCount: boundedInt(raw.preFillCandidateCount, 0, 0, 10),
    postFillCandidateCount: boundedInt(raw.postFillCandidateCount, 0, 0, 10),
    sameNodeContinuityCount: boundedInt(raw.sameNodeContinuityCount, 0, 0, 10),
    candidateAChanged: raw.candidateAChanged === true,
    candidateBChanged: raw.candidateBChanged === true,
    transitionUnique: raw.transitionUnique === true,
    detached: raw.detached === true,
    changedCategories: categories.filter((entry) => typeof entry === "string" && allow.has(entry)).slice(0, 17),
  };
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function boundedArray(value, max) {
  return (Array.isArray(value) ? value : []).slice(0, max).map((row) => String(row ?? "").slice(0, 400))
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function safeUrl(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  try {
    const parsed = new URL(raw)
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.toString() : null
  } catch {
    return null
  }
}