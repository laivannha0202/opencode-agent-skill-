// V16.3 runtime integration: the managed browser lane for the Pi controller.
//
// WHY THIS FILE EXISTS. The V16.3 Phase A modules decide *policy*. This file is
// the adapter that puts that policy on the real Pi tool path, and it deliberately
// contains ZERO policy of its own: every allow/block decision is produced by
// `classifyBrowserAction`, `browserCapabilityRouting` or `browserRetryDecision`,
// and every receipt is produced by `buildActionReceipt`.
//
// The shape is dictated by the host. A Pi `tool_call` hook can allow, block or
// annotate a call; it cannot dispatch one. So the lane is a GATE plus a RECEIPT:
//
//   tool_call  -> browserActionGate()      -> allow | block(reason)  + budget ledger
//   tool_result-> browserActionReceipt()   -> evidence receipt + verification verdict
//
// Two consequences are deliberate and are the safety properties of this file:
//
//   1. A managed browser tool cannot be called by the model while the V16.3
//      policy would refuse it. There is no "unmanaged" browser path.
//   2. Because the host dispatches, a retry is a NEW model-initiated call, not an
//      automatic replay. The lane enforces the recovery ORDER (fresh snapshot
//      before re-resolution) and the retry BUDGET, so the model cannot replay a
//      stale click forever, and an external side effect can never be replayed at
//      all because it has zero budget and the duplicate guard refuses the second
//      submission of the same target.

import {
  BROWSER_ACTION_CLASS,
  classifyBrowserAction,
} from "./browser-action-taxonomy.mjs"
import {
  browserCapabilityRouting,
  browserCapabilityToolExposure,
  preflightBrowserCapability,
  actionFromBrowserToolName,
} from "./browser-capability.mjs"
import { browserRetryDecision, classifyBrowserFailure, BROWSER_RETRY_LIMITS } from "./browser-retry-policy.mjs"
import { locateTargetIdentity, staleRecoveryDecision } from "./browser-stale-recovery.mjs"
import {
  BROWSER_ACTION_RESULT,
  BROWSER_VERIFICATION_STATUS,
  buildActionReceipt,
  createBrowserTelemetry,
  verifyExpectedState,
} from "./browser-evidence.mjs"
import { cleanupBrowserArtifacts, createBrowserSession, resolveBrowserTimeouts } from "./browser-lifecycle.mjs"
import { createSubmitGuard } from "./browser-execution.mjs"
import { externalTrustContract } from "./browser-security.mjs"
import { locatorFingerprint } from "./browser-stale-recovery.mjs"

export const BROWSER_LANE_SCHEMA_VERSION = 1

export const BROWSER_GATE_DECISION = Object.freeze({
  ALLOW: "allow",
  BLOCK: "block",
})

export const BROWSER_BLOCK_REASON = Object.freeze({
  UNMANAGED: "not-a-managed-browser-tool",
  UNKNOWN_ACTION: "unknown-browser-action-fail-closed",
  CAPABILITY_FAIL_CLOSED: "interactive-capability-unavailable",
  PROVIDER_COOLDOWN: "browser-provider-in-bounded-cooldown",
  SIDE_EFFECT_NOT_APPROVED: "external-side-effect-not-approved",
  DUPLICATE_SUBMIT: "duplicate-submit-refused",
  FRESH_SNAPSHOT_REQUIRED: "fresh-semantic-snapshot-required-before-retry",
  RETRY_BUDGET_EXHAUSTED: "retry-budget-exhausted",
  RECOVERY_NOT_ALLOWED: "stale-recovery-not-allowed",
  ACTION_ALREADY_APPLIED: "state-may-have-already-been-applied",
})

export const BROWSER_LANE_VERIFICATION_STATUS = Object.freeze({
  VERIFIED: "VERIFIED",
  NOT_VERIFIED: "NOT_VERIFIED",
  FAILED: "FAILED",
})

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function normalizeToolName(name) {
  return String(name || "").trim()
}

/** @param {any[]} tools host tool descriptors */
function hostBrowserTools(tools = []) {
  const rows = Array.isArray(tools) ? tools : []
  return rows.map((tool) => (typeof tool === "string" ? { name: tool } : tool || {}))
}

// ---------------------------------------------------------------------------
// Lane construction
// ---------------------------------------------------------------------------

/**
 * Build the managed browser lane for a run.
 *
 * `options`:
 *   tools                 host tool descriptors (or names)
 *   healthTracker         McpHealthTracker instance
 *   nativeInspect         native Playwright inspect is available
 *   requiredActions       explicit action list for the task
 *   approvedSideEffects   true only when the USER approved external side effects
 *   sessionOptions        bounded session options
 *   limits                retry overrides (bounded by the taxonomy anyway)
 */
export function createBrowserLane(options = {}) {
  const tools = hostBrowserTools(options.tools)
  const telemetry = options.telemetry || createBrowserTelemetry()
  const submitGuard = options.submitGuard || createSubmitGuard()
  const session = options.session || createBrowserSession(options.sessionOptions || {})
  const nowOf = typeof options.now === "function" ? () => Number(options.now()) : () => Date.now()
  const timeouts = resolveBrowserTimeouts(options.timeouts || {})
  /** @type {Map<string, any>} */
  const pending = new Map()
  /** @type {Map<string, any>} */
  const budgets = new Map()
  /** @type {any} */
  let pendingStaleRecovery = null
  const limits = {
    staleLocatorMax: boundedInt(options.limits?.staleLocatorMax, 1, 0, 3),
    transientSafeMax: boundedInt(options.limits?.transientSafeMax, 2, 0, 4),
  }

  function budgetKey(action, target) {
    return `${action}|${locatorFingerprint(target || {})}`
  }

  function capability(overrides = {}) {
    return preflightBrowserCapability({
      tools,
      healthTracker: options.healthTracker,
      // The lane's configured clock is the default. Passing `undefined` through
      // silently fell back to wall-clock, so an injected clock made a live
      // cooldown look expired -- and a degraded provider look healthy.
      now: overrides.now ?? nowOf(),
      providerName: options.providerName,
      nativeInspect: options.nativeInspect === true,
      requiredActions: overrides.requiredActions || options.requiredActions,
      capability: overrides.capability,
    })
  }

  return {
    schemaVersion: BROWSER_LANE_SCHEMA_VERSION,
    tools,
    telemetry,
    session,
    timeouts,
    limits,

    /** The managed tool surface: minimal, task-scoped, provider-aware. */
    describe(overrides = {}) {
      const cap = capability(overrides)
      const exposure = browserCapabilityToolExposure(cap, overrides.exposure)
      return {
        schemaVersion: BROWSER_LANE_SCHEMA_VERSION,
        kind: "ues-browser-lane",
        capability: cap,
        exposure,
        managedTools: exposure.exposed,
        withheldTools: exposure.withheld,
        interactive: cap.interactive === true,
        inspectOnly: cap.inspectOnly === true,
        reason: cap.reason,
        timeouts,
        limits,
        security: externalTrustContract("browser-lane"),
      }
    },

    capability,
    exposure: (overrides = {}) => browserCapabilityToolExposure(capability(overrides), overrides.exposure),

    /** Tool names this lane manages. Empty means "no managed browser path". */
    managedToolNames(overrides = {}) {
      const cap = capability(overrides)
      if (cap.provider === null) return []
      return browserCapabilityToolExposure(cap, overrides.exposure).exposed
    },

    /**
     * Pre-dispatch gate. Returns `{ block, reason, ... }` to block, or
     * `{ block: false }` to allow. Never dispatches anything.
     */
    gate(input = /** @type {any} */ ({})) {
      const toolName = normalizeToolName(input.toolName)
      const action = classifyBrowserAction({ action: input.action })
      const toolAction = action.action !== "unknown"
        ? action
        : classifyBrowserAction({ action: inferActionFromTool(toolName) })
      const resolved = toolAction.unknownAction === true ? null : toolAction

      if (!resolved) {
        return {
          block: true,
          decision: BROWSER_GATE_DECISION.BLOCK,
          reason: BROWSER_BLOCK_REASON.UNKNOWN_ACTION,
          message:
            `UES blocked ${toolName}: the browser verb could not be mapped to a known action. ` +
            "An unrecognised browser action is never auto-retried and never executed on the managed lane.",
        }
      }

      const cap = capability({ now: input.now })
      // Degraded is checked BEFORE routing so the refusal says WHY. Both paths
      // block identically; a cooldown-specific reason is what tells the model to
      // wait rather than to conclude the capability is missing forever.
      if (cap.degraded === true) {
        telemetry.recordCooldown()
        return {
          block: true,
          decision: BROWSER_GATE_DECISION.BLOCK,
          reason: BROWSER_BLOCK_REASON.PROVIDER_COOLDOWN,
          capability: cap,
          taxonomy: resolved,
          message:
            `UES blocked ${toolName}: the browser MCP provider is in a bounded cooldown after repeated transient ` +
            `failures (${cap.degradedTool}). Do NOT retry immediately; continue with non-browser work and report the gap.`,
        }
      }
      const routing = browserCapabilityRouting(cap, { action: resolved.action })

      if (routing.failClosed) {
        telemetry.recordInteractiveCapabilityFailure()
        if (cap.fallbackAvailable) telemetry.recordNativeFallback()
        return {
          block: true,
          decision: BROWSER_GATE_DECISION.BLOCK,
          reason: BROWSER_BLOCK_REASON.CAPABILITY_FAIL_CLOSED,
          capability: cap,
          taxonomy: resolved,
          message:
            `UES blocked ${toolName}: no interactive browser capability is available (${cap.reason}). ` +
            "Do NOT claim browser-visible behavior as verified. Report the browser evidence gap explicitly, " +
            "or use a project-native browser test that produces fresh equivalent evidence.",
        }
      }

      const target = locateTargetIdentity(input.input || {})
      const key = budgetKey(resolved.action, target)
      const hadStaleRecovery = pendingStaleRecovery !== null

      // Recovery ORDER: after a stale failure, the next browser call must be a
      // fresh semantic snapshot. This is what makes "snapshot -> re-resolve ->
      // retry" a pipeline instead of three unrelated model choices.
      let freshSnapshotSatisfied = false
      if (pendingStaleRecovery && resolved.actionClass === BROWSER_ACTION_CLASS.READ_ONLY) {
        // A read-only re-observation IS the fresh snapshot step. Clearing here --
        // rather than when the same action is next allowed -- is what lets exactly
        // one re-resolution follow it instead of deadlocking.
        pendingStaleRecovery = null
        freshSnapshotSatisfied = true
      } else if (
        pendingStaleRecovery &&
        resolved.actionClass !== BROWSER_ACTION_CLASS.READ_ONLY &&
        pendingStaleRecovery.action !== resolved.action
      ) {
        return {
          block: true,
          decision: BROWSER_GATE_DECISION.BLOCK,
          reason: BROWSER_BLOCK_REASON.FRESH_SNAPSHOT_REQUIRED,
          taxonomy: resolved,
          message:
            `UES blocked ${toolName}: the previous ${pendingStaleRecovery.action} failed with a stale locator. ` +
            "Take a FRESH semantic snapshot (accessibility tree) and re-resolve the target before acting again; " +
            "do not retry the same locator blind.",
        }
      }

      if (resolved.actionClass === BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT) {
        if (options.approvedSideEffects !== true) {
          return {
            block: true,
            decision: BROWSER_GATE_DECISION.BLOCK,
            reason: BROWSER_BLOCK_REASON.SIDE_EFFECT_NOT_APPROVED,
            taxonomy: resolved,
            message:
              `UES blocked ${resolved.action}: external side effects are never executed on the managed lane without ` +
              "explicit user approval, and are NEVER auto-replayed.",
          }
        }
        const duplicate = submitGuard.check({
          sessionId: session.id,
          taxonomy: resolved,
          locatorFingerprint: target.fingerprint,
          beforeUrl: input.beforeUrl,
          idempotencyKey: input.input?.idempotencyKey,
          now: input.now,
        })
        if (duplicate.allowed === false) {
          return {
            block: true,
            decision: BROWSER_GATE_DECISION.BLOCK,
            reason: BROWSER_BLOCK_REASON.DUPLICATE_SUBMIT,
            taxonomy: resolved,
            message:
              `UES blocked a duplicate ${resolved.action}: this session already submitted the same target. ` +
              "Verify the first submission's outcome before issuing another; a duplicate may double-charge or double-post.",
          }
        }
      }

      const spent = budgets.get(key) || { staleRetries: 0, transientRetries: 0, attempts: 0 }

      // Bounded retry ENFORCEMENT. The taxonomy budget is the authority: once it
      // is spent for this target identity, another attempt of the same action is
      // refused outright rather than merely discouraged.
      if (retryBudgetExhausted({ taxonomy: resolved, spent, freshSnapshotSatisfied, hadStaleRecovery: hadStaleRecovery })) {
        return {
          block: true,
          decision: BROWSER_GATE_DECISION.BLOCK,
          reason: BROWSER_BLOCK_REASON.RETRY_BUDGET_EXHAUSTED,
          taxonomy: resolved,
          message:
            `UES blocked ${toolName}: the bounded retry budget for this ${resolved.action} target is exhausted. ` +
            "Do not retry the same locator. Take a fresh snapshot, change the approach, or report the blocker.",
        }
      }

      spent.attempts += 1
      budgets.set(key, spent)
      telemetry.recordDispatch()

      const toolCallId = String(input.toolCallId || `${key}#${spent.attempts}`)
      pending.set(toolCallId, {
        toolCallId,
        toolName,
        action: resolved.action,
        taxonomy: resolved,
        routing,
        capability: cap,
        target,
        key,
        startedAt: input.now ?? nowOf(),
        retryCount: spent.attempts - 1,
        afterStaleRecovery: freshSnapshotSatisfied || hadStaleRecovery,
      })

      return {
        block: false,
        decision: BROWSER_GATE_DECISION.ALLOW,
        toolCallId,
        taxonomy: resolved,
        routing,
        capability: cap,
        target,
        retryCount: spent.attempts - 1,
      }
    },

    /**
     * Post-dispatch receipt. Builds the V16.3 evidence receipt from the REAL
     * provider result, applies post-action verification, and decides whether a
     * bounded recovery is still open.
     */
    receipt(input = /** @type {any} */ ({})) {
      const toolCallId = String(input.toolCallId || "")
      const started = pending.get(toolCallId)
      if (!started) return null
      pending.delete(toolCallId)

      const resultText = String(input.resultText ?? "")
      const failed = input.isError === true
      const taxonomy = started.taxonomy
      const key = started.key
      const spent = budgets.get(key) || { staleRetries: 0, transientRetries: 0, attempts: 1 }

      const observed = observeBrowserResult(input)
      const failure = failed
        ? classifyBrowserFailure({ message: observed.errorText, kind: input.failureKind })
        : null
      if (failure?.transient) telemetry.recordMcpTransientFailure()

      const verifications = observeDeclaredExpectations({
        declared: Array.isArray(input.expectedStates) ? input.expectedStates : [],
        observed,
        resultText: String(input.resultText ?? ""),
      })
      const receiptBody = buildActionReceipt({
        actionId: toolCallId,
        action: taxonomy.action,
        taxonomy,
        provider: started.capability?.provider,
        route: started.routing?.route,
        beforeUrl: observed.beforeUrl,
        afterUrl: observed.afterUrl,
        locatorStrategy: started.target?.strategy,
        locatorFingerprint: started.target?.fingerprint,
        startTime: started.startedAt,
        endedAt: input.now ?? nowOf(),
        result: failed
          ? BROWSER_ACTION_RESULT.FAILURE
          : taxonomy.requiresPostVerification && !verifications.length
            ? BROWSER_ACTION_RESULT.UNVERIFIED
            : BROWSER_ACTION_RESULT.SUCCESS,
        retryCount: started.retryCount,
        staleRecovered: started.afterStaleRecovery,
        navigationObserved: observed.urlChanged === true,
        screenshotRef: observed.screenshotRef,
        snapshotRef: observed.snapshotRef,
        consoleErrorCount: observed.consoleErrorCount,
        networkFailureCount: observed.networkFailureCount,
        verifications,
        providerResult: { error: observed.errorText || null, url: observed.afterUrl },
      })
      telemetry.recordReceipt(receiptBody)

      const verdict = verificationVerdict({
        taxonomy,
        failed,
        receiptBody,
        verifications,
      })

      // Retry / recovery decision, from the taxonomy's budget only.
      let retry = null
      let recovery = null
      if (failure) {
        if (failure.kind === "stale-locator") {
          telemetry.recordStaleFailure()
          recovery = staleRecoveryDecision({
            taxonomy,
            failureKind: failure.kind,
            freshSnapshot: input.freshSnapshot ?? null,
            before: started.target,
            after: input.afterTarget || input.freshSnapshot?.target || started.target,
            // The target's own identity is the re-resolution candidate. Falling
            // back to it means a stale failure always has somewhere to recover
            // TO, instead of dead-ending on "no-allowed-locator-strategy".
            locatorCandidates: input.locatorCandidates || [started.target],
            staleRecoveryAttempts: spent.staleRetries,
            stateMayHaveApplied: input.stateMayHaveApplied === true,
            confidenceThreshold: options.identityConfidenceThreshold,
          })
          if (recovery.recover === true) {
            spent.staleRetries += 1
          }
          // The recovery ORDER is armed for EVERY stale failure, not only when
          // identity was confirmed. Requiring a fresh snapshot is a property of
          // the pipeline; whether the retry is then permitted is a separate
          // question the budget answers.
          pendingStaleRecovery = { action: taxonomy.action, key, at: input.now ?? nowOf() }
        }
        retry = browserRetryDecision({
          taxonomy,
          attempt: spent.attempts,
          failureKind: failure.kind,
          message: observed.errorText,
          retryKind: failure.kind === "stale-locator" ? "stale-locator" : "transient",
          staleRetries: spent.staleRetries,
          transientRetries: spent.transientRetries,
        })
        if (retry.retry === true && retry.kind === "transient") spent.transientRetries += 1
      }

      return {
        schemaVersion: BROWSER_LANE_SCHEMA_VERSION,
        kind: "ues-browser-action-receipt",
        toolCallId,
        toolName: started.toolName,
        action: taxonomy.action,
        actionClass: taxonomy.actionClass,
        verdict: verdict.status,
        expectedStateVerified: receiptBody.expectedStateVerified,
        receipt: receiptBody,
        failure,
        retry,
        recovery,
        retryPermitted: failure
          ? (retry?.retry === true || recovery?.recover === true)
          : false,
        // The single sentence the model must not be able to misread.
        notVerifiedNotice: verdict.status === BROWSER_LANE_VERIFICATION_STATUS.NOT_VERIFIED
          ? "UES NOT_VERIFIED: the browser tool returned success but no expected state was observed. " +
            "This action is NOT evidence of the claimed outcome. Do not report it as verified."
          : null,
        security: externalTrustContract("browser-lane-receipt"),
      }
    },

    pendingCount() {
      return pending.size
    },

    budgets() {
      return [...budgets.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => a.key.localeCompare(b.key))
    },

    snapshot() {
      return {
        schemaVersion: BROWSER_LANE_SCHEMA_VERSION,
        kind: "ues-browser-lane-snapshot",
        capability: capability(),
        pendingActions: pending.size,
        budgets: this.budgets(),
        sessionId: session.id,
        telemetry: telemetry.snapshot(),
        security: externalTrustContract("browser-lane"),
      }
    },

    /** Bounded teardown: screenshot cache + session record. Never throws. */
    async cleanup(root, cleanupOptions = {}) {
      const artifacts = await cleanupBrowserArtifacts(root, {
        maxFiles: boundedInt(cleanupOptions.maxFiles, 50, 0, 500),
        rmImpl: cleanupOptions.rmImpl,
        listImpl: cleanupOptions.listImpl,
      }).catch(() => ({ removed: 0, skipped: true, reason: "cleanup-failed" }))
      if (typeof session.close === "function") session.close()
      return {
        schemaVersion: BROWSER_LANE_SCHEMA_VERSION,
        kind: "ues-browser-lane-cleanup",
        sessionId: session.id,
        artifacts,
        pendingActions: pending.size,
        telemetry: telemetry.snapshot(),
      }
    },
  }
}

// Derives the taxonomy action from a tool name using the SAME resolver the
// capability preflight uses. Importing it (rather than re-deriving) is what
// guarantees the gate and the preflight can never disagree about what a tool is.
export function inferActionFromTool(toolName) {
  return actionFromBrowserToolName(String(toolName || "")) || "unknown"
}

export function verificationVerdict({ taxonomy = {}, failed = false, receiptBody = {}, verifications = [] } = /** @type {any} */ ({})) {
  // The rows arrive as DECLARATIONS plus observations; each is run through the
  // shared validator here so the verdict is computed from the same code that
  // builds the receipt. Reading `row.verified` off an unvalidated row would make
  // every verdict NOT_VERIFIED forever.
  const checks = (Array.isArray(verifications) ? verifications : [])
    .map((row) => verifyExpectedState({
      kind: row.kind,
      expected: row.expected,
      observed: row.observed,
      required: row.required === true,
    }))
  if (failed) {
    return {
      status: BROWSER_LANE_VERIFICATION_STATUS.FAILED,
      reason: "browser-tool-reported-failure",
      observedChecks: checks.length,
    }
  }
  if (taxonomy.requiresPostVerification !== true) {
    return { status: BROWSER_LANE_VERIFICATION_STATUS.VERIFIED, reason: "post-verification-not-required", observedChecks: checks.length }
  }
  const required = checks.filter((row) => row.required === true)
  const allVerified = required.length > 0 && required.every((row) => row.verified === true)
  if (allVerified) {
    return {
      status: BROWSER_LANE_VERIFICATION_STATUS.VERIFIED,
      reason: "required-expected-state-observed",
      observedChecks: checks.length,
    }
  }
  return {
    // Tool success without an observed expected state is NOT_VERIFIED, never
    // PASS. This is the browser-lane half of the V16 false-pass gate.
    status: BROWSER_LANE_VERIFICATION_STATUS.NOT_VERIFIED,
    reason: checks.length === 0 ? "no-expectation-supplied" : "expected-state-not-observed",
    observedChecks: checks.length,
    receiptStatus: receiptBody.verification?.status || BROWSER_VERIFICATION_STATUS.UNVERIFIED,
  }
}

// Whether the taxonomy's bounded retry budget for this target is spent.
//
// The budget is the TAXONOMY's `maxRetries` applied to attempts per
// (action, target-identity) key. Using the same number the retry policy uses
// keeps the gate and the policy from ever disagreeing: a click gets 1 attempt
// beyond the first, a read-only probe gets 2, and a side effect gets 0 -- so a
// second submit of the same target is structurally impossible.
export function retryBudgetExhausted({ taxonomy = {}, spent = {} } = /** @type {any} */ ({})) {
  const maxAttempts = Number(taxonomy.maxRetries ?? 0)
  const attempts = Number(spent.attempts || 0)
  return attempts > maxAttempts
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g
const CONSOLE_ERROR_RE = /\b(?:console\.error|uncaught|Unhandled|SEVERE)\b/gi
const NETWORK_FAILURE_RE = /\b(?:(?:4\d\d|5\d\d)\b|ERR_CONNECTION|ECONNREFUSED|ETIMEDOUT|failed to load)\b/gi

/**
 * Reads what can actually be observed in a provider result blob. It never
 * guesses: a missing signal is 0 / null, never an optimistic value.
 */
export function observeBrowserResult(input = /** @type {any} */ ({})) {
  const text = String(input.resultText ?? "")
  const urls = text.match(URL_RE) || []
  const beforeUrl = safeUrl(input.beforeUrl)
  const afterUrl = safeUrl(input.afterUrl) || (urls.length ? safeUrl(urls[urls.length - 1]) : null)
  return {
    beforeUrl,
    afterUrl,
    urlChanged: Boolean(beforeUrl && afterUrl && beforeUrl !== afterUrl),
    errorText: input.isError === true ? text.slice(0, 600) : "",
    consoleErrorCount: (text.match(CONSOLE_ERROR_RE) || []).length,
    networkFailureCount: (text.match(NETWORK_FAILURE_RE) || []).length,
    screenshotRef: pickRef(text, /screenshot[^:\n]*[:=]\s*([^\s\n]+\.png)/i),
    snapshotRef: pickRef(text, /(?:snapshot|ref)[^:\n]*[:=]\s*([^\s\n]{1,120})/i),
  }
}

// Observes a DECLARED expectation against what the provider actually returned.
//
// This is the honest half of post-action verification: the declaration comes from
// the caller, the observation comes from the result. When the provider reported
// nothing that could satisfy the expectation, `observed` stays null and the check
// is UNVERIFIED -- which is exactly the case the V16 false-pass gate exists for.
export function observeDeclaredExpectations({ declared = [], observed = {}, resultText = "" } = /** @type {any} */ ({})) {
  const text = String(resultText || "")
  return declared
    .filter((row) => row && typeof row === "object" && row.kind)
    .slice(0, 8)
    .map((row) => {
      const expected = row.expected === undefined || row.expected === null ? null : String(row.expected)
      let value = row.observed === undefined ? null : row.observed
      if (value === null || value === "") {
        if (row.kind === "url") {
          value = observed.afterUrl || observed.beforeUrl || null
        } else if (row.kind === "text-present" || row.kind === "success-indicator" || row.kind === "element-present") {
          value = expected && expected.trim() ? text.includes(expected) : null
        } else if (row.kind === "element-absent" || row.kind === "text-absent") {
          value = expected && expected.trim() ? !text.includes(expected) : null
        }
      }
      return {
        kind: row.kind,
        expected,
        observed: value,
        required: row.required === true,
      }
    })
}

function pickRef(text, pattern) {
  const match = text.match(pattern)
  return match ? String(match[1]).slice(0, 200) : null
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