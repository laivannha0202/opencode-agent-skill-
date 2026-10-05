// V16.7.1 Part 14: preserved adapter hooks + a closed, secret-free failure
// vocabulary that classifies each provider failure family SEPARATELY.
//
// Two contracts are proven here:
//
//   1. The production adapter wiring keeps the live hooks the proven DeepSeek
//      path binds (`authProbe` / `domInspect` / `transitionBegin` /
//      `transitionMeasure`). If any of them is dropped the real consultation
//      fails closed; the adapter-wiring test drives the full round trip, and
//      this file pins the NAMES so the wiring cannot silently regress.
//   2. `classifyConsultationError` returns a distinct, fixed literal for
//      needs-auth, ui-changed, browser-unavailable, provider-timeout,
//      service-unavailable, rate-limited and profile-locked -- never the raw
//      message, so no provider text can leak into the journal.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { WEB_CONSULTATION_ERROR, classifyConsultationError } from "../lib/web-reasoning-escalation.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const EXTENSION = path.join(ROOT, "pi", "extensions", "ues.ts")

test("V16.7.1 failure vocabulary: the closed set is complete and every entry is a fixed literal", () => {
  const expected = [
    "consultation-error",
    "escalation-error",
    "provider-error",
    "unavailable",
    "timeout",
    "needs-auth",
    "ui-changed",
    "browser-unavailable",
    "service-unavailable",
    "rate-limited",
    "profile-locked",
  ]
  assert.deepEqual(Object.values(WEB_CONSULTATION_ERROR).sort(), expected.sort())
  for (const value of Object.values(WEB_CONSULTATION_ERROR)) {
    assert.equal(typeof value, "string")
    assert.match(value, /^[a-z][a-z0-9-]*$/, `${value} must be a stable literal`)
  }
})

test("V16.7.1 failure vocabulary: each provider failure family classifies SEPARATELY", () => {
  const cases = [
    [new Error("deepseek-auth-required"), WEB_CONSULTATION_ERROR.NEEDS_AUTH],
    [{ reason: "logged-out" }, WEB_CONSULTATION_ERROR.NEEDS_AUTH],
    [new Error("deepseek-ui-selector-changed:send-resolve-post-fill"), WEB_CONSULTATION_ERROR.UI_CHANGED],
    [new Error("ui-changed"), WEB_CONSULTATION_ERROR.UI_CHANGED],
    [new Error("deepseek-browser-unavailable"), WEB_CONSULTATION_ERROR.BROWSER_UNAVAILABLE],
    [new Error("browser-worker-unavailable"), WEB_CONSULTATION_ERROR.BROWSER_UNAVAILABLE],
    [new Error("deepseek-response-timeout"), WEB_CONSULTATION_ERROR.TIMEOUT],
    [{ code: "ETIMEDOUT" }, WEB_CONSULTATION_ERROR.TIMEOUT],
    [new Error("503 Service Unavailable"), WEB_CONSULTATION_ERROR.SERVICE_UNAVAILABLE],
    [new Error("socket hang up"), WEB_CONSULTATION_ERROR.SERVICE_UNAVAILABLE],
    [new Error("429 Too Many Requests"), WEB_CONSULTATION_ERROR.RATE_LIMITED],
    [new Error("rate limit exceeded"), WEB_CONSULTATION_ERROR.RATE_LIMITED],
    [{ code: "UES_PROFILE_LOCKED" }, WEB_CONSULTATION_ERROR.PROFILE_LOCKED],
    [new Error("profile lock held by a live owner"), WEB_CONSULTATION_ERROR.PROFILE_LOCKED],
  ]
  for (const [input, want] of cases) {
    assert.equal(classifyConsultationError(input), want, `${JSON.stringify(input)} -> ${want}`)
  }
})

test("V16.7.1 failure vocabulary: profile-locked wins over the generic provider bucket", () => {
  // A locked profile that also mentions a timeout must still classify as the
  // most specific, actionable remedy.
  assert.equal(
    classifyConsultationError(new Error("UES_PROFILE_LOCKED: timeout while waiting for the owner")),
    WEB_CONSULTATION_ERROR.PROFILE_LOCKED,
  )
})

test("V16.7.1 failure vocabulary: an unclassifiable error stays the honest catch-all", () => {
  assert.equal(classifyConsultationError(new Error("something entirely unexpected")), WEB_CONSULTATION_ERROR.PROVIDER)
  assert.equal(classifyConsultationError(new Error("socket closed")), WEB_CONSULTATION_ERROR.PROVIDER)
  assert.equal(classifyConsultationError({ code: "EBUSY" }), WEB_CONSULTATION_ERROR.PROVIDER)
})

test("V16.7.1 failure vocabulary: no raw message, path or secret is ever returned", () => {
  const leaky = classifyConsultationError(new Error("SECRET_TOKEN=abc123 at C:/Users/me/.deepseek/cookies.json"))
  assert.equal(leaky, WEB_CONSULTATION_ERROR.PROVIDER)
  assert.equal(leaky.includes("SECRET"), false)
  assert.equal(leaky.includes("cookies.json"), false)
  // A tagged reason is honored verbatim (it is already a closed literal).
  assert.equal(
    classifyConsultationError({ uesConsultationReason: "rate-limited" }),
    WEB_CONSULTATION_ERROR.RATE_LIMITED,
  )
})

test("V16.7.1 adapter hooks: the production wiring preserves authProbe/domInspect/transitionBegin/transitionMeasure", () => {
  const source = readFileSync(EXTENSION, "utf8")
  for (const hook of ["authProbe:", "domInspect:", "transitionBegin:", "transitionMeasure:"]) {
    assert.ok(source.includes(hook), `the production deps must keep the live hook ${hook}`)
  }
  // The transition hooks must use the same-node send-transition modes.
  assert.ok(source.includes('mode: "send-transition-begin"'), "transitionBegin uses the pre-fill mode")
  assert.ok(source.includes('mode: "send-transition-measure"'), "transitionMeasure uses the post-fill mode")
  // authProbe must forward the live answer-selector family, never a guess.
  assert.ok(source.includes("answerSelectors: WEB_REASONING_ANSWER_SELECTORS"), "authProbe forwards the live selectors")
})
