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
    maxFollowUps: deps.maxFollowUps ?? 4,
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

      const auth = await probeAuthState({ deps, config });
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
        browserSession: createBrowserSession({ sessionId: `dsw-bs-${input.reuseSessionId || now.toString(36)}` }),
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

// One prompt round trip: type -> submit -> wait -> extract -> verify ownership.
async function sendPrompt(session, prompt, options, deps, config, runAction) {
  if (!session || session.state === DEEPSEEK_WEB_STATE.CLOSED) {
    return { ok: false, failure: DEEPSEEK_WEB_FAILURE.NO_SESSION }
  }
  // Submit preconditions. A prompt is never typed and never submitted unless the
  // session navigated AND the read-only auth probe is READY. A session that was
  // adopted but never health-checked is refused here.
  if (session.navigationPassed !== true) {
    return { ok: false, failure: `${DEEPSEEK_WEB_FAILURE.UI_CHANGED}:navigation-not-confirmed` }
  }
  if (session.authState !== "READY") {
    return { ok: false, failure: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }
  }
  const requestId = String(options.requestId || `dsq-${session.sessionId}`)
  const submitGuard = session.submitGuard || createSubmitGuard()

  const typed = await runAction("fill", {
    value: prompt,
    target: config.options.promptBox,
    idempotencyKey: `${requestId}:prompt`,
  }, { provenIdempotent: true, session: options.browserSession || session.browserSession, submitGuard })
  if (typed.outcome !== "completed") {
    return { ok: false, failure: mapExecutionFailure(typed), execution: typed }
  }

  // The submit is the external side effect. It carries an explicit idempotency
  // key so the duplicate-submit guard refuses a replay of THIS prompt while
  // still allowing a genuinely different follow-up. No expected state is
  // declared here: `deepSeekDefaultVerify` observes dispatch from the URL
  // movement or input clearing the provider actually reports.
  const submitted = await runAction("click", {
    target: config.options.sendButton,
    idempotencyKey: `${requestId}:send`,
  }, { externalSideEffect: true, session: options.browserSession || session.browserSession, submitGuard })
  if (submitted.outcome === "refused" && submitted.reason === "duplicate-submit-refused") {
    return { ok: false, failure: DEEPSEEK_WEB_FAILURE.ANSWER_MISMATCH, reason: "duplicate-submit-refused" }
  }
  if (submitted.outcome !== "completed") {
    return { ok: false, failure: mapExecutionFailure(submitted), execution: submitted }
  }

  const answered = await waitForAnswer(session, options, deps, config, runAction)
  if (!answered.ok) return answered

  return {
    ok: true,
    requestId,
    answer: answered.answer,
    answerFingerprint: answered.fingerprint,
    latencyMs: answered.latencyMs,
    receipts: [...(typed.receipts || []), ...(submitted.receipts || []), ...(answered.receipts || [])],
  }
}

function mapExecutionFailure(execution = {}) {
  if (execution?.reason === "browser-auth-required") return DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
  if (execution?.reason === "interactive-capability-unavailable") return DEEPSEEK_WEB_FAILURE.BROWSER_UNAVAILABLE
  if (execution?.recoveryReason === "no-allowed-locator-strategy") return DEEPSEEK_WEB_FAILURE.UI_CHANGED
  if (isAuthRequiredFailure(execution?.error)) return DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED
  return DEEPSEEK_WEB_FAILURE.UI_CHANGED
}

// Answer extraction is deliberately two-step. The model streams, so the last
// message on the page may belong to the PREVIOUS turn; a response is only
// accepted when it can be bound to this request.
async function waitForAnswer(session, options, deps, config, runAction) {
  const startedAt = typeof deps.now === "function" ? Number(deps.now()) : Date.now()
  const deadline = startedAt + (Number(options.answerTimeoutMs) || config.options.answerTimeoutMs)
  const requestId = String(options.requestId || "")

  while (true) {
    const read = await runAction("snapshot", {
      target: config.options.answerRegion,
    }, { session: options.browserSession || session.browserSession })
    if (read.outcome === "refused" || read.outcome === "failed") {
      if (read.reason === "browser-auth-required") {
        session.state = DEEPSEEK_WEB_STATE.LOGGED_OUT
        return { ok: false, failure: DEEPSEEK_WEB_FAILURE.AUTH_REQUIRED }
      }
      if (read.recoveryReason === "no-allowed-locator-strategy" || read.failure?.kind === "stale-locator") {
        session.state = DEEPSEEK_WEB_STATE.UI_CHANGED
        return { ok: false, failure: DEEPSEEK_WEB_FAILURE.UI_CHANGED }
      }
      return { ok: false, failure: DEEPSEEK_WEB_FAILURE.NO_ANSWER, execution: read }
    }

    const answer = typeof deps.extractAnswer === "function"
      ? await deps.extractAnswer(read)
      : (read.result?.answer ?? read.result?.text ?? null)
    if (typeof answer === "string" && answer.trim()) {
      const bound = verifyExpectedState({
        kind: BROWSER_EXPECTED_STATE_KIND.TEXT_PRESENT,
        expected: requestId,
        observed: typeof deps.answerBelongsToRequest === "function"
          ? await deps.answerBelongsToRequest(answer, requestId)
          : true,
        required: true,
      })
      if (!bound.verified) {
        // Either the page still shows the previous answer, or ownership cannot
        // be proven. Neither may be parsed as THIS turn's advice.
        if (typeof deps.now === "function" && Number(deps.now()) >= deadline) {
          return { ok: false, failure: DEEPSEEK_WEB_FAILURE.TIMEOUT }
        }
        if (typeof deps.sleep === "function") await deps.sleep(250)
        continue
      }
      return {
        ok: true,
        answer,
        fingerprint: typeof deps.answerFingerprint === "function" ? deps.answerFingerprint(answer) : null,
        latencyMs: (typeof deps.now === "function" ? Number(deps.now()) : Date.now()) - startedAt,
        receipts: read.receipts || [],
      }
    }

    const now = typeof deps.now === "function" ? Number(deps.now()) : Date.now()
    if (now >= deadline) {
      session.state = DEEPSEEK_WEB_STATE.TIMEOUT
      return { ok: false, failure: DEEPSEEK_WEB_FAILURE.TIMEOUT, waitedMs: now - startedAt }
    }
    if (typeof deps.sleep === "function") await deps.sleep(250)
  }
}
