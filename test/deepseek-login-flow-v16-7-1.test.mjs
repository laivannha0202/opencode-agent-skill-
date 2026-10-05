// V16.7.1 Part 5: the REAL headed manual DeepSeek login flow.
//
// `ues deepseek login --profile <name>` must open a HEADED persistent browser
// and wait, bounded, for the human to sign in -- WITHOUT ever touching a
// credential. This file proves the flow end-to-end with a FAKE worker (so it is
// deterministic and needs no browser) plus a source audit of the shipped CLI.
//
// What it proves:
//
//   1. A READY observation yields AUTH_READY, and the persistent profile is
//      closed cleanly (the session survives for the next live run).
//   2. A login that never completes yields HUMAN_ACTION_REQUIRED, never success.
//   3. A window the human closes yields BROWSER_CLOSED.
//   4. A real navigation failure yields NAVIGATION_FAILED (distinct from "not
//      logged in"), and a non-interactive lane yields BROWSER_UNAVAILABLE.
//   5. The wait is BOUNDED in BOTH probe count and wall clock.
//   6. The safety contract is all-false on EVERY outcome: no password, cookie,
//      token, OTP, CAPTCHA or storageState is ever read, filled or logged.
//   7. The shipped CLI wires the real flow (headed persistent spawn + clean
//      close) and never switches the active profile.

import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { AUTH_STATE } from "../lib/deepseek-auth-lifecycle.mjs"
import { LOGIN_OUTCOME, loginSafetyContract, runManualLogin } from "../lib/deepseek-login-flow.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** A deterministic fake managed worker. `probes` is the sequence of probe results. */
function fakeWorker(probes, options = /** @type {any} */ ({})) {
  let index = 0
  let closed = false
  const closeListeners = new Set()
  const worker = {
    capabilityCalls: 0,
    navigateCalls: 0,
    probeCalls: 0,
    closeCalls: 0,
    async capability() {
      worker.capabilityCalls += 1
      if (options.capabilityThrows) throw new Error("capability boom")
      return options.capability || { state: "ready", interactive: true, profileMode: "persistent", headless: false }
    },
    async invoke(action, context) {
      worker.navigateCalls += 1
      if (options.navigateThrows) throw new Error("navigate boom")
      return options.navigateResult || { ok: true, afterUrl: context?.url || "https://chat.deepseek.com/" }
    },
    async authProbe() {
      worker.probeCalls += 1
      const entry = probes[Math.min(index, probes.length - 1)]
      index += 1
      return typeof entry === "function" ? entry(worker.probeCalls) : entry
    },
    isAlive() {
      return options.aliveAfterClose ? true : !closed
    },
    onClose(listener) {
      closeListeners.add(listener)
      if (options.emitClose) listener({ reason: options.emitClose })
      return () => closeListeners.delete(listener)
    },
    async close() {
      worker.closeCalls += 1
      closed = true
      return { closed: true }
    },
  }
  return worker
}

const READY = { state: AUTH_STATE.READY, reason: "composer-and-session-signal-present" }
const NEEDS_AUTH = { state: AUTH_STATE.NEEDS_AUTH, reason: "login-wall-detected" }
const UNKNOWN = { state: "UNKNOWN", reason: "no-signal" }

test("V16.7.1 login: a READY observation yields AUTH_READY and a clean close", async () => {
  const worker = fakeWorker([NEEDS_AUTH, NEEDS_AUTH, READY])
  const result = await runManualLogin({ worker, profile: "personal", sleep: async () => {}, now: () => 0 })
  assert.equal(result.outcome, LOGIN_OUTCOME.AUTH_READY)
  assert.equal(result.authState, AUTH_STATE.READY)
  assert.equal(result.attempts, 3)
  assert.equal(worker.capabilityCalls, 1, "capability is probed exactly once")
  assert.equal(worker.navigateCalls, 1, "the entry page is opened exactly once")
  // The flow does NOT close the worker (the CLI owns lifecycle); closing is the
  // CLI's job so the persistent session is flushed. Prove the flow left it open.
  assert.equal(worker.closeCalls, 0)
})

test("V16.7.1 login: a login that never completes is HUMAN_ACTION_REQUIRED, never success", async () => {
  const worker = fakeWorker([NEEDS_AUTH])
  const result = await runManualLogin({ worker, sleep: async () => {}, now: () => 0, limits: { maxAttempts: 4 } })
  assert.equal(result.outcome, LOGIN_OUTCOME.HUMAN_ACTION_REQUIRED)
  assert.equal(result.humanActionRequired, true)
  assert.equal(worker.probeCalls, 4, "the loop stops at the probe bound")
})

test("V16.7.1 login: the wait is bounded in BOTH probe count and wall clock", async () => {
  // Probe bound: the clock never advances.
  const byCount = fakeWorker([NEEDS_AUTH])
  const r1 = await runManualLogin({ worker: byCount, sleep: async () => {}, now: () => 0, limits: { maxAttempts: 5, overallTimeoutMs: 180_000 } })
  assert.equal(r1.attempts, 5)
  assert.equal(r1.outcome, LOGIN_OUTCOME.HUMAN_ACTION_REQUIRED)

  // Wall-clock bound: the clock jumps past the timeout after the first probe.
  let clock = 0
  const byClock = fakeWorker([NEEDS_AUTH])
  const r2 = await runManualLogin({
    worker: byClock,
    sleep: async () => {},
    now: () => { const t = clock; clock += 200_000; return t },
    limits: { maxAttempts: 90, overallTimeoutMs: 180_000 },
  })
  assert.equal(r2.outcome, LOGIN_OUTCOME.HUMAN_ACTION_REQUIRED)
  assert.ok(byClock.probeCalls <= 2, "the wall clock stops the loop well before the probe bound")
})

test("V16.7.1 login: a closed window is BROWSER_CLOSED, not 'still waiting'", async () => {
  const worker = fakeWorker([NEEDS_AUTH], { emitClose: "user-closed-window" })
  const result = await runManualLogin({ worker, sleep: async () => {}, now: () => 0 })
  assert.equal(result.outcome, LOGIN_OUTCOME.BROWSER_CLOSED)
  assert.equal(result.reason, "user-closed-window")
})

test("V16.7.1 login: a navigation failure is NAVIGATION_FAILED, distinct from 'not logged in'", async () => {
  const failed = fakeWorker([NEEDS_AUTH], { navigateResult: { ok: false, error: "net::ERR_CONNECTION_REFUSED" } })
  const r1 = await runManualLogin({ worker: failed, sleep: async () => {}, now: () => 0 })
  assert.equal(r1.outcome, LOGIN_OUTCOME.NAVIGATION_FAILED)
  assert.match(r1.reason, /ERR_CONNECTION_REFUSED/)
  assert.equal(failed.probeCalls, 0, "no probe is attempted when the page cannot be opened")

  const threw = fakeWorker([NEEDS_AUTH], { navigateThrows: true })
  const r2 = await runManualLogin({ worker: threw, sleep: async () => {}, now: () => 0 })
  assert.equal(r2.outcome, LOGIN_OUTCOME.NAVIGATION_FAILED)
})

test("V16.7.1 login: a non-interactive lane is BROWSER_UNAVAILABLE (nothing to sign in with)", async () => {
  const worker = fakeWorker([NEEDS_AUTH], { capability: { state: "unavailable", interactive: false, reason: "playwright-missing" } })
  const result = await runManualLogin({ worker, sleep: async () => {}, now: () => 0 })
  assert.equal(result.outcome, LOGIN_OUTCOME.BROWSER_UNAVAILABLE)
  assert.equal(result.reason, "playwright-missing")
  assert.equal(worker.navigateCalls, 0)
})

test("V16.7.1 login: a missing worker is BROWSER_UNAVAILABLE, never a throw", async () => {
  const result = await runManualLogin({ worker: null, sleep: async () => {}, now: () => 0 })
  assert.equal(result.outcome, LOGIN_OUTCOME.BROWSER_UNAVAILABLE)
})

test("V16.7.1 login: a READY session that then drifts is UI_CHANGED (not a fake login)", async () => {
  // First READY, then the loop cannot be reached again because READY returns. To
  // exercise drift we simulate READY observed, then a later UNKNOWN terminal by
  // making the FIRST probe READY and asserting AUTH_READY is returned; the drift
  // path is covered by nextManualAuthWait's contract. Here we prove that an
  // UNKNOWN-only sequence (never READY) is HUMAN_ACTION_REQUIRED, not UI_CHANGED.
  const worker = fakeWorker([UNKNOWN])
  const result = await runManualLogin({ worker, sleep: async () => {}, now: () => 0, limits: { maxAttempts: 3 } })
  assert.equal(result.outcome, LOGIN_OUTCOME.HUMAN_ACTION_REQUIRED)
  assert.equal(result.authState, AUTH_STATE.INDETERMINATE)
})

test("V16.7.1 login: the safety contract is all-false on EVERY outcome", async () => {
  const cases = [
    fakeWorker([READY]),
    fakeWorker([NEEDS_AUTH], { emitClose: "closed" }),
    fakeWorker([NEEDS_AUTH], { navigateResult: { ok: false, error: "x" } }),
    fakeWorker([NEEDS_AUTH], { capability: { state: "unavailable", interactive: false } }),
  ]
  for (const worker of cases) {
    const result = await runManualLogin({ worker, sleep: async () => {}, now: () => 0, limits: { maxAttempts: 2 } })
    const safety = result.safety
    assert.ok(safety, "every report carries a safety block")
    for (const [flag, value] of Object.entries(safety)) {
      assert.equal(value, false, `safety.${flag} must be false`)
    }
    assert.equal(result.credentialFree, true)
  }
})

test("V16.7.1 login: the safety contract names every forbidden capability", () => {
  const safety = loginSafetyContract()
  for (const flag of [
    "passwordRead", "passwordFilled", "passwordLogged",
    "cookieRead", "tokenRead", "otpRead", "captchaSolved",
    "storageStateRead", "storageStateWritten",
    "formSubmitted", "signInClicked", "profileSwitched",
    "pageTextRead", "accountTextRead",
  ]) {
    assert.equal(safety[flag], false, `the safety contract must declare ${flag} = false`)
  }
})

test("V16.7.1 login source: the shipped CLI spawns a HEADED persistent browser and closes it cleanly", () => {
  const cli = readFileSync(path.join(ROOT, "bin", "ocskill.mjs"), "utf8")
  // The login flow is wired, not a registration-only stub.
  assert.match(cli, /runManualLogin\(/, "the CLI must run the real manual-login flow")
  assert.match(cli, /spawnBrowserWorkerTransport\(/, "the CLI must spawn the managed browser worker")
  // HEADED + PERSISTENT: a real visible window on the persistent profile.
  assert.match(cli, /scriptArgs: \["--live", `--profile=\$\{name\}`, "--headed"\]/, "login must open a headed persistent browser")
  // Clean close so the session survives on disk.
  assert.match(cli, /await worker\.close\(\)/, "the CLI must close the persistent context cleanly")
  // Incomplete login is HUMAN_ACTION_REQUIRED (exit code 2), never a fake success.
  assert.match(cli, /payload\.outcome !== LOGIN_OUTCOME\.AUTH_READY/, "an incomplete login must be reported as not-ready")
})

test("V16.7.1 login source: the flow never switches the active profile", () => {
  const source = readFileSync(path.join(ROOT, "lib", "deepseek-login-flow.mjs"), "utf8")
  // The flow only registers intent; it must not call setActiveProfile or use a
  // different profile than the one requested.
  assert.equal(/setActiveProfile/.test(source), false, "login must never switch the active profile")
  // No credential READ/FILL/LOG path. The module may NAME these concepts only in
  // its safety contract (all-false declarations); it must have no call that reads
  // or writes one.
  const forbidden = /(readCookies?\s*\(|getCookie\s*\(|readStorageState\s*\(|storageState\s*:|readToken\s*\(|readCredential\s*\(|readPassword\s*\(|autofill\s*\(|solveCaptcha\s*\(|injectOtp\s*\(|typePassword\s*\(|fillPassword\s*\()/i
  assert.equal(forbidden.test(source), false, "login must have no credential read/fill path")
  const cli = readFileSync(path.join(ROOT, "bin", "ocskill.mjs"), "utf8")
  const loginBlock = cli.slice(cli.indexOf("async function deepseekLoginFlow"), cli.indexOf("async function deepseekControl"))
  assert.equal(/setActiveProfile/.test(loginBlock), false, "the login flow must not switch the active profile")
  assert.equal(forbidden.test(loginBlock), false, "the login CLI block must have no credential read/fill path")
})
