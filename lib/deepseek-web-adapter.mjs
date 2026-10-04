// V16.3 Phase B, step 9: the DeepSeek Web session adapter.
//
// This adapter drives a real web UI, so it is built to assume the UI will
// change, the session will expire, and the model will occasionally answer with
// something that is not JSON. Every one of those is a normal return value, not
// an exception:
//
//   - login required        -> state `needs-auth`, and NEVER a retry loop
//   - selector drift        -> the action is re-resolved from a fresh snapshot
//   - timeout               -> `timeout` failure, session released
//   - answer does not belong to this request -> discarded, not parsed
//
// It does NOT bypass login, does not solve CAPTCHAs, and does not have any
// filesystem, git, terminal or code-editing capability: its entire outbound
// surface is one text box and one read of the answer element. Everything it
// does to the browser goes through the Phase A taxonomy, so a submit here is an
// `external-side-effect` action with a zero retry budget.

import {
  BROWSER_EXPECTED_STATE_KIND,
  verifyExpectedState,
} from "./browser-evidence.mjs"
import { classifyBrowserAction } from "./browser-action-taxonomy.mjs"
import { createBrowserSession } from "./browser-lifecycle.mjs"
import { createSubmitGuard, executeBrowserAction } from "./browser-execution.mjs"
import { isAuthRequiredFailure } from "./browser-retry-policy.mjs"
import { AUTH_SETTLE_LIMIT } from "./browser-profile.mjs"
import {
  DEEPSEEK_ANSWER_CANDIDATES,
  DEEPSEEK_LOCATOR_KIND,
  resolveDeepSeekTarget,
} from "./deepseek-locators.mjs"
import {
  baselineFromAnswerCounts,
  DEEPSEEK_ANSWER_MAX_CHARS,
  DEEPSEEK_ANSWER_MAX_CONSECUTIVE_READ_FAILURES,
  DEEPSEEK_ANSWER_POLL_INTERVAL_MS,
  DEEPSEEK_ANSWER_STABLE_MS,
  classifyAnswerPoll,
  emptyAnswerBaseline,
  isNewAnswerObserved,
  isPartialJson,
  normalizeAnswerBaseline,
  preserveAnswerReadFailure,
  sanitizeAnswerObservation,
  shouldRecoverAnswerRead,
} from "./deepseek-answer.mjs"
import { parseDeepSeekResponse } from "./deepseek-response.mjs"
// V16.6.1: the adapter's follow-up allowance comes from the canonical bounds
// table, not from a private default that could drift from the lane's.
import { WEB_REASONING_BOUNDS } from "./deepseek-turn-policy-v16-6.mjs"

export const DEEPSEEK_WEB_PROVIDER_ID = "deepseek-web"

export const DEEPSEEK_WEB_STATE = Object.freeze({
  READY: "ready",
  NEEDS_AUTH: "needs-auth",
  LOGGED_OUT: "logged-out",
  UI_CHANGED: "ui-changed",
  TIMEOUT: "timeout",
  CLOSED: "closed",
})

export const DEEPSEEK_WEB_FAILURE = Object.freeze({
  AUTH_REQUIRED: "deepseek-auth-required",
  NO_SESSION: "deepseek-no-session",
  SESSION_LOST: "deepseek-session-lost",
  UI_CHANGED: "deepseek-ui-selector-changed",
  TIMEOUT: "deepseek-response-timeout",
  NO_ANSWER: "deepseek-no-answer-extracted",
  ANSWER_MISMATCH: "deepseek-answer-not-belonging-to-request",
  BROWSER_UNAVAILABLE: "deepseek-browser-unavailable",
  INVALID_RESPONSE: "deepseek-response-invalid",
  PROMPT_TOO_LARGE: "deepseek-prompt-exceeds-budget",
})

// Bounded internal stage metadata for stage-specific safe evidence. Stages are
// reported as suffixes on the failure string (e.g.
// `deepseek-ui-selector-changed:send-resolve-post-fill:...`) so the stage
// survives the provider/lane envelope, which otherwise carries only `reason`.
// No prompt contents, input values, conversation content, account data,
// cookies/storage, or URLs with query/ids are ever attached to a stage.
export const DEEPSEEK_FAILURE_STAGE = Object.freeze({
  SESSION_NAVIGATION: "session-navigation",
  SESSION_AUTH: "session-auth",
  COMPOSER_RESOLVE: "composer-resolve",
  COMPOSER_FILL: "composer-fill",
  SEND_RESOLVE_POST_FILL: "send-resolve-post-fill",
  SEND_CLICK: "send-click",
  DISPATCH_VERIFY: "dispatch-verify",
  ANSWER_RESOLVE: "answer-resolve",
  ANSWER_WAIT: "answer-wait",
  ANSWER_PARSE: "answer-parse",
})

// Smoke/live status classification. NEVER maps a generic "unavailable"
// outcome to NEEDS_AUTH: only an explicit `deepseek-auth-required` reason is
// authentication. A `deepseek-ui-selector-changed` reason is always UI_CHANGED,
// even when the lane outcome is "unavailable" (FORCE mode). TIMEOUT and
// NO_ANSWER stay distinct FAIL-family reasons; browser-unavailable is
// UNAVAILABLE. This is what keeps the live smoke from printing NEEDS_AUTH for
// selector drift.
export const DEEPSEEK_SMOKE_STATUS = Object.freeze({
  PASS: "PASS",
  NEEDS_AUTH: "NEEDS_AUTH",
  UI_CHANGED: "UI_CHANGED",
  UNAVAILABLE: "UNAVAILABLE",
  TIMEOUT: "TIMEOUT",
  FAIL: "FAIL",
})

/**
 * Classify a lane/adapter result into a smoke status without ever conflating
 * selector drift with authentication.
 *
 * @param {Record<string, any>} result lane result with outcome/reason/failure
 * @returns {string} one of DEEPSEEK_SMOKE_STATUS
 */
export function classifyDeepSeekSmokeStatus(result = {}) {
  const reason = String(result?.reason || result?.failure || "")
  const outcome = String(result?.outcome || "")
  // Explicit failure codes win over the coarse outcome. Order matters: auth
  // first is safe only because each branch requires its own explicit token;
  // a bare "unavailable" outcome with no auth token never reaches NEEDS_AUTH.
  if (reason.includes(DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED)) return DEEPSEEK_SMOKE_STATUS.NEEDS_AUTH
  if (reason.includes(DEEPSEEK_WEB_FAILURE.UI_CHANGED)) return DEEPSEEK_SMOKE_STATUS.UI_CHANGED
  if (reason.includes(DEEPSEEK_WEB_FAILURE.BROWSER_UNAVAILABLE) || reason.includes("browser-worker-unavailable") || reason.includes("browser-unavailable")) return DEEPSEEK_SMOKE_STATUS.UNAVAILABLE
  if (reason.includes(DEEPSEEK_WEB_FAILURE.TIMEOUT)) return DEEPSEEK_SMOKE_STATUS.TIMEOUT
  if (reason.includes(DEEPSEEK_WEB_FAILURE.NO_ANSWER)) return DEEPSEEK_SMOKE_STATUS.FAIL
  if (reason.includes("auth-required") || reason.includes("browser-auth-required")) return DEEPSEEK_SMOKE_STATUS.NEEDS_AUTH
  // A generic unavailable outcome without a specific reason is UNAVAILABLE,
  // never NEEDS_AUTH. Authentication must be proven by its own token.
  if (outcome === "unavailable") return DEEPSEEK_SMOKE_STATUS.UNAVAILABLE
  if (outcome === "advised" || outcome === "advice-accepted") return DEEPSEEK_SMOKE_STATUS.PASS
  return DEEPSEEK_SMOKE_STATUS.FAIL
}

/**
 * Extract the bounded failure stage suffix from a failure reason, or null.
 * Stages are allowlisted so an arbitrary reason suffix cannot become a stage.
 */
export function parseDeepSeekFailureStage(reason = "") {
  const raw = String(reason || "")
  for (const stage of Object.values(DEEPSEEK_FAILURE_STAGE)) {
    if (raw.includes(`:${stage}`) || raw.includes(stage)) return stage
  }
  return null
}

/**
 * Bounded action counters for receipts/telemetry. Counts only, no content.
 * Proves fill-once / submit-at-most-once without inferring from elapsed time.
 */
export function createDeepSeekCounters() {
  return { fillAttempts: 0, submitAttempts: 0, snapshotAttempts: 0 }
}

export function boundDeepSeekCounters(counters = {}) {
  return {
    fillAttempts: Math.max(0, Math.min(100, Number(counters.fillAttempts) || 0)),
    submitAttempts: Math.max(0, Math.min(100, Number(counters.submitAttempts) || 0)),
    snapshotAttempts: Math.max(0, Math.min(1_000, Number(counters.snapshotAttempts) || 0)),
  }
}

// The prompt the adapter sends. Kept in one place so the instruction contract
// ("you are a consultant, return JSON, you do not decide PASS") is auditable
// rather than scattered through string concatenation at the call site.
export function renderDeepSeekPrompt(packet = {}, options = {}) {
  const requestId = String(options.requestId || "req-1")
  return [
    "[UES CONSULTATION REQUEST]",
    `request_id=${requestId}`,
    "You are an external consultant. You do not have repository, filesystem, terminal or network authority.",
    "Do not ask for secrets, tokens, credentials or .env values. Do not claim any task is PASS.",
    "Answer ONLY with a single JSON object using exactly these keys:",
    'summary (string), hypotheses (array of strings), recommendedApproach (array of strings),',
    'filesToInspect (array of repository-relative paths), risks (array of strings),',
    'edgeCases (array of strings), verificationSuggestions (array of strings), confidence (number 0..1).',
    // V16.6.1: the ONE evidence-request channel. A request asks the local
    // runtime to fetch evidence; it never runs anything and never grants
    // anything. It is optional: omit the key when you need nothing further.
    "You may also include one optional key:",
    'evidenceRequests (array of at most 4 objects: {"kind": one of ' +
      '"diff|failed-output|file-excerpt|test-names|verifier-output|repo-summary|telemetry-summary|tool-output", ' +
      '"target": a workspace-relative path (only for file-excerpt/tool-output), ' +
      '"reason": why you need it}). Requests outside this shape are refused.',
    "Base every claim on the evidence below. If the evidence is insufficient, say so in summary and lower confidence.",
    "",
    packet.rendered || JSON.stringify(packet.sections || {}),
    "[END UES CONSULTATION REQUEST]",
  ].join("\n")
}

/**
 * Build the DeepSeek Web adapter over an injected browser lane.
 *
 * `deps` contract (all required; there is no default browser):
 *   capability   - precomputed browser capability object
 *   invoke       - async (action, context) => provider result   [Phase A executor]
 *   freshSnapshot- async () => { ok, snapshot, target }
 *   now          - clock
 *   loginProbe   - async () => ({ authenticated: boolean, url?: string })
 */
/**
 * @param {Record<string, any>} deps injected browser lane (see module comment)
 * @returns {Record<string, any>} a WebReasoningProvider adapter
 */
export function createDeepSeekWebAdapter(deps = {}) {
  const config = {
    id: DEEPSEEK_WEB_PROVIDER_ID,
    maxSessionMs: deps.maxSessionMs ?? 600_000,
    maxFollowUps: deps.maxFollowUps ?? WEB_REASONING_BOUNDS.maxFollowUps,
    options: {
      entryUrl: deps.entryUrl || "https://chat.deepseek.com/",
      promptBox: deps.promptBox || {
        strategy: "role-and-accessible-name",
        role: "textbox",
        accessibleName: "message to DeepSeek",
      },
      sendButton: deps.sendButton || {
        strategy: "role-and-accessible-name",
        role: "button",
        accessibleName: "Send",
      },
      answerRegion: deps.answerRegion || {
        strategy: "stable-semantic-selector",
        selector: "[data-message-role=assistant]",
      },
      answerTimeoutMs: deps.answerTimeoutMs ?? 90_000,
      maxPromptChars: deps.maxPromptChars ?? 120_000,
      // A browser action is the only tool this adapter has. Interactive actions
      // are admitted only when the lane is interactive-capable; otherwise the
      // adapter reports `browser-unavailable` instead of degrading silently.
    },
  }

  const requireLane = () => {
    if (typeof deps.invoke !== "function") {
      return {
        ok: false,
        // Uniform shape: every `runAction` caller sees the same fields whether the
        // lane was missing or the executor refused, so a missing browser reads as
        // an outcome rather than an undefined-property crash.
        outcome: "unavailable",
        receipts: [],
        failure: DEEPSEEK_WEB_FAILURE.BROWSER_UNAVAILABLE,
        reason: "no-browser-lane-bound",
      }
    }
    return { ok: true }
  }

  // Every browser interaction runs through the Phase A executor, so the DeepSeek
  // lane inherits the action taxonomy, the zero-retry submit budget, the
  // duplicate-submit guard and the receipt ledger for free.
  const runAction = async (action, request, options = {}) => {
    const lane = requireLane()
    if (!lane.ok) return lane
    const taxonomy = classifyBrowserAction({ action })
    return executeBrowserAction(
      {
        action,
        // Prompt submission commits an external side effect (a message to a
        // third party), so it is classified as one and never replayed.
        provenExternalSideEffect: options.externalSideEffect === true,
        provenIdempotent: options.provenIdempotent === true,
        approved: options.externalSideEffect === true ? true : undefined,
        target: request.target || config.options.promptBox,
        value: request.value,
        expectedStates: request.expectedStates || [],
        idempotencyKey: request.idempotencyKey,
        sessionOptions: options.sessionOptions,
      },
      {
        capability: deps.capability,
        invoke: deps.invoke,
        freshSnapshot: deps.freshSnapshot,
        verify: options.verify || deps.verify || deepSeekDefaultVerify,
        session: options.session,
        submitGuard: options.submitGuard,
        telemetry: deps.telemetry,
        now: deps.now,
        sleep: deps.sleep,
      },
    )
  }

  const adapter = {
    id: config.id,
    maxSessionMs: config.maxSessionMs,
    maxFollowUps: config.maxFollowUps,
    // Declared so the generic provider wrapper can turn an adapter error into a
    // countable failure code instead of an anonymous provider-error.
    failureCodes: Object.values(DEEPSEEK_WEB_FAILURE),
    options: config.options,

    async capability() {
      const lane = requireLane()
      const browser = deps.capability || null
      if (!lane.ok) {
        return { state: "unavailable", reason: lane.failure, supportsFollowUp: false, sessionReusable: false }
      }
      const interactive = browser?.interactive === true
      if (!interactive) {
        // Read-only lanes cannot type a prompt. Saying so up front is what lets
        // AUTO fall back locally instead of discovering it mid-consultation.
        return {
          state: "unavailable",
          reason: DEEPSEEK_WEB_FAILURE.BROWSER_UNAVAILABLE,
          supportsFollowUp: false,
          sessionReusable: false,
          browserInteractive: false,
          maxPacketChars: 0,
        }
      }
      // The auth state comes from a real observation. There is deliberately no
      // `authenticated: true` default here: with no probe bound the adapter is
      // `needs-auth`, so a missing wiring can never look like a logged-in user.
      const auth = await probeAuthState({ deps, config });
      if (auth.state !== "READY") {
        // UNKNOWN means no observation backed the answer, which for an auth gate
        // is the same practical position as "not logged in": refuse.
        const authRequired = auth.state === "NEEDS_AUTH" || auth.state === "UNKNOWN";
        return {
          state: auth.state === "TIMEOUT" ? "degraded" : "needs-auth",
          authState: auth.state,
          reason: authRequired
            ? DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
            : `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${auth.reason || "auth-probe"}`,
          supportsFollowUp: false,
          sessionReusable: false,
          browserInteractive: true,
          loginUrl: auth.url || config.options.entryUrl,
        }
      }
      return {
        state: "ready",
        authState: auth.state,
        reason: null,
        supportsFollowUp: true,
        sessionReusable: true,
        browserInteractive: true,
        maxPacketChars: config.options.maxPromptChars,
        latencyHintMs: config.options.answerTimeoutMs,
      }
    },

    /**
     * Start (or adopt) a session.
     *
     * A NEW session always navigates to `entryUrl` FIRST. A REUSED session runs a
     * read-only health probe instead: if the page is gone, redirected to a login
     * wall, or the UI no longer has a recognisable composer, the session is
     * REJECTED rather than silently typed into. Both paths are bounded, and
     * neither bypasses login -- a login wall is reported, never worked around.
     */
    async startSession(input = {}) {
      const now = typeof deps.now === "function" ? Number(deps.now()) : Date.now()
      const reused = Boolean(input.reuseSessionId)

      // V16.6.1: REUSE must not reset the conversation.
      //
      // The previous implementation navigated to `entryUrl` unconditionally,
      // while its own doc comment claimed a reused session runs a read-only
      // health probe. Navigating the entry URL on reuse discards the DeepSeek
      // conversation and opens a new chat: a follow-up delta was silently
      // becoming a fresh, context-free consultation. Reuse now takes the
      // read-only path; only a NEW session navigates.
      if (reused) {
        const probe = await probeReusedSession({ deps, config });
        if (probe.ok !== true) {
          return {
            sessionId: null,
            state: probe.state,
            reused,
            reason: probe.reason,
            openedUrl: probe.url || null,
            navigationPassed: false,
            authState: probe.authState || null,
          };
        }
        return {
          // The conversation id is preserved: this IS the same thread.
          sessionId: String(input.reuseSessionId),
          state: DEEPSEEK_WEB_STATE.READY,
          reused,
          reason: null,
          submitGuard: createSubmitGuard(),
          browserSession: createBrowserSession({ sessionId: `dsw-bs-${input.reuseSessionId}` }),
          openedUrl: probe.url || config.options.entryUrl,
          navigationPassed: false,
          navigationSkipped: true,
          authState: probe.authState || DEEPSEEK_WEB_AUTH_STATE.READY,
        };
      }

      const opened = await runAction(
        "navigate",
        { target: config.options.entryUrl, idempotencyKey: input.reuseSessionId || null },
        { provenIdempotent: true, session: input.browserSession },
      )
      if (opened.outcome !== "completed" && opened.outcome !== "unverified") {
        return {
          sessionId: null,
          state: DEEPSEEK_WEB_STATE.UI_CHANGED,
          reused,
          reason: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:entry-navigation-${opened.outcome}`,
          openedUrl: null,
          navigationPassed: false,
        }
      }

      // Short bounded SPA hydration settle after the entry navigation. DeepSeek
      // hydrates sidebar/history asynchronously (~2s): a single immediate probe
      // races hydration and reports UNKNOWN on an authenticated page. READY and
      // NEEDS_AUTH (login wall/URL) are terminal immediately; UNKNOWN /
      // UI_CHANGED / TIMEOUT retry for ~6s max, read-only, no navigation retry.
      const { auth } = await settlePostNavigateAuth({ deps, config });
      if (auth.state !== "READY") {
        // UNKNOWN (no observation bound) is treated as NEEDS_AUTH, not UI_CHANGED:
        // "we could not confirm a login" must not be reported to the operator as
        // "the vendor changed their markup", which sends them looking in the wrong
        // place entirely.
        const authRequired = auth.state === "NEEDS_AUTH" || auth.state === "UNKNOWN";
        return {
          sessionId: null,
          state: auth.state === "TIMEOUT"
            ? DEEPSEEK_WEB_STATE.TIMEOUT
            : authRequired
              ? DEEPSEEK_WEB_STATE.NEEDS_AUTH
              : DEEPSEEK_WEB_STATE.UI_CHANGED,
          reused,
          reason: auth.state === "NEEDS_AUTH"
            ? DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
            : auth.state === "TIMEOUT"
              ? DEEPSEEK_WEB_FAILURE.TIMEOUT
              : `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${auth.reason || "auth-probe"}`,
          authState: auth.state,
          authUrl: auth.url || null,
          openedUrl: opened.receipts?.[0]?.afterUrl || config.options.entryUrl,
          navigationPassed: true,
        }
      }

      return {
        sessionId: String(input.reuseSessionId || `dsw-${now.toString(36)}`),
        state: DEEPSEEK_WEB_STATE.READY,
        reused,
        reason: null,
        submitGuard: createSubmitGuard(),
        // ONE browser lane session for the whole conversation. Creating a fresh
        // one per action gave every action a new random session id, which silently
        // defeated the duplicate-submit guard -- the guard's key starts with the
        // session id, so two identical submits landed in different scopes and the
        // second was treated as a new, legitimate submission.
        browserSession: createBrowserSession({ sessionId: `dsw-bs-${now.toString(36)}` }),
        openedUrl: opened.receipts?.[0]?.afterUrl || config.options.entryUrl,
        navigationPassed: true,
        authState: auth.state,
        authUrl: auth.url || null,
      }
    },

    async consult(session, packet, options = {}) {
      const prompt = renderDeepSeekPrompt(packet, { requestId: options.requestId })
      if (prompt.length > config.options.maxPromptChars) {
        return { ok: false, failure: DEEPSEEK_WEB_FAILURE.PROMPT_TOO_LARGE, chars: prompt.length }
      }
      return sendPrompt(session, prompt, options, deps, config, runAction)
    },

    async followUp(session, delta, options = {}) {
      if (!session || session.state !== DEEPSEEK_WEB_STATE.READY) {
        return { ok: false, failure: DEEPSEEK_WEB_FAILURE.SESSION_LOST }
      }
      const prompt = [
        "[UES FOLLOW-UP DELTA]",
        "The previous advice did not survive local verification. Here is ONLY what changed.",
        "Return the same JSON schema. Do not repeat unchanged content.",
        "",
        delta.rendered || JSON.stringify(delta.sections || {}),
        "[END UES FOLLOW-UP DELTA]",
      ].join("\n")
      return sendPrompt(session, prompt, { ...options, followUp: true }, deps, config, runAction)
    },

    async closeSession(session) {
      if (!session) return false
      session.state = DEEPSEEK_WEB_STATE.CLOSED
      if (typeof deps.closeBrowser === "function") {
        try {
          await deps.closeBrowser()
        } catch {
          // Closing is best effort; a leaked page must never fail the run.
        }
      }
      return true
    },
  }

  return adapter
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

// Default post-action observations for the three steps of a prompt round trip.
//
// These are real observations read from what the provider reported, not
// assertions. A fill that typed nothing is `false`; a send that left the URL
// untouched and the composer populated is `false`. Declared expectations from the
// caller always win, so a lane that can observe more precisely can say so.
export async function deepSeekDefaultVerify(
  { action, result = {}, context = {}, declared = [] } = /** @type {any} */ ({}),
) {
  if (Array.isArray(declared) && declared.length) return declared
  if (action === "fill") {
    const filled = firstFinite(result.filledChars, result.result?.filledChars, result.result?.valueLength)
    return [{
      kind: BROWSER_EXPECTED_STATE_KIND.TEXT_PRESENT,
      expected: "non-empty prompt in the composer",
      observed: Number(filled || 0) > 0,
      required: true,
    }]
  }
  if (action === "click") {
    const after = result.afterUrl ?? null
    const before = result.beforeUrl ?? context.beforeUrl ?? null
    const urlMoved = Boolean(after && before && after !== before)
    const inputCleared = result.inputCleared === true || result.result?.inputCleared === true
    return [{
      kind: BROWSER_EXPECTED_STATE_KIND.SUCCESS_INDICATOR,
      expected: "prompt dispatched to the conversation",
      observed: urlMoved || inputCleared,
      required: true,
    }]
  }
  // The answer read declares no REQUIRED expectation on purpose: an empty answer
  // region while the model is still streaming is a normal state, not a failure.
  // Its real post-condition -- that the answer belongs to THIS request -- is
  // enforced by the ownership check below, not by a presence flag.
  return []
}

/**
 * Resolve the live auth state from the READ-ONLY probe.
 *
 * Three sources, in order of preference:
 *   1. `deps.authProbe` -- the managed browser worker's DOM/URL observation.
 *   2. `deps.loginProbe` -- an embedder-supplied observation (must return an
 *      observed state, never an asserted one).
 *   3. nothing bound -> NOT READY.
 *
 * There is no path here that returns READY without an observation behind it.
 */
export async function probeAuthState({ deps = {}, config = {} } = /** @type {any} */ ({})) {
  const lane = /** @type {Record<string, any>} */ (deps);
  const settings = /** @type {Record<string, any>} */ (config);
  if (typeof lane.authProbe === "function") {
    try {
      const observed = await lane.authProbe({
        answerSelectors: settings.options?.answerSelectors || [],
        composerSelector: settings.options?.promptBox?.selector || "",
        timeoutMs: settings.options?.authProbeTimeoutMs ?? 30_000,
      });
      const state = String(observed?.state || "UNKNOWN").toUpperCase();
      return {
        state: DEEPSEEK_WEB_AUTH_STATE[state] || DEEPSEEK_WEB_AUTH_STATE.UNKNOWN,
        reason: observed?.reason || null,
        url: observed?.url || null,
        answerRegions: Number(observed?.answerRegions || 0),
        source: "browser-auth-probe",
      };
    } catch (error) {
      return { state: "TIMEOUT", reason: `auth-probe-threw:${error?.message || error}`.slice(0, 160), url: null, source: "browser-auth-probe" };
    }
  }
  if (typeof lane.loginProbe === "function") {
    const observed = await lane.loginProbe();
    // An embedder probe must report an OBSERVED state. A legacy
    // `{ authenticated: true }` shape is accepted only when it is the embedder's
    // own observation and is labelled as such.
    const state = observed?.state
      ? String(observed.state).toUpperCase()
      : observed?.authenticated === true
        ? "READY"
        : observed?.authenticated === false
          ? "NEEDS_AUTH"
          : "UNKNOWN";
    return {
      state: DEEPSEEK_WEB_AUTH_STATE[state] || DEEPSEEK_WEB_AUTH_STATE.UNKNOWN,
      reason: observed?.reason || null,
      url: observed?.url || null,
      answerRegions: Number(observed?.answerRegions || 0),
      source: "embedder-login-probe",
    };
  }
  return {
    state: "UNKNOWN",
    reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED,
    url: null,
    source: "no-probe-bound",
  };
}

export const DEEPSEEK_WEB_AUTH_STATE = Object.freeze({
  READY: "READY",
  NEEDS_AUTH: "NEEDS_AUTH",
  UI_CHANGED: "UI_CHANGED",
  TIMEOUT: "TIMEOUT",
  UNKNOWN: "UNKNOWN",
});

/**
 * V16.6.1 read-only health probe for a REUSED conversation.
 *
 * It navigates nowhere. It asks three read-only questions:
 *   1. is the page still the DeepSeek conversation (not a login wall)?
 *   2. is the composer still present and recognised (selector drift)?
 *   3. is the DOM observation still possible at all (timeout)?
 *
 * Any failure REJECTS the session instead of typing into a page that is not the
 * expected conversation. A login wall is reported, never worked around: the
 * persistent browser profile and its cookies are read by the same probe that
 * every other action uses and are never exported.
 */
export async function probeReusedSession({ deps = {}, config = {} } = /** @type {any} */ ({})) {
  // Step 1: the canonical auth observation. It is read-only and it is the same
  // probe every other path uses, so a login wall is reported by identity
  // (NEEDS_AUTH) rather than as a generic UI failure.
  const auth = await probeAuthState({ deps, config });
  if (auth.state !== DEEPSEEK_WEB_AUTH_STATE.READY) {
    if (auth.url && isAuthWall(auth.url)) {
      return {
        ok: false,
        state: DEEPSEEK_WEB_STATE.NEEDS_AUTH,
        reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED,
        url: auth.url,
        authState: auth.state,
      };
    }
    const authRequired = auth.state === DEEPSEEK_WEB_AUTH_STATE.NEEDS_AUTH || auth.state === DEEPSEEK_WEB_AUTH_STATE.UNKNOWN;
    return {
      ok: false,
      state: auth.state === DEEPSEEK_WEB_AUTH_STATE.TIMEOUT
        ? DEEPSEEK_WEB_STATE.TIMEOUT
        : authRequired
          ? DEEPSEEK_WEB_STATE.NEEDS_AUTH
          : DEEPSEEK_WEB_STATE.UI_CHANGED,
      reason: authRequired
        ? DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
        : auth.state === DEEPSEEK_WEB_AUTH_STATE.TIMEOUT
          ? DEEPSEEK_WEB_FAILURE.TIMEOUT
          : `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${auth.reason || "auth-probe"}`,
      url: auth.url || null,
      authState: auth.state,
    };
  }

  // Step 2: read-only DOM observation. No navigation, no typing.
  const probe = async () => {
    if (typeof deps.freshSnapshot === "function") return await deps.freshSnapshot();
    if (typeof deps.invoke === "function") {
      return await deps.invoke("snapshot", { target: config?.options?.entryUrl }, {});
    }
    return null;
  };
  let observation = null;
  try {
    observation = await probe();
  } catch (error) {
    return {
      ok: false,
      state: DEEPSEEK_WEB_STATE.TIMEOUT,
      reason: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:reused-session-probe-${String(error?.message || error).slice(0, 120)}`,
      authState: auth.state,
    };
  }
  if (!observation || observation.ok === false) {
    return {
      ok: false,
      state: DEEPSEEK_WEB_STATE.LOGGED_OUT,
      reason: `${DEEPSEEK_WEB_FAILURE.SESSION_LOST}:reused-session-unreachable`,
      authState: auth.state,
    };
  }
  const url = String(observation.url || observation.snapshot?.url || auth.url || "");
  if (url && isAuthWall(url)) {
    return {
      ok: false,
      state: DEEPSEEK_WEB_STATE.NEEDS_AUTH,
      reason: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED,
      url,
      authState: DEEPSEEK_WEB_AUTH_STATE.NEEDS_AUTH,
    };
  }
  // The locator cascade is a COUNT-based measurement over the accessibility
  // inspection, so the probe passes the inspection it observed (never a
  // re-navigation) plus the configured prompt box.
  const inspection = observation?.inspection || observation?.snapshot?.inspection || observation;
  const target = resolveDeepSeekTarget(DEEPSEEK_LOCATOR_KIND.COMPOSER, inspection, {
    ...(config?.options || {}),
    snapshot: Array.isArray(observation?.snapshot) ? observation.snapshot : null,
  });
  if (!target || !target.ok) {
    // Selector drift and a lost conversation are DIFFERENT failures and stay
    // distinguishable: one needs a locator update, the other a new thread.
    return {
      ok: false,
      state: DEEPSEEK_WEB_STATE.UI_CHANGED,
      reason: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:reused-session-composer-${String(target?.reason || "missing")}`,
      url,
      authState: auth.state,
    };
  }
  return { ok: true, state: DEEPSEEK_WEB_STATE.READY, url, authState: DEEPSEEK_WEB_AUTH_STATE.READY };
}

function isAuthWall(url) {
  try {
    const parsed = new URL(String(url))
    const host = parsed.hostname.toLowerCase()
    if (host === "chat.deepseek.com") return /^\/(?:sign_?in|login|auth)/i.test(parsed.pathname)
    return /login|signin|sign-in|auth/i.test(host) || /^\/(?:login|signin|auth)/i.test(parsed.pathname)
  } catch {
    return /login|signin|sign-in/i.test(String(url))
  }
}

/**
 * Short bounded settle for the post-navigation auth probe inside startSession.
 *
 * Same policy as waitForAuthenticatedPage in lib/browser-profile.mjs, but over
 * probeAuthState (which wraps deps.authProbe/loginProbe) so the adapter keeps
 * its loginProbe fallback and its no-probe-bound UNKNOWN. READY and NEEDS_AUTH
 * are terminal immediately; UNKNOWN/UI_CHANGED/TIMEOUT retry read-only for
 * ~6s max and never convert into READY.
 */
export async function settlePostNavigateAuth({ deps = {}, config = {} } = /** @type {any} */ ({})) {
  const maxAttempts = Math.max(1, Math.min(10, Number(deps.settleMaxAttempts ?? AUTH_SETTLE_LIMIT.maxAttempts) || AUTH_SETTLE_LIMIT.maxAttempts));
  const intervalMs = Math.max(0, Math.min(5_000, Number(deps.settleIntervalMs ?? AUTH_SETTLE_LIMIT.intervalMs) || AUTH_SETTLE_LIMIT.intervalMs));
  const overallTimeoutMs = Math.max(500, Math.min(30_000, Number(deps.settleOverallTimeoutMs ?? AUTH_SETTLE_LIMIT.overallTimeoutMs) || AUTH_SETTLE_LIMIT.overallTimeoutMs));
  const startedAt = typeof deps.now === "function" ? Number(deps.now()) : Date.now();
  /** @type {any} */
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const auth = await probeAuthState({ deps, config });
    last = auth;
    if (auth.state === "READY" || auth.state === "NEEDS_AUTH") return { auth, attempts: attempt };
    const elapsedMs = Math.max(0, (typeof deps.now === "function" ? Number(deps.now()) : Date.now()) - startedAt);
    if (attempt >= maxAttempts || elapsedMs >= overallTimeoutMs) return { auth: last, attempts: attempt };
    const remaining = Math.max(0, overallTimeoutMs - elapsedMs);
    const waitMs = Math.max(0, Math.min(intervalMs, remaining));
    if (waitMs > 0) {
      if (typeof deps.sleep === "function") await deps.sleep(waitMs);
      else await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return { auth: last, attempts: maxAttempts };
}

/**
 * Health gate for a REUSED session. Fails closed on anything that is not an
 * explicit READY observation, so a stale or redirected tab is never typed into.
 */
export async function probeSessionHealth({ deps = {}, session = null } = /** @type {any} */ ({})) {
  const auth = await probeAuthState({ deps });
  if (auth.state !== "READY") {
    return {
      ok: false,
      auth,
      session: {
        sessionId: null,
        state: auth.state === "NEEDS_AUTH"
          ? DEEPSEEK_WEB_STATE.NEEDS_AUTH
          : auth.state === "TIMEOUT"
            ? DEEPSEEK_WEB_STATE.TIMEOUT
            : DEEPSEEK_WEB_STATE.UI_CHANGED,
        reused: true,
        reason: `reused-session-unhealthy:${auth.reason || auth.state}`,
        authState: auth.state,
        healthPassed: false,
      },
    };
  }
  if (session && typeof session === "object") {
    session.healthPassed = true;
    session.authState = auth.state;
  }
  return { ok: true, auth };
}

// ---------------------------------------------------------------------------
// Measured locator cascade (V16.3 selector-drift fix)
//
// The prompt composer drifted: role=textbox name="message to DeepSeek" times
// out on the real page, while selector=textarea succeeds (measured live).
// These resolvers pick the target from read-only vicinity evidence BEFORE any
// fill/click, so drift fails closed to UI_CHANGED instead of timing out or
// clicking a guessed element. Lanes without a domInspect binding keep the
// legacy defaults, which preserves every existing deterministic test.
// ---------------------------------------------------------------------------

/**
 * Read the sanitized composer vicinity once, or null when no binding exists
 * (legacy lane) or the inspection itself failed (caller fails closed).
 */
async function readVicinity({ deps = {} } = /** @type {any} */ ({})) {
  if (typeof deps.domInspect !== "function") return null
  try {
    const inspected = await deps.domInspect({ mode: "composer-vicinity" })
    if (inspected && inspected.ok && inspected.vicinity) return inspected.vicinity
  } catch {}
  return null
}

/**
 * Resolve the prompt composer read-only. Exactly one usable composer or
 * failure: never guess among ambiguous textareas.
 */
export async function resolveComposerTarget({ deps = {}, config = {} } = /** @type {any} */ ({})) {
  const settings = /** @type {Record<string, any>} */ (config)
  const vicinity = await readVicinity({ deps })
  if (!vicinity) {
    return {
      ok: true,
      target: settings.options?.promptBox || { strategy: "role-and-accessible-name", role: "textbox", accessibleName: "message to DeepSeek" },
      strategy: "role-and-accessible-name",
      reason: "legacy-composer-default",
      candidates: 1,
    }
  }
  const resolved = resolveDeepSeekTarget(DEEPSEEK_LOCATOR_KIND.COMPOSER, vicinity, { snapshot: deps.locatorSnapshot || null })
  if (!resolved.ok) return { ok: false, target: null, strategy: null, reason: resolved.reason, candidates: resolved.candidates }
  return { ok: true, target: resolved.target, strategy: resolved.strategy, reason: resolved.reason, candidates: resolved.candidates }
}

/**
 * Resolve the send control read-only AFTER a successful fill and BEFORE any
 * click. Unresolvable means UI_CHANGED before submit: never click a guess.
 *
 * `transition` (optional) is a sanitized pre/post-fill same-node summary.
 * When it proves exactly-one-changed, the returned target is a same-node
 * marker; otherwise resolution falls through fail-closed as before. Callers
 * without transition evidence (legacy lanes, deterministic tests) behave
 * exactly as before.
 */
export async function resolveSendTarget({ deps = {}, config = {}, transition = null } = /** @type {any} */ ({})) {
  const settings = /** @type {Record<string, any>} */ (config)
  const vicinity = await readVicinity({ deps })
  if (!vicinity) {
    return {
      ok: true,
      target: settings.options?.sendButton || { strategy: "role-and-accessible-name", role: "button", accessibleName: "Send" },
      strategy: "role-and-accessible-name",
      reason: "legacy-send-default",
      candidates: 1,
    }
  }
  const resolved = resolveDeepSeekTarget(DEEPSEEK_LOCATOR_KIND.SEND, vicinity, { snapshot: deps.locatorSnapshot || null, transition })
  if (!resolved.ok) return { ok: false, target: null, strategy: null, reason: resolved.reason, candidates: resolved.candidates, matches: resolved.matches ?? 0 }
  return { ok: true, target: resolved.target, strategy: resolved.strategy, reason: resolved.reason, candidates: resolved.candidates, matches: resolved.matches ?? 0 }
}

/**
 * Resolve the answer region. Never fails: with no observed message regions
 * (fresh page, nothing streamed yet) the long-standing primary selector is
 * assumed and the read loop below reports absence per the current contract.
 */
export async function resolveAnswerTarget({ deps = {}, config = {} } = /** @type {any} */ ({})) {
  const settings = /** @type {Record<string, any>} */ (config)
  const primary = settings.options?.answerRegion || { ...DEEPSEEK_ANSWER_CANDIDATES[0] }
  const vicinity = await readVicinity({ deps })
  if (!vicinity) {
    return { ok: true, target: primary, strategy: "stable-semantic-selector", reason: "primary-answer-default", candidates: DEEPSEEK_ANSWER_CANDIDATES.length }
  }
  const resolved = resolveDeepSeekTarget(DEEPSEEK_LOCATOR_KIND.ANSWER, vicinity)
  if (!resolved.ok) {
    return { ok: true, target: primary, strategy: "stable-semantic-selector", reason: "primary-answer-assumed", candidates: resolved.candidates }
  }
  return { ok: true, target: resolved.target, strategy: resolved.strategy, reason: resolved.reason, candidates: resolved.candidates }
}

// One prompt round trip: type -> submit -> wait -> extract -> verify ownership.
//
// PRODUCTION ORDER (the locator diagnostic reproduces this exactly, minus the
// click): resolve composer read-only -> PRE-FILL same-node snapshot ->
// FILL prompt (once) -> POST-FILL re-inspect SAME handles + vicinity +
// accessibility counts -> transition comparison -> resolve send ->
// CLICK send (at most once) -> wait for answer. Send is never resolved from
// stale pre-fill evidence and never by index: the second `readVicinity` and
// the transition measure below both happen AFTER the fill, so toolbar state
// changes caused by a non-empty composer are observed before any decision.
async function sendPrompt(session, prompt, options, deps, config, runAction) {
  const counters = createDeepSeekCounters()
  if (!session || session.state === DEEPSEEK_WEB_STATE.CLOSED) {
    return { ok: false, failure: DEEPSEEK_WEB_FAILURE.NO_SESSION, failureStage: DEEPSEEK_FAILURE_STAGE.SESSION_NAVIGATION, ...boundDeepSeekCounters(counters) }
  }
  // Submit preconditions. A prompt is never typed and never submitted unless the
  // session navigated AND the read-only auth probe is READY. A session that was
  // adopted but never health-checked is refused here.
  if (session.navigationPassed !== true) {
    return { ok: false, failure: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${DEEPSEEK_FAILURE_STAGE.SESSION_NAVIGATION}:navigation-not-confirmed`, failureStage: DEEPSEEK_FAILURE_STAGE.SESSION_NAVIGATION, ...boundDeepSeekCounters(counters) }
  }
  if (session.authState !== "READY") {
    return { ok: false, failure: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED, failureStage: DEEPSEEK_FAILURE_STAGE.SESSION_AUTH, ...boundDeepSeekCounters(counters) }
  }
  const requestId = String(options.requestId || `dsq-${session.sessionId}`)
  const submitGuard = session.submitGuard || createSubmitGuard()

  // Locator cascade: the composer is resolved read-only BEFORE typing, and
  // the send control AFTER typing but BEFORE clicking. Either unresolvable
  // fails closed to UI_CHANGED with no submit attempt.
  const composer = await resolveComposerTarget({ deps, config })
  if (!composer.ok) {
    return {
      ok: false,
      failure: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${DEEPSEEK_FAILURE_STAGE.COMPOSER_RESOLVE}:no-usable-composer:${composer.reason || "unresolvable"}`,
      failureStage: DEEPSEEK_FAILURE_STAGE.COMPOSER_RESOLVE,
      composerStrategy: composer.strategy || null,
      composerCandidates: composer.candidates ?? 0,
      composerReason: String(composer.reason || "").slice(0, 160),
      ...boundDeepSeekCounters(counters),
    }
  }
  // Optional pre-fill same-node snapshot. Read-only; lanes without transition
  // hooks skip it and behave exactly as before (fail-closed on ambiguity).
  let transitionArmed = false
  if (typeof deps.transitionBegin === "function") {
    try {
      const begun = await deps.transitionBegin({})
      transitionArmed = begun && begun.ok === true
    } catch { transitionArmed = false }
  }
  const typed = await runAction("fill", {
    value: prompt,
    target: composer.target,
    idempotencyKey: `${requestId}:prompt`,
  }, { provenIdempotent: true, session: options.browserSession || session.browserSession, submitGuard })
  counters.fillAttempts = 1
  const filledChars = Number(typed?.result?.filledChars ?? typed?.filledChars ?? 0)
  if (typed.outcome !== "completed") {
    const mapped = mapExecutionFailure(typed)
    const stage = mapped === DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED ? DEEPSEEK_FAILURE_STAGE.SESSION_AUTH : DEEPSEEK_FAILURE_STAGE.COMPOSER_FILL
    return {
      ok: false,
      failure: `${mapped}:${stage}:${String(typed?.reason || typed?.error || "fill-unverified").slice(0, 120)}`,
      failureStage: stage,
      composerStrategy: composer.strategy || null,
      composerCandidates: composer.candidates ?? 0,
      filledChars: Math.max(0, Math.min(1_000_000, filledChars)),
      ...boundDeepSeekCounters(counters),
      execution: typed,
    }
  }

  // The submit is the external side effect. It carries an explicit idempotency
  // key so the duplicate-submit guard refuses a replay of THIS prompt while
  // still allowing a genuinely different follow-up. No expected state is
  // declared here: `deepSeekDefaultVerify` observes dispatch from the URL
  // movement or input clearing the provider actually reports.
  //
  // POST-FILL resolution: this `readVicinity` runs AFTER the fill above, so a
  // toolbar/control-state change caused by the non-empty composer is observed
  // before any click decision. Never reuse the pre-fill inspection here.
  // The same-node transition measure (when armed) re-inspects THOSE SAME
  // handles post-fill; order swaps cannot confuse it.
  let transitionSummary = null
  if (transitionArmed && typeof deps.transitionMeasure === "function") {
    try {
      const measured = await deps.transitionMeasure({})
      if (measured && measured.ok === true && measured.transition) transitionSummary = measured.transition
    } catch { transitionSummary = null }
  }
  const send = await resolveSendTarget({ deps, config, transition: transitionSummary })
  if (!send.ok) {
    return {
      ok: false,
      failure: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL}:send-unresolvable-before-submit:${send.reason || "unresolvable"}`,
      failureStage: DEEPSEEK_FAILURE_STAGE.SEND_RESOLVE_POST_FILL,
      composerStrategy: composer.strategy || null,
      composerCandidates: composer.candidates ?? 0,
      sendStrategy: send.strategy || null,
      sendCandidates: send.candidates ?? 0,
      sendReason: String(send.reason || "").slice(0, 200),
      postFillSendMatches: Number(send.matches ?? 0) || 0,
      transitionUnique: transitionSummary ? transitionSummary.transitionUnique === true : false,
      filledChars: Math.max(0, Math.min(1_000_000, filledChars)),
      ...boundDeepSeekCounters(counters),
      execution: typed,
    }
  }
  const submitted = await (async () => {
    // Baseline BEFORE submit: capture READ-ONLY answer-region counts BEFORE
    // the click so an OLD assistant response can never be accepted as the new
    // consultation. Counts only, no content. Read-only: no fill/click here.
    const preSubmitBaseline = await readAnswerBaseline({ deps });
    const clicked = await runAction("click", {
      target: send.target,
      idempotencyKey: `${requestId}:send`,
    }, { externalSideEffect: true, session: options.browserSession || session.browserSession, submitGuard });
    // Stash baseline for the answer phase without a second read.
    clicked.__answerBaseline = preSubmitBaseline;
    return clicked;
  })();
  counters.submitAttempts = 1
  // Follow-up dispatch confirmation evidence. Stays null on every path
  // except a read-only-confirmed follow-up dispatch (set below); carried
  // into the success result so the receipt trail shows WHY an unverified
  // click was accepted as dispatched.
  let confirmedDispatch = null
  if (submitted.outcome === "refused" && submitted.reason === "duplicate-submit-refused") {
    return { ok: false, failure: DEEPSEEK_WEB_FAILURE.ANSWER_MISMATCH, failureStage: DEEPSEEK_FAILURE_STAGE.SEND_CLICK, reason: "duplicate-submit-refused", ...boundDeepSeekCounters(counters) }
  }
  if (submitted.outcome !== "completed") {
    const mapped = mapExecutionFailure(submitted)
    // A REQUIRED verification that observed false is a dispatch problem, not a
    // transport problem: the click happened but dispatch is unproven.
    const verifyFailed = submitted?.verification?.status === "failed" || String(submitted?.verification?.summary || "").includes("failed")
    const stage = mapped === DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
      ? DEEPSEEK_FAILURE_STAGE.SESSION_AUTH
      : verifyFailed
        ? DEEPSEEK_FAILURE_STAGE.DISPATCH_VERIFY
        : DEEPSEEK_FAILURE_STAGE.SEND_CLICK
    // Follow-up dispatch re-confirmation (read-only, zero clicks). The click
    // predicate only knows initial-consult signals (conversation-URL movement
    // or a worker-reported composer clear, which the worker hard-codes to
    // false): on a follow-up inside the SAME conversation neither fires even
    // when Send executed. When the transport demonstrably ran (a REQUIRED
    // verification exists and failed) and this is a follow-up, a bounded
    // read-only vicinity observation window (immediate first probe, then
    // 500ms re-probes up to 5 probes / 3s hard timeout) may still prove
    // dispatch via follow-up-valid signals. A confirmed dispatch falls through to the answer phase; any
    // other outcome returns the identical failure below. This path never
    // fills, clicks, submits or navigates, so the zero-retry
    // external-side-effect budget is structurally unchanged.
    if (verifyFailed && options.followUp === true) {
      confirmedDispatch = await confirmFollowUpDispatch({ deps, baseline: submitted.__answerBaseline })
      if (confirmedDispatch?.confirmed !== true) {
        return {
          ok: false,
          failure: `${mapped}:${stage}:${String(submitted?.reason || submitted?.error || "submit-unverified").slice(0, 120)}`,
          failureStage: stage,
          composerStrategy: composer.strategy || null,
          sendStrategy: send.strategy || null,
          sendCandidates: send.candidates ?? 0,
          dispatchConfirmation: confirmedDispatch,
          ...boundDeepSeekCounters(counters),
          execution: submitted,
        }
      }
    } else {
      return {
        ok: false,
        failure: `${mapped}:${stage}:${String(submitted?.reason || submitted?.error || "submit-unverified").slice(0, 120)}`,
        failureStage: stage,
        composerStrategy: composer.strategy || null,
        sendStrategy: send.strategy || null,
        sendCandidates: send.candidates ?? 0,
        ...boundDeepSeekCounters(counters),
        execution: submitted,
      }
    }
  }

  const answer = await resolveAnswerTarget({ deps, config })
  // Baseline captured BEFORE the click above (preSubmitBaseline). Reuse it so
  // the answer phase never performs a second pre-submit read that could race
  // the streaming response.
  const answerBaseline = submitted.__answerBaseline && typeof submitted.__answerBaseline === "object"
    ? submitted.__answerBaseline
    : await readAnswerBaseline({ deps })
  const answered = await waitForAnswer(session, { ...options, answerTarget: answer.target, answerBaseline }, deps, config, runAction)
  counters.snapshotAttempts = Number(answered?.snapshotAttempts || answered?.answerReadAttempts || 0)
  if (!answered.ok) {
    const rawFailure = String(answered.failure || "")
    // Stage mapping preserves the existing smoke contract: TIMEOUT and
    // NO_ANSWER stay distinct FAIL-family reasons, AUTH stays NEEDS_AUTH,
    // UI drift stays UI_CHANGED. Infrastructure tokens ride in the reason
    // suffix without changing the status classification.
    let stage = DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT
    if (rawFailure.includes(DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED)) stage = DEEPSEEK_FAILURE_STAGE.SESSION_AUTH
    else if (rawFailure.includes(DEEPSEEK_WEB_FAILURE.TIMEOUT)) stage = DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT
    else if (rawFailure.includes(DEEPSEEK_WEB_FAILURE.NO_ANSWER)) stage = DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT
    else if (rawFailure.includes(DEEPSEEK_WEB_FAILURE.UI_CHANGED)) stage = DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT
    else if (rawFailure.includes(DEEPSEEK_WEB_FAILURE.INVALID_RESPONSE)) stage = DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE
    else if (rawFailure.includes(DEEPSEEK_WEB_FAILURE.ANSWER_MISMATCH)) stage = DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE
    else stage = DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE
    return {
      ...answered,
      answerBaseline,
      failure: rawFailure.includes(":")
        ? rawFailure
        : `${rawFailure}:${stage}`,
      failureStage: answered.failureStage || stage,
      composerStrategy: composer.strategy || null,
      sendStrategy: send.strategy || null,
      ...boundDeepSeekCounters(counters),
    }
  }

  return {
    ok: true,
    requestId,
    answer: answered.answer,
    answerFingerprint: answered.fingerprint,
    latencyMs: answered.latencyMs,
    receipts: [...(typed.receipts || []), ...(submitted.receipts || []), ...(answered.receipts || [])],
    answerBaseline,
    answerSelectorCounts: answered.answerSelectorCounts || null,
    selectedAnswerStrategy: answered.selectedAnswerStrategy || null,
    answerTextChars: Number(answered.answerTextChars ?? String(answered.answer || "").length),
    // Null on every path except a read-only-confirmed follow-up dispatch.
    dispatchConfirmation: confirmedDispatch,
    ...boundDeepSeekCounters({ ...counters, snapshotAttempts: Number(answered?.snapshotAttempts || 0) }),
  }
}

function mapExecutionFailure(execution = {}) {
  if (execution?.reason === "browser-auth-required") return DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
  if (execution?.reason === "interactive-capability-unavailable") return DEEPSEEK_WEB_FAILURE.BROWSER_UNAVAILABLE
  if (execution?.recoveryReason === "no-allowed-locator-strategy") return DEEPSEEK_WEB_FAILURE.UI_CHANGED
  if (isAuthRequiredFailure(execution?.error)) return DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
  return DEEPSEEK_WEB_FAILURE.UI_CHANGED
}

// Answer-region baseline (READ-ONLY, counts only). Captured BEFORE Send so an
// OLD assistant response can never be accepted as the new consultation.
export async function readAnswerBaseline({ deps = {} } = {}) {
  if (typeof deps.domInspect === "function") {
    try {
      const inspected = await deps.domInspect({ mode: "deepseek-answer-regions" });
      if (inspected && inspected.ok && inspected.answerRegions) {
        const regions = inspected.answerRegions;
        // Normalize counts from families/counts into the canonical baseline.
        const counts = {};
        if (regions.counts && typeof regions.counts === "object") {
          for (const [k, v] of Object.entries(regions.counts)) counts[k] = Number(v) || 0;
        } else if (Array.isArray(regions.families)) {
          for (const row of regions.families) {
            if (row && row.selectorKey) counts[row.selectorKey] = Number(row.visibleCount) || 0;
          }
        }
        // Map hyphen keys to camel baseline.
        const baseline = normalizeAnswerBaseline(counts);
        return { ...baseline, _source: "deepseek-answer-regions", _available: true };
      }
    } catch {}
  }
  // Legacy lane without answer-region inspection: zeros, flagged unavailable.
  // Ownership then relies on the answerBelongsToRequest hook (existing tests).
  return { ...emptyAnswerBaseline(), _source: "unavailable", _available: false };
}

// Bounded read-only observation window for follow-up dispatch confirmation.
//
// WHY A WINDOW (live race): the V16.3 single live follow-up run reused the
// same session, resolved ready, filled once and clicked once, yet the single
// immediate post-click probe saw `stopVisible=false, answerGrew=false` and
// the run failed closed with `no-post-submit-dispatch-signal` before answer
// polling ever started. The DeepSeek UI streams asynchronously: the Stop
// control and the new answer region appear AFTER the click transport returns,
// so one immediate read races UI hydration and observes "nothing yet" even
// when Send executed. A bounded re-observation window fixes the race without
// touching the one-click budget.
//
// Defaults (overridable via deps only inside the clamps below):
//   click-to-first-probe ~0ms (probe 1 runs immediately, no pre-sleep)
//   probe interval 500ms (shared answer-poll primitive, clamped 400..750ms)
//   hard overall timeout 3000ms, max 5 read-only probes
// Elapsed time alone NEVER confirms: only the two explicit positive signals
// below return `confirmed:true`.
export const FOLLOWUP_DISPATCH_CONFIRM_LIMIT = Object.freeze({
  maxProbes: 5,
  intervalMs: 500,
  overallTimeoutMs: 3000,
});

// Follow-up dispatch re-confirmation (read-only, zero external actions).
//
// WHY THIS EXISTS: `deepSeekDefaultVerify` proves a click dispatched via
// `urlMoved || inputCleared`. Both are initial-consult signals: the first
// prompt creates a new conversation (URL moves), and the worker hard-codes
// `inputCleared: false` on every click. A follow-up inside the SAME
// conversation moves no URL, so a successfully executed Send fails the
// REQUIRED dispatch expectation with `submit-unverified` and the answer phase
// never starts -- even though the message is streaming.
//
// This helper re-proves dispatch with follow-up-valid POSITIVE signals only:
//   1. a visible streaming Stop control (generic "stop" token, allowlisted --
//      no labels, values or content cross the boundary), OR
//   2. answer-region growth versus the pre-submit baseline (a new response is
//      already streaming).
//
// Bounded READ-ONLY observation window: probe 1 runs immediately after the
// failed click verification (~0ms click-to-first-probe), then re-probes on
// the shared answer-poll interval until a positive signal appears, the hard
// overall timeout fires, or the max probe count is reached -- whichever comes
// first. Stops at the FIRST positive signal. Never fills, clicks, submits,
// navigates or retries the side effect. Returns `{ confirmed, reason,
// stopVisible, answerGrew, probes, elapsedMs }` (booleans, bounded counts and
// a bounded reason only). Lanes without a domInspect binding report
// unavailable with zero probes, which keeps their behaviour identical to
// before. A window that observes no positive signal returns
// `no-post-submit-dispatch-signal`, and the caller preserves the exact
// fail-closed `submit-unverified` outcome.
export async function confirmFollowUpDispatch({ deps = {}, baseline = null } = {}) {
  const nowOf = () => (typeof deps.now === "function" ? Number(deps.now()) : Date.now())
  const sleepFor = async (ms) => {
    if (typeof deps.sleep === "function") await deps.sleep(ms)
    else await new Promise((resolve) => setTimeout(resolve, ms))
  }
  const startedAt = nowOf()
  const elapsedOf = () => Math.max(0, nowOf() - startedAt)
  const negative = (reason, probes) => ({ confirmed: false, reason, stopVisible: false, answerGrew: false, probes, elapsedMs: elapsedOf() })
  if (typeof deps.domInspect !== "function") return negative("no-dispatch-confirmation-bound", 0)
  // Existing timing primitives: the probe interval reuses the answer-poll
  // interval (default 500ms, clamped 400..750ms exactly like waitForAnswer);
  // the attempt/timeout shape mirrors settlePostNavigateAuth.
  const maxProbes = Math.max(1, Math.min(6, Math.trunc(Number(deps.dispatchConfirmMaxProbes ?? FOLLOWUP_DISPATCH_CONFIRM_LIMIT.maxProbes)) || FOLLOWUP_DISPATCH_CONFIRM_LIMIT.maxProbes))
  const intervalMs = Math.max(400, Math.min(750, Number(deps.dispatchConfirmIntervalMs ?? deps.answerPollIntervalMs ?? DEEPSEEK_ANSWER_POLL_INTERVAL_MS) || DEEPSEEK_ANSWER_POLL_INTERVAL_MS))
  const overallTimeoutMs = Math.max(500, Math.min(5000, Number(deps.dispatchConfirmTimeoutMs ?? FOLLOWUP_DISPATCH_CONFIRM_LIMIT.overallTimeoutMs) || FOLLOWUP_DISPATCH_CONFIRM_LIMIT.overallTimeoutMs))
  let lastNegative = "no-post-submit-dispatch-signal"
  for (let probe = 1; probe <= maxProbes; probe += 1) {
    let inspected = null
    try {
      inspected = await deps.domInspect({ mode: "composer-vicinity" })
    } catch {
      lastNegative = "dispatch-confirmation-threw"
    }
    if (inspected !== null) {
      const vicinity = inspected && inspected.ok === true ? inspected.vicinity || null : null
      if (vicinity && typeof vicinity === "object") {
        const nearby = Array.isArray(vicinity.sendNearby) ? vicinity.sendNearby : []
        const stopVisible = nearby.some((row) => {
          if (!row || typeof row !== "object") return false
          return row.controlName?.generic === "stop" || row.ariaLabel?.generic === "stop"
        })
        let answerGrew = false
        try {
          const current = baselineFromAnswerCounts(vicinity.answers || {})
          answerGrew = isNewAnswerObserved({ counts: current }, baseline || {}) === true
        } catch {
          answerGrew = false
        }
        // Positive signals stop the window immediately; elapsed time alone
        // never confirms.
        if (stopVisible) return { confirmed: true, reason: "stop-control-visible-post-submit", stopVisible: true, answerGrew, probes: probe, elapsedMs: elapsedOf() }
        if (answerGrew) return { confirmed: true, reason: "answer-region-grew-post-submit", stopVisible: false, answerGrew: true, probes: probe, elapsedMs: elapsedOf() }
        lastNegative = "no-post-submit-dispatch-signal"
      } else {
        lastNegative = "dispatch-confirmation-unavailable"
      }
    }
    if (probe >= maxProbes || elapsedOf() >= overallTimeoutMs) break
    const remaining = Math.max(0, overallTimeoutMs - elapsedOf())
    const waitMs = Math.max(0, Math.min(intervalMs, remaining))
    if (waitMs > 0) await sleepFor(waitMs)
    if (elapsedOf() >= overallTimeoutMs) break
  }
  return negative(lastNegative, maxProbes)
}

/**
 * One READ-ONLY answer-region read. Prefers the dedicated
 * `deepseek-answer-regions` DOM_INSPECT path; falls back to a legacy snapshot
 * that reads ONLY `result.answer` (never whole-page text).
 *
 * Never clicks, fills, submits or navigates. Returns either
 * `{ ok:true, observation }` or `{ ok:false, read }` where `read` is the raw
 * executor result for exact failure preservation.
 */
export async function readAnswerRegion({ deps = {}, runAction = null, answerTarget = null, session = null, options = {} } = {}) {
  if (typeof deps.domInspect === "function") {
    try {
      const inspected = await deps.domInspect({ mode: "deepseek-answer-regions" });
      if (inspected && inspected.ok && inspected.answerRegions) {
        const raw = inspected.answerRegions;
        // Build a sanitized observation with baseline comparison.
        const families = Array.isArray(raw.families) ? raw.families : [];
        const counts = {};
        for (const row of families) {
          if (row && row.selectorKey) counts[row.selectorKey] = Number(row.visibleCount) || 0;
        }
        if (raw.counts && typeof raw.counts === "object") {
          for (const [k, v] of Object.entries(raw.counts)) {
            if (counts[k] === undefined) counts[k] = Number(v) || 0;
          }
        }
        const sel = raw.selected || null;
        const observation = sanitizeAnswerObservation({
          selectorKey: sel?.selectorKey || families.find((r) => (Number(r.visibleCount) || 0) > 0)?.selectorKey || null,
          visibleCount: sel ? Number(sel.visibleCount) || 0 : families.reduce((s, r) => s + (Number(r.visibleCount) || 0), 0),
          baselineCount: 0,
          textChars: sel ? Number(sel.textChars ?? String(sel.answerText || "").length) || 0 : 0,
          answerText: sel ? String(sel.answerText || "") : "",
          counts,
        });
        return { ok: true, observation, raw: inspected };
      }
      // Legacy lane: domInspect bound but without answer-region support
      // (returns vicinity for every mode). Fall through to the snapshot
      // answer-only path so existing deterministic tests keep passing.
      // A real refusal/failure (ok:false) is preserved below, never hidden.
      if (inspected && inspected.ok && !inspected.answerRegions && typeof runAction === "function") {
        // Fall through to snapshot fallback below.
      } else {
        // domInspect refused/failed: preserve exact cause via a synthetic read.
        return {
          ok: false,
          read: {
            outcome: "failed",
            reason: String(inspected?.reason || inspected?.failure || "answer-region-inspect-failed").slice(0, 160),
            failure: inspected?.failure ? { kind: String(inspected.failure).slice(0, 80) } : undefined,
            strategy: "deepseek-answer-regions",
          },
        };
      }
    } catch (error) {
      return {
        ok: false,
        read: {
          outcome: "failed",
          reason: String(error?.message || error || "answer-region-inspect-threw").slice(0, 160),
          strategy: "deepseek-answer-regions",
        },
      };
    }
  }
  // Legacy fallback: snapshot, answer-only. NEVER whole-page body text.
  if (typeof runAction !== "function") {
    return { ok: false, read: { outcome: "failed", reason: "no-answer-read-bound", strategy: "legacy-snapshot-answer-only" } };
  }
  const read = await runAction("snapshot", {
    target: answerTarget,
  }, { session });
  if (read.outcome === "refused" || read.outcome === "failed") {
    return { ok: false, read };
  }
  // STRICT: only the dedicated answer field. Whole-page text (sidebar and
  // history chrome) must never become an answer.
  const answerText = typeof deps.extractAnswer === "function"
    ? await deps.extractAnswer(read)
    : (typeof read.result?.answer === "string" ? read.result.answer : "");
  const bounded = String(answerText ?? "").slice(0, DEEPSEEK_ANSWER_MAX_CHARS);
  const observation = sanitizeAnswerObservation({
    selectorKey: null,
    visibleCount: bounded.trim() ? 1 : 0,
    baselineCount: 0,
    textChars: bounded.length,
    answerText: bounded,
    counts: null,
  });
  return { ok: true, observation, read };
}

// Answer extraction is deliberately ownership-gated and streaming-aware. The
// model streams, so the last message on the page may belong to the PREVIOUS
// turn; a response is only accepted when it can be bound to this request via
// baseline-newness AND (when bound) the ownership hook, with a complete JSON
// parse. Read-only polling only: never a new fill/click/submit/navigation.
export async function waitForAnswer(session, options, deps, config, runAction) {
  const startedAt = typeof deps.now === "function" ? Number(deps.now()) : Date.now()
  const timeoutMs = Number(options.answerTimeoutMs) || Number(config?.options?.answerTimeoutMs) || 90_000
  const deadline = startedAt + timeoutMs
  const requestId = String(options.requestId || "")
  const baselineRaw = options.answerBaseline && typeof options.answerBaseline === "object"
    ? options.answerBaseline
    : emptyAnswerBaseline()
  const baseline = normalizeAnswerBaseline(baselineRaw)
  const baselineAvailable = baselineRaw._available !== false && typeof deps.domInspect === "function"
  const pollIntervalMs = Math.max(400, Math.min(750, Number(deps.answerPollIntervalMs ?? options.answerPollIntervalMs ?? DEEPSEEK_ANSWER_POLL_INTERVAL_MS) || DEEPSEEK_ANSWER_POLL_INTERVAL_MS))
  let snapshotAttempts = 0
  let consecutiveReadFailures = 0
  let firstReadEvidence = null
  let lastText = ""
  let lastChangeAt = startedAt
  let lastObservation = null
  let lastSelectorKey = null
  let sawNewRegion = false
  let sawText = false

  const nowOf = () => (typeof deps.now === "function" ? Number(deps.now()) : Date.now());
  const sleepFor = async (ms) => {
    if (typeof deps.sleep === "function") await deps.sleep(ms);
    else await new Promise((resolve) => setTimeout(resolve, ms));
  };

  while (true) {
    const acquired = await readAnswerRegion({
      deps,
      runAction,
      answerTarget: options.answerTarget || config?.options?.answerRegion,
      session: options.browserSession || session?.browserSession,
      options,
    })
    snapshotAttempts += 1
    const readAttempts = snapshotAttempts

    if (!acquired.ok) {
      const read = acquired.read || {};
      const preserved = preserveAnswerReadFailure(read, readAttempts);
      if (!firstReadEvidence) firstReadEvidence = preserved;
      const token = String(preserved.answerReadFailure || "").toLowerCase();
      const reasonLower = String(preserved.answerReadReason || "").toLowerCase();
      // Terminal: auth required (never retry a login wall).
      if (token.includes("auth-required") || reasonLower.includes("browser-auth-required")) {
        session.state = DEEPSEEK_WEB_STATE.LOGGED_OUT
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED}:${DEEPSEEK_FAILURE_STAGE.SESSION_AUTH}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.SESSION_AUTH,
          snapshotAttempts,
          ...preserved,
          answerBaseline: { ...baseline },
          consecutiveReadFailures: consecutiveReadFailures + 1,
        }
      }
      // Terminal: selector drift / stale / target-not-found => UI_CHANGED with
      // measured evidence, never NO_ANSWER.
      if (token.includes("stale-locator") || token.includes("target-not-found") || token.includes("no-allowed-locator-strategy")) {
        session.state = DEEPSEEK_WEB_STATE.UI_CHANGED
        const mapped = token.includes("stale-locator") ? "stale-locator" : token.includes("target-not-found") ? "target-not-found" : "no-allowed-locator-strategy";
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}:${mapped}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          snapshotAttempts,
          ...preserved,
          answerBaseline: { ...baseline },
          consecutiveReadFailures: consecutiveReadFailures + 1,
        }
      }
      // Terminal: session aborted / worker closed (no page to poll).
      if (token.includes("browser-session-aborted") || token.includes("browser-worker-closed") || token.includes("worker-process-exited") || token.includes("transport-closed")) {
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.NO_ANSWER}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}:${token || "worker-closed"}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          snapshotAttempts,
          ...preserved,
          answerBaseline: { ...baseline },
          consecutiveReadFailures: consecutiveReadFailures + 1,
        }
      }
      // Retryable infrastructure (timeout / provider-error / transient):
      // bounded read-only recovery, no new fill/click/submit.
      consecutiveReadFailures += 1
      if (!shouldRecoverAnswerRead(consecutiveReadFailures)) {
        // Third consecutive infrastructure failure => exact reason preserved.
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.NO_ANSWER}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}:${String(preserved.answerReadFailure || "read-failed").slice(0, 120)}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          snapshotAttempts,
          ...preserved,
          firstReadEvidence,
          answerBaseline: { ...baseline },
          consecutiveReadFailures,
        }
      }
      // Deadline check before retrying the read.
      if (nowOf() >= deadline) {
        session.state = DEEPSEEK_WEB_STATE.TIMEOUT
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          waitedMs: Math.max(0, nowOf() - startedAt),
          snapshotAttempts,
          ...preserved,
          firstReadEvidence,
          answerBaseline: { ...baseline },
          consecutiveReadFailures,
        }
      }
      await sleepFor(pollIntervalMs)
      continue
    }

    // Successful READ-ONLY observation: reset consecutive failure count.
    consecutiveReadFailures = 0
    const observation = sanitizeAnswerObservation(acquired.observation || {});
    // Attach baseline comparison for ownership.
    const countsForBaseline = observation.counts || null;
    let ownership = false;
    if (baselineAvailable && countsForBaseline) {
      observation.baselineCount = 0;
      ownership = isNewAnswerObserved({ ...observation, counts: countsForBaseline }, baseline);
      // Enrich with per-family counts for diagnostics.
      observation.counts = { ...countsForBaseline };
    } else if (baselineAvailable && typeof observation.visibleCount === "number") {
      // domInspect path without counts map: compare totals.
      const baseTotal = Object.values(baseline).reduce((s, n) => s + (Number(n) || 0), 0);
      ownership = Number(observation.visibleCount) > baseTotal || observation.newRegionObserved === true;
    } else {
      // Legacy snapshot path: no structural baseline; ownership hook decides.
      ownership = true;
    }
    lastObservation = observation;
    if (observation.selectorKey) lastSelectorKey = observation.selectorKey;

    const answerText = typeof observation.answerText === "string" ? observation.answerText : "";
    const answerSelectorCounts = countsForBaseline ? { ...normalizeAnswerBaseline(countsForBaseline) } : null;

    // No new region yet (old answer only or empty page) => continue, NOT fail.
    if (baselineAvailable && !ownership) {
      if (nowOf() >= deadline) {
        session.state = DEEPSEEK_WEB_STATE.TIMEOUT
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          waitedMs: Math.max(0, nowOf() - startedAt),
          snapshotAttempts,
          answerReadOutcome: "completed",
          answerReadReason: "no-new-region-before-deadline",
          answerReadFailure: "no-new-region",
          answerReadRecoveryReason: null,
          answerReadAttempts: readAttempts,
          answerReadTargetStrategy: "deepseek-answer-regions",
          ...(firstReadEvidence ? { firstReadEvidence } : {}),
          answerBaseline: { ...baseline },
          answerSelectorCounts,
          selectedAnswerStrategy: lastSelectorKey,
          answerTextChars: 0,
          consecutiveReadFailures: 0,
        }
      }
      await sleepFor(pollIntervalMs)
      continue
    }

    // New region observed (or legacy path): track streaming.
    if (ownership) sawNewRegion = true;
    if (!answerText.trim()) {
      // NEW_REGION_EMPTY => continue polling.
      if (nowOf() >= deadline) {
        session.state = DEEPSEEK_WEB_STATE.TIMEOUT
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          waitedMs: Math.max(0, nowOf() - startedAt),
          snapshotAttempts,
          answerReadOutcome: "completed",
          answerReadReason: "new-region-empty-at-deadline",
          answerReadFailure: "new-region-empty",
          answerReadRecoveryReason: null,
          answerReadAttempts: readAttempts,
          answerReadTargetStrategy: "deepseek-answer-regions",
          ...(firstReadEvidence ? { firstReadEvidence } : {}),
          answerBaseline: { ...baseline },
          answerSelectorCounts,
          selectedAnswerStrategy: lastSelectorKey || observation.selectorKey,
          answerTextChars: 0,
          consecutiveReadFailures: 0,
        }
      }
      await sleepFor(pollIntervalMs)
      continue
    }
    sawText = true;
    if (answerText !== lastText) {
      lastText = answerText;
      lastChangeAt = nowOf();
    }

    // Ownership hook (request binding). Defaults to true; when bound it must
    // prove THIS request, otherwise the old answer is discarded, not parsed.
    let belongs = true;
    if (typeof deps.answerBelongsToRequest === "function") {
      try {
        belongs = await deps.answerBelongsToRequest(answerText, requestId);
      } catch {
        belongs = false;
      }
      // Legacy path without structural baseline relies entirely on this hook.
      // domInspect path uses it as an additional gate when the hook is strict
      // (tests prove old regions are rejected even when counts grew).
      if (!belongs) {
        const bound = verifyExpectedState({
          kind: BROWSER_EXPECTED_STATE_KIND.TEXT_PRESENT,
          expected: requestId,
          observed: false,
          required: true,
        });
        void bound;
        if (nowOf() >= deadline) {
          return { ok: false, failure: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:${DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE}`, failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE, snapshotAttempts, answerBaseline: { ...baseline }, answerSelectorCounts, selectedAnswerStrategy: lastSelectorKey || observation.selectorKey, answerTextChars: answerText.length }
        }
        await sleepFor(pollIntervalMs)
        continue
      }
    }

    // Stream completion: require a parseable complete JSON answer. Partial
    // JSON keeps polling; stabilized invalid returns answer-parse.
    let parsed = null;
    try {
      parsed = parseDeepSeekResponse(answerText);
    } catch {
      parsed = { ok: false, failure: "deepseek-response-not-json" };
    }
    if (parsed && parsed.ok === true) {
      return {
        ok: true,
        answer: answerText,
        fingerprint: typeof deps.answerFingerprint === "function" ? deps.answerFingerprint(answerText) : null,
        latencyMs: Math.max(0, nowOf() - startedAt),
        receipts: acquired.read?.receipts || [],
        snapshotAttempts,
        answerReadOutcome: "completed",
        answerReadReason: "valid-complete-json",
        answerReadFailure: null,
        answerReadRecoveryReason: null,
        answerReadAttempts: readAttempts,
        answerReadTargetStrategy: "deepseek-answer-regions",
        answerBaseline: { ...baseline },
        answerSelectorCounts,
        selectedAnswerStrategy: lastSelectorKey || observation.selectorKey,
        answerTextChars: answerText.length,
        consecutiveReadFailures: 0,
      }
    }
    // Parse failed.
    if (isPartialJson(answerText)) {
      // PARTIAL_JSON => continue polling; do not fail parse immediately.
      if (nowOf() >= deadline) {
        session.state = DEEPSEEK_WEB_STATE.TIMEOUT
        return {
          ok: false,
          failure: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}`,
          failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
          waitedMs: Math.max(0, nowOf() - startedAt),
          snapshotAttempts,
          answerReadOutcome: "completed",
          answerReadReason: "partial-json-at-deadline",
          answerReadFailure: "streaming-until-timeout",
          answerReadRecoveryReason: null,
          answerReadAttempts: readAttempts,
          answerReadTargetStrategy: "deepseek-answer-regions",
          ...(firstReadEvidence ? { firstReadEvidence } : {}),
          answerBaseline: { ...baseline },
          answerSelectorCounts,
          selectedAnswerStrategy: lastSelectorKey || observation.selectorKey,
          answerTextChars: answerText.length,
          consecutiveReadFailures: 0,
        }
      }
      await sleepFor(pollIntervalMs)
      continue
    }
    // Present but invalid (non-partial). If stabilized, report answer-parse;
    // otherwise keep polling for the remainder of the deadline.
    const stableForMs = Math.max(0, nowOf() - lastChangeAt);
    if (stableForMs >= DEEPSEEK_ANSWER_STABLE_MS) {
      return {
        ok: false,
        failure: `${DEEPSEEK_WEB_FAILURE.INVALID_RESPONSE}:${DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE}`,
        failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_PARSE,
        snapshotAttempts,
        answerReadOutcome: "completed",
        answerReadReason: String(parsed?.failure || "invalid-response").slice(0, 160),
        answerReadFailure: String(parsed?.failure || "invalid-response").slice(0, 160),
        answerReadRecoveryReason: null,
        answerReadAttempts: readAttempts,
        answerReadTargetStrategy: "deepseek-answer-regions",
        ...(firstReadEvidence ? { firstReadEvidence } : {}),
        answerBaseline: { ...baseline },
        answerSelectorCounts,
        selectedAnswerStrategy: lastSelectorKey || observation.selectorKey,
        answerTextChars: answerText.length,
        consecutiveReadFailures: 0,
      }
    }
    if (nowOf() >= deadline) {
      // Deadline with present-but-invalid text: distinguish invalid vs timeout.
      // Stabilized invalid already returned above; here the text was still
      // changing recently, so this is streaming-until-timeout.
      // If the text never stabilized but is clearly complete-invalid (not
      // partial), report answer-parse when the deadline proves no valid JSON
      // will arrive; streaming timeout stays TIMEOUT. Heuristic: if the text
      // changed recently, it was still streaming => TIMEOUT.
      session.state = DEEPSEEK_WEB_STATE.TIMEOUT
      // When the deadline expires with invalid complete text, prefer
      // answer-parse if the text had been stable for a meaningful window;
      // otherwise response-timeout. The stable window already returned, so
      // this remaining case is a timeout.
      return {
        ok: false,
        failure: `${DEEPSEEK_WEB_FAILURE.TIMEOUT}:${DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT}`,
        failureStage: DEEPSEEK_FAILURE_STAGE.ANSWER_WAIT,
        waitedMs: Math.max(0, nowOf() - startedAt),
        snapshotAttempts,
        answerReadOutcome: "completed",
        answerReadReason: String(parsed?.failure || "invalid-at-deadline").slice(0, 160),
        answerReadFailure: "answer-present-but-invalid-until-timeout",
        answerReadRecoveryReason: null,
        answerReadAttempts: readAttempts,
        answerReadTargetStrategy: "deepseek-answer-regions",
        ...(firstReadEvidence ? { firstReadEvidence } : {}),
        answerBaseline: { ...baseline },
        answerSelectorCounts,
        selectedAnswerStrategy: lastSelectorKey || observation.selectorKey,
        answerTextChars: answerText.length,
        consecutiveReadFailures: 0,
      }
    }
    // Expose poll state for tests without changing the wire contract.
    void classifyAnswerPoll({ observation, baseline, parseResult: parsed });
    await sleepFor(pollIntervalMs)
  }
}
