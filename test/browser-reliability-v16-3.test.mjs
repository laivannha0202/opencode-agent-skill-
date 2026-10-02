// V16.3 Phase A - Browser Execution Reliability.
//
// Every test here drives the real pipeline (preflight -> routing -> retry ->
// stale recovery -> receipt -> telemetry) through a FAKE provider. No real
// browser, no network, no live DeepSeek. The properties under test are the ones
// that make the lane safe: a side effect is never replayed, a tool success is
// never mistaken for a verified outcome, an interactive task with no interactive
// provider fails closed, and a degraded provider produces a bounded cooldown
// rather than a retry storm.
import test from "node:test"
import assert from "node:assert/strict"

import {
  BROWSER_ACTION_CLASS,
  classifyBrowserAction,
  listBrowserActions,
  requiredActionsForClass,
} from "../lib/browser-action-taxonomy.mjs"
import {
  actionFromBrowserToolName,
  browserCapabilityRouting,
  browserCapabilityToolExposure,
  preflightBrowserCapability,
} from "../lib/browser-capability.mjs"
import { browserRetryDecision, classifyBrowserFailure } from "../lib/browser-retry-policy.mjs"
import {
  LOCATOR_FORBIDDEN,
  LOCATOR_PRIORITY,
  chooseLocatorStrategy,
  compareTargetIdentity,
  staleRecoveryDecision,
} from "../lib/browser-stale-recovery.mjs"
import {
  BROWSER_ACTION_RESULT,
  buildActionReceipt,
  createBrowserTelemetry,
  summarizeVerification,
  verifyExpectedState,
} from "../lib/browser-evidence.mjs"
import {
  BROWSER_NAVIGATION_KIND,
  classifyNavigationEvent,
  cleanupBrowserArtifacts,
  closeBrowserSession,
  createBrowserSession,
  resolveBrowserTimeouts,
  resolveWaitUntil,
  shouldAbortBrowserSession,
} from "../lib/browser-lifecycle.mjs"
import { createSubmitGuard, executeBrowserAction } from "../lib/browser-execution.mjs"
import { externalTrustContract } from "../lib/browser-security.mjs"
import { McpHealthTracker } from "../lib/mcp-health.mjs"

const SNAP = "mcp__playwright__browser_snapshot"
const CLICK = "mcp__playwright__browser_click"
const NAVIGATE = "mcp__playwright__browser_navigate"
const FILL = "mcp__playwright__browser_fill_form"
const SCREENSHOT = "mcp__playwright__browser_take_screenshot"
const CONSOLE = "mcp__playwright__browser_console_messages"
const NETWORK = "mcp__playwright__browser_network_requests"

const ALL_TOOLS = [SNAP, CLICK, NAVIGATE, FILL, SCREENSHOT, CONSOLE, NETWORK]

const TARGET = {
  strategy: "role-and-accessible-name",
  role: "button",
  accessibleName: "Save order",
  testId: "save-order",
}

function interactiveCapability(requiredActions = ["snapshot", "click"]) {
  return preflightBrowserCapability({ tools: ALL_TOOLS, requiredActions, providerName: "playwright-mcp" })
}

function fakeClock(start = 1_700_000_000_000) {
  let value = start
  return {
    now: () => value,
    advance: (ms) => {
      value += ms
      return value
    },
  }
}

// ---- 1. capability preflight ----

test("V16.3 browser capability preflight detects a healthy interactive MCP provider", () => {
  const capability = interactiveCapability(["snapshot", "click"])
  assert.equal(capability.healthy, true)
  assert.equal(capability.interactive, true)
  assert.equal(capability.inspectOnly, false)
  assert.equal(capability.reason, "mcp-provider-healthy-interactive")
  assert.ok(capability.supportedActions.includes("snapshot"))
  assert.ok(capability.supportedActions.includes("click"))
  assert.deepEqual(capability.missingActions, [])
  // The task asked for two tools, not the whole provider surface.
  const exposure = browserCapabilityToolExposure(capability)
  assert.equal(exposure.exposed.length, 2)
  assert.deepEqual(exposure.exposed.sort(), [CLICK, SNAP].sort())
  assert.equal(capability.security.trustLevel, "untrusted-external")
  assert.equal(capability.security.instructionAuthority, "none")
})

test("V16.3 capability preflight reports no provider when the browser tool surface is empty", () => {
  const capability = preflightBrowserCapability({ tools: [], requiredActions: ["snapshot"] })
  assert.equal(capability.provider, null)
  assert.equal(capability.healthy, false)
  assert.equal(capability.fallbackAvailable, false)
  assert.equal(capability.reason, "no-browser-provider-available")
  // The task only needs reads, so interactive capability is genuinely not
  // required -- but with no provider at all, no read can be served either.
  assert.equal(capability.interactiveCapability, "not-required")
  assert.equal(capability.readOnlyAvailable, false)
  assert.deepEqual(capability.missingActions, ["snapshot"])
  const routing = browserCapabilityRouting(capability, { action: "snapshot" })
  assert.equal(routing.failClosed, true)
})

test("V16.3 native Playwright inspect absorbs a read-only requirement when MCP is unavailable", async () => {
  const capability = preflightBrowserCapability({
    tools: [],
    nativeInspect: true,
    requiredActions: requiredActionsForClass("read-only"),
  })
  assert.equal(capability.reason, "mcp-unavailable-native-inspect-fallback")
  assert.equal(capability.healthy, true)
  assert.equal(capability.inspectOnly, true)
  assert.equal(capability.interactive, false)
  assert.equal(capability.fallbackAvailable, true)
  assert.equal(capability.fallbackKind, "native-playwright-inspect")
  assert.deepEqual(capability.missingActions, [])
  assert.equal(browserCapabilityRouting(capability, { action: "snapshot" }).route, "native-inspect")

  // The fallback is read-only BY CONSTRUCTION: a click through it fails closed.
  const clickRoute = browserCapabilityRouting(capability, { action: "click" })
  assert.equal(clickRoute.failClosed, true)
  assert.equal(clickRoute.reason, "interactive-capability-unavailable")
})

test("V16.3 a read-only-only provider never claims interactive capability", () => {
  const capability = preflightBrowserCapability({
    tools: [SNAP, SCREENSHOT],
    requiredActions: ["snapshot"],
  })
  // The empty-`every()` bug reported interactive:true for a provider that
  // exposes zero interactive tools.
  assert.equal(capability.interactive, false)
  assert.equal(capability.interactiveCapability, "not-required")
  assert.equal(browserCapabilityRouting(capability, { action: "click" }).failClosed, true)
  // Read-only tools still route, and interactive tools are withheld.
  const exposure = browserCapabilityToolExposure(capability)
  assert.ok(exposure.exposed.every((name) => name === SNAP || name === SCREENSHOT))
  assert.equal(exposure.interactiveExposed, false)
})

test("V16.3 unknown browser tool names grant no action at all", () => {
  assert.equal(actionFromBrowserToolName("mcp__playwright__browser_evaluate"), null)
  assert.equal(actionFromBrowserToolName("mcp__playwright__browser_take_screenshot"), "screenshot")
  assert.equal(actionFromBrowserToolName("mcp__playwright__browser_fill_form"), "fill")
  assert.equal(actionFromBrowserToolName("mcp__playwright__browser_wait_for"), "wait")
  const capability = preflightBrowserCapability({
    tools: ["mcp__playwright__browser_evaluate"],
    requiredActions: ["snapshot"],
  })
  assert.deepEqual(capability.supportedActions, [])
})

// ---- 2. health-aware routing / MCP cooldown ----

test("V16.3 repeated transient MCP failures degrade the provider and produce a bounded cooldown", async () => {
  const tracker = new McpHealthTracker({ failureThreshold: 2, cooldownMs: 15_000 })
  const clock = fakeClock()
  tracker.begin("c1", CLICK, {}, clock.now())
  tracker.finish("c1", { isError: true, error: "connection reset by peer" }, clock.now())
  tracker.begin("c2", CLICK, {}, clock.now())
  tracker.finish("c2", { isError: true, error: "connection reset by peer" }, clock.now())

  const status = tracker.status(CLICK, clock.now())
  assert.equal(status.status, "degraded")
  assert.equal(status.available, false)
  assert.ok(status.cooldownUntil)

  const capability = preflightBrowserCapability({
    tools: ALL_TOOLS,
    healthTracker: tracker,
    now: clock.now(),
    requiredActions: ["snapshot", "click"],
  })
  assert.equal(capability.degraded, true)
  assert.equal(capability.degradedTool, CLICK)
  assert.equal(capability.reason, "mcp-provider-degraded-bounded-cooldown")
  assert.equal(capability.interactive, false)
  assert.equal(browserCapabilityRouting(capability, { action: "click" }).failClosed, true)

  // A degraded provider with a native inspect fallback stays available for reads.
  const withFallback = preflightBrowserCapability({
    tools: ALL_TOOLS,
    healthTracker: tracker,
    nativeInspect: true,
    now: clock.now(),
    requiredActions: requiredActionsForClass("read-only"),
  })
  assert.equal(withFallback.reason, "mcp-unavailable-native-inspect-fallback")
  assert.equal(withFallback.readOnlyAvailable, true)
})

// ---- 3. action taxonomy ----

test("V16.3 action taxonomy fails closed on an unknown verb and covers all four classes", () => {
  const unknown = classifyBrowserAction({ action: "teleport" })
  assert.equal(unknown.unknownAction, true)
  assert.equal(unknown.actionClass, BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT)
  assert.equal(unknown.retryAllowed, false)
  assert.equal(unknown.maxRetries, 0)
  assert.equal(unknown.requiresExplicitApproval, true)

  const classes = new Set(listBrowserActions().map((action) => classifyBrowserAction({ action }).actionClass))
  for (const expected of [
    BROWSER_ACTION_CLASS.READ_ONLY,
    BROWSER_ACTION_CLASS.NAVIGATION,
    BROWSER_ACTION_CLASS.INTERACTIVE,
    BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
  ]) {
    assert.ok(classes.has(expected), `missing action class ${expected}`)
  }

  for (const action of ["submit", "payment", "purchase", "delete", "publish", "send-message", "create-order", "account-mutation", "destructive-confirm"]) {
    const definition = classifyBrowserAction({ action })
    assert.equal(definition.actionClass, BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT, action)
    assert.equal(definition.maxRetries, 0, action)
    assert.equal(definition.requiresPostVerification, true, action)
  }

  // Proving a click is external escalates it without changing its name.
  const provenExternal = classifyBrowserAction({ action: "click", provenExternalSideEffect: true })
  assert.equal(provenExternal.actionClass, BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT)
  assert.equal(provenExternal.maxRetries, 0)
  assert.equal(provenExternal.requiresExplicitApproval, true)
})

// ---- 4. retry policy ----

test("V16.3 a transient snapshot failure is retried exactly within the bounded budget", async () => {
  const clock = fakeClock()
  const telemetry = createBrowserTelemetry()
  let calls = 0
  const execution = await executeBrowserAction(
    {
      action: "snapshot",
      capability: interactiveCapability(["snapshot"]),
      expectedStates: [{ kind: "element-present", observed: true, required: true }],
    },
    {
      now: clock.now,
      sleep: async () => {},
      telemetry,
      invoke: async () => {
        calls += 1
        if (calls === 1) return { ok: false, error: "socket hang up: transient" }
        return { ok: true, snapshotRef: "snap-1" }
      },
    },
  )
  assert.equal(execution.outcome, "completed")
  assert.equal(calls, 2)
  assert.equal(execution.retries, 1)
  assert.equal(execution.telemetry.mcpTransientFailures, 1)
  assert.equal(execution.telemetry.browserRetries, 1)
  assert.equal(execution.telemetry.browserActionSuccessRate, 1)
})

test("V16.3 a transient failure is never retried past the budget", () => {
  const taxonomy = classifyBrowserAction({ action: "navigate" })
  const first = browserRetryDecision({ taxonomy, attempt: 1, failureKind: "transient", message: "502 bad gateway" })
  assert.equal(first.retry, true)
  const exhausted = browserRetryDecision({
    taxonomy,
    attempt: 3,
    failureKind: "transient",
    message: "502 bad gateway",
    transientRetries: 2,
  })
  assert.equal(exhausted.retry, false)
  assert.equal(exhausted.reason, "retry-budget-exhausted")
})

test("V16.3 a submit is never replayed, and the retry policy has no code path that allows it", async () => {
  const clock = fakeClock()
  const submitTaxonomy = classifyBrowserAction({ action: "click", provenExternalSideEffect: true })
  for (const kind of ["transient", "stale-locator"]) {
    const decision = browserRetryDecision({
      taxonomy: submitTaxonomy,
      attempt: 1,
      retryKind: kind,
      message: "locator resolved to 0 elements",
    })
    assert.equal(decision.retry, false, kind)
    assert.equal(decision.reason, "external-side-effect-never-replayed")
    assert.equal(decision.replay, false)
  }

  // End to end: a submit that fails is attempted exactly once.
  let calls = 0
  const execution = await executeBrowserAction(
    {
      action: "click",
      provenExternalSideEffect: true,
      approved: true,
      target: TARGET,
      capability: interactiveCapability(["click"]),
      expectedStates: [{ kind: "url", expected: "https://shop.test/done", observed: "https://shop.test/done", required: true }],
    },
    {
      now: clock.now,
      sleep: async () => {},
      invoke: async () => {
        calls += 1
        return { ok: false, error: "connection reset by peer" }
      },
    },
  )
  assert.equal(calls, 1)
  assert.equal(execution.outcome, "failed")
  assert.equal(execution.retries, 0)
  assert.equal(execution.retryDecision.retry, false)
})

test("V16.3 a duplicate submit of the same target inside one session is refused", async () => {
  const clock = fakeClock()
  const submitGuard = createSubmitGuard()
  const capability = interactiveCapability(["click"])
  const request = {
    action: "click",
    provenExternalSideEffect: true,
    approved: true,
    target: TARGET,
    capability,
    expectedStates: [{ kind: "element-present", observed: true, required: true }],
  }
  const invoke = async () => ({ ok: true, afterUrl: "https://shop.test/done" })
  const first = await executeBrowserAction(request, { now: clock.now, sleep: async () => {}, submitGuard, invoke })
  assert.equal(first.outcome, "completed")

  const second = await executeBrowserAction(request, { now: clock.now, sleep: async () => {}, submitGuard, invoke })
  assert.equal(second.outcome, "refused")
  assert.equal(second.reason, "duplicate-submit-refused")
  // A refusal is not a retry: the provider was not called a second time.
  assert.equal(second.receipts.length, 0)
})

test("V16.3 an unapproved external side effect never reaches the provider", async () => {
  const clock = fakeClock()
  let calls = 0
  const execution = await executeBrowserAction(
    { action: "submit", approved: false, capability: interactiveCapability(["click"]) },
    {
      now: clock.now,
      invoke: async () => {
        calls += 1
        return { ok: true }
      },
    },
  )
  assert.equal(execution.outcome, "refused")
  assert.equal(execution.reason, "external-side-effect-not-approved")
  assert.equal(calls, 0)
})

// ---- 5. stale element recovery ----

test("V16.3 a stale click recovers once through a fresh snapshot and an identity match", async () => {
  const clock = fakeClock()
  const telemetry = createBrowserTelemetry()
  let calls = 0
  const execution = await executeBrowserAction(
    {
      action: "click",
      provenIdempotent: true,
      target: TARGET,
      capability: interactiveCapability(["click"]),
      expectedStates: [{ kind: "element-present", observed: true, required: true }],
    },
    {
      now: clock.now,
      sleep: async () => {},
      telemetry,
      invoke: async () => {
        calls += 1
        if (calls === 1) return { ok: false, error: "element is not attached to the DOM" }
        return { ok: true, afterUrl: "https://app.test/orders" }
      },
      freshSnapshot: async () => ({
        ok: true,
        snapshot: { ref: "snap-fresh" },
        target: { ...TARGET },
      }),
    },
  )
  assert.equal(calls, 2)
  assert.equal(execution.outcome, "completed")
  assert.equal(execution.staleRecovered, true)
  assert.equal(execution.telemetry.staleLocatorFailures, 1)
  assert.equal(execution.telemetry.staleRecoveryAttempts, 1)
  assert.equal(execution.telemetry.staleRecoverySuccessRate, 1)
  // The recovery step itself is receipted, so the ledger shows the whole story.
  assert.ok(execution.receipts.length >= 2)
})

test("V16.3 stale recovery is refused when target identity confidence is too low", async () => {
  const clock = fakeClock()
  let calls = 0
  const execution = await executeBrowserAction(
    {
      action: "click",
      provenIdempotent: true,
      target: { strategy: "role-and-accessible-name", role: "button", accessibleName: "Save order", testId: "save-order" },
      capability: interactiveCapability(["click"]),
    },
    {
      now: clock.now,
      sleep: async () => {},
      invoke: async () => {
        calls += 1
        return { ok: false, error: "element is not attached to the DOM" }
      },
      freshSnapshot: async () => ({
        ok: true,
        snapshot: { ref: "snap-fresh" },
        // Same role, different control: the id disagrees, so identity is contradicted.
        target: { strategy: "role-and-accessible-name", role: "button", accessibleName: "Save order", testId: "delete-everything" },
      }),
    },
  )
  assert.equal(calls, 1)
  assert.equal(execution.outcome, "failed")
  assert.equal(execution.staleRecovered, false)
  // The high-confidence name match must NOT be able to outvote a changed test id.
  assert.equal(execution.recoveryReason, "target-identity-contradicted")
})

test("V16.3 stale recovery is refused when the target semantics changed", () => {
  const decision = staleRecoveryDecision({
    taxonomy: classifyBrowserAction({ action: "click", provenIdempotent: true }),
    failureKind: "stale-locator",
    freshSnapshot: { ref: "s" },
    before: { role: "button", accessibleName: "Save order" },
    after: { role: "button", accessibleName: "Delete everything" },
  })
  assert.equal(decision.recover, false)
  assert.equal(decision.reason, "target-semantics-changed")
})

test("V16.3 stale recovery is refused when the snapshot shows the state may already be applied", () => {
  const decision = staleRecoveryDecision({
    taxonomy: classifyBrowserAction({ action: "click", provenIdempotent: true }),
    failureKind: "stale-locator",
    freshSnapshot: { ref: "s" },
    before: TARGET,
    after: TARGET,
    stateMayHaveApplied: true,
  })
  assert.equal(decision.recover, false)
  assert.equal(decision.reason, "snapshot-shows-state-may-have-applied")
})

test("V16.3 an external side effect is never stale-recovered even with a perfect identity match", () => {
  const decision = staleRecoveryDecision({
    taxonomy: classifyBrowserAction({ action: "submit" }),
    failureKind: "stale-locator",
    freshSnapshot: { ref: "s" },
    before: TARGET,
    after: TARGET,
  })
  assert.equal(decision.recover, false)
  assert.equal(decision.reason, "external-side-effect-never-recovered")
})

test("V16.3 identity comparison refuses to match on absence of comparable signals", () => {
  const weak = compareTargetIdentity({ role: "button", accessibleName: "Save" }, {})
  assert.equal(weak.match, false)
  assert.equal(weak.confidence, 0)
  const strong = compareTargetIdentity(TARGET, { ...TARGET })
  assert.equal(strong.match, true)
  assert.equal(strong.confidence, 1)
  // A weak-but-above-bar score with a contradicting high-trust signal is a veto.
  const contradicted = compareTargetIdentity(TARGET, { ...TARGET, testId: "delete-everything" })
  assert.ok(contradicted.confidence >= 0.75, "the veto case must be one a threshold alone would have allowed")
  assert.equal(contradicted.match, false)
  assert.equal(contradicted.reason, "identity-contradicted")
  assert.deepEqual(contradicted.contradictions, ["test-id-changed"])
})

// ---- 6. locator quality ----

test("V16.3 locator priority is role+name first and forbids coordinates, indexes and volatile classes", () => {
  assert.deepEqual(
    [...LOCATOR_PRIORITY],
    ["role-and-accessible-name", "data-testid", "label-text", "stable-id", "stable-semantic-selector", "bounded-css"],
  )
  for (const forbidden of LOCATOR_FORBIDDEN) {
    assert.equal(
      chooseLocatorStrategy([{ strategy: forbidden, selector: "x" }]).allowed,
      false,
      forbidden,
    )
  }
  // Listing a forbidden candidate first must not win.
  const chosen = chooseLocatorStrategy([
    { strategy: "nth-child", selector: "div:nth-child(3)" },
    { strategy: "bounded-css", selector: "form#checkout .submit" },
    { strategy: "role-and-accessible-name", role: "button", accessibleName: "Pay" },
  ])
  assert.equal(chosen.strategy, "role-and-accessible-name")
  assert.equal(chosen.allowed, true)

  // A volatile generated class is not an acceptable bounded CSS selector.
  const volatile = chooseLocatorStrategy([{ strategy: "bounded-css", selector: "div.css-1a2b3c" }])
  assert.equal(volatile.allowed, false)
  assert.equal(volatile.reason, "volatile-generated-class")

  // Nothing allowed at all is an explicit refusal, not a silent CSS fallback.
  assert.equal(chooseLocatorStrategy([]).reason, "no-allowed-locator-strategy")
})

test("V16.3 the receipt records the locator strategy and a position-independent fingerprint", () => {
  const first = buildActionReceipt({
    action: "click",
    taxonomy: classifyBrowserAction({ action: "click", provenIdempotent: true }),
    locatorStrategy: "role-and-accessible-name",
    locator: TARGET,
    startTime: 1_700_000_000_000,
    endedAt: 1_700_000_000_120,
    result: BROWSER_ACTION_RESULT.SUCCESS,
  })
  const second = buildActionReceipt({
    action: "click",
    taxonomy: classifyBrowserAction({ action: "click", provenIdempotent: true }),
    locatorStrategy: "role-and-accessible-name",
    locator: { ...TARGET, box: { x: 900, y: 12 } },
    startTime: 1_700_000_000_000,
    endedAt: 1_700_000_000_200,
    result: BROWSER_ACTION_RESULT.SUCCESS,
  })
  assert.equal(first.locatorStrategy, "role-and-accessible-name")
  assert.equal(first.locatorFingerprint, second.locatorFingerprint)
  assert.notEqual(first.locatorFingerprint, "")
  assert.equal(first.durationMs, 120)
})

// ---- 7. navigation lifecycle + timeouts ----

test("V16.3 navigation lifecycle separates redirect, document load, SPA transition and no-navigation", () => {
  const redirect = classifyNavigationEvent({
    beforeUrl: "https://app.test/orders",
    afterUrl: "https://app.test/orders?created=1",
    waitUntil: "domcontentloaded",
    documentChanged: true,
    redirected: true,
    durationMs: 420,
  })
  assert.equal(redirect.kind, BROWSER_NAVIGATION_KIND.DOCUMENT)
  assert.equal(redirect.redirected, true)
  assert.equal(redirect.observed, true)
  assert.equal(redirect.durationMs, 420)

  const spa = classifyNavigationEvent({
    beforeUrl: "https://app.test/orders",
    afterUrl: "https://app.test/orders",
    waitUntil: "spa-navigation",
    spaSignal: true,
    durationMs: 90,
  })
  assert.equal(spa.kind, BROWSER_NAVIGATION_KIND.SPA)
  assert.equal(spa.observed, true)
  assert.equal(spa.urlChanged, false)

  const none = classifyNavigationEvent({
    beforeUrl: "https://app.test/orders",
    afterUrl: "https://app.test/orders",
    waitUntil: "no-navigation",
    documentChanged: true,
  })
  assert.equal(none.kind, BROWSER_NAVIGATION_KIND.NONE)
  // A no-navigation action that reports documentChanged is still not "navigated".
  assert.equal(none.navigated, false)
})

test("V16.3 navigation wait-until comes from the action class, not from the caller", () => {
  assert.equal(resolveWaitUntil({ action: "navigate" }), "domcontentloaded")
  assert.equal(resolveWaitUntil({ action: "reload" }), "load")
  assert.equal(resolveWaitUntil({ action: "click" }), "spa-navigation")
  assert.equal(resolveWaitUntil({ action: "snapshot" }), "no-navigation")
  assert.equal(resolveWaitUntil({ action: "wait" }), "no-navigation")
})

test("V16.3 the five browser timeouts are separate and the tool envelope contains the action budget", () => {
  const defaults = resolveBrowserTimeouts()
  assert.equal(defaults.navigationTimeoutMs, 30_000)
  assert.equal(defaults.actionTimeoutMs, 10_000)
  assert.equal(defaults.waitTimeoutMs, 5_000)
  assert.equal(defaults.sessionTimeoutMs, 300_000)
  assert.ok(defaults.browserToolTimeoutMs >= defaults.navigationTimeoutMs + defaults.actionTimeoutMs)

  // Raising a specific budget automatically raises the outer envelope, so the
  // tool-level kill can never pre-empt the action-level timeout.
  const slow = resolveBrowserTimeouts({ navigationTimeoutMs: 120_000, actionTimeoutMs: 60_000, browserToolTimeoutMs: 5_000 })
  assert.equal(slow.navigationTimeoutMs, 120_000)
  assert.ok(slow.browserToolTimeoutMs > 120_000)

  // A caller cannot push a timeout past the bounded ceiling.
  const absurd = resolveBrowserTimeouts({ navigationTimeoutMs: 99_999_999, sessionTimeoutMs: 99_999_999 })
  assert.equal(absurd.navigationTimeoutMs, 180_000)
  assert.equal(absurd.sessionTimeoutMs, 7_200_000)
})

test("V16.3 a browser session has an absolute ceiling that active work cannot extend", () => {
  const start = 1_700_000_000_000
  const session = createBrowserSession({ maxSessionMs: 5_000, hardTimeoutMs: 1_000 }, start)
  assert.equal(session.beginAction(start).ok, true)
  assert.equal(session.beginAction(start + 900).ok, true)
  const aborted = shouldAbortBrowserSession(session, start + 9_000)
  assert.equal(aborted.abort, true)
  assert.equal(aborted.reason, "absolute-hard-timeout")
})

test("V16.3 a browser session is bounded by action count and refuses a new session after close", () => {
  const start = 1_700_000_000_000
  const session = createBrowserSession({ maxActionsPerSession: 2 }, start)
  assert.equal(session.beginAction(start).ok, true)
  assert.equal(session.beginAction(start + 1).ok, true)
  const exhausted = session.beginAction(start + 2)
  assert.equal(exhausted.ok, false)
  assert.equal(exhausted.reason, "session-action-budget-exhausted")

  const reused = createBrowserSession({}, start)
  assert.equal(reused.beginAction(start).ok, true)
  reused.close()
  assert.equal(shouldAbortBrowserSession(reused, start).abort, true)
  assert.equal(shouldAbortBrowserSession(reused, start).reason, "session-closed")
  assert.notEqual(reused.beginAction(start).ok, true)
  assert.equal(reused.beginAction(start).reason, "session-closed")
})

// ---- 8. receipts, verification, redaction ----

test("V16.3 tool success without an expected-state observation is unverified, never a pass", async () => {
  const clock = fakeClock()
  const execution = await executeBrowserAction(
    {
      action: "click",
      provenIdempotent: true,
      target: TARGET,
      capability: interactiveCapability(["click"]),
      // The caller declared an expectation but supplied NO observation.
      expectedStates: [{ kind: "element-present", expected: "order-confirmation", required: true }],
    },
    { now: clock.now, sleep: async () => {}, invoke: async () => ({ ok: true }) },
  )
  assert.equal(execution.outcome, "unverified")
  const receipt = execution.receipts.at(-1)
  assert.equal(receipt.result, BROWSER_ACTION_RESULT.UNVERIFIED)
  assert.equal(receipt.expectedStateVerified, false)
  assert.equal(receipt.verification.reason, "tool-success-is-not-proof")
})

test("V16.3 a submit requires post-action verification and reports failure when it is not observed", async () => {
  const clock = fakeClock()
  const execution = await executeBrowserAction(
    {
      action: "click",
      provenExternalSideEffect: true,
      approved: true,
      target: TARGET,
      capability: interactiveCapability(["click"]),
      expectedStates: [
        { kind: "url", expected: "https://shop.test/receipt", observed: "https://shop.test/cart", required: true },
        { kind: "success-indicator", expected: "receipt-id", observed: false, required: true },
      ],
    },
    { now: clock.now, sleep: async () => {}, invoke: async () => ({ ok: true, afterUrl: "https://shop.test/cart" }) },
  )
  assert.equal(execution.outcome, "failed")
  assert.equal(execution.verification.status, "failed")
  assert.equal(execution.receipts.at(-1).expectedStateVerified, false)
  assert.equal(execution.receipts.at(-1).taxonomy.requiresPostVerification, true)
})

test("V16.3 a satisfied expectation produces a verified receipt with observed state recorded", async () => {
  const clock = fakeClock()
  const execution = await executeBrowserAction(
    {
      action: "click",
      provenExternalSideEffect: true,
      approved: true,
      target: TARGET,
      capability: interactiveCapability(["click"]),
      expectedStates: [
        { kind: "url", expected: "https://shop.test/receipt", observed: "https://shop.test/receipt", required: true },
        { kind: "success-indicator", expected: "receipt-id", observed: true, required: true },
      ],
    },
    { now: clock.now, sleep: async () => {}, invoke: async () => ({ ok: true, afterUrl: "https://shop.test/receipt" }) },
  )
  assert.equal(execution.outcome, "completed")
  const receipt = execution.receipts.at(-1)
  assert.equal(receipt.result, BROWSER_ACTION_RESULT.SUCCESS)
  assert.equal(receipt.expectedStateVerified, true)
  assert.equal(receipt.verification.status, "verified")
  assert.equal(receipt.verification.observed.length, 2)
  assert.equal(receipt.afterUrl, "https://shop.test/receipt")
  assert.equal(receipt.urlChanged, false)
})

test("V16.3 an unknown expected-state kind can never satisfy a required check", () => {
  const check = verifyExpectedState({ kind: "vibes", expected: "good", observed: "good", required: true })
  assert.equal(check.verified, false)
  assert.equal(check.knownKind, false)
  const summary = summarizeVerification([check])
  assert.equal(summary.status, "unverified")
})

test("V16.3 action receipts redact credentials, tokens, cookies and secret form values", () => {
  const receipt = buildActionReceipt({
    action: "fill",
    taxonomy: classifyBrowserAction({ action: "fill" }),
    provider: "playwright-mcp",
    beforeUrl: "https://app.test/login",
    afterUrl: "https://app.test/login",
    locatorStrategy: "data-testid",
    // A password field: the submitted value is a secret regardless of its shape.
    locator: { strategy: "data-testid", testId: "password", role: "textbox" },
    startTime: 1_700_000_000_000,
    endedAt: 1_700_000_000_050,
    result: BROWSER_ACTION_RESULT.SUCCESS,
    value: "hunter2-correct-horse",
    providerResult: {
      submittedValue: "hunter2-correct-horse",
      headers: { Authorization: "Bearer sk-abcdef0123456789abcdef", Cookie: "session=deadbeefcafe" },
    },
  })
  const serialized = JSON.stringify(receipt)
  assert.ok(!serialized.includes("hunter2-correct-horse"), "secret form value leaked into a receipt")
  assert.ok(!serialized.includes("sk-abcdef0123456789abcdef"))
  assert.ok(!serialized.includes("deadbeefcafe"))
  assert.equal(receipt.providerResult, null)
  assert.equal(receipt.providerResultWithheld, "secret-form-target")
  // Redaction must not damage the evidence the receipt exists to carry.
  assert.equal(receipt.provider, "playwright-mcp")
  assert.equal(receipt.beforeUrl, "https://app.test/login")
  assert.equal(receipt.locatorStrategy, "data-testid")
})

test("V16.3 a non-secret action still redacts credential-shaped provider output", () => {
  const receipt = buildActionReceipt({
    action: "click",
    taxonomy: classifyBrowserAction({ action: "click" }),
    provider: "playwright-mcp",
    startTime: 1_700_000_000_000,
    endedAt: 1_700_000_000_050,
    result: BROWSER_ACTION_RESULT.SUCCESS,
    locator: { strategy: "role-and-accessible-name", role: "button", accessibleName: "Refresh orders" },
    providerResult: {
      consoleErrors: ["POST /api 401 { token: ghp_abcdefghijklmnopqrstuvwxyz012345 }"],
      headers: { Authorization: "Bearer sk-abcdef0123456789abcdef", Cookie: "session=deadbeefcafe" },
    },
  })
  const serialized = JSON.stringify(receipt)
  assert.ok(!serialized.includes("sk-abcdef0123456789abcdef"))
  assert.ok(!serialized.includes("ghp_abcdefghijklmnopqrstuvwxyz012345"))
  assert.ok(!serialized.includes("deadbeefcafe"))
  assert.ok(serialized.includes("[REDACTED]"))
  assert.equal(receipt.redaction.applied, true)
})

test("V16.3 an oversized provider payload is bounded and marked, never stored whole", () => {
  const receipt = buildActionReceipt({
    action: "snapshot",
    taxonomy: classifyBrowserAction({ action: "snapshot" }),
    startTime: 1_700_000_000_000,
    result: BROWSER_ACTION_RESULT.SUCCESS,
    providerResult: { body: "x".repeat(50_000) },
  })
  assert.ok(receipt.providerResult.body.length <= 2_020)
  assert.ok(receipt.providerResult.body.endsWith("...[truncated]"))
})

test("V16.3 every receipt carries the untrusted-external trust contract", () => {
  const receipt = buildActionReceipt({
    action: "snapshot",
    taxonomy: classifyBrowserAction({ action: "snapshot" }),
    startTime: 1_700_000_000_000,
    result: BROWSER_ACTION_RESULT.SUCCESS,
  })
  assert.equal(receipt.trustLevel, "untrusted-external")
  assert.equal(receipt.instructionAuthority, "none")
  assert.equal(receipt.pageContentIsInstruction, false)
  assert.equal(receipt.allowPageContentToChangePermissions, false)
  assert.equal(receipt.allowPageContentToRequestSecrets, false)
  const contract = externalTrustContract("browser-page-content")
  assert.equal(contract.trustLevel, "untrusted-external")
})

// ---- 9. telemetry ----

test("V16.3 browser telemetry reports only measured values and never fabricates a rate", () => {
  const empty = createBrowserTelemetry().snapshot()
  assert.equal(empty.browserActionSuccessRate, null)
  assert.equal(empty.staleRecoverySuccessRate, null)
  assert.equal(empty.navigationMs.count, 0)
  assert.equal(empty.mcpTransientFailures, 0)

  const telemetry = createBrowserTelemetry()
  telemetry.recordReceipt({
    result: BROWSER_ACTION_RESULT.SUCCESS,
    durationMs: 100,
    retryCount: 0,
    navigationObserved: true,
    snapshotRef: "s1",
  })
  telemetry.recordReceipt({ result: BROWSER_ACTION_RESULT.FAILURE, durationMs: 300, retryCount: 1 })
  telemetry.recordStaleFailure()
  telemetry.recordMcpTransientFailure()
  telemetry.recordCooldown()
  telemetry.recordNativeFallback()
  telemetry.recordInteractiveCapabilityFailure()
  telemetry.recordNavigation({ observed: true, kind: "redirect", durationMs: 200 })
  telemetry.recordTokens({ inputTokens: 1200, outputTokens: 300, reasoningTurns: 2 })
  const snapshot = telemetry.snapshot()
  assert.equal(snapshot.browserToolCalls, 2)
  assert.equal(snapshot.browserActionSuccesses, 1)
  assert.equal(snapshot.browserActionFailures, 1)
  assert.equal(snapshot.browserActionSuccessRate, 0.5)
  assert.equal(snapshot.browserRetries, 1)
  assert.equal(snapshot.staleRecoverySuccessRate, 0)
  assert.equal(snapshot.navigationMs.meanMs, 200)
  assert.equal(snapshot.actionLatencyMs.meanMs, 200)
  assert.equal(snapshot.snapshots, 1)
  assert.equal(snapshot.mcpTransientFailures, 1)
  assert.equal(snapshot.mcpCooldowns, 1)
  assert.equal(snapshot.nativeFallbacks, 1)
  assert.equal(snapshot.interactiveCapabilityFailures, 1)
  assert.equal(snapshot.browserInputTokens, 1200)
  assert.equal(snapshot.browserReasoningTurns, 2)
})

// ---- 10. session and process hygiene ----

test("V16.3 session cleanup closes pages, closes the browser and kills the process tree", async () => {
  const closed = []
  const killed = []
  const removed = []
  const record = await closeBrowserSession(
    {
      id: "bs-1",
      pages: [{ id: 1 }, { id: 2 }],
      browser: { name: "chromium" },
      process: { pid: 4242 },
      artifacts: ["a", "b"],
      closed: false,
    },
    {
      closePage: async (page) => { closed.push(page.id) },
      closeBrowser: async (browser) => { closed.push(browser.name) },
      killTree: (proc, options) => { killed.push([proc.pid, options.graceMs]); return true },
      removeArtifacts: async (artifacts) => { removed.push(...artifacts); return artifacts.length },
    },
  )
  assert.deepEqual(closed, [1, 2, "chromium"])
  assert.deepEqual(killed, [[4242, 1_000]])
  assert.equal(removed.length, 2)
  assert.equal(record.browserClosed, true)
  assert.equal(record.processTreeTerminated, true)
  assert.equal(record.artifactsRemoved, 2)
  assert.equal(record.complete, true)
})

test("V16.3 a browser that refuses to close is still killed, and cleanup still runs after an abort", async () => {
  const killed = []
  const record = await closeBrowserSession(
    { id: "bs-2", pages: [{ id: 1 }], browser: {}, process: { pid: 99 }, artifacts: ["a", "b", "c"], aborted: true },
    {
      closePage: async () => {},
      closeBrowser: async () => { throw new Error("target page closed") },
      killTree: (proc) => { killed.push(proc.pid); return true },
      removeArtifacts: async () => 3,
    },
  )
  assert.deepEqual(killed, [99])
  assert.equal(record.browserClosed, false)
  assert.equal(record.processTreeTerminated, true)
  assert.equal(record.artifactsRemoved, 3)
  assert.equal(record.complete, false)
  assert.equal(record.errors.length, 1)
  assert.equal(record.ranAfterAbort, true)
  // A partial cleanup is visible in the record rather than implied as success.
  assert.ok(!record.steps.includes("browser-closed"))
  assert.ok(record.steps.includes("process-tree-terminated"))
})

test("V16.3 transient browser screenshots are cleaned up within a bound", async () => {
  const removed = []
  const dir = (names) => names.map((entry) => (entry.endsWith("/")
    ? { name: entry.slice(0, -1), isDirectory: () => true }
    : { name: entry, isDirectory: () => false }))
  const tree = {
    "C:/repo": dir([".ues-cache/", "lib/"]),
    "C:/repo/.ues-cache": dir(["browser-v1/", "keep.txt"]),
    "C:/repo/.ues-cache/browser-v1": dir(["a.png", "b.png", "c.png"]),
  }
  const result = await cleanupBrowserArtifacts("C:/repo", {
    listImpl: async (dir) => tree[dir] || [],
    rmImpl: async (target) => { removed.push(target) },
  })
  // Only files inside the declared browser cache directory are removed, and the
  // default bound keeps the sweep finite.
  assert.equal(result.removed, 3)
  assert.deepEqual(removed.sort(), [
    "C:/repo/.ues-cache/browser-v1/a.png",
    "C:/repo/.ues-cache/browser-v1/b.png",
    "C:/repo/.ues-cache/browser-v1/c.png",
  ])
  assert.equal(result.remaining, 0)

  const bounded = await cleanupBrowserArtifacts("C:/repo", {
    listImpl: async (dir) => tree[dir] || [],
    rmImpl: async (target) => { removed.push(target) },
    maxFiles: 1,
  })
  assert.equal(bounded.removed, 1)
  assert.equal(bounded.remaining, 2)

  const disabled = await cleanupBrowserArtifacts("C:/repo", { maxFiles: 0 })
  assert.equal(disabled.skipped, true)
  assert.equal(disabled.reason, "cleanup-disabled")

  const missing = await cleanupBrowserArtifacts("C:/repo", { listImpl: async () => [] })
  assert.equal(missing.reason, "cache-dir-absent")

  // A directory escape in the declared dir cannot be walked out of the root.
  const escaped = await cleanupBrowserArtifacts("C:/repo", {
    dir: "../../elsewhere",
    listImpl: async () => [],
  })
  assert.equal(escaped.reason, "cache-dir-absent")
})

// ---- 11. fail-closed guarantees ----

test("V16.3 an interactive action with no interactive provider is refused before any provider call", async () => {
  const clock = fakeClock()
  let calls = 0
  const capability = preflightBrowserCapability({
    tools: [SNAP, SCREENSHOT],
    nativeInspect: true,
    requiredActions: ["snapshot", "click"],
  })
  const execution = await executeBrowserAction(
    { action: "click", target: TARGET, capability },
    {
      now: clock.now,
      invoke: async () => { calls += 1; return { ok: true } },
    },
  )
  assert.equal(calls, 0)
  assert.equal(execution.outcome, "refused")
  assert.equal(execution.reason, "interactive-capability-unavailable")
  assert.equal(execution.telemetry.interactiveCapabilityFailures, 1)
  assert.equal(execution.telemetry.nativeFallbacks, 1)
})

test("V16.3 an unknown browser action is refused with the strictest possible policy", async () => {
  const clock = fakeClock()
  let calls = 0
  const execution = await executeBrowserAction(
    { action: "detonate-everything", capability: interactiveCapability() },
    { now: clock.now, invoke: async () => { calls += 1; return { ok: true } } },
  )
  assert.equal(calls, 0)
  assert.equal(execution.outcome, "refused")
  assert.equal(execution.reason, "unknown-browser-action")
  assert.equal(execution.taxonomy.sideEffectRisk, "unknown")
})

test("V16.3 a browser auth-required failure surfaces as a refusal, never as a retry loop", async () => {
  const clock = fakeClock()
  let calls = 0
  const execution = await executeBrowserAction(
    { action: "snapshot", capability: interactiveCapability(["snapshot"]) },
    {
      now: clock.now,
      sleep: async () => {},
      invoke: async () => { calls += 1; return { ok: false, error: "401 Unauthorized: please log in" } },
    },
  )
  assert.equal(calls, 1)
  assert.equal(execution.outcome, "refused")
  assert.equal(execution.reason, "browser-auth-required")
  const failure = classifyBrowserFailure({ message: "sign in to continue" })
  assert.equal(failure.authRequired, true)
  assert.equal(failure.transient, false)
})
