// V3 regression tests for the diagnostics race and adaptive history.
//
// Every race test here uses the DEFAULT (non-zero) fallback grace on purpose.
// The pre-fix implementation only ever raced the fallback when the grace was 0,
// because it snapshotted a `fallbackPromise` variable that was still `null` at the
// moment the first `Promise.race` was constructed. Every earlier test passed
// `diagnosticsFallbackGraceMs: 0` and therefore never exercised the default
// configuration at all -- which is why a fallback that finished complete in ~800ms
// could not win and the call still burned the whole initial + continuation budget
// (measured: 10259ms before the fix, 2131ms after).
//
// The assertions are tied to the budget arithmetic the runtime actually uses
// (grace clamp, initial window, continuation window) rather than to absolute
// machine timings, so they stay meaningful on slow and fast hosts alike.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { diagnoseCode, executeDiagnosticsOperation } from "../lib/code-intelligence/lsp-provider.mjs"
import {
  diagnosticsBudgetHistory,
  diagnosticsHistoryKey,
  recordDiagnosticsOutcome,
  resetDiagnosticsBudgetHistory,
  resolveDiagnosticsBudget,
} from "../lib/code-intelligence/diagnostics-budget.mjs"
import { resetTypeScriptFallbackCache } from "../lib/code-intelligence/ts-diagnostics.mjs"
import {
  lspPoolStatus,
  resetLspPoolMetrics,
  shutdownLspPool,
} from "../lib/code-intelligence/lsp-pool.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const mockServerFixture = path.join(here, "fixtures", "mock-lsp-server.mjs")

const TS_PROVIDER = { id: "typescript-language-server", command: "typescript-language-server" }
// gopls is not in the TypeScript family, so it has no fallback tier and therefore
// no grace at all.
const NON_TS_PROVIDER = { id: "gopls", command: "gopls" }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A stub session that mirrors the pooled adapter's shape: `file` is
// workspace-relative and posix, `meta.configFingerprint` is part of the identity.
function makeSession(root, file, meta = {}, workload = {}) {
  const absolute = path.join(root, file)
  let attempts = 0
  return {
    uri: "file:///" + absolute.replaceAll("\\", "/"),
    base: root,
    file,
    documentSync: {
      changed: true,
      syncedAt: 1,
      version: 1,
      bytes: workload.bytes ?? 64,
      lineCount: workload.lineCount ?? 4,
      ...workload,
    },
    meta: { poolHit: true, coldSession: false, coldStartMs: 100, ...meta },
    attempts: () => attempts,
    // A genuinely silent server: the wait really burns its whole window. A stub
    // that rejected instantly would hide the race entirely.
    async waitForNotification(method, options) {
      attempts += 1
      await sleep(Number(options.timeoutMs || 0))
      const error = new Error("LSP notification timed out: " + method)
      error.code = "LSP_NOTIFICATION_TIMEOUT"
      throw error
    },
  }
}

function publishingSession(root, file, delayMs, meta = {}, workload = {}) {
  const session = makeSession(root, file, meta, workload)
  return {
    ...session,
    async waitForNotification() {
      session.attempts()
      await sleep(delayMs)
      return { uri: session.uri, diagnostics: [] }
    },
  }
}

async function workspace(source = "export const answer: number = 42\n", file = "clean.ts") {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-race-v3-"))
  await writeFile(path.join(root, file), source)
  resetDiagnosticsBudgetHistory()
  resetTypeScriptFallbackCache()
  return root
}

// An unresolvable module graph: the fallback can report real findings but can
// never prove the file is clean.
async function unresolvedWorkspace() {
  return workspace(
    'import { thing } from "./does-not-exist.js"\nexport const used = thing\n',
    "dep.ts",
  )
}

async function cleanup(root) {
  await shutdownLspPool()
  await removeWorkspace(root)
}

// Windows releases a child's directory handle asynchronously after the process
// exits, so an immediate removal can transiently report EBUSY on a loaded host.
// The retry is bounded and short: it waits for the handle to be released, it does
// not paper over a child that is genuinely still running (the reap assertions in
// the race tests check the process counters explicitly).
async function removeWorkspace(root, attempts = 10) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(root, { recursive: true })
      return
    } catch (error) {
      if (attempt === attempts - 1) {
        await rm(root, { recursive: true, force: true }).catch(() => {})
        return
      }
      await sleep(200)
    }
  }
}

// --- 1. healthy LSP fast path ------------------------------------------------------

test("1. an LSP publish before the grace never spawns the fallback child", async () => {
  const root = await workspace()
  try {
    // The stub file is 64 bytes -> workload bucket "xs" -> adaptive budget 2500ms,
    // so the default 1500ms grace is clamped to floor(2500/2) = 1250ms.
    const session = publishingSession(root, "clean.ts", 50)
    const startedAt = Date.now()
    const result = await executeDiagnosticsOperation({
      session,
      provider: TS_PROVIDER,
      options: { timeoutMs: 2_000, diagnosticsTimeoutMs: 8_000, diagnosticsContinuationMs: 4_000 },
      maxResults: 10,
    })
    const wallMs = Date.now() - startedAt

    assert.equal(result.complete, true)
    assert.equal(result.source, "lsp-publish")
    assert.equal(result.fallbackLaunched, false, "no fallback child may be spawned on the healthy path")
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.fallbackAbandoned, false)
    assert.equal(result.fallbackGraceMs, 1_250, "the effective, clamped grace is reported")
    assert.ok(wallMs < 1_250, `the fast path must not wait for the grace (took ${wallMs}ms)`)
  } finally {
    await cleanup(root)
  }
})

// --- 2. silent LSP + complete fallback wins early ----------------------------------

test("2. a complete fallback wins the race early under the DEFAULT grace", async () => {
  const root = await workspace()
  try {
    const session = makeSession(root, "clean.ts", {}, { bytes: 200_000, lineCount: 5_000 })
    const startedAt = Date.now()
    // No diagnosticsFallbackGraceMs: this is the default path that never raced.
    const result = await executeDiagnosticsOperation({
      session,
      provider: TS_PROVIDER,
      options: {
        timeoutMs: 2_000,
        diagnosticsTimeoutMs: 8_000,
        diagnosticsContinuationMs: 4_000,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 10,
    })
    const wallMs = Date.now() - startedAt

    assert.equal(result.fallbackLaunched, true)
    assert.equal(result.fallbackUsed, true)
    assert.equal(result.complete, true)
    assert.equal(result.source, "typescript-compiler-api")
    assert.equal(result.reason, "fallback-complete")
    assert.equal(
      result.continuationUsed,
      false,
      "the fallback won while the first server window was still open",
    )

    // The whole point of the fix: the call must not run to the full
    // initial + continuation budget. Pre-fix this was ~10259ms.
    const fullBudget = result.initialTimeoutMs + result.continuationTimeoutMs
    assert.ok(fullBudget >= 8_000, `the tier A budget must be the large one (got ${fullBudget}ms)`)
    assert.ok(
      wallMs < fullBudget - 4_000,
      `must return far inside the budget, took ${wallMs}ms of ${fullBudget}ms`,
    )
    assert.ok(wallMs < result.initialTimeoutMs, `must return inside the initial window, took ${wallMs}ms`)
  } finally {
    await cleanup(root)
  }
})

// --- 3. incomplete fallback must not fake clean ------------------------------------

test("3. an incomplete fallback that settles early never returns clean", async () => {
  const root = await unresolvedWorkspace()
  try {
    const session = makeSession(root, "dep.ts")
    const startedAt = Date.now()
    const result = await executeDiagnosticsOperation({
      session,
      provider: TS_PROVIDER,
      options: {
        timeoutMs: 2_000,
        diagnosticsTimeoutMs: 500,
        diagnosticsContinuationMs: 2_000,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 20,
    })
    const wallMs = Date.now() - startedAt

    assert.equal(result.fallbackUsed, true)
    assert.equal(result.complete, false, "an unresolved graph can never be proven clean")
    assert.equal(result.reason, "fallback-environment-incomplete")
    assert.ok(result.diagnostics.length > 0, "the real findings gathered in parallel are still reported")

    // It settled early, yet the call kept waiting for the language server to its
    // bounded deadline instead of returning on the incomplete result.
    const serverDeadline = result.initialTimeoutMs + result.continuationTimeoutMs
    assert.ok(
      wallMs >= serverDeadline - 500,
      `an incomplete fallback must not short-circuit the server wait (returned after ${wallMs}ms, deadline ${serverDeadline}ms)`,
    )
  } finally {
    await cleanup(root)
  }
})

// --- 4. LSP wins while the fallback is still running -------------------------------

test("4. an LSP publish during a running fallback wins and reaps the child", async () => {
  const root = await workspace()
  try {
    resetLspPoolMetrics()
    const { stat } = await import("node:fs/promises")
    const target = { base: root, file: path.join(root, "clean.ts"), info: await stat(path.join(root, "clean.ts")) }
    const provider = {
      id: "typescript-mock",
      command: process.execPath,
      args: [mockServerFixture],
      languageId: "typescript",
      env: {},
    }

    const diag = await (await import("../lib/code-intelligence/lsp-pool.mjs")).withManagedLspSession(
      target,
      provider,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2_000, startupTimeoutMs: 5_000 },
      (session) =>
        executeDiagnosticsOperation({
          session,
          provider: TS_PROVIDER,
          options: {
            timeoutMs: 2_000,
            diagnosticsTimeoutMs: 2_000,
            diagnosticsContinuationMs: 500,
            // Launch the fallback up front so the server's publish lands while the
            // child is genuinely still running.
            diagnosticsFallbackGraceMs: 0,
            diagnosticsFallbackTimeoutMs: 20_000,
          },
          maxResults: 10,
        }),
    )

    assert.equal(diag.ok, true)
    const result = diag.result
    assert.equal(result.source, "lsp-publish", "the authoritative server answer wins")
    assert.equal(result.complete, true)
    assert.equal(result.fallbackLaunched, true)
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.fallbackAbandoned, true, "the launched fallback is reported as discarded")

    // Reaped before returning: once the pool is shut down the workspace must be
    // removable, which fails while a child still holds a handle to it.
    await shutdownLspPool()
    await removeWorkspace(root)

    const status = lspPoolStatus({ includeSessions: true })
    const metrics = status.metrics
    assert.equal(metrics.failedOperations, 0)
    assert.equal(metrics.restarts, 0)
    assert.equal(metrics.evictions, 0)
    assert.equal(metrics.diagnosticsFallbackAbandoned, 1)
    assert.equal(metrics.diagnosticsFallbacks, 0, "an abandoned fallback is not a used fallback")
  } finally {
    await shutdownLspPool()
    await rm(root, { recursive: true, force: true })
  }
})

// --- 5. continuation window keeps the fallback in the race -------------------------

test("5. a complete fallback still wins inside the continuation window", async () => {
  const root = await workspace()
  try {
    const session = makeSession(root, "clean.ts")
    const startedAt = Date.now()
    const result = await executeDiagnosticsOperation({
      session,
      provider: TS_PROVIDER,
      options: {
        timeoutMs: 2_000,
        // Initial window expires long before the fallback can finish, so the
        // result can only arrive while the continuation wait is open.
        diagnosticsTimeoutMs: 500,
        diagnosticsContinuationMs: 6_000,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 10,
    })
    const wallMs = Date.now() - startedAt

    assert.equal(result.source, "typescript-compiler-api")
    assert.equal(result.complete, true)
    assert.equal(result.continuationUsed, true, "the initial window did expire first")

    const fullBudget = result.initialTimeoutMs + result.continuationTimeoutMs
    assert.ok(
      wallMs < fullBudget - 2_000,
      `an in-flight fallback must keep racing during the continuation (took ${wallMs}ms of ${fullBudget}ms)`,
    )
  } finally {
    await cleanup(root)
  }
})

// --- 6/7. stable history identity --------------------------------------------------

test("6. diagnostics history survives session replacement", async () => {
  const root = await workspace()
  try {
    const keyFor = (sessionId, configFingerprint) =>
      diagnosticsHistoryKey({
        workspace: root,
        providerId: "typescript-language-server",
        configFingerprint,
        file: "clean.ts",
        coldSession: false,
      })

    // Identity must not carry any session-scoped component.
    assert.equal(keyFor("uuid-a", "cfg-1"), keyFor("uuid-b", "cfg-1"))

    // Two operations on two different session ids (what an idle-TTL eviction or a
    // bounded restart produces) must land on the same history entry. Both use a
    // healthy server push, so each contributes a real observed duration.
    for (const sessionId of ["uuid-a", "uuid-b"]) {
      const session = publishingSession(root, "clean.ts", 20, {
        sessionId,
        configFingerprint: "cfg-1",
      })
      const result = await executeDiagnosticsOperation({
        session,
        provider: TS_PROVIDER,
        options: { timeoutMs: 2_000, diagnosticsTimeoutMs: 8_000, diagnosticsContinuationMs: 500 },
        maxResults: 10,
      })
      assert.equal(result.source, "lsp-publish")
    }

    const history = diagnosticsBudgetHistory(keyFor("uuid-c", "cfg-1"))
    assert.equal(history.outcomes.length, 2, "both requests recorded against the shared identity")
    assert.equal(history.timeouts, 0)
    assert.ok(history.samples.length === 2, "each request contributed its actual observed duration")
    for (const sample of history.samples) {
      assert.ok(sample < 8_000, "the recorded duration is an observation, not a configured budget")
    }

    // The learned timing is now available to the budget, which is the whole point
    // of surviving a session replacement.
    const adaptive = resolveDiagnosticsBudget({
      bytes: 64,
      lineCount: 4,
      providerId: "typescript-language-server",
      historyKey: keyFor("uuid-d", "cfg-1"),
    })
    assert.ok(adaptive.observedMs != null, "the replaced session must still see learned timings")
    assert.ok(adaptive.historyKey === keyFor("uuid-d", "cfg-1"))
  } finally {
    await cleanup(root)
  }
})

test("7. a configuration change invalidates the learned history", async () => {
  const root = await workspace()
  try {
    const keyFor = (configFingerprint) =>
      diagnosticsHistoryKey({
        workspace: root,
        providerId: "typescript-language-server",
        configFingerprint,
        file: "clean.ts",
        coldSession: false,
      })

    const before = keyFor("cfg-before")
    const after = keyFor("cfg-after")
    assert.notEqual(before, after, "config is part of the diagnostics identity")

    recordDiagnosticsOutcome(before, { durationMs: 4_000, timedOut: false, complete: true, source: "lsp-publish" })
    assert.deepEqual(diagnosticsBudgetHistory(before).samples, [4_000])
    assert.deepEqual(diagnosticsBudgetHistory(after).samples, [], "stale timings must not cross a config change")

    // Distinct workspaces and distinct cold/warm classes must not be pooled.
    const base = { workspace: root, providerId: "typescript-language-server", configFingerprint: "cfg-before", file: "clean.ts" }
    assert.notEqual(diagnosticsHistoryKey(base), diagnosticsHistoryKey({ ...base, workspace: root + "-other" }))
    assert.notEqual(diagnosticsHistoryKey(base), diagnosticsHistoryKey({ ...base, coldSession: true }))
    assert.notEqual(diagnosticsHistoryKey(base), diagnosticsHistoryKey({ ...base, file: "other.ts" }))
  } finally {
    await cleanup(root)
  }
})

// --- 8. exactly one terminal outcome per request -----------------------------------

test("8. one request contributes exactly one history outcome", async () => {
  const key = "exactly-once-key"
  try {
    resetDiagnosticsBudgetHistory()
    // A single request id may only land once, however many exits the race takes.
    recordDiagnosticsOutcome(key, {
      requestId: "req-1",
      timedOut: true,
      complete: false,
      source: "lsp-publish",
    })
    recordDiagnosticsOutcome(key, {
      requestId: "req-1",
      durationMs: 5,
      timedOut: false,
      complete: true,
      source: "typescript-compiler-api",
    })
    const history = diagnosticsBudgetHistory(key)
    assert.equal(history.outcomes.length, 1)
    assert.equal(history.timeouts, 1)
    assert.equal(history.samples.length, 0, "a duplicate must not also add a timing sample")

    // The recorded outcome carries the terminal evidence, not a configured budget.
    assert.deepEqual(history.outcomes[0].timedOut, true)
    assert.deepEqual(history.outcomes[0].complete, false)
    assert.equal(history.outcomes[0].source, "lsp-publish", "the first terminal verdict is the one kept")
    assert.equal(history.outcomes[0].cold, false)
    assert.equal(history.outcomes[0].durationMs, null, "a timeout records no fabricated duration")
  } finally {
    resetDiagnosticsBudgetHistory()
  }
})

test("8b. an incomplete fallback that settles early is not recorded as the request's outcome", async () => {
  const root = await unresolvedWorkspace()
  try {
    const key = diagnosticsHistoryKey({
      workspace: root,
      providerId: "typescript-language-server",
      configFingerprint: "none",
      file: "dep.ts",
      coldSession: false,
    })
    await executeDiagnosticsOperation({
      session: makeSession(root, "dep.ts"),
      provider: TS_PROVIDER,
      options: {
        timeoutMs: 2_000,
        diagnosticsTimeoutMs: 500,
        diagnosticsContinuationMs: 2_000,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 20,
    })

    const history = diagnosticsBudgetHistory(key)
    assert.equal(history.outcomes.length, 1, "the mid-race incomplete settlement must not be a second outcome")
    assert.equal(history.samples.length, 0, "a request that exhausted tier A records a timeout, not a fake timing")
    assert.equal(history.timeouts, 1)
    assert.equal(history.outcomes[0].timedOut, true)
    assert.equal(history.outcomes[0].complete, false)
  } finally {
    await cleanup(root)
  }
})

// --- 9/10. effective grace telemetry -------------------------------------------------

test("9. the default path reports a non-null effective grace", async () => {
  const root = await workspace()
  try {
    const session = publishingSession(root, "clean.ts", 10)
    const result = await executeDiagnosticsOperation({
      session,
      provider: TS_PROVIDER,
      options: { timeoutMs: 2_000, diagnosticsTimeoutMs: 8_000, diagnosticsContinuationMs: 4_000 },
      maxResults: 10,
    })
    assert.ok(result.fallbackGraceMs != null, "a TypeScript-family eligible path has a real grace")
    assert.equal(result.fallbackGraceMs, 1_250)
  } finally {
    await cleanup(root)
  }
})

test("10. the reported grace is the clamped value, not the raw option", async () => {
  const root = await workspace()
  try {
    // Half of a 600ms initial window is 300ms, so a 9000ms request is clamped.
    const clamped = await executeDiagnosticsOperation({
      session: publishingSession(root, "clean.ts", 10),
      provider: TS_PROVIDER,
      options: {
        timeoutMs: 2_000,
        diagnosticsTimeoutMs: 600,
        diagnosticsContinuationMs: 500,
        diagnosticsFallbackGraceMs: 9_000,
      },
      maxResults: 10,
    })
    assert.equal(clamped.initialTimeoutMs, 600)
    assert.equal(clamped.fallbackGraceMs, 300, "the reported grace must be the effective clamped value")

    // A small explicit grace is honoured verbatim.
    const explicit = await executeDiagnosticsOperation({
      session: publishingSession(root, "clean.ts", 10),
      provider: TS_PROVIDER,
      options: {
        timeoutMs: 2_000,
        diagnosticsTimeoutMs: 8_000,
        diagnosticsContinuationMs: 500,
        diagnosticsFallbackGraceMs: 100,
      },
      maxResults: 10,
    })
    assert.equal(explicit.fallbackGraceMs, 100)

    // A provider with no fallback tier has no grace at all.
    const none = await executeDiagnosticsOperation({
      session: publishingSession(root, "clean.go", 10),
      provider: NON_TS_PROVIDER,
      options: { timeoutMs: 2_000, diagnosticsTimeoutMs: 8_000, diagnosticsContinuationMs: 500 },
      maxResults: 10,
    })
    assert.equal(none.fallbackGraceMs, null, "a non-TypeScript provider legitimately reports no grace")
  } finally {
    await cleanup(root)
  }
})

test("10b. diagnoseCode reports the effective grace from the operation result", async () => {
  const root = await workspace()
  try {
    const result = await diagnoseCode(root, "clean.ts", {
      timeoutMs: 2_000,
      persistent: false,
      diagnosticsContinuationMs: 500,
    }).catch(() => null)

    // End-to-end through the public surface, when a real TypeScript language server
    // is present on the host and actually answers. Under load the server can also
    // be unavailable or time out, in which case there is no tier result to
    // describe -- that is a legitimate environment outcome, not a telemetry defect,
    // and the strict effective-grace coverage lives in the tests above.
    if (result?.available === false) return
    if (result?.diagnosticsSource == null || result.diagnosticsSource === "none") return
    if (result?.diagnosticsInitialTimeoutMs == null) return

    // Whichever tier wins, a TypeScript-family provider is fallback eligible, so
    // the grace exists and telemetry must describe it.
    assert.ok(
      result.diagnosticsFallbackGraceMs != null,
      "telemetry must describe the grace the runtime actually used, not the raw option",
    )
    const reported = result.diagnosticsFallbackGraceMs
    const initial = result.diagnosticsInitialTimeoutMs
    assert.ok(Number.isFinite(initial) && initial > 0)
    assert.ok(reported <= Math.floor(initial / 2), "the reported value is the clamped, effective grace")
    assert.ok(Number.isFinite(reported) && reported >= 0)
  } finally {
    await cleanup(root)
  }
})

// --- ledger boundedness audit --------------------------------------------------------
//
// "Exactly one terminal outcome per request" is enforced by a request-id ledger, so
// the ledger must not be able to grow without bound in a long-lived Pi process. The
// retention bound is asserted BEHAVIOURALLY here rather than by exposing the internal
// size: a probe re-records a request id and observes whether the duplicate is ignored.
// A protected id leaves the counter untouched; a forgotten id is accepted again.

// Number of distinct request ids still remembered, pinned exactly below.
const LEDGER_LIMIT = 256

function insertRequests(key, count, prefix = "req") {
  for (let index = 0; index < count; index += 1) {
    recordDiagnosticsOutcome(key, { requestId: `${prefix}-${index}`, timedOut: true })
  }
}

// True when the id is still remembered, i.e. the duplicate record was ignored.
function isStillProtected(key, requestId) {
  const before = diagnosticsBudgetHistory(key).timeouts
  recordDiagnosticsOutcome(key, { requestId, timedOut: true })
  return diagnosticsBudgetHistory(key).timeouts === before
}

test("11. the request ledger retains exactly its limit and evicts oldest-first", async () => {
  const root = await workspace()
  try {
    // 256 distinct ids fit without evicting anything.
    resetDiagnosticsBudgetHistory()
    insertRequests("probe-256", 256, "a")
    assert.equal(isStillProtected("probe-256", "a-0"), true, "256 ids must all still be retained")

    // The 257th id evicts exactly the oldest one.
    resetDiagnosticsBudgetHistory()
    insertRequests("probe-257", 257, "b")
    assert.equal(isStillProtected("probe-257", "b-0"), false, "the oldest id is evicted once the limit is passed")
    assert.equal(isStillProtected("probe-257", "b-256"), true, "the newest id is retained")

    // Eviction is oldest-first, not arbitrary: after 257 inserts only the last 256
    // survive, so the boundary id from the previous batch is gone and the rest stand.
    resetDiagnosticsBudgetHistory()
    insertRequests("probe-order", 257, "c")
    for (const index of [1, 2, 128, 255, 256]) {
      assert.equal(isStillProtected("probe-order", `c-${index}`), true, `c-${index} must be retained`)
    }
    assert.equal(isStillProtected("probe-order", "c-0"), false, "c-0 is the single evicted entry")
  } finally {
    resetDiagnosticsBudgetHistory()
    await rm(root, { recursive: true, force: true })
  }
})

test("12. thousands of terminal requests keep the ledger bounded", async () => {
  const root = await workspace()
  try {
    resetDiagnosticsBudgetHistory()

    // A long-lived process serving far more requests than the ledger can hold.
    const total = 5_000
    insertRequests("bulk", total, "bulk")
    assert.equal(
      diagnosticsBudgetHistory("bulk").timeouts,
      total,
      "every distinct request must still be accounted for exactly once",
    )

    // Boundedness, observed rather than assumed: the oldest ids are gone and the
    // most recent window is still protected. A ledger that merely grew would
    // still remember the very first id.
    assert.equal(isStillProtected("bulk", "bulk-0"), false, "an id from 5000 requests ago must not be retained")
    assert.equal(isStillProtected("bulk", `bulk-${total - 1}`), true, "the newest id is still protected")

    // Still exactly-once for everything the ledger currently retains.
    const before = diagnosticsBudgetHistory("bulk")
    recordDiagnosticsOutcome("bulk", { requestId: `bulk-${total - 1}`, timedOut: true })
    recordDiagnosticsOutcome("bulk", { requestId: `bulk-${total - 2}`, durationMs: 5, timedOut: false })
    const after = diagnosticsBudgetHistory("bulk")
    assert.deepEqual(after.timeouts, before.timeouts, "duplicates of retained ids must not be counted")
    assert.deepEqual(after.samples, before.samples, "duplicates must not add a timing sample either")
    assert.equal(after.outcomes.length, before.outcomes.length)

    // The adaptive history is bounded as well: distinct identities cannot pile up
    // either, which is the same growth risk in the same module.
    resetDiagnosticsBudgetHistory()
    for (let index = 0; index < 1_000; index += 1) {
      recordDiagnosticsOutcome(`workspace-${index}`, { durationMs: 1_000, timedOut: false })
    }
    assert.equal(diagnosticsBudgetHistory("workspace-999").samples.length, 1, "the newest identity is retained")
    assert.deepEqual(diagnosticsBudgetHistory("workspace-0").samples, [], "the oldest identity was evicted")
  } finally {
    resetDiagnosticsBudgetHistory()
    await rm(root, { recursive: true, force: true })
  }
})

test("13. duplicate protection is insertion-bounded and never time-based", async () => {
  const root = await workspace()
  try {
    // Wall-clock time must not weaken the guarantee: a time-based expiry would let a
    // duplicate terminal record for the same request through. Protection here is a
    // pure function of how many ids were inserted afterwards, so it is unchanged by
    // elapsed time and by the number of requests already served.
    resetDiagnosticsBudgetHistory()
    insertRequests("timed", 10, "t")
    assert.equal(isStillProtected("timed", "t-0"), true)
    await sleep(150)
    assert.equal(isStillProtected("timed", "t-0"), true, "protection must not decay with elapsed time")

    // Static guard: the module must keep an explicit retention bound and must not
    // introduce time-based ledger cleanup later.
    const source = await readFile(
      new URL("../lib/code-intelligence/diagnostics-budget.mjs", import.meta.url),
      "utf8",
    )
    assert.match(source, /const RECORDED_REQUEST_LIMIT = 256\b/, "the ledger must keep an explicit retention bound")
    assert.match(source, /RECORDED_REQUESTS\.size >= RECORDED_REQUEST_LIMIT/, "the bound must gate every insertion")
    assert.match(source, /RECORDED_REQUESTS\.keys\(\)\.next\(\)\.value/, "eviction must take the oldest entry")
    assert.equal(
      /RECORDED_REQUESTS[^\n]*\b(setInterval|setTimeout|Date\.now)\b/.test(source),
      false,
      "the ledger must not expire entries by wall-clock time",
    )
    assert.match(source, /RECORDED_REQUESTS\.clear\(\)/, "reset must release the ledger too")

    // And the observable bound must match the declared constant.
    resetDiagnosticsBudgetHistory()
    insertRequests("matched", LEDGER_LIMIT, "m")
    assert.equal(isStillProtected("matched", "m-0"), true)
    insertRequests("matched", 1, "n")
    assert.equal(isStillProtected("matched", "m-0"), false, "one insert past the declared bound evicts the oldest")
  } finally {
    resetDiagnosticsBudgetHistory()
    await rm(root, { recursive: true, force: true })
  }
})

test("14. terminal evidence is unchanged by the ledger bound", async () => {
  const root = await workspace()
  try {
    resetDiagnosticsBudgetHistory()
    recordDiagnosticsOutcome("evidence", {
      requestId: "evidence-1",
      durationMs: 1_234,
      timedOut: false,
      complete: true,
      source: "lsp-publish",
      coldSession: true,
    })
    const history = diagnosticsBudgetHistory("evidence")
    assert.deepEqual(history.samples, [1_234], "the actual observed duration is still recorded verbatim")
    assert.deepEqual(history.timeouts, 0)
    assert.equal(history.outcomes.length, 1)
    assert.deepEqual(history.outcomes[0], {
      durationMs: 1_234,
      timedOut: false,
      complete: true,
      source: "lsp-publish",
      cold: true,
    })

    // A duplicate returns the same snapshot and changes nothing.
    const again = recordDiagnosticsOutcome("evidence", { requestId: "evidence-1", timedOut: true })
    assert.deepEqual(again.samples, [1_234])
    assert.deepEqual(again.outcomes, history.outcomes)
  } finally {
    resetDiagnosticsBudgetHistory()
    await rm(root, { recursive: true, force: true })
  }
})
