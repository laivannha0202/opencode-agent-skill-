// V16.3 DeepSeek selector-drift repair: measured composer/send/answer cascade.
//
// REAL LIVE EVIDENCE (authenticated persistent profile, auth settle FIXED with
// 2 probes / ~1157ms / READY / historyCount 50):
//   fill role=textbox name="message to DeepSeek": TIMEOUT (selector drift)
//   fill selector=textarea: SUCCESS (filledChars 22, cleared to 0)
//   vicinity: textarea visible=1 (no aria, no testid, enabled)
//   send: 5 icon-only div[role=button], no aria/testid/type; the composer
//   toolbar (adjacent sibling of the textarea's parent) holds exactly the two
//   composer controls -> `div:has(> textarea) + div [role="button"]` count=2
//   answers: all families 0 on the list page (no open conversation)
//
// The cascade resolves targets read-only BEFORE fill/click and fails closed to
// UI_CHANGED instead of timing out on drift or clicking a guessed element.
// Deterministic. No browser, no network, no DeepSeek.
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_PROBE_STATE,
  AUTH_SETTLE_LIMIT,
  classifyAuthState,
  waitForAuthenticatedPage,
} from "../lib/browser-profile.mjs"
import {
  DEEPSEEK_ANSWER_CANDIDATES,
  DEEPSEEK_COMPOSER_CANDIDATES,
  DEEPSEEK_LOCATOR_KIND,
  DEEPSEEK_LOCATOR_STRATEGY,
  DEEPSEEK_SEND_CANDIDATES,
  composerVicinityScript,
  resolveDeepSeekTarget,
  sanitizeComposerVicinity,
} from "../lib/deepseek-locators.mjs"
import { classifyBrowserAction } from "../lib/browser-action-taxonomy.mjs"
import { workerModePlan, WORKER_MODE } from "../lib/browser-worker-mode.mjs"
import {
  BROWSER_WORKER_OPERATION,
  decodeWorkerResponse,
  encodeWorkerRequest,
  encodeWorkerResponse,
} from "../lib/browser-worker-protocol.mjs"
import { createBrowserWorkerClient } from "../lib/browser-worker-client.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// --- fixtures ---------------------------------------------------------------

function composerFamily(selector, visible) {
  return {
    selector,
    visible,
    rows: visible > 0
      ? [{ index: 0, tag: selector === "textarea" ? "textarea" : "div", ariaLabel: { present: false, generic: null }, testId: null, disabled: false, hasNameAttr: true }]
      : [],
  }
}

function vicinity(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: "ues-deepseek-composer-vicinity",
    url: "https://chat.deepseek.com/",
    composers: [
      composerFamily("textarea", 1),
      composerFamily('[contenteditable="true"]', 0),
      composerFamily('input[type="text"]', 0),
    ],
    composerContext: null,
    sendNearby: [],
    sendTotal: 0,
    sendMatches: {},
    answers: {},
    disclosure: {
      pageTextRead: false, inputValuesRead: false, cookiesRead: false,
      storageRead: false, conversationTitlesRead: false, accountNameRead: false, acted: false,
    },
    ...overrides,
  }
}

function sendButton(overrides = {}) {
  return {
    index: 0, tag: "div", ariaLabel: { present: false, generic: null },
    testId: null, disabled: false, hasNameAttr: false, role: "button", type: null,
    controlName: { present: false, generic: null }, hasSvg: true, childCount: 2,
    box: { w: 34, h: 34 }, tabIndex: 0, distance: 1, afterComposer: true,
    ...overrides,
  }
}

function legacyTextboxSnapshot() {
  return [{ role: "textbox", accessibleName: "Message to DeepSeek", visible: true }]
}

function lane(overrides = {}) {
  return {
    capability: null,
    invoke: async () => ({ ok: true }),
    ...overrides,
  }
}

async function testAdapter(overrides = {}) {
  const { createDeepSeekWebAdapter } = await import("../lib/deepseek-web-adapter.mjs")
  const { preflightBrowserCapability } = await import("../lib/browser-capability.mjs")
  const capability = preflightBrowserCapability({
    tools: [
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_navigate",
    ],
    requiredActions: ["snapshot", "click", "fill", "navigate"],
    providerName: "browser-worker",
  })
  return createDeepSeekWebAdapter({ capability, ...overrides })
}

function adviceJson(summary) {
  return JSON.stringify({
    summary, hypotheses: [], recommendedApproach: [], filesToInspect: [],
    risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.5,
  })
}

// --- 1-5: composer cascade ---------------------------------------------------

test("V16.3 locators 1 old role/name composer works -> preferred", () => {
  const resolved = resolveDeepSeekTarget("composer", vicinity(), { snapshot: legacyTextboxSnapshot() })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.strategy, DEEPSEEK_LOCATOR_STRATEGY.ROLE_AND_NAME)
  assert.equal(resolved.target.accessibleName, "message to DeepSeek")
  assert.equal(resolved.reason, "legacy-composer-resolves")
})

test("V16.3 locators 2 old role/name missing + one visible textarea -> textarea selected", () => {
  const resolved = resolveDeepSeekTarget("composer", vicinity())
  assert.equal(resolved.ok, true)
  assert.equal(resolved.strategy, DEEPSEEK_LOCATOR_STRATEGY.CSS)
  assert.equal(resolved.target.selector, "textarea")
  assert.match(resolved.reason, /structural-composer-resolves:textarea/)
})

test("V16.3 locators 3 multiple ambiguous textareas -> fail closed", () => {
  const inspection = vicinity({
    composers: [composerFamily("textarea", 2), composerFamily('[contenteditable="true"]', 0)],
  })
  const resolved = resolveDeepSeekTarget("composer", inspection)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.target, null)
  assert.match(resolved.reason, /ambiguous-composer/)
})

test("V16.3 locators 4 hidden textarea ignored (not counted, no false positive)", () => {
  // A hidden textarea contributes no visible count, so the cascade must not
  // select textarea and must not report ambiguity for it.
  const inspection = vicinity({
    composers: [composerFamily("textarea", 0), composerFamily('[contenteditable="true"]', 0)],
  })
  const resolved = resolveDeepSeekTarget("composer", inspection)
  assert.equal(resolved.ok, false)
  assert.equal(resolved.reason, "no-usable-composer")
  assert.ok(!resolved.reason.includes("textarea-matches"), "a hidden textarea must not match at all")
})

test("V16.3 locators 5 contenteditable fallback works", () => {
  const inspection = vicinity({
    composers: [composerFamily("textarea", 0), composerFamily('[contenteditable="true"]', 1)],
  })
  const resolved = resolveDeepSeekTarget("composer", inspection)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.target.selector, '[contenteditable="true"]')
})

// --- 6-7: fill discipline ----------------------------------------------------

test("V16.3 locators 6 fill happens once", async () => {
  const calls = []
  const answer = adviceJson("s")
  const adapter = await testAdapter({
    // No domInspect binding: legacy defaults, exactly one fill then one click.
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      calls.push(action)
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      if (action === "fill") return { ok: true, filledChars: 20 }
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true }
      if (action === "snapshot") return { ok: true, result: { answer } }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  assert.equal(session.state, "ready")
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-6" })
  assert.equal(result.ok, true)
  assert.equal(calls.filter((a) => a === "fill").length, 1, "exactly one fill per consultation")
  assert.equal(calls.filter((a) => a === "click").length, 1, "exactly one submit per consultation")
})

test("V16.3 locators 7 filledChars verification remains required", async () => {
  const calls = []
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    invoke: async (action) => {
      calls.push(action)
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      // Typed nothing: the REQUIRED text-present check must fail the consult.
      if (action === "fill") return { ok: true, filledChars: 0 }
      if (action === "click") return { ok: true, inputCleared: true }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  assert.equal(session.state, "ready")
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-7" })
  assert.equal(result.ok, false, "an empty composer must never submit")
  assert.equal(calls.filter((a) => a === "click").length, 0, "no submit after unverified fill")
})

// --- 8-11: send discipline ---------------------------------------------------

test("V16.3 locators 8 send locator resolved read-only before submit", async () => {
  const order = []
  const inspection = vicinity({
    sendNearby: [sendButton({ ariaLabel: { present: true, generic: "send" } })],
    sendTotal: 1,
  })
  const answer = adviceJson("s")
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    domInspect: async () => { order.push("domInspect"); return { ok: true, vicinity: inspection } },
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      order.push(action)
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      if (action === "fill") return { ok: true, filledChars: 20 }
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true }
      if (action === "snapshot") return { ok: true, result: { answer } }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  assert.equal(session.state, "ready")
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-8" })
  assert.equal(result.ok, true)
  assert.ok(order.indexOf("domInspect") !== -1, "resolution reads evidence first")
  assert.ok(order.indexOf("domInspect") < order.indexOf("fill"), "composer resolved before typing")
  assert.ok(order.indexOf("fill") < order.lastIndexOf("domInspect") || order.indexOf("fill") < order.indexOf("click"))
  assert.ok(order.indexOf("click") !== -1)
  const firstDom = order.indexOf("domInspect")
  assert.ok(firstDom < order.indexOf("click"), "send resolved read-only before any click")
})

test("V16.3 locators 9 missing send control -> no submit", async () => {
  const calls = []
  const inspection = vicinity({ sendNearby: [], sendTotal: 0, sendMatches: {} })
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    domInspect: async () => ({ ok: true, vicinity: inspection }),
    invoke: async (action) => {
      calls.push(action)
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      if (action === "fill") return { ok: true, filledChars: 20 }
      if (action === "click") return { ok: true, inputCleared: true }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  assert.equal(session.state, "ready")
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-9" })
  assert.equal(result.ok, false)
  assert.match(result.failure, /send-unresolvable-before-submit/)
  assert.equal(calls.filter((a) => a === "click").length, 0, "no click without a resolved send control")
  assert.equal(calls.filter((a) => a === "fill").length, 1, "the prompt was typed but never submitted")
})

test("V16.3 locators 10 submit exactly once", async () => {
  let sends = 0
  const answer = adviceJson("s")
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }),
    answerBelongsToRequest: async () => true,
    answerTimeoutMs: 500,
    invoke: async (action) => {
      if (action === "click") sends += 1
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      if (action === "fill") return { ok: true, filledChars: 20 }
      if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true }
      if (action === "snapshot") return { ok: true, result: { answer } }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  const first = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-10" })
  assert.equal(first.ok, true)
  assert.equal(sends, 1)
  const replay = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-10" })
  assert.equal(replay.ok, false)
  assert.equal(sends, 1, "a replayed prompt must never produce a second submit")
})

test("V16.3 locators 11 submit never retried after external side effect", async () => {
  const { classifyBrowserAction: classify } = await import("../lib/browser-action-taxonomy.mjs")
  const click = classify({ action: "click", provenExternalSideEffect: true })
  assert.equal(click.actionClass, "external-side-effect")
  assert.equal(click.retryAllowed, false)
  assert.equal(click.maxRetries, 0)
  assert.equal(click.requiresExplicitApproval, true)

  // And end to end: a failed click is reported, never replayed.
  let sends = 0
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    invoke: async (action) => {
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      if (action === "fill") return { ok: true, filledChars: 20 }
      if (action === "click") {
        sends += 1
        return { ok: false, error: "net::ERR_CONNECTION_RESET" }
      }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "loc-11" })
  assert.equal(result.ok, false)
  assert.equal(sends, 1, "one submit attempt, zero retries")
})

// --- 12-14: answer regions ---------------------------------------------------

test("V16.3 locators 12 answer-region primary selector works", () => {
  const inspection = vicinity({ answers: { "[data-message-role='assistant']": 3 } })
  const resolved = resolveDeepSeekTarget("answer", inspection)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.target.selector, "[data-message-role='assistant']")
  assert.match(resolved.reason, /measured-answer-resolves/)
})

test("V16.3 locators 13 measured current answer fallback works", () => {
  const inspection = vicinity({
    answers: { "[data-message-role='assistant']": 0, "[data-role='assistant']": 0, ".ds-markdown": 2 },
  })
  const resolved = resolveDeepSeekTarget("answer", inspection)
  assert.equal(resolved.ok, true)
  assert.equal(resolved.target.selector, ".ds-markdown")
})

test("V16.3 locators 14 stale old-answer region cannot be mistaken for current answer", async () => {
  const seen = []
  const fresh = adviceJson("fresh for req-stale")
  const adapter = await testAdapter({
    authProbe: async () => ({ state: "READY", url: "https://chat.deepseek.com/" }),
    answerBelongsToRequest: async (answer, requestId) => {
      seen.push(String(answer).slice(0, 40))
      return String(answer).includes(String(requestId))
    },
    sleep: async () => {},
    answerTimeoutMs: 5_000,
    invoke: (() => {
      let snapshots = 0
      return async (action) => {
        if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
        if (action === "fill") return { ok: true, filledChars: 20 }
        if (action === "click") return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/9", inputCleared: true }
        if (action === "snapshot") {
          snapshots += 1
          if (snapshots === 1) return { ok: true, result: { answer: "stale old answer from yesterday" } }
          return { ok: true, result: { answer: fresh } }
        }
        return { ok: true }
      }
    })(),
  })
  const session = await adapter.startSession({})
  const result = await adapter.consult(session, { rendered: "p" }, { requestId: "req-stale" })
  assert.equal(result.ok, true)
  assert.ok(seen.length >= 2, "ownership was checked, not assumed")
  assert.equal(seen[0], "stale old answer from yesterday".slice(0, 40))
  assert.ok(String(result.answer).includes("req-stale"), "only the current answer is accepted")
})

// --- 15: diagnostics leak nothing --------------------------------------------

test("V16.3 locators 15 no conversation text/input value/account data crosses diagnostics", () => {
  const nasty = {
    url: "https://chat.deepseek.com/?token=abc123",
    composers: [{
      selector: "textarea", visible: 1,
      rows: [{
        index: 0, tag: "textarea",
        ariaLabel: { present: true, generic: "Ada Lovelace" },
        title: { present: true, generic: "Q3 revenue thread" },
        testId: "[present]", hasNameAttr: true,
        accountName: "Ada Lovelace", cookie: "sid=abc123", inputValue: "hunter2",
        conversationTitle: "Q3 revenue thread",
      }],
    }],
    sendNearby: [{
      index: 0, tag: "div", role: "button",
      ariaLabel: { present: true, generic: "Super Secret Send" },
      controlName: { present: true, generic: "hunter2" },
      testId: "[present]", disabled: false, type: null, hasSvg: true, childCount: 2,
      accountName: "Ada", localStorage: { token: "tok_1" },
    }],
    sendTotal: 1, sendMatches: {}, answers: {},
  }
  const sanitized = sanitizeComposerVicinity(nasty)
  const serialized = JSON.stringify(sanitized)
  for (const forbidden of ["Ada", "Q3", "sid=abc123", "hunter2", "tok_1", "token=abc123", "Super Secret"]) {
    assert.ok(!serialized.includes(forbidden), `vicinity leaked ${forbidden}`)
  }
  // Generic vocabulary survives (that is the diagnostic signal).
  assert.equal(sanitized.composers[0].rows[0].testId, "[present]", "testid presence survives, value withheld")
  const resolved = resolveDeepSeekTarget("composer", sanitized)
  assert.ok(!JSON.stringify(resolved).includes("Ada"))
  assert.ok(!JSON.stringify(resolveDeepSeekTarget("send", sanitized)).includes("Ada"))

  // The in-page script never reads credentials, storage or input values.
  const script = composerVicinityScript({})
  const code = script.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
  for (const forbidden of ["document.cookie", "localStorage", "sessionStorage", ".value", "inputValue", "password"]) {
    assert.ok(!code.includes(forbidden), `vicinity script must not touch ${forbidden}`)
  }
})

// --- 16-18: auth/profile untouched --------------------------------------------

test("V16.3 locators 16 auth settle unchanged", async () => {
  const { AUTH_SETTLE_LIMIT } = await import("../lib/browser-profile.mjs")
  assert.equal(AUTH_SETTLE_LIMIT.maxAttempts, 5)
  assert.equal(AUTH_SETTLE_LIMIT.intervalMs, 1_000)
  assert.equal(AUTH_SETTLE_LIMIT.overallTimeoutMs, 6_000)
  let calls = 0
  const worker = {
    authProbe: async () => {
      calls += 1
      return calls === 1
        ? { state: "UNKNOWN", reason: "composer-visible-but-no-session-signal", url: "https://chat.deepseek.com/", transportAlive: true }
        : { state: "READY", reason: "composer-and-history-present", url: "https://chat.deepseek.com/", transportAlive: true }
    },
    isAlive: () => true,
    onClose: () => () => {},
  }
  const settled = await waitForAuthenticatedPage(worker, { sleep: async () => {} })
  assert.equal(settled.state, "READY")
  assert.equal(settled.attempts, 2)
})

test("V16.3 locators 17 authProbes 0->50 hydration regression unchanged", () => {
  const first = classifyAuthState({
    url: "https://chat.deepseek.com/", composerVisible: true,
    accountSignal: false, answerRegions: 0, historyCount: 0,
  })
  assert.equal(first.state, AUTH_PROBE_STATE.UNKNOWN)
  const second = classifyAuthState({
    url: "https://chat.deepseek.com/", composerVisible: true,
    accountSignal: false, answerRegions: 0, historyCount: 50,
  })
  assert.equal(second.state, AUTH_PROBE_STATE.READY)
  assert.equal(second.reason, "composer-and-history-present")
})

test("V16.3 locators 18 persistent profile unchanged", () => {
  const auth = workerModePlan({ auth: true, profile: "deepseek-web" })
  const live = workerModePlan({ live: true, profile: "deepseek-web" })
  assert.equal(auth.persistentProfileName, live.persistentProfileName)
  assert.equal(auth.profileName, live.profileName)
  assert.equal(workerModePlan({}).mode, WORKER_MODE.PREFLIGHT)
})

// --- plumbing: protocol / worker / client / smoke ------------------------------

test("V16.3 locators protocol carries composer-vicinity mode without breaking structure", () => {
  const vicinityReq = encodeWorkerRequest({
    operation: BROWSER_WORKER_OPERATION.DOM_INSPECT,
    requestId: "v1",
    mode: "composer-vicinity",
    answerSelectors: ["[data-message-role='assistant']"],
    nearbyLimit: 10,
  })
  assert.equal(vicinityReq.ok, true)
  assert.equal(vicinityReq.payload.mode, "composer-vicinity")
  assert.deepEqual(vicinityReq.payload.answerSelectors, ["[data-message-role='assistant']"])

  const fallback = encodeWorkerRequest({ operation: BROWSER_WORKER_OPERATION.DOM_INSPECT, requestId: "v2", mode: "bogus" })
  assert.equal(fallback.ok, true)
  assert.equal(fallback.payload.mode, "structure")

  const decoded = decodeWorkerResponse(encodeWorkerResponse({
    ok: true, requestId: "v1", operation: BROWSER_WORKER_OPERATION.DOM_INSPECT,
    payload: {
      vicinity: {
        url: "https://chat.deepseek.com/",
        composers: [{ selector: "textarea", visible: 1, rows: [] }],
        sendNearby: [{ tag: "div", role: "button" }],
        sendTotal: 5, sendMatches: { a: 2 }, answers: { b: 0 },
      },
    },
  }))
  assert.equal(decoded.ok, true)
  assert.equal(decoded.result.vicinity.sendTotal, 5)
  assert.equal(decoded.result.vicinity.url, "https://chat.deepseek.com/")
})

test("V16.3 locators worker handles composer-vicinity without touching auth", async () => {
  const worker = await readFile(path.join(root, "scripts", "browser-worker-v16-3.mjs"), "utf8")
  assert.ok(worker.includes("composer-vicinity"), "worker must route the vicinity mode")
  assert.ok(worker.includes("composerVicinityScript"), "worker must evaluate the vicinity script")
  assert.ok(worker.includes("../lib/deepseek-locators.mjs"), "selectors stay centralized in the locators module")
})

test("V16.3 locators client domInspect defaults to structure, vicinity on request", async () => {
  const listeners = []
  const client = createBrowserWorkerClient({
    transport: {
      send(message) {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(encodeWorkerResponse({
              ok: true,
              requestId: message.requestId,
              operation: message.operation,
              payload: message.mode === "composer-vicinity"
                ? { vicinity: { url: "https://chat.deepseek.com/", composers: [{ selector: "textarea", visible: 1, rows: [] }], sendNearby: [], sendTotal: 0, sendMatches: {}, answers: {} } }
                : { dom: { url: "https://chat.deepseek.com/", aggregates: { textarea: 1 }, rows: [] } },
            }))
          }
        })
      },
      onMessage(listener) { listeners.push(listener); return () => {} },
      close() {},
    },
  })
  const structure = await client.domInspect({ limit: 10 })
  assert.equal(structure.ok, true)
  assert.ok(structure.inspection)
  assert.equal(structure.vicinity, undefined)
  const vic = await client.domInspect({ mode: "composer-vicinity" })
  assert.equal(vic.ok, true)
  assert.ok(vic.vicinity)
  assert.equal(vic.vicinity.composers[0].visible, 1)
  await client.close()
})

test("V16.3 locators smoke pre-submit validation is read-only and never submits", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8")
  assert.ok(smoke.includes("--locator-diagnose"), "locator validation must be an explicit flag")
  assert.ok(smoke.includes("LOCATOR_READY"), "validation reports readiness without consulting")
  for (const field of ["composerStrategy", "composerCandidates", "sendStrategy", "sendCandidates", "answerStrategy", "answerCandidates"]) {
    assert.ok(smoke.includes(field), `validation must report ${field}`)
  }
  const start = smoke.indexOf("if (args.locatorDiagnose)")
  const end = smoke.indexOf("// ---- preflight: observe")
  assert.ok(start >= 0 && end > start)
  const block = smoke.slice(start, end)
  assert.ok(block.includes('resolveDeepSeekTarget("composer"'))
  assert.ok(block.includes('resolveDeepSeekTarget("send"'))
  assert.ok(block.includes('resolveDeepSeekTarget("answer"'))
  assert.ok(block.includes("waitForAuthenticatedPage"), "validation requires auth READY first")
  assert.ok(!block.includes("lane.consult"), "validation must never consult")
  assert.ok(!block.includes("createDeepSeekWebAdapter"), "validation must never build a consultation lane")
  assert.ok(!block.match(/invoke\("click"/), "validation must never click")
  const consults = smoke.match(/lane\.consult\s*\(/g) || []
  assert.equal(consults.length, 1, "the live consultation still happens at most once")

  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  assert.ok((pkg.files || []).includes("lib/"), "the locators module ships inside lib/")
  for (const gate of ["ci", "release:verify", "test", "eval:v16", "eval:v16.3", "eval:v16.3.workers"]) {
    assert.ok(!String(pkg.scripts[gate] || "").includes("locator-diagnose"), `${gate} must not run the locator diagnostic`)
  }
  assert.ok(!String(pkg.scripts["smoke:deepseek-web"] || "").includes("--locator-diagnose"), "locator diagnose stays opt-in")
})
