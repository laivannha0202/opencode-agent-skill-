// V16.3 Phase A: the single execution path for a browser action.
//
// Everything a browser lane can do goes through `executeBrowserAction`. That is
// the point of the module: preflight, routing, retry, stale recovery, receipt
// writing and telemetry are one deterministic pipeline, so there is no second
// code path where a caller can skip the "may this be retried" question.
//
// Dependencies are injected, so the entire pipeline is exercised by the
// deterministic tests with a fake provider. Nothing here reaches for a real
// browser: this module decides and records, `deps.invoke` performs.

import { BROWSER_ACTION_CLASS, classifyBrowserAction } from "./browser-action-taxonomy.mjs"
import { browserCapabilityRouting, preflightBrowserCapability } from "./browser-capability.mjs"
import { browserRetryDecision, classifyBrowserFailure, isAuthRequiredFailure } from "./browser-retry-policy.mjs"
import { chooseLocatorStrategy, locatorFingerprint, staleRecoveryDecision } from "./browser-stale-recovery.mjs"
import { externalTrustContract } from "./browser-security.mjs"
import {
  BROWSER_ACTION_RESULT,
  BROWSER_RECEIPT_SCHEMA_VERSION,
  buildActionReceipt,
  createBrowserTelemetry,
  summarizeVerification,
  verifyExpectedState,
} from "./browser-evidence.mjs"
import {
  classifyNavigationEvent,
  createBrowserSession,
  resolveBrowserTimeouts,
  resolveWaitUntil,
  shouldAbortBrowserSession,
} from "./browser-lifecycle.mjs"

export const BROWSER_EXECUTION_OUTCOME = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  REFUSED: "refused",
  ABORTED: "aborted",
  UNVERIFIED: "unverified",
})

export const BROWSER_REFUSAL_REASON = Object.freeze({
  INTERACTIVE_UNAVAILABLE: "interactive-capability-unavailable",
  SIDE_EFFECT_NOT_APPROVED: "external-side-effect-not-approved",
  DUPLICATE_SUBMIT: "duplicate-submit-refused",
  SESSION_ABORTED: "browser-session-aborted",
  UNKNOWN_ACTION: "unknown-browser-action",
  AUTH_REQUIRED: "browser-auth-required",
})

// Duplicate-submit guard.
//
// A submit is not retried, but it can still be *issued twice*: by a recovery
// loop, by a follow-up turn that re-reads a stale receipt, or by a provider that
// returned an ambiguous result. The guard keys on session + action + target
// identity, so a genuine second, different submission is still allowed while a
// replay of the same one is refused.
export function createSubmitGuard() {
  const seen = new Map()
  return {
    check(input = {}) {
      const taxonomy = input.taxonomy || {}
      if (taxonomy.actionClass !== BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT) {
        return { allowed: true, duplicate: false, key: null }
      }
      const key = [
        String(input.sessionId || "session"),
        String(taxonomy.action || "action"),
        String(input.locatorFingerprint || locatorFingerprint(input.locator || {})),
        String(input.beforeUrl || ""),
        String(input.idempotencyKey || ""),
      ].join("|")
      if (seen.has(key)) {
        return { allowed: false, duplicate: true, key, reason: BROWSER_REFUSAL_REASON.DUPLICATE_SUBMIT }
      }
      seen.set(key, { at: Number(input.now || 0) })
      return { allowed: true, duplicate: false, key }
    },
    size() {
      return seen.size
    },
    clear() {
      seen.clear()
    },
  }
}

function nowOf(deps) {
  return typeof deps.now === "function" ? Number(deps.now()) : Date.now()
}

function sleep(ms, deps) {
  const value = Math.max(0, Math.min(2_000, Number(ms) || 0))
  if (value === 0) return Promise.resolve()
  if (typeof deps.sleep === "function") return deps.sleep(value)
  return new Promise((resolve) => setTimeout(resolve, value))
}

function resolveLocator(input = {}) {
  const candidates = Array.isArray(input.locatorCandidates) && input.locatorCandidates.length
    ? input.locatorCandidates
    : (input.locator ? [input.locator] : [])
  const chosen = chooseLocatorStrategy(candidates)
  if (!chosen.allowed) {
    return { strategy: null, allowed: false, reason: chosen.reason, fingerprint: null }
  }
  const source = candidates.find((candidate) => {
    const strategy = typeof candidate === "string" ? candidate : candidate?.strategy
    return String(strategy || "").trim().toLowerCase().replace(/[\s_]+/g, "-") === chosen.strategy
  }) || {}
  return {
    strategy: chosen.strategy,
    allowed: true,
    reason: chosen.reason,
    fingerprint: locatorFingerprint(typeof source === "string" ? {} : source),
  }
}

function buildVerifications(input = {}) {
  const expected = Array.isArray(input.expectedStates) ? input.expectedStates : []
  return expected
    .filter((row) => row && typeof row === "object")
    .slice(0, 8)
    .map((row) => verifyExpectedState({
      kind: row.kind,
      expected: row.expected,
      observed: row.observed,
      required: row.required === true,
    }))
}

function refusal(input, reason, extra = {}) {
  return {
    schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
    kind: "ues-browser-action-refusal",
    outcome: BROWSER_EXECUTION_OUTCOME.REFUSED,
    action: input.taxonomy?.action || input.action || "unknown",
    actionClass: input.taxonomy?.actionClass || BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    reason,
    ...extra,
    trustLevel: "untrusted-external",
    ...externalTrustContract("browser-action-refusal"),
  }
}

/**
 * Execute exactly one browser action under the full V16.3 reliability contract.
 *
 * `deps` (all optional, all injectable for deterministic tests):
 *   capability  - precomputed capability object; otherwise built from `input`
 *   invoke      - async (action, context) => provider result
 *   freshSnapshot - async () => { ok, snapshot, targets }
 *   session     - prebuilt browser session
 *   submitGuard - prebuilt duplicate-submit guard
 *   telemetry   - browser telemetry recorder
 *   now / sleep - clock injection
 */
export async function executeBrowserAction(input = {}, deps = {}) {
  const taxonomy = classifyBrowserAction({
    action: input.action,
    provenIdempotent: input.provenIdempotent === true,
    provenExternalSideEffect: input.provenExternalSideEffect === true,
  })
  const action = taxonomy.action
  const telemetry = deps.telemetry || input.telemetry || createBrowserTelemetry()
  const timeouts = resolveBrowserTimeouts(input.timeouts || {})
  // `input.capability` is honoured so a caller that already ran preflight does
  // not have to thread the object through `deps` as well. Precomputing and
  // passing a capability in must never be silently ignored.
  const capability = deps.capability || input.capability || preflightBrowserCapability({
    tools: input.tools,
    providerName: input.providerName,
    nativeInspect: input.nativeInspect === true,
    healthTracker: input.healthTracker,
    health: input.health,
    requiredActions: input.requiredActions,
    capability: input.capabilityKind,
  })
  const session = deps.session || input.session || createBrowserSession(input.sessionOptions || {}, nowOf(deps))
  const submitGuard = deps.submitGuard || input.submitGuard || createSubmitGuard()

  // --- gate 1: is the action even known? -------------------------------------
  if (taxonomy.unknownAction === true) {
    telemetry.recordInteractiveCapabilityFailure()
    return {
      ...refusal(input, BROWSER_REFUSAL_REASON.UNKNOWN_ACTION, { taxonomy, capability }),
      taxonomy,
      capability,
      receipts: [],
      telemetry: telemetry.snapshot(),
    }
  }

  // --- gate 2: external side effects need explicit approval -----------------
  // Approval is checked BEFORE provider capability on purpose: an unapproved
  // action is refused regardless of whether a browser happens to be available,
  // so the refusal reason never leaks which providers exist.
  if (taxonomy.requiresExplicitApproval === true && input.approved !== true) {
    return {
      ...refusal(input, BROWSER_REFUSAL_REASON.SIDE_EFFECT_NOT_APPROVED, { taxonomy, capability }),
      taxonomy,
      capability,
      receipts: [],
      telemetry: telemetry.snapshot(),
    }
  }

  // --- gate 3: capability + routing -----------------------------------------
  const routing = browserCapabilityRouting(capability, { action })
  if (routing.failClosed) {
    telemetry.recordInteractiveCapabilityFailure()
    if (capability.fallbackAvailable) telemetry.recordNativeFallback()
    return {
      ...refusal(input, BROWSER_REFUSAL_REASON.INTERACTIVE_UNAVAILABLE, { taxonomy, capability, routing }),
      taxonomy,
      capability,
      receipts: [],
      telemetry: telemetry.snapshot(),
    }
  }
  if (routing.route === "native-inspect") telemetry.recordNativeFallback()

  // --- gate 4: session budget ------------------------------------------------
  const admission = typeof session.beginAction === "function"
    ? session.beginAction(nowOf(deps))
    : shouldAbortBrowserSession(session, nowOf(deps))
  if (admission && admission.ok === false || admission?.abort) {
    return {
      ...refusal(input, BROWSER_REFUSAL_REASON.SESSION_ABORTED, {
        taxonomy,
        capability,
        sessionReason: admission.reason || null,
      }),
      taxonomy,
      capability,
      receipts: [],
      telemetry: telemetry.snapshot(),
    }
  }

  const locator = resolveLocator(input)
  // The same candidate list drives the initial resolution and any recovery, so a
  // recovery can never re-resolve onto a worse selector than the one that failed.
  const locatorCandidates = [
    ...(Array.isArray(input.locatorCandidates) ? input.locatorCandidates : []),
    input.locator,
    input.target,
  ].filter(Boolean)
  const provider = capability.provider || input.providerName || "browser"
  const waitUntil = resolveWaitUntil({ action, waitUntil: input.waitUntil, taxonomy })
  const submitCheck = submitGuard.check({
    sessionId: session.id,
    taxonomy,
    locatorFingerprint: locator.fingerprint,
    beforeUrl: input.beforeUrl,
    idempotencyKey: input.idempotencyKey,
    now: nowOf(deps),
  })
  if (submitCheck.allowed === false) {
    return {
      ...refusal(input, submitCheck.reason, { taxonomy, capability }),
      taxonomy,
      capability,
      receipts: [],
      telemetry: telemetry.snapshot(),
    }
  }

  // --- attempt loop ---------------------------------------------------------
  const receipts = []
  let attempt = 1
  let staleRetries = 0
  let transientRetries = 0
  let staleRecoveryAttempts = 0
  let staleRecovered = false
  let currentLocator = locator
  const startedAt = nowOf(deps)
  let lastResult = null

  while (true) {
    const attemptStart = nowOf(deps)
    if (typeof deps.invoke !== "function") {
      lastResult = { ok: false, error: "no-browser-provider-bound" }
    } else {
      try {
        lastResult = await deps.invoke(action, {
          attempt,
          locator: currentLocator,
          target: input.target || null,
          value: input.value,
          waitUntil,
          navigationTimeoutMs: timeouts.navigationTimeoutMs,
          actionTimeoutMs: timeouts.actionTimeoutMs,
          waitTimeoutMs: timeouts.waitTimeoutMs,
          browserToolTimeoutMs: timeouts.browserToolTimeoutMs,
          sessionId: session.id,
        }) || {}
      } catch (error) {
        lastResult = { ok: false, error: error?.message || String(error) }
      }
    }

    const failure = lastResult.ok === true
      ? null
      : classifyBrowserFailure({ message: lastResult.error, kind: lastResult.failureKind })
    if (failure?.kind === "transient") telemetry.recordMcpTransientFailure()

    if (failure === null) {
      // Success path. Verification is mandatory where the taxonomy demands it.
      const navigation = classifyNavigationEvent({
        beforeUrl: lastResult.beforeUrl ?? input.beforeUrl,
        afterUrl: lastResult.afterUrl,
        waitUntil: lastResult.navigates ? resolveWaitUntil({ taxonomy }) : waitUntil,
        loadState: lastResult.loadState,
        documentChanged: lastResult.documentChanged,
        redirected: lastResult.redirected,
        durationMs: Math.max(0, nowOf(deps) - attemptStart),
      })
      telemetry.recordNavigation(navigation)

      // `deps.verify` is the seam for callers that can only observe the page
      // through their own provider (the DeepSeek adapter, for example). Without
      // it, a declared expectation would have to hard-code `observed: true`,
      // which is exactly the tool-success-as-proof mistake this phase removes.
      const expected = typeof deps.verify === "function"
        ? await deps.verify({
          action,
          taxonomy,
          result: lastResult,
          context: { attempt, locator: currentLocator, beforeUrl: input.beforeUrl },
          declared: Array.isArray(input.expectedStates) ? input.expectedStates : [],
        })
        : input.expectedStates
      const verifications = buildVerifications({
        ...input,
        expectedStates: expected,
      })
      const summary = summarizeVerification(verifications)
      const receipt = buildActionReceipt({
        actionId: input.actionId,
        action,
        taxonomy,
        provider,
        route: routing.route,
        beforeUrl: lastResult.beforeUrl ?? input.beforeUrl,
        afterUrl: lastResult.afterUrl,
        locatorStrategy: currentLocator.strategy,
        locatorFingerprint: currentLocator.fingerprint,
        startTime: attemptStart,
        endedAt: nowOf(deps),
        durationMs: Math.max(0, nowOf(deps) - attemptStart),
        result: BROWSER_ACTION_RESULT.SUCCESS,
        retryCount: attempt - 1,
        staleRecovered,
        navigationObserved: navigation.observed,
        screenshotRef: lastResult.screenshotRef,
        snapshotRef: lastResult.snapshotRef,
        consoleErrorCount: lastResult.consoleErrorCount,
        networkFailureCount: lastResult.networkFailureCount,
        verifications,
        providerResult: lastResult.result,
        sequence: receipts.length,
      })
      receipts.push(receipt)
      telemetry.recordReceipt(receipt)
      return {
        schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
        kind: "ues-browser-action-execution",
        outcome: summary.status === "failed"
          ? BROWSER_EXECUTION_OUTCOME.FAILED
          : receipt.result === BROWSER_ACTION_RESULT.UNVERIFIED
            ? BROWSER_EXECUTION_OUTCOME.UNVERIFIED
            : BROWSER_EXECUTION_OUTCOME.COMPLETED,
        action,
        taxonomy,
        capability,
        routing,
        navigation,
        verification: summary,
        receipts,
        attempts: attempt,
        retries: attempt - 1,
        staleRecovered,
        durationMs: Math.max(0, nowOf(deps) - startedAt),
        result: lastResult.result ?? null,
        telemetry: telemetry.snapshot(),
      }
    }

    // --- failure path -------------------------------------------------------
    if (failure.authRequired) {
      const receipt = buildActionReceipt({
        action,
        taxonomy,
        provider,
        route: routing.route,
        startTime: attemptStart,
        endedAt: nowOf(deps),
        result: BROWSER_ACTION_RESULT.REFUSED,
        retryCount: attempt - 1,
        verifications: [],
        sequence: receipts.length,
      })
      receipts.push(receipt)
      telemetry.recordReceipt(receipt)
      return {
        schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
        kind: "ues-browser-action-execution",
        outcome: BROWSER_EXECUTION_OUTCOME.REFUSED,
        action,
        taxonomy,
        capability,
        receipts,
        attempts: attempt,
        reason: BROWSER_REFUSAL_REASON.AUTH_REQUIRED,
        error: isAuthRequiredFailure(lastResult.error) ? "browser-auth-required" : "browser-auth-required",
        telemetry: telemetry.snapshot(),
      }
    }

    let recoveryReason = null
    if (failure.kind === "stale-locator") {
      telemetry.recordStaleFailure()
      const snapshot = typeof deps.freshSnapshot === "function"
        ? await deps.freshSnapshot({ attempt, locator: currentLocator })
        : null
      const decision = staleRecoveryDecision({
        taxonomy,
        failureKind: failure.kind,
        freshSnapshot: snapshot?.ok === true ? (snapshot.snapshot ?? snapshot) : null,
        before: input.target || input.locator || {},
        after: snapshot?.target || snapshot?.resolved || input.target || input.locator || {},
        locatorCandidates,
        // The count of recoveries ALREADY performed, not including this one.
        // Passing the post-increment value here made every first recovery look
        // like a repeat and silently disabled the whole feature.
        staleRecoveryAttempts,
        stateMayHaveApplied: input.stateMayHaveApplied === true || lastResult.stateMayHaveApplied === true,
        confidenceThreshold: input.identityConfidenceThreshold,
      })
      if (decision.recover) {
        staleRecoveryAttempts += 1
        staleRetries += 1
        staleRecovered = true
        currentLocator = {
          strategy: decision.locator.strategy,
          allowed: true,
          reason: decision.locator.reason,
          fingerprint: locatorFingerprint(snapshot?.target || input.target || {}),
        }
        // The recovery step is itself receipted and lands in the ledger: the
        // evidence trail has to show the failed attempt AND the single bounded
        // re-resolution, not just the final success. Its own `staleRecovered` is
        // false because this receipt records the RE-RESOLUTION, which did not
        // itself complete an action; the succeeding receipt carries the flag.
        const recoveryReceipt = buildActionReceipt({
          action,
          taxonomy,
          provider,
          route: routing.route,
          startTime: attemptStart,
          endedAt: nowOf(deps),
          result: BROWSER_ACTION_RESULT.SKIPPED,
          retryCount: attempt - 1,
          staleRecovered: false,
          locatorStrategy: currentLocator.strategy,
          locatorFingerprint: currentLocator.fingerprint,
          snapshotRef: snapshot?.snapshot?.ref ?? snapshot?.ref ?? null,
          verifications: [],
          sequence: receipts.length,
        })
        receipts.push(recoveryReceipt)
        telemetry.recordReceipt(recoveryReceipt)
        attempt += 1
        continue
      }
      recoveryReason = decision.reason
    }

    const retry = browserRetryDecision({
      taxonomy,
      attempt,
      failureKind: failure.kind,
      message: lastResult.error,
      retryKind: failure.kind === "stale-locator" ? "stale-locator" : "transient",
      staleRetries,
      transientRetries,
    })

    if (retry.retry && retry.kind === "transient" && failure.kind === "transient") {
      transientRetries += 1
      await sleep(retry.delayMs, deps)
      attempt = retry.nextAttempt
      continue
    }

    const receipt = buildActionReceipt({
      action,
      taxonomy,
      provider,
      route: routing.route,
      startTime: attemptStart,
      endedAt: nowOf(deps),
      result: BROWSER_ACTION_RESULT.FAILURE,
      retryCount: attempt - 1,
      staleRecovered,
      locatorStrategy: currentLocator.strategy,
      locatorFingerprint: currentLocator.fingerprint,
      verifications: [],
      sequence: receipts.length,
    })
    receipts.push(receipt)
    telemetry.recordReceipt(receipt)
    return {
      schemaVersion: BROWSER_RECEIPT_SCHEMA_VERSION,
      kind: "ues-browser-action-execution",
      outcome: BROWSER_EXECUTION_OUTCOME.FAILED,
      action,
      taxonomy,
      capability,
      receipts,
      attempts: attempt,
      retries: attempt - 1,
      staleRecovered,
      failure,
      retryDecision: retry,
      recoveryReason,
      error: lastResult.error || null,
      durationMs: Math.max(0, nowOf(deps) - startedAt),
      telemetry: telemetry.snapshot(),
    }
  }
}

export function browserCapabilityPreflight(input = {}) {
  return preflightBrowserCapability(input)
}
