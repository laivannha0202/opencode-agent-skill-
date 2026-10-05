// V16.7.1 production-path proof for the DeepSeek Web consultation.
//
// The defect: the controller passes `notes` to the lane as a JOINED STRING,
// while the escalation router assumed an ARRAY and called `.join()` on it. That
// threw `TypeError: (intermediate value).join is not a function`, the async
// throw became a rejected promise, and the controller swallowed it with
// `.catch(() => null)`. The result: a production consultation could NEVER
// complete, and nothing was journaled to say why.
//
// This file is deliberately NOT a helper-only unit test. It drives the SAME
// modules the shipped `pi/extensions/ues.ts` drives, in the SAME order, with the
// SAME input shapes:
//
//   1. The shipped extension is type-stripped and really imported (boot proof).
//   2. The lane is hydrated through the REAL lazy-runtime registry, then built
//      exactly as `createRunWebLane()` builds it.
//   3. `consult()` is called with the EXACT `notes` join expression the
//      controller uses, against a READY provider fixture.
//   4. The chain is asserted to end in a NON-EMPTY `advisorText`.
//   5. The follow-up path is asserted to find its prior packet afterwards.
//
// No live browser, no network, no live DeepSeek.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

// The advice fixture is bound to a REAL repository file so the local verifier
// accepts it (a claim with no locally verifiable grounding is rejected, and the
// chain would end in `advice-rejected` instead of a non-empty `advisorText`).
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

// A READY provider double implementing the same `WebReasoningProvider` surface
// the real DeepSeek adapter implements. `capability()` returns READY, so the
// consultation must reach the provider stage.
function readyProvider(overrides = {}) {
  const calls = { capability: 0, startSession: 0, consult: 0, followUp: 0, closeSession: 0, prompts: [] }
  const script = overrides.script || {}
  const pick = (method, fallback) => {
    const queue = Array.isArray(script[method]) ? script[method] : []
    return queue.length ? queue.shift() : fallback
  }
  const answer = (behaviour) => {
    if (typeof behaviour === "string") return { answer: behaviour }
    return { answer: JSON.stringify(behaviour.answer ?? behaviour) }
  }
  return {
    calls,
    adapter: {
      id: "deepseek-web",
      capability: async () => {
        calls.capability += 1
        return pick("capability", { state: "ready", reason: "ready", supportsFollowUp: true })
      },
      startSession: async (input = {}) => {
        calls.startSession += 1
        const behaviour = pick("startSession", { sessionId: "dsw-v1671", state: "ready" })
        return { ...behaviour, reused: Boolean(input.reuseSessionId) }
      },
      consult: async (session, packet, options = {}) => {
        calls.consult += 1
        calls.prompts.push({ kind: "consult", chars: String(packet?.rendered?.length || 0), requestId: options?.requestId ?? null })
        const behaviour = pick("consult", { answer: GOOD_ADVICE })
        if (behaviour?.throw) throw new Error(behaviour.throw)
        return answer(behaviour)
      },
      followUp: async (session, delta, options = {}) => {
        calls.followUp += 1
        calls.prompts.push({ kind: "follow-up", chars: delta?.chars || 0, requestId: options?.requestId ?? null })
        const behaviour = pick("followUp", { answer: GOOD_ADVICE })
        if (behaviour?.throw) throw new Error(behaviour.throw)
        return answer(behaviour)
      },
      closeSession: async () => { calls.closeSession += 1; return true },
    },
  }
}

// ---------------------------------------------------------------------------
// The shipped extension really boots (wiring proof, not a mock).
// ---------------------------------------------------------------------------
const PROBE_DIR = path.join(ROOT, ".ues-cache", "v16-7-1-prod-path-probe")
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
  const probe = path.join(path.dirname(EXTENSION), `__v1671_prod_path_probe_${process.pid}.mjs`)
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

// The exact `notes` expression the controller uses at the consult site. Kept in
// one place so the test cannot silently drift from the production shape.
function controllerNotes(parts) {
  return parts.filter(Boolean).join("\n\n")
}

async function productionEquivalentLane(options = {}) {
  // Hydrate through the REAL lazy registry, exactly as `createRunWebLane()`
  // does in production. This proves the loader resolves the shipped lane module.
  const lazy = await import(pathToFileURL(path.join(ROOT, "lib", "lazy-runtime.mjs")).href)
  const laneModule = await lazy.hydrateRuntimeModule(lazy.LAZY_RUNTIME_MODULES.WEB_REASONING_LANE)
  assert.equal(typeof laneModule.createWebReasoningLane, "function")
  const { adapter } = options
  // Mirrors `createRunWebLane()`: mode from the canonical resolver, `live` from
  // the flag (default false), provider id, and the adapters array.
  return laneModule.createWebReasoningLane({
    mode: options.mode || "auto",
    live: options.live === true,
    provider: "deepseek-web",
    maxConsultations: options.maxConsultations ?? 1,
    maxFollowUps: options.maxFollowUps ?? 2,
    adapters: adapter ? [adapter] : [],
  })
}

// ---------------------------------------------------------------------------
// 1. Boot proof + production-path success
// ---------------------------------------------------------------------------
test("V16.7.1 production path: the shipped extension boots and exposes activate()", async () => {
  const { module } = await bootShippedExtension()
  assert.equal(typeof module.default, "function", "the shipped extension must expose activate()")
  assert.equal(typeof module.requiredBrowserActionsForTask, "function")
})

test("V16.7.1 production path: a joined-STRING notes payload completes with non-empty advisorText", async () => {
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const { calls, adapter } = readyProvider()
  const lane = await productionEquivalentLane({ adapter })

  // The EXACT controller call shape. The old escalation router threw on this
  // string, so this test fails on the pre-fix implementation.
  const notes = controllerNotes(["pending resume capsule", "failure delta text", "advisor packet"])
  assert.equal(typeof notes, "string")
  const result = await lane.consult({
    task: "The verifier still fails across the browser lane and MCP health modules; the root cause is ambiguous and several fixes are plausible.",
    notes,
    constraints: ["MUST NOT disable verification"],
    verification: ["npm test"],
    affectedSubsystems: 2,
    relevantFiles: [{ path: "lib/browser-lane.mjs" }],
    knownFiles: ["lib/browser-lane.mjs"],
    requestId: "prod-path-consult-1",
  })

  // The chain ENDS in a non-empty advisorText, and a REAL consultation happened.
  assert.equal(result.consulted, true, "the lane must report a REAL provider consultation")
  assert.equal(result.outcome, "advised")
  assert.equal(calls.consult, 1, "exactly one provider consultation")
  assert.equal(calls.capability >= 1, true, "the READY provider was probed")
  assert.ok(result.advisorText && result.advisorText.length > 0, "the chain must end in non-empty advisorText")
  assert.ok(result.advisorText.includes("ADVISORY EVIDENCE ONLY"))
  assert.equal(result.isTaskVerdict, false)
  assert.equal(result.canProducePass, false)
})

// ---------------------------------------------------------------------------
// 2. Follow-up path after a successful consult
// ---------------------------------------------------------------------------
test("V16.7.1 production path: a successful consult sets the packet fingerprint so a follow-up is admitted", async () => {
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const { calls, adapter } = readyProvider()
  const lane = await productionEquivalentLane({ adapter, maxFollowUps: 2 })

  const first = await lane.consult({
    task: "The verifier still fails across modules; the root cause is ambiguous.",
    notes: controllerNotes(["capsule", "advisor packet"]),
    knownFiles: ["lib/browser-lane.mjs"],
  })
  assert.equal(first.outcome, "advised")
  assert.ok(lane.state().lastPacketFingerprint, "a successful consult must set the packet fingerprint")

  const followUp = await lane.followUp({
    task: "The verifier still fails across modules; the root cause is ambiguous.",
    evidence: [{ kind: "verifier", source: "ues-verifier", text: "verifier still fails after the fix" }],
    diff: "--- a/lib/browser-lane.mjs\n+++ b/lib/browser-lane.mjs\n+identity check",
  })
  // The historical silent failure surfaced as `skipped:no-prior-packet`. That
  // must never happen after a successful consult.
  assert.notEqual(followUp.reason, "no-prior-packet")
  assert.equal(followUp.outcome, "advised")
  assert.equal(calls.followUp, 1, "the follow-up reuses the session and sends only the delta")
})

// ---------------------------------------------------------------------------
// 3. Error matrix: no unhandled rejection, correct mode posture
// ---------------------------------------------------------------------------
test("V16.7.1 error matrix: a provider that THROWS falls back in AUTO and never rejects", async () => {
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const { adapter } = readyProvider({ script: { consult: [{ throw: "deepseek-ui-changed" }] } })
  const lane = await productionEquivalentLane({ adapter })
  // The lane must RESOLVE (the controller's try/catch is the only failure
  // boundary); a thrown provider is handled internally and reported, never
  // surfaced as an unhandled rejection.
  const result = await lane.consult({
    task: "ambiguous root cause across modules",
    notes: controllerNotes(["capsule"]),
    knownFiles: ["lib/browser-lane.mjs"],
  })
  assert.equal(result.fallbackToLocal, true)
  assert.equal(result.consulted, false)
  assert.equal(result.advisorText, null)
})

test("V16.7.1 error matrix: FORCE keeps the fail-loud contract when the provider is unavailable", async () => {
  const { adapter } = readyProvider({ script: { capability: [{ state: "unavailable", reason: "browser-worker-unavailable" }] } })
  const lane = await productionEquivalentLane({ mode: "force", adapter })
  const result = await lane.consult({
    task: "Bump the package version",
    notes: controllerNotes(["capsule"]),
  })
  assert.equal(result.outcome, "unavailable")
  assert.equal(result.code, "WEB_REASONING_UNAVAILABLE")
  assert.equal(result.fallbackToLocal, false, "FORCE must never silently degrade to a local run")
})

test("V16.7.1 error matrix: a provider TIMEOUT falls back in AUTO and is classified as timeout", async () => {
  const { clearDecisionPacketCache } = await import("../lib/decision-packet.mjs")
  clearDecisionPacketCache()
  const { adapter } = readyProvider({ script: { consult: [{ throw: "deepseek-response-timeout" }] } })
  const lane = await productionEquivalentLane({ adapter })
  const result = await lane.consult({
    task: "ambiguous root cause across modules",
    notes: controllerNotes(["capsule"]),
    knownFiles: ["lib/browser-lane.mjs"],
  })
  assert.equal(result.fallbackToLocal, true)
  assert.equal(result.consulted, false)
  // The lane classifies the failure with the closed vocabulary the controller
  // journals; a timeout never masquerades as a generic provider error.
  assert.equal(lane.classifyConsultationError(new Error("deepseek-response-timeout")), "timeout")
})

test("V16.7.1 error matrix: an escalation throw is tagged and classified, never swallowed to null", async () => {
  const lane = await productionEquivalentLane({ adapter: readyProvider().adapter })
  const poisoned = {
    task: "ambiguous root cause across modules",
    get notes() { throw new Error("notes accessor exploded") },
  }
  await assert.rejects(
    () => lane.consult(poisoned),
    (error) => {
      assert.equal(error.uesConsultationReason, "escalation-error")
      // The raw message never survives the classification.
      assert.equal(typeof lane.classifyConsultationError(error), "string")
      assert.equal(lane.classifyConsultationError(error), "escalation-error")
      return true
    },
  )
})

test("V16.7.1 error matrix: the lane exposes the closed, secret-free classifier the controller journals", async () => {
  const lane = await productionEquivalentLane({ adapter: readyProvider().adapter })
  assert.equal(typeof lane.classifyConsultationError, "function")
  assert.equal(lane.classifyConsultationError({ uesConsultationReason: "timeout" }), "timeout")
  assert.equal(lane.classifyConsultationError({ code: "WEB_REASONING_UNAVAILABLE" }), "unavailable")
  assert.equal(lane.classifyConsultationError(new Error("socket reset")), "provider-error")
  assert.equal(lane.classifyConsultationError(new Error("(x).join is not a function")), "escalation-error")
})

// ---------------------------------------------------------------------------
// 4. The controller source itself: no silent swallow remains
// ---------------------------------------------------------------------------
test("V16.7.1 controller source: the silent `.catch(() => null)` on web consults is gone", async () => {
  const source = readFileSync(EXTENSION, "utf8")
  // The three historical swallow sites (initial consult, patch review, follow-up)
  // ended with `.catch(() => null)` directly on the lane call. That exact idiom
  // must be gone; a bounded window keeps the check from matching an unrelated
  // `.catch(() => null)` later in the file.
  for (const call of ["webLane.consult(", "webLane.followUp(", "webLane\n", "webLane\r\n"]) {
    let from = 0
    while (true) {
      const at = source.indexOf(call, from)
      if (at === -1) break
      from = at + call.length
      const window = source.slice(at, at + 1_600)
      assert.equal(
        /\.catch\(\(\) => null\)/.test(window),
        false,
        `a web lane call at offset ${at} is still swallowed with .catch(() => null)`,
      )
    }
  }
  // The journaling + FORCE fail-loud synthesis are present.
  assert.ok(source.includes('"web-reasoning.consultation-error"'), "the controller must journal consultation failures")
  assert.ok(source.includes("journalConsultationFailure"), "the controller must use the shared failure journaler")
  assert.ok(source.includes("forceUnavailableConsultation"), "FORCE must synthesize an explicit unavailable result")
  // The stale-response path reassigns `consultation`, so it must be `let`.
  assert.ok(source.includes("let consultation: any;"), "the reassigned consult binding must be `let`")
})

test("V16.7.1 controller source: web-reasoning.consulted is discriminated, not provider:undefined", async () => {
  const source = readFileSync(EXTENSION, "utf8")
  // The single consultation event carries a `source` discriminator and an
  // always-defined provider + outcome.
  assert.ok(source.includes('source,'), "the consulted event must carry a source discriminator")
  assert.ok(source.includes('"cache-replay"') && source.includes('"provider"') && source.includes('"unavailable"') && source.includes('"error"'))
  // The old cache-only event (provider: "consult-cache") must be folded in, not
  // emitted as a second event with no discriminator.
  const cacheEvents = [...source.matchAll(/appendRunJournalEvent\([^)]*"web-reasoning\.consulted"/g)]
  assert.equal(cacheEvents.length, 1, "there must be exactly ONE web-reasoning.consulted emission")
  // A cache replay is labeled, and the event NEVER reports `provider: undefined`
  // with `outcome: undefined` (the ambiguity the fix removes).
  assert.ok(source.includes('const cacheReplay = cacheLookup.cached'), "a cache replay must be detected explicitly")
  assert.ok(source.includes('outcome = source === "provider" ? "success"'), "a real provider consult reports outcome success")
})
