// V16.3 Phase A, step 1: browser action taxonomy.
//
// The taxonomy is the load-bearing part of browser reliability. Everything
// downstream -- retry budget, stale-element recovery, health-aware fallback,
// evidence receipts -- reads its decision from THIS table and never re-derives
// risk from an action name. That is deliberate: a second place that guesses
// whether `click` is safe is how a payment submit gets replayed.
//
// Four classes, and the class decides the retry budget:
//
//   read-only                        observe; never mutates remote or local state
//   navigation                       moves the page; does not commit a mutation
//   interactive-idempotent-or-recoverable  local UI state change, bounded recovery
//   external-side-effect             observable by somebody else; never auto-replayed
//
// Anything the table does not know is treated as `external-side-effect` with
// `unknownAction: true`. An unrecognised browser verb gets the strictest budget
// instead of a guess.

export const BROWSER_ACTION_CLASS = Object.freeze({
  READ_ONLY: "read-only",
  NAVIGATION: "navigation",
  INTERACTIVE: "interactive-idempotent-or-recoverable",
  EXTERNAL_SIDE_EFFECT: "external-side-effect",
})

export const BROWSER_SIDE_EFFECT_RISK = Object.freeze({
  NONE: "none",
  POSSIBLE: "possible",
  LIKELY: "likely",
  UNKNOWN: "unknown",
})

export const BROWSER_EVIDENCE_REQUIREMENT = Object.freeze({
  NONE: "none",
  OPTIONAL: "optional",
  REQUIRED: "required",
})

// NAVIGATION_WAIT_UNTIL values are lifecycle-distinct on purpose: a redirect
// and a network-idle wait are different observations and a task must be able to
// ask for one without implying the other.
export const BROWSER_NAVIGATION_WAIT_UNTIL = Object.freeze({
  COMMIT: "commit",
  DOM_CONTENT_LOADED: "domcontentloaded",
  LOAD: "load",
  NETWORK_IDLE: "networkidle",
  SPA_NAVIGATION: "spa-navigation",
  NONE: "no-navigation",
})

const DEFINITIONS = {
  snapshot: {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 2,
    retryKinds: ["transient", "stale-locator"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.OPTIONAL,
    evidence: ["snapshotRef"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  screenshot: {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.NONE,
    evidence: ["screenshotRef"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  inspect: {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 2,
    retryKinds: ["transient", "stale-locator"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.OPTIONAL,
    evidence: ["snapshotRef"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  "console-read": {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.NONE,
    evidence: ["consoleErrorCount"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  "network-read": {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.OPTIONAL,
    evidence: ["networkFailureCount"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  navigate: {
    class: BROWSER_ACTION_CLASS.NAVIGATION,
    risk: BROWSER_SIDE_EFFECT_RISK.POSSIBLE,
    retry: 2,
    retryKinds: ["transient", "stale-locator"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "navigationObserved"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.DOM_CONTENT_LOADED,
    navigates: true,
  },
  reload: {
    class: BROWSER_ACTION_CLASS.NAVIGATION,
    risk: BROWSER_SIDE_EFFECT_RISK.POSSIBLE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "navigationObserved"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.LOAD,
    navigates: true,
  },
  back: {
    class: BROWSER_ACTION_CLASS.NAVIGATION,
    risk: BROWSER_SIDE_EFFECT_RISK.POSSIBLE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.OPTIONAL,
    evidence: ["beforeUrl", "afterUrl", "navigationObserved"],
    // History navigation settles like a fresh document load; keeping the shared
    // enum value avoids a second literal drifting from BROWSER_NAVIGATION_WAIT_UNTIL.
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.DOM_CONTENT_LOADED,
    navigates: true,
  },
  forward: {
    class: BROWSER_ACTION_CLASS.NAVIGATION,
    risk: BROWSER_SIDE_EFFECT_RISK.POSSIBLE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.OPTIONAL,
    evidence: ["beforeUrl", "afterUrl", "navigationObserved"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.DOM_CONTENT_LOADED,
    navigates: true,
  },
  click: {
    class: BROWSER_ACTION_CLASS.INTERACTIVE,
    risk: BROWSER_SIDE_EFFECT_RISK.POSSIBLE,
    retry: 1,
    retryKinds: ["stale-locator"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["locatorStrategy", "locatorFingerprint", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    idempotencyProofRequired: true,
  },
  fill: {
    class: BROWSER_ACTION_CLASS.INTERACTIVE,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["stale-locator", "transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["locatorStrategy", "locatorFingerprint"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
    idempotencyProofRequired: true,
  },
  type: {
    class: BROWSER_ACTION_CLASS.INTERACTIVE,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["stale-locator", "transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["locatorStrategy", "locatorFingerprint"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
    idempotencyProofRequired: true,
  },
  select: {
    class: BROWSER_ACTION_CLASS.INTERACTIVE,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["stale-locator", "transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["locatorStrategy", "locatorFingerprint"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
    idempotencyProofRequired: true,
  },
  hover: {
    class: BROWSER_ACTION_CLASS.INTERACTIVE,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["stale-locator", "transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.NONE,
    evidence: ["locatorStrategy", "locatorFingerprint"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  press: {
    class: BROWSER_ACTION_CLASS.INTERACTIVE,
    risk: BROWSER_SIDE_EFFECT_RISK.POSSIBLE,
    retry: 1,
    retryKinds: ["stale-locator"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["locatorStrategy", "locatorFingerprint", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    idempotencyProofRequired: true,
  },
  wait: {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 1,
    retryKinds: ["transient"],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.NONE,
    evidence: [],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  close: {
    class: BROWSER_ACTION_CLASS.READ_ONLY,
    risk: BROWSER_SIDE_EFFECT_RISK.NONE,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.NONE,
    evidence: [],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
  },
  submit: {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  purchase: {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  payment: {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  delete: {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  "destructive-confirm": {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  "send-message": {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  "create-order": {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  publish: {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
  "account-mutation": {
    class: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
    risk: BROWSER_SIDE_EFFECT_RISK.LIKELY,
    retry: 0,
    retryKinds: [],
    postVerification: BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    evidence: ["beforeUrl", "afterUrl", "expectedStateVerified"],
    waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.SPA_NAVIGATION,
    requiresExplicitApproval: true,
  },
}

function normalizeActionName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
}

export function isKnownBrowserAction(value) {
  return Object.hasOwn(DEFINITIONS, normalizeActionName(value))
}

export function listBrowserActions() {
  return Object.freeze(Object.keys(DEFINITIONS).sort())
}

export function browserActionDefinition(value) {
  const key = normalizeActionName(value)
  const definition = DEFINITIONS[key]
  if (!definition) return null
  return {
    schemaVersion: 1,
    action: key,
    actionClass: definition.class,
    retryAllowed: definition.retry > 0,
    maxRetries: definition.retry,
    retryKinds: [...definition.retryKinds],
    requiresPostVerification: definition.postVerification === BROWSER_EVIDENCE_REQUIREMENT.REQUIRED,
    sideEffectRisk: definition.risk,
    evidenceRequirements: [...definition.evidence],
    waitUntil: definition.waitUntil,
    navigates: definition.navigates === true,
    idempotencyProofRequired: definition.idempotencyProofRequired === true,
    requiresExplicitApproval: definition.requiresExplicitApproval === true,
    unknownAction: false,
  }
}

export function classifyBrowserAction(input = {}) {
  const raw = typeof input === "string" ? { action: input } : input || {}
  const action = normalizeActionName(raw.action)
  const known = Object.hasOwn(DEFINITIONS, action)
  const definition = known ? browserActionDefinition(action) : null

  if (!definition) {
    // Fail closed. An unknown verb is not "probably safe"; it is "never replay,
    // never recover, and ask for explicit approval before it runs at all".
    return {
      schemaVersion: 1,
      action: action || "unknown",
      actionClass: BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
      retryAllowed: false,
      maxRetries: 0,
      retryKinds: [],
      requiresPostVerification: true,
      sideEffectRisk: BROWSER_SIDE_EFFECT_RISK.UNKNOWN,
      evidenceRequirements: ["beforeUrl", "afterUrl", "expectedStateVerified"],
      waitUntil: BROWSER_NAVIGATION_WAIT_UNTIL.NONE,
      navigates: false,
      idempotencyProofRequired: true,
      requiresExplicitApproval: true,
      unknownAction: true,
      reason: "unknown-action-fail-closed",
    }
  }

  const provenIdempotent = raw.provenIdempotent === true
  const provenExternal = raw.provenExternalSideEffect === true
  /** @type {Record<string, any>} */
  const out = { ...definition }

  if (provenExternal) {
    out.actionClass = BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT
    out.retryAllowed = false
    out.maxRetries = 0
    out.retryKinds = []
    out.sideEffectRisk = BROWSER_SIDE_EFFECT_RISK.LIKELY
    out.requiresExplicitApproval = true
    out.requiresPostVerification = true
  } else if (provenIdempotent && out.actionClass === BROWSER_ACTION_CLASS.INTERACTIVE) {
    out.sideEffectRisk = BROWSER_SIDE_EFFECT_RISK.NONE
  }

  // `idempotencyProofRequired` marks the action as safe only once the caller
  // proves it cannot commit an external side effect. Without that proof the
  // action keeps its declared class but is not eligible for blind transient
  // replay -- only for a fresh re-resolution of the same target.
  out.idempotencyProof = provenIdempotent
  out.replaySafe = definition.class === BROWSER_ACTION_CLASS.READ_ONLY ||
    definition.class === BROWSER_ACTION_CLASS.NAVIGATION ||
    (out.actionClass === BROWSER_ACTION_CLASS.INTERACTIVE && provenIdempotent)

  return out
}

export function requiredActionsForClass(target) {
  const wanted = String(target || "").trim()
  return listBrowserActions().filter((action) => {
    const definition = browserActionDefinition(action)
    if (!definition) return false
    if (wanted === "read-only") return definition.actionClass === BROWSER_ACTION_CLASS.READ_ONLY
    if (wanted === "interactive") {
      return definition.actionClass === BROWSER_ACTION_CLASS.INTERACTIVE ||
        definition.actionClass === BROWSER_ACTION_CLASS.NAVIGATION
    }
    if (wanted === "navigation") return definition.actionClass === BROWSER_ACTION_CLASS.NAVIGATION
    return false
  })
}

export const BROWSER_DEFAULT_ACTIONS = Object.freeze(["snapshot", "screenshot", "inspect"])