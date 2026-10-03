// V16.3 live-auth hydration settle: the race that made --live fail on an
// authenticated profile.
//
// REAL EVIDENCE:
//   --auth-diagnose: composerVisible=true, historyCount=50, READY
//   --auth: probe 1 waiting-for-login, probe 2 READY (~2256ms)
//   --live immediately after: NEEDS_AUTH, composer-visible-but-no-session-signal
//
// ROOT CAUSE: live/preflight did navigate -> single observeAuth() immediately
// after domcontentloaded. DeepSeek hydrates sidebar/history asynchronously, so
// probe 1 sees UNKNOWN on an authenticated page. --auth survives via 180s
// polling; --auth-diagnose via a fixed 4s sleep. Live had neither.
//
// FIX: short bounded READ-ONLY settle waitForAuthenticatedPage(worker):
// max 5 probes, 1s interval, 6s overall, early exit on READY, fail-fast on
// login walls, retry UNKNOWN/UI_CHANGED/TIMEOUT, fail closed on worker close.
// No navigation retry, no click/type/submit, never UNKNOWN->READY.
//
// Deterministic. No browser, no network, no DeepSeek.
import test from "node:test"
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  AUTH_PROBE_STATE,
  AUTH_SETTLE_LIMIT,
  AUTH_WAIT_LIMIT,
  AUTH_WAIT_STATE,
  classifyAuthState,
  nextAuthWaitState,
  waitForAuthenticatedPage,
} from "../lib/browser-profile.mjs"
import { workerModePlan, WORKER_MODE } from "../lib/browser-worker-mode.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const READY = (extra = {}) => ({
  state: AUTH_PROBE_STATE.READY,
  reason: "composer-and-history-present",
  url: "https://chat.deepseek.com/",
  observations: { composerVisible: true, historyCount: 50, answerRegions: 0, accountSignal: false },
  transportAlive: true,
  ...extra,
})
const UNKNOWN = (extra = {}) => ({
  state: AUTH_PROBE_STATE.UNKNOWN,
  reason: "composer-visible-but-no-session-signal",
  url: "https://chat.deepseek.com/",
  observations: { composerVisible: true, historyCount: 0, answerRegions: 0, accountSignal: false },
  transportAlive: true,
  ...extra,
})
const UI_CHANGED = (extra = {}) => ({
  state: AUTH_PROBE_STATE.UI_CHANGED,
  reason: "page-loaded-but-no-known-composer-found",
  url: "https://chat.deepseek.com/",
  observations: {},
  transportAlive: true,
  ...extra,
})
const TIMEOUT = (extra = {}) => ({
  state: AUTH_PROBE_STATE.TIMEOUT,
  reason: "auth-probe-timed-out",
  url: "https://chat.deepseek.com/",
  observations: null,
  transportAlive: true,
  ...extra,
})
const NEEDS_WALL = (extra = {}) => ({
  state: AUTH_PROBE_STATE.NEEDS_AUTH,
  reason: "login-wall-detected",
  url: "https://chat.deepseek.com/",
  observations: { loginEvidence: true },
  transportAlive: true,
  ...extra,
})
const NEEDS_URL = (extra = {}) => ({
  state: AUTH_PROBE_STATE.NEEDS_AUTH,
  reason: "login-url-detected",
  url: "https://chat.deepseek.com/login",
  observations: {},
  transportAlive: true,
  ...extra,
})

function makeWorker(sequence, opts = {}) {
  let authCalls = 0
  const invokeCalls = []
  let alive = opts.alive !== false
  const closeListeners = []
  const sleepCalls = []
  const worker = {
    authProbe: async (probeOpts) => {
      authCalls += 1
      if (opts.closeOnAttempt && authCalls >= opts.closeOnAttempt) {
        alive = false
        for (const fn of [...closeListeners]) {
          try { fn({ reason: "worker-process-exited" }) } catch {}
        }
        return { state: "closed", reason: "worker-process-exited", observations: null, transportAlive: false }
      }
      if (opts.throwOnAttempt && authCalls === opts.throwOnAttempt) {
        throw new Error(opts.throwMessage || "probe exploded")
      }
      const entry = sequence[Math.min(authCalls - 1, sequence.length - 1)]
      if (typeof entry === "function") return entry(authCalls, probeOpts)
      return entry
    },
    isAlive: () => alive,
    onClose: (fn) => {
      if (typeof fn === "function") {
        closeListeners.push(fn)
        if (!alive) {
          try { fn({ reason: "worker-process-exited" }) } catch {}
        }
      }
      return () => {
        const i = closeListeners.indexOf(fn)
        if (i >= 0) closeListeners.splice(i, 1)
      }
    },
    invoke: async (action) => {
      invokeCalls.push(action)
      return { ok: true, afterUrl: "https://chat.deepseek.com/" }
    },
  }
  const sleepImpl = async (ms) => { sleepCalls.push(ms) }
  return {
    worker,
    get authCalls() { return authCalls },
    invokeCalls,
    sleepCalls,
    sleepImpl,
    kill() {
      alive = false
      for (const fn of [...closeListeners]) {
        try { fn({ reason: "worker-process-exited" }) } catch {}
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Settle bounds: short, bounded, faster than the diagnostic sleep when quick
// ---------------------------------------------------------------------------

test("V16.3 settle bounds are short: 5 probes, 1s interval, 6s overall", () => {
  assert.equal(AUTH_SETTLE_LIMIT.maxAttempts, 5)
  assert.equal(AUTH_SETTLE_LIMIT.intervalMs, 1_000)
  assert.equal(AUTH_SETTLE_LIMIT.overallTimeoutMs, 6_000)
  assert.ok(AUTH_SETTLE_LIMIT.overallTimeoutMs <= 6_000, "total must stay within ~6s")
  assert.ok(AUTH_SETTLE_LIMIT.maxAttempts * AUTH_SETTLE_LIMIT.intervalMs <= 6_000)
})

test("V16.3 settle is a separate short waiter, not the 180s manual flow", () => {
  assert.equal(AUTH_WAIT_LIMIT.maxAttempts, 90)
  assert.equal(AUTH_WAIT_LIMIT.overallTimeoutMs, 180_000)
  assert.ok(AUTH_SETTLE_LIMIT.overallTimeoutMs < AUTH_WAIT_LIMIT.overallTimeoutMs)
  assert.ok(AUTH_SETTLE_LIMIT.maxAttempts < AUTH_WAIT_LIMIT.maxAttempts)
})

// ---------------------------------------------------------------------------
// 1-3: hydration recovery
// ---------------------------------------------------------------------------

test("V16.3 settle 1 first UNKNOWN then READY continues", async () => {
  const f = makeWorker([UNKNOWN(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 2)
  assert.equal(out.authProbes, 2)
  assert.ok(Number(out.authSettleMs) >= 0)
  assert.equal(f.authCalls, 2)
  assert.equal(f.sleepCalls.length, 1, "one 1s re-probe, not a blind 4s sleep")
  assert.equal(f.sleepCalls[0], 1_000)
})

test("V16.3 settle 2 UNKNOWN twice then READY continues", async () => {
  const f = makeWorker([UNKNOWN(), UNKNOWN(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 3)
  assert.equal(f.authCalls, 3)
  assert.equal(f.sleepCalls.length, 2)
})

test("V16.3 settle 3 UI_CHANGED then READY continues within the short bound", async () => {
  const f = makeWorker([UI_CHANGED(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 2)
  assert.equal(f.authCalls, 2)
})

// ---------------------------------------------------------------------------
// Exact real sequence: history hydrates from 0 to 50
// ---------------------------------------------------------------------------

test("V16.3 settle accepts the EXACT real hydration sequence (0 -> 50 rows)", async () => {
  // Probe 1 and probe 2 as CLASSIFIED from real observations, end to end
  // through the production classifier: no mocked READY, the rule must fire.
  const first = classifyAuthState({
    url: "https://chat.deepseek.com/",
    composerVisible: true,
    accountSignal: false,
    answerRegions: 0,
    historyCount: 0,
  })
  assert.equal(first.state, AUTH_PROBE_STATE.UNKNOWN)
  assert.equal(first.reason, "composer-visible-but-no-session-signal")
  const second = classifyAuthState({
    url: "https://chat.deepseek.com/",
    composerVisible: true,
    accountSignal: false,
    answerRegions: 0,
    historyCount: 50,
  })
  assert.equal(second.state, AUTH_PROBE_STATE.READY)
  assert.equal(second.reason, "composer-and-history-present")

  const f = makeWorker([
    { ...first, observations: { composerVisible: true, historyCount: 0 }, transportAlive: true },
    { ...second, observations: { composerVisible: true, historyCount: 50 }, transportAlive: true },
  ])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 2)
  assert.equal(out.probe.historyCount, 50)
})

// ---------------------------------------------------------------------------
// 4: no unnecessary sleep when already READY
// ---------------------------------------------------------------------------

test("V16.3 settle 4 READY on first probe returns with no sleep", async () => {
  const f = makeWorker([READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 1)
  assert.equal(f.authCalls, 1)
  assert.equal(f.sleepCalls.length, 0, "must not sleep when hydration is already complete")
})

// ---------------------------------------------------------------------------
// 5-6: login walls fail immediately, never retried into READY
// ---------------------------------------------------------------------------

test("V16.3 settle 5 explicit login wall NEEDS_AUTH fails immediately", async () => {
  const f = makeWorker([NEEDS_WALL(), READY(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.NEEDS_AUTH)
  assert.equal(out.reason, "login-wall-detected")
  assert.equal(out.attempts, 1)
  assert.equal(f.authCalls, 1, "a login wall must not be retried")
  assert.equal(f.sleepCalls.length, 0)
})

test("V16.3 settle 6 login URL NEEDS_AUTH fails immediately", async () => {
  const f = makeWorker([NEEDS_URL(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.NEEDS_AUTH)
  assert.equal(out.reason, "login-url-detected")
  assert.equal(out.attempts, 1)
  assert.equal(f.authCalls, 1)
})

// ---------------------------------------------------------------------------
// 7: exhausted bound never fabricates READY
// ---------------------------------------------------------------------------

test("V16.3 settle 7 UNKNOWN through the whole bound never becomes READY", async () => {
  const f = makeWorker([UNKNOWN(), UNKNOWN(), UNKNOWN(), UNKNOWN(), UNKNOWN(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.notEqual(out.state, AUTH_PROBE_STATE.READY)
  assert.ok([AUTH_PROBE_STATE.UNKNOWN, AUTH_PROBE_STATE.NEEDS_AUTH].includes(out.state) || out.state === AUTH_PROBE_STATE.UNKNOWN)
  assert.equal(out.state, AUTH_PROBE_STATE.UNKNOWN)
  assert.equal(out.attempts, 5, "bounded at 5 probes")
  assert.equal(f.authCalls, 5)
  assert.equal(f.sleepCalls.length, 4)
  assert.equal(out.reason, "composer-visible-but-no-session-signal")
})

// ---------------------------------------------------------------------------
// 8: worker closes fail closed
// ---------------------------------------------------------------------------

test("V16.3 settle 8 worker closes during settle fails closed", async () => {
  const f = makeWorker([UNKNOWN(), READY()], { closeOnAttempt: 2 })
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, "CLOSED")
  assert.equal(out.closed, true)
  assert.notEqual(out.state, AUTH_PROBE_STATE.READY)
})

test("V16.3 settle 8b already-dead worker fails closed without probing", async () => {
  const f = makeWorker([READY()], { alive: false })
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, "CLOSED")
  assert.notEqual(out.state, AUTH_PROBE_STATE.READY)
})

// ---------------------------------------------------------------------------
// 9: individual TIMEOUT recovers
// ---------------------------------------------------------------------------

test("V16.3 settle 9 probe TIMEOUT then READY recovers within the bound", async () => {
  const f = makeWorker([TIMEOUT(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 2)
})

test("V16.3 settle 9b thrown probe then READY recovers", async () => {
  const f = makeWorker([READY()], { throwOnAttempt: 1 })
  // First call throws, second returns READY: emulate by sequencing throw then READY
  let calls = 0
  const throwing = {
    ...f.worker,
    authProbe: async () => {
      calls += 1
      if (calls === 1) throw new Error("probe exploded")
      return READY()
    },
  }
  const sleeps = []
  const out = await waitForAuthenticatedPage(throwing, { sleep: async (ms) => sleeps.push(ms) })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.equal(out.attempts, 2)
})

// ---------------------------------------------------------------------------
// 10-11: read-only, no side effects
// ---------------------------------------------------------------------------

test("V16.3 settle 10 no navigation retry during settle", async () => {
  const f = makeWorker([UNKNOWN(), READY()])
  await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.deepEqual(f.invokeCalls, [], "settle must never navigate, retry or otherwise invoke")
})

test("V16.3 settle 11 no click/type/submit during auth settle", async () => {
  const f = makeWorker([UNKNOWN(), UI_CHANGED(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(out.state, AUTH_PROBE_STATE.READY)
  assert.deepEqual(f.invokeCalls, [], "no fill/click/submit path goes through invoke; settle must not touch it")
  const lib = await readFile(path.join(root, "lib", "browser-profile.mjs"), "utf8")
  const settle = lib.slice(lib.indexOf("export async function waitForAuthenticatedPage"))
  assert.ok(settle.includes("authProbe"), "settle probes read-only")
  assert.ok(!/worker\.invoke\s*\(/.test(settle), "settle must never invoke navigation or actions")
})

test("V16.3 settle safe output carries counts only, no page content", async () => {
  const f = makeWorker([UNKNOWN(), READY()])
  const out = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  const serialized = JSON.stringify(out)
  for (const forbidden of ["conversationTitles", "accountName", "avatarAlt", "cookie", "token", "password", "inputValue", "localStorage"]) {
    assert.ok(!serialized.includes(forbidden), `settle must not carry ${forbidden}`)
  }
  assert.ok(Number.isFinite(out.authProbes))
  assert.ok(Number.isFinite(out.authSettleMs))
})

// ---------------------------------------------------------------------------
// 12-13: consultation gating (settle before submit, exactly once)
// ---------------------------------------------------------------------------

test("V16.3 settle 12 consultation submitted exactly once after READY", async () => {
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
  const f = makeWorker([UNKNOWN(), READY()])
  const settled = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(settled.state, AUTH_PROBE_STATE.READY)
  assert.deepEqual(f.invokeCalls, [], "no submit happened during settle")

  let sends = 0
  const answer = JSON.stringify({
    summary: "s", hypotheses: [], recommendedApproach: [], filesToInspect: [],
    risks: [], edgeCases: [], verificationSuggestions: [], confidence: 0.5,
  })
  const adapter = createDeepSeekWebAdapter({
    capability,
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
  assert.equal(session.state, "ready")
  const first = await adapter.consult(session, { rendered: "p" }, { requestId: "settle-12" })
  assert.equal(first.ok, true)
  assert.equal(sends, 1, "consultation happens exactly once after READY")
})

test("V16.3 settle 13 consultation never submitted before READY", async () => {
  const f = makeWorker([NEEDS_WALL()])
  const settled = await waitForAuthenticatedPage(f.worker, { sleep: f.sleepImpl })
  assert.equal(settled.state, AUTH_PROBE_STATE.NEEDS_AUTH)
  // The live lane must stop here: no adapter, no fill, no click.
  assert.deepEqual(f.invokeCalls, [], "a login wall must stop before any submit path")
  let submits = 0
  const fakeSubmit = async () => { submits += 1; return { ok: true } }
  // Gate: only submit when settled READY. NEEDS_AUTH => never call it.
  if (settled.state === AUTH_PROBE_STATE.READY) await fakeSubmit()
  assert.equal(submits, 0)
})

// ---------------------------------------------------------------------------
// 14-16: continuity guarantees
// ---------------------------------------------------------------------------

test("V16.3 settle 14 persistent profile continuity unchanged", async () => {
  const auth = workerModePlan({ auth: true, profile: "deepseek-web" })
  const live = workerModePlan({ live: true, profile: "deepseek-web" })
  assert.equal(auth.persistentProfileName, live.persistentProfileName)
  assert.equal(auth.profileName, live.profileName)
  assert.equal(auth.live, true)
  assert.equal(live.live, true)
  assert.equal(workerModePlan({}).mode, WORKER_MODE.PREFLIGHT)
  // Settle never touches the profile: it only probes.
  const lib = await readFile(path.join(root, "lib", "browser-profile.mjs"), "utf8")
  const settle = lib.slice(lib.indexOf("export async function waitForAuthenticatedPage"))
  assert.ok(!settle.includes("userDataDir"))
  assert.ok(!settle.includes("profileForMode"))
})

test("V16.3 settle 15 manual-auth 180s flow unchanged", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8")
  assert.ok(smoke.includes("waitForManualLogin"), "manual waiter must remain")
  assert.ok(smoke.includes("nextAuthWaitState"), "shared state machine must remain")
  assert.ok(smoke.includes("AUTH_WAIT_STATE.READY"))
  // Manual bounds untouched.
  assert.ok(smoke.includes("maxAttempts"))
  assert.ok(smoke.includes("overallTimeoutMs"))
  const pending = nextAuthWaitState({
    observation: AUTH_PROBE_STATE.UNKNOWN, transportAlive: true, navigationOk: true,
    attempt: 1, elapsedMs: 2_000, maxAttempts: 90, overallTimeoutMs: 180_000,
  })
  assert.equal(pending.state, AUTH_WAIT_STATE.PENDING)
})

test("V16.3 settle 16 diagnostic mode unchanged (fixed 4s sleep, single probe)", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8")
  assert.ok(smoke.includes("--auth-diagnose"))
  assert.ok(smoke.includes("READ-ONLY AUTH DIAGNOSTIC"))
  assert.ok(smoke.includes("await sleep(4_000)"), "diagnostic keeps its measurement sleep")
  const diagStart = smoke.indexOf("if (args.authDiagnose)")
  const diagEnd = smoke.indexOf("// ---- --locator-diagnose")
  const preflightStart = smoke.indexOf("// ---- preflight: observe")
  assert.ok(diagStart >= 0 && diagEnd > diagStart && preflightStart > diagEnd)
  const diagBlock = smoke.slice(diagStart, diagEnd)
  assert.ok(!diagBlock.includes("waitForAuthenticatedPage"), "diagnostic must not use the live settle")
  assert.ok(diagBlock.includes("observeAuth(worker)"), "diagnostic keeps its single probe")
})

// ---------------------------------------------------------------------------
// Smoke wiring: live/preflight uses the settle before any consultation
// ---------------------------------------------------------------------------

test("V16.3 settle smoke live/preflight navigates once then settles before consult", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8")
  assert.ok(smoke.includes("waitForAuthenticatedPage"), "live/preflight must use the bounded settle")
  assert.ok(smoke.includes("AUTH_SETTLE_LIMIT"), "live output reports the settle bound")
  // No blind fixed sleep in the live path: the only sleep(4_000) is diagnostic.
  const preflightStart = smoke.indexOf("// ---- preflight: observe")
  const liveConsult = smoke.indexOf("ONE real consultation")
  assert.ok(preflightStart >= 0 && liveConsult > preflightStart)
  const liveBlock = smoke.slice(preflightStart, liveConsult)
  assert.ok(!liveBlock.includes("sleep(4_000)"), "live must poll with early exit, not a blind 4s sleep")
  assert.ok(liveBlock.includes("waitForAuthenticatedPage(worker)"))
  // Settle happens before any consultation construction.
  assert.ok(smoke.indexOf("waitForAuthenticatedPage(worker)") < smoke.indexOf("createDeepSeekWebAdapter({"))
  assert.ok(smoke.indexOf("waitForAuthenticatedPage(worker)") < smoke.indexOf("lane.consult("))
  // Persistent-profile guard still first (preflight occurrence is the last
  // waitForAuthenticatedPage(worker) call site; the locator diagnostic above
  // carries its own identical guard under a different plan variable).
  assert.ok(smoke.indexOf("workerModeViolation(workerPlan, capability)") < smoke.lastIndexOf("waitForAuthenticatedPage(worker)"))
  // Consultation still at most once.
  const consults = smoke.match(/lane\.consult\s*\(/g) || []
  assert.equal(consults.length, 1, "the live consultation must happen at most once")
})

test("V16.3 settle smoke reports bounded metadata without page content", async () => {
  const smoke = await readFile(path.join(root, "scripts", "smoke-deepseek-web-v16-3.mjs"), "utf8")
  assert.ok(smoke.includes("authProbes"))
  assert.ok(smoke.includes("authSettleMs"))
  const preflightStart = smoke.indexOf("// ---- preflight: observe")
  const tail = smoke.slice(preflightStart)
  for (const forbidden of ["conversationTitles", "accountName", "inputValue", "localStorage", "cookie"]) {
    // The smoke must never print these in the settle path; the words may appear
    // in comments about what is NOT printed, so only fail if printed via report.
    const lines = tail.split("\n").filter((l) => l.includes("report(") || l.includes("console.log"))
    assert.ok(!lines.some((l) => l.includes(forbidden)), `settle output must not print ${forbidden}`)
  }
})

// ---------------------------------------------------------------------------
// Latent live-path faults exposed by the settle (navigate encoding + session
// hydration). Both are auth-path faults: without them the live lane can never
// reach a consultation, no matter how correct the settle is.
// ---------------------------------------------------------------------------

test("V16.3 settle worker client encodes a string navigate target as URL", async () => {
  const { createBrowserWorkerClient } = await import("../lib/browser-worker-client.mjs")
  const { encodeWorkerResponse, BROWSER_WORKER_OPERATION } = await import("../lib/browser-worker-protocol.mjs")
  const listeners = []
  let seen = null
  const client = createBrowserWorkerClient({
    transport: {
      send(message) {
        seen = message
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(encodeWorkerResponse({
              ok: true,
              requestId: message.requestId,
              operation: message.operation || BROWSER_WORKER_OPERATION.NAVIGATE,
              payload: { finalUrl: "https://chat.deepseek.com/", beforeUrl: "about:blank" },
            }))
          }
        })
      },
      onMessage(listener) { listeners.push(listener); return () => {} },
      close() {},
    },
  })
  // The adapter passes the entry URL as a bare string target. The client must
  // carry it as the navigate URL, not drop it to null.
  const res = await client.invoke("navigate", { target: "https://chat.deepseek.com/" })
  assert.equal(res.ok, true)
  assert.equal(res.afterUrl, "https://chat.deepseek.com/")
  assert.equal(seen.url, "https://chat.deepseek.com/")
  await client.close()
})

test("V16.3 settle adapter startSession hydrates UNKNOWN then READY", async () => {
  const { createDeepSeekWebAdapter, settlePostNavigateAuth } = await import("../lib/deepseek-web-adapter.mjs")
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
  let probes = 0
  const sleeps = []
  const adapter = createDeepSeekWebAdapter({
    capability,
    authProbe: async () => {
      probes += 1
      if (probes === 1) return UNKNOWN()
      return READY()
    },
    sleep: async (ms) => { sleeps.push(ms) },
    invoke: async (action) => {
      if (action === "navigate") return { ok: true, afterUrl: "https://chat.deepseek.com/" }
      return { ok: true }
    },
  })
  const session = await adapter.startSession({})
  assert.equal(session.state, "ready")
  assert.equal(session.navigationPassed, true)
  assert.equal(session.authState, "READY")
  assert.equal(probes, 2, "post-navigate hydration retries once then succeeds")
  assert.equal(sleeps.length, 1)

  // Direct settle unit: NEEDS_AUTH is terminal, UNKNOWN exhausts fail-closed.
  const wall = await settlePostNavigateAuth({
    deps: { authProbe: async () => NEEDS_WALL(), sleep: async () => {} },
    config: {},
  })
  assert.equal(wall.auth.state, "NEEDS_AUTH")
  assert.equal(wall.attempts, 1)
})
