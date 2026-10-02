// V16.3 Phase A, steps 1 and 2 (preflight half): capability preflight and
// health-aware fallback.
//
// A browser lane that opens with "here are the twenty Playwright tools, good
// luck" is how an agent spends a turn on snapshot when the task needed a click,
// and how it burns five turns when the MCP provider is dead. So the first thing
// V16.3 does for a browser task is compute a deterministic capability object:
//
//   { provider, healthy, interactive, inspectOnly, supportedActions,
//     fallbackAvailable, reason }
//
// and then expose ONLY the actions the task needs. The object is computed, not
// probed by executing something risky: a read-only task can never accidentally
// learn `interactive: true` because a tool happened to exist.

import { BROWSER_ACTION_CLASS, classifyBrowserAction, requiredActionsForClass } from "./browser-action-taxonomy.mjs"
import { externalTrustContract } from "./browser-security.mjs"

export const BROWSER_CAPABILITY_REASON = Object.freeze({
  READY_INTERACTIVE: "mcp-provider-healthy-interactive",
  READY_READ_ONLY: "mcp-provider-healthy-read-only",
  NATIVE_INSPECT_FALLBACK: "mcp-unavailable-native-inspect-fallback",
  COOLDOWN: "mcp-provider-degraded-bounded-cooldown",
  INTERACTIVE_UNAVAILABLE: "interactive-capability-unavailable",
  NO_PROVIDER: "no-browser-provider-available",
  READ_ONLY_ONLY: "only-read-only-actions-supported",
})

const TOOL_NAME_HINT =
  /(^|[_:.])(browser|playwright)([_:.]|$)|^browser_|^playwright_|mcp.*(?:browser|playwright)/i

const PROVIDER_HINT = /(playwright|browser automation|browser mcp|chromium|webkit|firefox|puppeteer)/i

// Tool names arrive in snake_case, kebab-case, dotted-namespaced and camelCase
// form. Matching a bare action word against the raw string is not enough: in
// `mcp__playwright__browser_snapshot` the underscore is a word character, so
// `\bsnapshot\b` never matches and every real Playwright MCP tool would be
// classified as "supports nothing" -- which is how a read-only task silently
// lost its capabilities. Tokenize first, then match tokens.
export function tokenizeBrowserToolName(name = "") {
  return String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
}

/** @type {Array<[RegExp, string]>} */
const TOOL_ACTION_HINTS = [
  [/^(?:snapshot|accessibility|a11y|accessibilitytree)$/, "snapshot"],
  [/^screenshot$/, "screenshot"],
  [/^(?:console|consoleread|logs?)$/, "console-read"],
  [/^(?:network|networkread|requests?|responses?)$/, "network-read"],
  [/^(?:navigate|goto|open|gotourl)$/, "navigate"],
  [/^reload$|^refresh$/, "reload"],
  [/^(?:goback|back|backpage)$/, "back"],
  [/^(?:goforward|forward|forwardpage)$/, "forward"],
  [/^(?:click|press|button|tap)$/, "click"],
  [/^(?:fill|type|input|textbox|typeintext|fillform)$/, "fill"],
  [/^(?:select|option|combobox|selectoption)$/, "select"],
  [/^hover$|^mouseover$/, "hover"],
  [/^(?:keyboard|key|presskey|keypress|shortcut)$/, "press"],
  [/^wait$|^waitfor|^waitunt il$|^delay$/, "wait"],
  [/^close$|^browserclose$|^closebrowser$|^pageclose$/, "close"],
]

// Tool name -> taxonomy action. This is a *name* mapping, so it can only ever
// grant an action when the taxonomy already says that action exists; a name that
// hints at something unknown (`browser_evaluate`) maps to nothing and therefore
// stays unavailable.
//
// Tokens are scanned from the END, because a provider namespaces first and names
// the action last: `browser_take_screenshot` (screenshot), `browser_fill_form`
// (fill), `browser_wait_for` (wait), `browser_console_messages` (console-read).
export function actionFromBrowserToolName(name = "") {
  const tokens = tokenizeBrowserToolName(name)
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    for (const [pattern, action] of TOOL_ACTION_HINTS) {
      if (pattern.test(token)) return action
    }
  }
  return null
}

function toolRows(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((raw) => (typeof raw === "string" ? { name: raw } : raw || {}))
    .filter((tool) => {
      const name = String(tool.name || "")
      if (!name) return false
      const descriptor = [name, tool.label, tool.description].filter(Boolean).join(" ")
      return TOOL_NAME_HINT.test(name) || TOOL_NAME_HINT.test(descriptor) || PROVIDER_HINT.test(descriptor)
    })
    .map((tool) => {
      const action = actionFromBrowserToolName(String(tool.name || ""))
      const definition = action ? classifyBrowserAction({ action }) : null
      return {
        name: String(tool.name || ""),
        action,
        actionClass: definition ? definition.actionClass : BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT,
        supported: Boolean(action) && definition.unknownAction !== true,
      }
    })
}

function resolveHealth(input) {
  const tracker = input.healthTracker
  if (tracker && typeof tracker.status === "function") {
    const names = input.healthNames?.length
      ? input.healthNames
      : (input.tools || []).map((tool) => String(typeof tool === "string" ? tool : tool?.name || "")).filter(Boolean)
    let worst = "healthy"
    let worstTool = null
    for (const name of names) {
      /** @type {any} */
      let status = "healthy"
      try {
        status = tracker.status(name, input.now)
      } catch {
        status = "healthy"
      }
      if (status?.available === false) {
        worst = "degraded"
        worstTool = name
        break
      }
      if (status?.status === "degraded") worst = "degraded"
    }
    return {
      healthy: worst === "healthy",
      degraded: worst === "degraded",
      degradedTool: worstTool,
      cooldownUntil: worstTool ? (tracker.status(worstTool, input.now)?.cooldownUntil ?? null) : null,
    }
  }
  const explicit = input.health && typeof input.health === "object" ? input.health : null
  if (explicit) {
    const healthy = explicit.available !== false && explicit.status !== "degraded"
    return {
      healthy,
      degraded: !healthy,
      degradedTool: explicit.tool || null,
      cooldownUntil: explicit.cooldownUntil || null,
    }
  }
  return { healthy: true, degraded: false, degradedTool: null, cooldownUntil: null }
}

export function requiredBrowserActions(input = {}) {
  const explicit = (input.requiredActions || []).map((value) => String(value || "").trim()).filter(Boolean)
  if (explicit.length) return [...new Set(explicit)]
  const target = String(input.capability || "").trim()
  if (target) return requiredActionsForClass(target)
  return ["snapshot", "screenshot", "inspect"]
}

export function preflightBrowserCapability(input = {}) {
  const rows = toolRows(input.tools)
  const health = resolveHealth(input)
  const required = requiredBrowserActions(input)
  const nativeInspect = input.nativeInspect === true
  const providerAvailable = rows.length > 0
  const mcpHealthy = providerAvailable && health.healthy

  const supported = new Set()
  const supportedTools = new Map()
  if (mcpHealthy) {
    for (const row of rows) {
      if (!row.supported) continue
      supported.add(row.action)
      if (!supportedTools.has(row.action)) supportedTools.set(row.action, row.name)
    }
  }

  const readOnlyRequired = required.filter((action) => {
    const definition = classifyBrowserAction({ action })
    return definition.actionClass === BROWSER_ACTION_CLASS.READ_ONLY
  })
  const interactiveRequired = required.filter((action) => {
    const definition = classifyBrowserAction({ action })
    return definition.actionClass !== BROWSER_ACTION_CLASS.READ_ONLY
  })

  // Native Playwright inspection is read-only by construction. It can absorb a
  // read-only requirement and nothing else -- that asymmetry is the whole point
  // of the fallback rule.
  if (nativeInspect) {
    for (const action of readOnlyRequired) supported.add(action)
  }

  const missing = required.filter((action) => !supported.has(action))
  const sideEffectRequired = required.some((action) => {
    const definition = classifyBrowserAction({ action })
    return definition.actionClass === BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT
  })
  // `interactive` means "this provider can actually drive the page". An empty
  // `every()` over an empty requirement list used to report `true` here, so a
  // read-only provider claimed to be interactive and a later click was routed to
  // it. It is true only when interactive actions were required AND all resolved.
  const interactiveAvailable = mcpHealthy &&
    interactiveRequired.length > 0 &&
    interactiveRequired.every((action) => supported.has(action))
  const inspectOnly = !interactiveAvailable && nativeInspect && readOnlyRequired.every((action) => supported.has(action))

  /** @type {string} */
  let reason = BROWSER_CAPABILITY_REASON.READY_INTERACTIVE
  if (!providerAvailable) {
    reason = nativeInspect
      ? BROWSER_CAPABILITY_REASON.NATIVE_INSPECT_FALLBACK
      : BROWSER_CAPABILITY_REASON.NO_PROVIDER
  } else if (providerAvailable && !health.healthy) {
    reason = nativeInspect
      ? BROWSER_CAPABILITY_REASON.NATIVE_INSPECT_FALLBACK
      : BROWSER_CAPABILITY_REASON.COOLDOWN
  } else if (interactiveRequired.length > 0 && !interactiveAvailable) {
    reason = nativeInspect
      ? BROWSER_CAPABILITY_REASON.INTERACTIVE_UNAVAILABLE
      : BROWSER_CAPABILITY_REASON.READ_ONLY_ONLY
  } else if (interactiveRequired.length === 0) {
    reason = BROWSER_CAPABILITY_REASON.READY_READ_ONLY
  }

  const capability = {
    schemaVersion: 1,
    provider: providerAvailable ? (input.providerName || "browser-mcp") : null,
    providerKind: providerAvailable ? "mcp" : null,
    healthy: mcpHealthy || Boolean(nativeInspect),
    interactive: interactiveAvailable,
    inspectOnly,
    supportedActions: [...supported].sort(),
    supportedTools: Object.fromEntries([...supportedTools.entries()].sort()),
    fallbackAvailable: Boolean(nativeInspect),
    fallbackKind: nativeInspect ? "native-playwright-inspect" : null,
    reason,
    degraded: health.degraded,
    degradedTool: health.degradedTool,
    cooldownUntil: health.cooldownUntil,
    requiredActions: required,
    missingActions: missing,
    readOnlyAvailable: readOnlyRequired.every((action) => supported.has(action)),
    sideEffectActions: supportedActionsFor(supported),
    // Fail-closed: an interactive or side-effect requirement with no interactive
    // provider is `interactiveCapability: false`, and the execution layer turns
    // that into a hard refusal rather than a degraded attempt.
    interactiveCapability: interactiveRequired.length === 0
      ? "not-required"
      : interactiveAvailable
        ? "available"
        : "unavailable",
    security: externalTrustContract("browser-page-content"),
  }

  if (sideEffectRequired) {
    capability.sideEffectApprovalRequired = true
  }

  return capability
}

function supportedActionsFor(supported) {
  return [...supported]
    .map((action) => classifyBrowserAction({ action }))
    .filter((definition) => definition.actionClass === BROWSER_ACTION_CLASS.EXTERNAL_SIDE_EFFECT)
    .map((definition) => definition.action)
}

// Exposes the minimum tool set the task needs and nothing more. When the task
// declared its required actions, ONLY those are exposed: a provider exposing
// twenty Playwright tools must not turn into twenty tools in the model's
// context. Interactive verbs are only ever exposed when the provider is
// interactive-capable.
export function browserCapabilityToolExposure(capability = {}, options = {}) {
  const limit = Math.max(1, Math.min(32, Number(options.limit || 10)))
  const required = new Set(capability.requiredActions || [])
  const scoped = required.size > 0 && options.taskScoped !== false
  const rows = Object.entries(capability.supportedTools || {})
    .map(([action, name]) => {
      const definition = classifyBrowserAction({ action })
      const readOnly = definition.actionClass === BROWSER_ACTION_CLASS.READ_ONLY
      return {
        name,
        action,
        actionClass: definition.actionClass,
        required: required.has(action),
        allowed: readOnly || capability.interactive === true,
      }
    })
    .filter((row) => row.allowed)
    .filter((row) => (scoped ? row.required : true))
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
  const exposed = rows.slice(0, limit).map((row) => row.name)
  return {
    schemaVersion: 1,
    exposed,
    withheld: rows.filter((row) => !exposed.includes(row.name)).map((row) => row.name),
    interactiveExposed: exposed.length > 0 && capability.interactive === true,
    reason: capability.interactive === true
      ? "task-scoped-browser-tools"
      : "read-only-tools-only-interactive-withheld",
  }
}

// One rule, no exceptions: a read-only action needs a read-only route; anything
// else needs `interactive === true`. `interactiveCapability === "not-required"`
// describes the TASK, not the provider, so it can never license an interactive
// action -- that is the fail-open this function exists to prevent.
export function browserCapabilityRouting(capability = {}, input = {}) {
  const action = String(input.action || "")
  const definition = classifyBrowserAction({ action })
  if (definition.actionClass === BROWSER_ACTION_CLASS.READ_ONLY) {
    if (capability.readOnlyAvailable === true) {
      return {
        route: capability.providerKind === "mcp" ? "mcp" : "native-inspect",
        reason: capability.reason,
        failClosed: false,
      }
    }
  }
  if (capability.interactive !== true) {
    return {
      route: "fail-closed",
      reason: definition.actionClass === BROWSER_ACTION_CLASS.READ_ONLY
        ? BROWSER_CAPABILITY_REASON.NO_PROVIDER
        : BROWSER_CAPABILITY_REASON.INTERACTIVE_UNAVAILABLE,
      failClosed: true,
    }
  }
  return { route: "mcp", reason: capability.reason, failClosed: false }
}