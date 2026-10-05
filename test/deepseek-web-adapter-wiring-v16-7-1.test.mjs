// V16.7.1 production adapter WIRING regression.
//
// The defect this file guards against is a wiring defect, not an algorithm
// defect: the SHIPPED `buildWebReasoningAdapter` bound only `invoke`, a
// forbidden asserted-auth `loginProbe` (`authenticated: worker.state() !==
// "needs-auth"`), and `closeBrowser`. The proven live DeepSeek path (the V16.3
// smoke and the A/B bench) binds `authProbe`, a mode-routed `domInspect`, and
// the same-node `transitionBegin` / `transitionMeasure` hooks. Without them the
// production adapter:
//   - could never observe READY auth (so AUTO silently fell back every time), and
//   - could never resolve an otherwise-ambiguous Send control (so a real
//     consultation failed closed at `send-unresolvable-before-submit`).
//
// This file drives the REAL `buildWebReasoningAdapterDeps` -- exported from the
// shipped `pi/extensions/ues.ts` specifically so the wiring is testable without
// a live browser -- through the REAL `createDeepSeekWebAdapter`, against a fake
// worker that implements the exact `browser-worker-client` surface. No live
// browser, no network, no DeepSeek.
//
// The deps under test are the production object; only the worker is a double.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

// The exact answer selectors the production deps bind. Kept here so the test
// fails if the constant drifts from the live smoke/bench family.
const EXPECTED_ANSWER_SELECTORS = [
  "[data-message-role='assistant']",
  ".ds-markdown",
  "[class*='assistant']",
]

const GOOD_ADVICE = {
  summary: "The stale click path re-resolves without an identity comparison.",
  hypotheses: ["The gate records the target fingerprint but never compares it."],
  recommendedApproach: ["Compare identity before permitting the single retry."],
  filesToInspect: ["lib/browser-lane.mjs"],
  risks: ["Over-permissive identity would click the wrong control."],
  edgeCases: ["A control whose test id changes between renders."],
  verificationSuggestions: ["Add a test where the test id changes."],
  confidence: 0.7,
}

// ---------------------------------------------------------------------------
// Boot the SHIPPED extension so `buildWebReasoningAdapterDeps` is the REAL one.
// ---------------------------------------------------------------------------
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-7-1-wiring-probe")
const TYPEBOX_STUB = [
  "const handler = {",
  "  get: () => new Proxy(function () {}, handler),",
  "  apply: () => new Proxy(function () {}, handler),",
  "};",
  "export const Type = new Proxy(function () {}, handler);",
  "export default { Type };",
].join("\n")

let bootResult = null
async function bootShippedExtension() {
  if (bootResult) return bootResult
  const probe = path.join(path.dirname(EXTENSION), `__v1671_wiring_probe_${process.pid}.mjs`)
  const stub = path.join(PROBE_DIR, "typebox-stub.mjs")
  try {
    mkdirSync(PROBE_DIR, { recursive: true })
    writeFileSync(stub, TYPEBOX_STUB, "utf8")
    let source = stripTypeScriptTypes(readFileSync(EXTENSION, "utf8"), {
      mode: "strip",
      sourceUrl: "pi/extensions/ues.ts",
    })
    const stubUrl = pathToFileURL(stub).href
    source = source.replaceAll('from "typebox"', `from "${stubUrl}"`).replaceAll("from 'typebox'", `from '${stubUrl}'`)
    writeFileSync(probe, source, "utf8")
    try {
      const module = await import(pathToFileURL(probe).href)
      bootResult = { module, source }
      return bootResult
    } finally {
      rmSync(probe, { force: true })
    }
  } finally {
    rmSync(PROBE_DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Fake managed browser worker: the EXACT surface `browser-worker-client` exposes
// (authProbe / domInspect / invoke / state / close) and nothing more.
// ---------------------------------------------------------------------------
function composerVicinity() {
  return {
    composers: [
      { selector: "textarea", visible: 1, rows: [{ index: 0, tag: "textarea", ariaLabel: { present: false, generic: null }, testId: null, disabled: false, hasNameAttr: true }] },
      { selector: '[contenteditable="true"]', visible: 0, rows: [] },
    ],
    composerContext: null,
    // Two identical, unlabeled, enabled controls: the structural count is 2 and
    // no semantic vocabulary identifies Send. ONLY the same-node transition can
    // resolve it, which is exactly the live shape this wiring must survive.
    sendNearby: [
      { index: 0, tag: "div", role: "button", disabled: false, ariaLabel: { present: false, generic: null }, controlName: { present: false, generic: null }, testId: null, type: null, hasSvg: true, childCount: 2, box: { w: 34, h: 34 }, tabIndex: 0, distance: 1, afterComposer: true },
      { index: 1, tag: "div", role: "button", disabled: false, ariaLabel: { present: false, generic: null }, controlName: { present: false, generic: null }, testId: null, type: null, hasSvg: true, childCount: 2, box: { w: 34, h: 34 }, tabIndex: 0, distance: 1, afterComposer: true },
    ],
    sendTotal: 5,
    sendMatches: { 'div:has(> textarea) + div [role="button"]': 2 },
    answers: {},
    semanticCounts: { sendExact: 0, sendGeneric: 0, submitGeneric: 0, stopGeneric: 0, attachGeneric: 0, uploadGeneric: 0, fileGeneric: 0, voiceGeneric: 0, microphoneGeneric: 0 },
  }
}

function answerRegions(count, text) {
  const families = [
    { selectorKey: "data-message-role-assistant", visibleCount: 0, latestTextChars: 0 },
    { selectorKey: "ds-markdown", visibleCount: count, latestTextChars: String(text || "").length },
  ]
  const counts = {}
  for (const row of families) counts[row.selectorKey] = row.visibleCount
  return {
    families,
    counts,
    selected: count > 0
      ? { selectorKey: "ds-markdown", visibleCount: count, textChars: String(text || "").length, answerText: String(text || "") }
      : null,
    totalVisible: count,
  }
}

// A worker whose answers only exist AFTER the click, so the answer phase must
// observe a genuinely NEW region rather than a stale one.
//
// `authRequiresNavigation` models the REAL worker exactly: a freshly spawned
// worker sits on `about:blank`, so an auth probe returns UNKNOWN
// (`no-url-observed`) until the entry navigation has happened. This is the shape
// that made the production path report `deepseek-auth-required` forever.
function fakeWorker(options = {}) {
  const calls = { invoke: [], domInspect: [], authProbe: [], clickTargets: [], navigateContexts: [], state: 0, close: 0 }
  let answered = false
  let navigated = false
  const answerText = options.answer ?? JSON.stringify(GOOD_ADVICE)
  return {
    calls,
    async authProbe(opts = {}) {
      calls.authProbe.push(opts)
      if (options.authState) return { state: options.authState, url: "https://chat.deepseek.com/login" }
      if (options.authRequiresNavigation === true && !navigated) {
        return { state: "UNKNOWN", reason: "no-url-observed", url: null, answerRegions: 0 }
      }
      return { state: "READY", url: "https://chat.deepseek.com/", answerRegions: 1 }
    },
    async domInspect(opts = {}) {
      const mode = String(opts.mode || "composer-vicinity")
      calls.domInspect.push(mode)
      if (mode === "composer-vicinity") return { ok: true, vicinity: composerVicinity() }
      if (mode === "send-transition-begin") {
        return { ok: true, transition: { preFillCandidateCount: 2, postFillCandidateCount: 0, sameNodeContinuityCount: 0, transitionUnique: false, detached: false } }
      }
      if (mode === "send-transition-measure") {
        // Exactly one candidate changed and continuity held: unique evidence.
        return { ok: true, transition: { preFillCandidateCount: 2, postFillCandidateCount: 2, sameNodeContinuityCount: 2, candidateAChanged: false, candidateBChanged: true, transitionUnique: true, detached: false, changedCategories: ["backgroundStateChanged"] } }
      }
      if (mode === "deepseek-answer-regions") {
        return { ok: true, answerRegions: answered ? answerRegions(1, answerText) : answerRegions(0, "") }
      }
      return { ok: true, inspection: {} }
    },
    async invoke(action, context = {}) {
      calls.invoke.push(action)
      if (action === "navigate") {
        calls.navigateContexts.push(context)
        navigated = true
        return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      }
      if (action === "fill") return { ok: true, filledChars: Number(context.value?.length || 0) }
      if (action === "click") {
        calls.clickTargets.push(context.target || null)
        answered = true
        return { ok: true, beforeUrl: "https://chat.deepseek.com/", afterUrl: "https://chat.deepseek.com/c/1", inputCleared: true }
      }
      return { ok: true }
    },
    state() {
      calls.state += 1
      return { state: options.workerState || "ready" }
    },
    async close() {
      calls.close += 1
      return { closed: true }
    },
  }
}

async function adapterFromProductionDeps(worker) {
  const { module } = await bootShippedExtension()
  const { createDeepSeekWebAdapter } = await import("../lib/deepseek-web-adapter.mjs")
  const deps = module.buildWebReasoningAdapterDeps(worker)
  return { deps, adapter: createDeepSeekWebAdapter(deps) }
}

// ---------------------------------------------------------------------------
// 1. The production deps bind the live hooks the proven path binds.
// ---------------------------------------------------------------------------
test("V16.7.1 wiring: the shipped deps bind authProbe/domInspect/transitionBegin/transitionMeasure/invoke/closeBrowser", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(typeof module.buildWebReasoningAdapterDeps, "function", "the wiring factory must be exported for regression coverage")

  const worker = fakeWorker()
  const deps = module.buildWebReasoningAdapterDeps(worker)
  assert.equal(typeof deps.invoke, "function", "invoke must be bound")
  assert.equal(typeof deps.authProbe, "function", "the REAL read-only authProbe must be bound")
  assert.equal(typeof deps.domInspect, "function", "domInspect must be bound")
  assert.equal(typeof deps.transitionBegin, "function", "transitionBegin must be bound")
  assert.equal(typeof deps.transitionMeasure, "function", "transitionMeasure must be bound")
  assert.equal(typeof deps.closeBrowser, "function", "closeBrowser must be bound")
  assert.equal(deps.capability?.interactive, true, "a real worker is interactive")
})

test("V16.7.1 wiring: authProbe passes the live answer selectors and never asserts an authenticated boolean", async () => {
  const worker = fakeWorker()
  const { deps } = await adapterFromProductionDeps(worker)
  const observed = await deps.authProbe({ timeoutMs: 5_000, composerSelector: "textarea" })
  assert.equal(observed.state, "READY")
  const probeArgs = worker.calls.authProbe.at(-1)
  assert.deepEqual(probeArgs.answerSelectors, EXPECTED_ANSWER_SELECTORS, "the live answer-selector family must be forwarded")
  assert.equal(probeArgs.composerSelector, "textarea")
  assert.equal(probeArgs.timeoutMs, 5_000)
  // The probe OBSERVES; it never returns an asserted `authenticated: true`.
  assert.equal(Object.hasOwn(observed, "authenticated"), false)
})

test("V16.7.1 wiring: loginProbe reports the OBSERVED worker state and never asserts authenticated", async () => {
  const { module } = await bootShippedExtension()
  const worker = fakeWorker({ workerState: "ready" })
  const deps = module.buildWebReasoningAdapterDeps(worker)
  const observed = await deps.loginProbe()
  assert.equal(observed.authenticated, false, "the embedder fallback must never assert a login it did not observe")
  assert.equal(observed.state, "UNKNOWN", "a ready worker state is NOT an auth observation")
  // A worker that IS at the login wall is reported honestly as NEEDS_AUTH.
  const walled = module.buildWebReasoningAdapterDeps(fakeWorker({ workerState: "needs-auth" }))
  const wallObserved = await walled.loginProbe()
  assert.equal(wallObserved.state, "NEEDS_AUTH")
  assert.equal(wallObserved.authenticated, false)
})

test("V16.7.1 wiring: domInspect is mode-routed and transition hooks use the send-transition modes", async () => {
  const worker = fakeWorker()
  const { deps } = await adapterFromProductionDeps(worker)
  await deps.domInspect({})
  await deps.domInspect({ mode: "deepseek-answer-regions" })
  await deps.transitionBegin()
  await deps.transitionMeasure()
  assert.deepEqual(worker.calls.domInspect, [
    "composer-vicinity", // default when no mode is requested
    "deepseek-answer-regions", // the requested mode must win, not be overwritten
    "send-transition-begin",
    "send-transition-measure",
  ])
})

test("V16.7.1 wiring: a null worker yields an honest unavailable adapter, never an asserted-auth shortcut", async () => {
  const { module } = await bootShippedExtension()
  const deps = module.buildWebReasoningAdapterDeps(null)
  assert.equal(deps.invoke, null)
  assert.equal(deps.capability?.interactive, false)
  const { createDeepSeekWebAdapter } = await import("../lib/deepseek-web-adapter.mjs")
  const capability = await createDeepSeekWebAdapter(deps).capability()
  assert.equal(capability.state, "unavailable", "no worker means the adapter is unavailable")
  // If loginProbe were consulted it must not claim a login.
  const loginObserved = await deps.loginProbe()
  assert.equal(loginObserved.authenticated, false)
})

// ---------------------------------------------------------------------------
// 2. The production deps drive the REAL adapter through a full round trip.
// ---------------------------------------------------------------------------
test("V16.7.1 wiring: the production deps resolve composer, transition-send, and read the answer region", async () => {
  const worker = fakeWorker()
  const { adapter } = await adapterFromProductionDeps(worker)

  const capability = await adapter.capability()
  assert.equal(capability.state, "ready", "a READY auth observation must reach the adapter")
  assert.equal(capability.authState, "READY")
  assert.equal(capability.browserInteractive, true)

  const session = await adapter.startSession({})
  assert.equal(session.state, "ready")
  assert.equal(session.navigationPassed, true)

  const result = await adapter.consult(session, { rendered: "hello prompt" }, { requestId: "wiring-1" })
  assert.equal(result.ok, true, JSON.stringify(result.failure || result))
  assert.ok(String(result.answer).includes(GOOD_ADVICE.summary))

  // The exact production action sequence: navigate -> fill -> click, one each.
  assert.deepEqual(worker.calls.invoke, ["navigate", "fill", "click"])
  // The composer was resolved read-only BEFORE the fill, and Send AFTER the fill
  // via the same-node transition (the only evidence that can resolve it here).
  const order = worker.calls.domInspect
  assert.equal(order[0], "composer-vicinity", "composer resolved read-only first")
  assert.ok(order.includes("send-transition-begin"), "pre-fill same-node snapshot was taken")
  assert.ok(order.includes("send-transition-measure"), "post-fill same-node re-measure was taken")
  // The click carried the same-node transition marker, never a CSS selector,
  // index, or coordinate. That is the proof Send resolved from the transition.
  assert.equal(worker.calls.clickTargets.length, 1, "exactly one click")
  assert.equal(worker.calls.clickTargets[0]?.strategy, "transition-unique-state")
  assert.equal(worker.calls.clickTargets[0]?.transition, "send-transition-unique")
  assert.equal(Object.hasOwn(worker.calls.clickTargets[0] || {}, "selector"), false, "the click target must carry no CSS selector")
  // The answer was read through scoped answer regions, never a whole-page snapshot.
  assert.ok(order.includes("deepseek-answer-regions"), "the answer phase must read scoped answer regions")
  assert.equal(order.includes("snapshot"), false, "the answer must never fall back to a whole-page snapshot")
})

test("V16.7.1 wiring: the built adapter identifies itself as deepseek-web and the lane reports provider participation", async () => {
  const worker = fakeWorker()
  const { adapter } = await adapterFromProductionDeps(worker)
  assert.equal(adapter.id, "deepseek-web", "telemetry identity must be deepseek-web")

  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const { createWebReasoningLane } = await import("../lib/web-reasoning-lane.mjs")
  const lane = createWebReasoningLane({
    mode: "auto",
    live: true,
    provider: "deepseek-web",
    maxConsultations: 1,
    adapters: [adapter],
  })
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane and MCP health modules; the root cause is ambiguous and several fixes are plausible.",
    notes: "pending resume capsule\n\nadvisor packet",
    constraints: ["MUST NOT disable verification"],
    verification: ["npm test"],
    affectedSubsystems: 2,
    knownFiles: ["lib/browser-lane.mjs"],
    requestId: "wiring-lane-1",
  })
  assert.equal(result.consulted, true, "the production-wired adapter performed a REAL consultation")
  assert.equal(result.provider, "deepseek-web")
  assert.equal(result.outcome, "advised")
  assert.ok(result.advisorText && result.advisorText.length > 0)
})

// ---------------------------------------------------------------------------
// 3. The production WARM-UP: the worker is spawned on `about:blank`, so the
//    adapter must be handed a page that has already been navigated + settled.
//    Without this the first auth probe observes `no-url-observed` -> UNKNOWN ->
//    `deepseek-auth-required`, and AUTO falls back to local on EVERY run.
// ---------------------------------------------------------------------------
test("V16.7.1 warm-up: warmManagedBrowserWorker navigates once and settles the real auth path", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(typeof module.warmManagedBrowserWorker, "function", "the warm-up must be exported for regression coverage")

  const worker = fakeWorker({ authRequiresNavigation: true })
  const settled = await module.warmManagedBrowserWorker(worker)

  assert.equal(settled?.state, "READY", "the warm-up must reach the observed READY state")
  assert.deepEqual(worker.calls.invoke, ["navigate"], "exactly ONE navigation, no click/type/submit")
  const nav = worker.calls.navigateContexts[0]
  assert.equal(nav?.url, "https://chat.deepseek.com/", "the warm-up navigates to the DeepSeek entry URL")
  assert.equal(nav?.waitUntil, "domcontentloaded")
  // The settle probed the live answer-selector family, never a whole-page guess.
  assert.deepEqual(worker.calls.authProbe.at(-1)?.answerSelectors, EXPECTED_ANSWER_SELECTORS)
})

test("V16.7.1 warm-up: the adapter reports needs-auth on an un-navigated worker and ready after warm-up", async () => {
  const { module } = await bootShippedExtension()
  const worker = fakeWorker({ authRequiresNavigation: true })
  const { adapter } = await adapterFromProductionDeps(worker)

  // BEFORE warm-up: the exact production failure, reproduced faithfully.
  const before = await adapter.capability()
  assert.equal(before.state, "needs-auth", "an about:blank worker must NOT read as ready")
  assert.equal(before.authState, "UNKNOWN")
  assert.equal(before.reason, "deepseek-auth-required", "this is the reason the live run journaled")

  // The shipped warm-up runs, then the SAME adapter must read ready.
  await module.warmManagedBrowserWorker(worker)
  const after = await adapter.capability()
  assert.equal(after.state, "ready", "after the warm-up the real observation must reach the adapter")
  assert.equal(after.authState, "READY")
  assert.equal(after.sessionReusable, true)
})

test("V16.7.1 warm-up: the production deps pin the entry URL the warm-up navigates to", async () => {
  const { module } = await bootShippedExtension()
  const worker = fakeWorker()
  const deps = module.buildWebReasoningAdapterDeps(worker)
  assert.equal(deps.entryUrl, "https://chat.deepseek.com/", "the adapter and the warm-up must share one entry URL")
  await module.warmManagedBrowserWorker(worker)
  assert.equal(worker.calls.navigateContexts[0]?.url, deps.entryUrl, "warm-up and startSession navigation cannot drift apart")
})

test("V16.7.1 warm-up: a worker whose navigation or probe throws is not fatal and never asserts READY", async () => {
  const { module } = await bootShippedExtension()
  const throwing = {
    async invoke() { throw new Error("navigation transport died") },
    async authProbe() { throw new Error("should not be reached") },
    state() { return { state: "ready" } },
    async close() { return { closed: true } },
  }
  const settled = await module.warmManagedBrowserWorker(throwing)
  assert.equal(settled, null, "a failed warm-up returns null rather than throwing")
  // A null worker is a no-op, never a crash.
  assert.equal(await module.warmManagedBrowserWorker(null), null)
  assert.equal(await module.warmManagedBrowserWorker({}), null)
})

// ---------------------------------------------------------------------------
// 4. The shipped source wires `buildWebReasoningAdapter` through the factory,
//    and the forbidden asserted-auth idiom is gone.
// ---------------------------------------------------------------------------
test("V16.7.1 wiring source: buildWebReasoningAdapter delegates to buildWebReasoningAdapterDeps", async () => {
  const { source } = await bootShippedExtension()
  assert.ok(
    source.includes("createDeepSeekWebAdapter(buildWebReasoningAdapterDeps(worker))"),
    "the production adapter must be built from the testable deps factory",
  )
  assert.ok(
    source.includes("createLazyBrowserWorker(() => resolveManagedBrowserWorker(cwd, runId))"),
    "the production adapter must resolve its worker LAZILY (Part 7)",
  )
  // The old forbidden shortcut asserted auth from a bare state check.
  assert.equal(
    /authenticated:\s*worker\.state\(\)/.test(source),
    false,
    "the asserted-auth loginProbe shortcut must be gone",
  )
  // The live hooks the proven path binds must be present in the deps object.
  for (const hook of ["authProbe:", "domInspect:", "transitionBegin:", "transitionMeasure:"]) {
    assert.ok(source.includes(hook), `the production deps must bind ${hook}`)
  }
})

test("V16.7.1 wiring source: closeBrowser closes the managed worker exactly once", async () => {
  const worker = fakeWorker()
  const { deps } = await adapterFromProductionDeps(worker)
  await deps.closeBrowser()
  await deps.closeBrowser()
  assert.equal(worker.calls.close, 2, "each close call is delegated to the worker (idempotency lives worker-side)")
})

// ---------------------------------------------------------------------------
// 5. V16.7.1 Part 7: lazy browser launch. The lane can be created without
//    spawning a browser; the worker is resolved only on the FIRST real use.
// ---------------------------------------------------------------------------
test("V16.7.1 lazy launch: constructing the worker does NOT spawn; the first use does, exactly once", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(typeof module.createLazyBrowserWorker, "function", "the lazy facade must be exported for regression coverage")

  let resolveCalls = 0
  const worker = fakeWorker()
  const lazy = module.createLazyBrowserWorker(async () => { resolveCalls += 1; return worker })

  // Construction is free: no resolver call, no spawn, no navigation.
  assert.equal(resolveCalls, 0, "building the facade must not resolve the worker")
  assert.equal(lazy.launched, false, "the facade must report it has not launched")
  assert.equal(lazy.resolved, null)

  // A synchronous state() read must NOT launch a browser either.
  assert.equal(lazy.state().state, "unknown", "an un-launched worker reads as unknown, never ready")
  assert.equal(resolveCalls, 0, "a state() read must not spawn a browser")

  // The FIRST real interaction resolves the worker exactly once.
  const capability = await module.buildWebReasoningAdapterDeps(lazy).authProbe({ timeoutMs: 1_000 })
  assert.equal(resolveCalls, 1, "the first auth probe resolves the worker")
  assert.equal(capability.state, "READY")

  // Concurrent + subsequent uses reuse the SAME worker (never a second spawn).
  await Promise.all([lazy.domInspect({}), lazy.invoke("navigate", {}), lazy.authProbe({})])
  assert.equal(resolveCalls, 1, "the worker is resolved exactly once for the whole lane")
  assert.equal(lazy.launched, true)
  assert.equal(lazy.resolved, worker)
})

test("V16.7.1 lazy launch: a never-used lane closes for free and never spawns", async () => {
  const { module } = await bootShippedExtension()
  let resolveCalls = 0
  const lazy = module.createLazyBrowserWorker(async () => { resolveCalls += 1; return fakeWorker() })
  const closed = await lazy.close()
  assert.equal(closed.closed, false, "closing a never-launched worker is a no-op")
  assert.equal(closed.reason, "worker-never-launched")
  assert.equal(resolveCalls, 0, "close() must NEVER spawn a browser")
})

test("V16.7.1 lazy launch: a failed resolution fails CLOSED (rejects), never a false READY", async () => {
  const { module } = await bootShippedExtension()
  const lazy = module.createLazyBrowserWorker(async () => null)
  // The adapter maps a throwing probe to TIMEOUT/degraded, never READY.
  const { createDeepSeekWebAdapter } = await import("../lib/deepseek-web-adapter.mjs")
  const capability = await createDeepSeekWebAdapter(module.buildWebReasoningAdapterDeps(lazy)).capability()
  assert.notEqual(capability.state, "ready", "a failed lazy resolution must never read as ready")
  assert.equal(capability.state, "degraded", "a throwing auth probe is bounded to degraded")
})

test("V16.7.1 lazy launch: the production adapter built at run start spawns NO browser until consulted", async () => {
  const { module } = await bootShippedExtension()
  let resolveCalls = 0
  const worker = fakeWorker()
  const lazy = module.createLazyBrowserWorker(async () => { resolveCalls += 1; return worker })
  const { createDeepSeekWebAdapter } = await import("../lib/deepseek-web-adapter.mjs")
  const adapter = createDeepSeekWebAdapter(module.buildWebReasoningAdapterDeps(lazy))

  // Building the adapter (what `createRunWebLane` does at run start) is free.
  assert.equal(resolveCalls, 0, "adapter construction must not spawn a browser")
  // A run that never consults never launches the browser; teardown is free.
  await adapter.closeSession()
  assert.equal(resolveCalls, 0, "a browser-free run must never spawn a worker")
})
