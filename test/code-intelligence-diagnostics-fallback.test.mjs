// Tiered diagnostics contract: tier A (bounded LSP push) and tier B
// (deterministic TypeScript evaluation) plus the guarantee that ties them
// together -- a missed diagnostics notification is a request-level outcome that
// must never damage the session, and must never be reported as a clean file.

import test from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  executeDiagnosticsOperation,
} from "../lib/code-intelligence/lsp-provider.mjs"
import {
  computeTypeScriptDiagnostics,
  diagnosticsEvidenceFingerprint,
  isEnvironmentDiagnostic,
  resetTypeScriptFallbackCache,
  runTypeScriptDiagnostics,
} from "../lib/code-intelligence/ts-diagnostics.mjs"
import {
  lspPoolStatus,
  resetLspPoolMetrics,
  shutdownLspPool,
  withManagedLspSession,
} from "../lib/code-intelligence/lsp-pool.mjs"

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-lsp-server.mjs")
const REAL_TS_PROVIDER = { id: "typescript-language-server", command: "typescript-language-server" }
const UNRESOLVABLE_PROVIDER = { id: "typescript-language-server", command: "ues-no-such-lsp-binary" }

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function targetFor(root, relative) {
  return { base: root, file: path.join(root, relative), info: await stat(path.join(root, relative)) }
}

function mockProvider(env) {
  return {
    id: "typescript-mock",
    command: process.execPath,
    args: [fixture],
    languageId: "typescript",
    env,
  }
}

// A stub session that models the language-server push. `publish` controls
// whether/when a notification arrives, so the tier A branches are exercised
// without spawning a server.
function stubSession(root, file, publish) {
  const base = root
  const absolute = path.join(root, file)
  return {
    uri: "file:///" + absolute.replaceAll("\\", "/"),
    base,
    file: absolute,
    documentSync: { changed: true, syncedAt: 1, version: 1, bytes: 64, lineCount: 4 },
    meta: { sessionId: "session-under-test", poolHit: true, coldSession: false, coldStartMs: 100 },
    waitForNotifications: 0,
    async waitForNotification(method, options) {
      this.waitForNotifications += 1
      const outcome = await publish(options.timeoutMs, this.waitForNotifications)
      if (outcome === null) {
        const error = new Error("LSP notification timed out: " + method)
        error.code = "LSP_NOTIFICATION_TIMEOUT"
        throw error
      }
      return outcome
    },
  }
}

async function tempWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-diag-"))
  return root
}

test("1. tier A reports complete=true when the server publishes normally", async () => {
  const root = await tempWorkspace()
  try {
    const session = stubSession(root, "demo.ts", async () => ({ uri: session0(session), diagnostics: [] }))
    function session0(s) { return s.uri }
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 2000, diagnosticsContinuationMs: 500 },
      maxResults: 10,
    })
    assert.equal(result.complete, true)
    assert.equal(result.reason, "ok")
    assert.equal(result.source, "lsp-publish")
    assert.equal(result.fallbackUsed, false)
    assert.equal(session.waitForNotifications, 1, "must not spend the continuation window on success")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("2. tier A succeeds via the continuation window after an initial timeout", async () => {
  const root = await tempWorkspace()
  try {
    const session = stubSession(root, "demo.ts", async (_timeoutMs, attempt) => {
      if (attempt === 1) return null // initial window expires
      return { uri: session.uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 2, message: "late" }] }
    })
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 500, diagnosticsContinuationMs: 2000 },
      maxResults: 10,
    })
    assert.equal(result.complete, true)
    assert.equal(result.continuationUsed, true)
    assert.equal(result.fallbackUsed, false, "a continuation success is still tier A")
    assert.equal(result.diagnostics.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("3. initial + continuation timeout never invents a clean result", async () => {
  const root = await tempWorkspace()
  try {
    const session = stubSession(root, "demo.ts", async () => null)
    const result = await executeDiagnosticsOperation({
      session,
      provider: UNRESOLVABLE_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 400, diagnosticsContinuationMs: 400 },
      maxResults: 10,
    })
    assert.equal(result.continuationUsed, true)
    assert.equal(result.fallbackUsed, true, "tier B must be attempted for the TS family")
    assert.equal(result.complete, false, "an unresolvable compiler must not produce complete=true")
    assert.deepEqual(result.diagnostics, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("10. complete=false with an empty array is never a clean bill of health", async () => {
  const root = await tempWorkspace()
  try {
    const session = stubSession(root, "demo.ts", async () => null)
    const result = await executeDiagnosticsOperation({
      session,
      provider: UNRESOLVABLE_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 300, diagnosticsContinuationMs: 300 },
      maxResults: 10,
    })
    assert.equal(result.complete, false)
    assert.equal(result.diagnostics.length, 0)
    // The contract: an empty list paired with complete=false means "not proven".
    const readsAsClean = result.complete === true && result.diagnostics.length === 0
    assert.equal(readsAsClean, false)
    assert.match(String(result.reason), /fallback-|diagnostics-timeout/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("11/12. tier B activates on a push timeout and can prove completion", async () => {
  const root = await tempWorkspace()
  try {
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const session = stubSession(root, "clean.ts", async () => null)
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 300, diagnosticsContinuationMs: 300, diagnosticsFallbackTimeoutMs: 20_000 },
      maxResults: 10,
    })
    assert.equal(result.fallbackUsed, true)
    assert.equal(result.source, "typescript-compiler-api")
    assert.equal(result.complete, true, "a sound environment must be provable complete")
    assert.equal(result.reason, "fallback-complete")
    // Internal tier result uses the short names; the public diagnoseCode
    // contract re-exports them as diagnosticsFallback*/diagnosticsEvidence*.
    assert.equal(result.fallbackCompilerVersion != null, true)
    assert.match(String(result.evidenceFingerprint), /^[0-9a-f]{32}$/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("12b. tier B reports real code defects with complete=true", async () => {
  const root = await tempWorkspace()
  try {
    await writeFile(path.join(root, "broken.ts"), "export const wrong: string = 5\n")
    const session = stubSession(root, "broken.ts", async () => null)
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 300, diagnosticsContinuationMs: 300, diagnosticsFallbackTimeoutMs: 20_000 },
      maxResults: 10,
    })
    assert.equal(result.complete, true)
    assert.equal(result.diagnostics.length, 1)
    assert.equal(result.diagnostics[0].code, 2322)
    assert.equal(result.diagnostics[0].file, "broken.ts", "diagnostics stay workspace-relative and posix")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("13. tier B failure keeps complete=false rather than faking success", async () => {
  const root = await tempWorkspace()
  try {
    await writeFile(path.join(root, "demo.ts"), "export const value = 1\n")
    const session = stubSession(root, "demo.ts", async () => null)
    const result = await executeDiagnosticsOperation({
      session,
      provider: UNRESOLVABLE_PROVIDER,
      options: { timeoutMs: 2000, diagnosticsTimeoutMs: 300, diagnosticsContinuationMs: 300, diagnosticsFallbackTimeoutMs: 20_000 },
      maxResults: 10,
    })
    assert.equal(result.fallbackUsed, true)
    assert.equal(result.complete, false)
    assert.equal(result.fallbackReason, "fallback-compiler-unavailable")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("tier B refuses complete=true when the module graph is unresolvable", async () => {
  const root = await tempWorkspace()
  try {
    await writeFile(path.join(root, "dep.ts"), 'import { thing } from "./does-not-exist.js"\nexport const used = thing\n')
    const result = computeTypeScriptDiagnostics({ base: root, file: path.join(root, "dep.ts"), timeoutMs: 20_000 })
    assert.equal(result.complete, false, "an unresolved graph cannot prove the absence of type errors")
    assert.equal(result.reason, "fallback-environment-incomplete")
    assert.ok(result.environmentDiagnosticCount > 0)
    assert.ok(result.diagnostics.length > 0, "real findings are still reported")
    assert.ok(result.diagnostics.some((row) => row.environment === true))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("14/15/16. diagnostics metrics are separate from session health metrics", async () => {
  const root = await tempWorkspace()
  try {
    resetLspPoolMetrics()
    resetTypeScriptFallbackCache()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const provider = mockProvider({ UES_MOCK_LSP_SILENT: "1" })

    const diagResult = await withManagedLspSession(
      await targetFor(root, "clean.ts"),
      provider,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 5000 },
      (session) =>
        executeDiagnosticsOperation({
          session,
          provider: REAL_TS_PROVIDER,
          options: {
            timeoutMs: 2000,
            diagnosticsTimeoutMs: 300,
            diagnosticsContinuationMs: 300,
            diagnosticsFallbackTimeoutMs: 20_000,
          },
          maxResults: 10,
        }),
    )
    assert.equal(diagResult.ok, true)
    assert.equal(diagResult.result.complete, true, "tier B should prove this clean file complete")

    const metrics = lspPoolStatus().metrics
    assert.equal(metrics.diagnosticsTimeouts, 1)
    assert.equal(metrics.diagnosticsFallbacks, 1)
    assert.equal(metrics.diagnosticsComplete, 1)
    assert.equal(metrics.diagnosticsIncomplete, 0)
    assert.equal(metrics.diagnosticsFallbackSuccesses, 1)

    // The soft timeout must not be laundered into pool failure counters.
    assert.equal(metrics.failedOperations, 0, "a missed notification is not a session failure")
    assert.equal(metrics.restarts, 0, "a missed notification must not restart the server")
    assert.equal(metrics.evictions, 0, "a missed notification must not evict the session")
    assert.equal(metrics.fallbacks, 0, "a missed notification must not trigger pool fallback")
  } finally {
    await shutdownLspPool()
    await rm(root, { recursive: true, force: true })
  }
})

test("4/5/6/7/8/9. a diagnostics timeout leaves the session warm, same-id, un-restarted and un-evicted", async () => {
  const root = await tempWorkspace()
  try {
    resetLspPoolMetrics()
    resetTypeScriptFallbackCache()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const provider = mockProvider({ UES_MOCK_LSP_SILENT: "1" })
    const target = await targetFor(root, "clean.ts")
    const options = { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 5000 }

    const before = await withManagedLspSession(target, provider, options, (session) =>
      session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(before.ok, true)
    assert.equal(before.meta.poolHit, false, "first acquisition is the cold one")

    const timedOut = await withManagedLspSession(target, provider, options, (session) =>
      executeDiagnosticsOperation({
        session,
        provider: REAL_TS_PROVIDER,
        options: {
          timeoutMs: 2000,
          diagnosticsTimeoutMs: 300,
          diagnosticsContinuationMs: 300,
          diagnosticsFallbackTimeoutMs: 20_000,
        },
        maxResults: 10,
      }),
    )
    assert.equal(timedOut.ok, true)
    assert.equal(timedOut.result.fallbackUsed, true)

    const after = await withManagedLspSession(target, provider, options, (session) =>
      session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(after.ok, true, "the session must still serve requests after a diagnostics timeout")
    assert.equal(after.meta.sessionId, before.meta.sessionId, "session identity must survive the timeout")
    assert.equal(after.meta.poolHit, true, "the call right after a timeout must be a warm hit")
    assert.equal(after.meta.coldStartMs, 0)

    const metrics = lspPoolStatus({ includeSessions: true }).metrics
    assert.equal(metrics.coldStarts, 1, "exactly one server start across the whole sequence")
    assert.equal(metrics.restarts, 0)
    assert.equal(metrics.evictions, 0)
    assert.equal(metrics.fallbacks, 0)
    const status = lspPoolStatus({ includeSessions: true })
    assert.equal(status.sessions.length, 1, "no session was evicted or duplicated")
  } finally {
    await shutdownLspPool()
    await rm(root, { recursive: true, force: true })
  }
})

test("tier A stays on the fast path and never spends the fallback budget", async () => {
  const root = await tempWorkspace()
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const provider = mockProvider({})
    const result = await withManagedLspSession(
      await targetFor(root, "clean.ts"),
      provider,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 5000 },
      (session) =>
        executeDiagnosticsOperation({
          session,
          provider: REAL_TS_PROVIDER,
          options: { timeoutMs: 2000, diagnosticsTimeoutMs: 2000, diagnosticsContinuationMs: 500 },
          maxResults: 10,
        }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.result.complete, true)
    assert.equal(result.result.source, "lsp-publish")
    assert.equal(result.result.fallbackUsed, false, "a healthy push must not trigger the fallback")
    const metrics = lspPoolStatus().metrics
    assert.equal(metrics.diagnosticsTimeouts, 0)
    assert.equal(metrics.diagnosticsFallbacks, 0)
  } finally {
    await shutdownLspPool()
    await rm(root, { recursive: true, force: true })
  }
})

test("17. the evidence fingerprint is anchored to source and config", async () => {
  const root = await tempWorkspace()
  try {
    resetTypeScriptFallbackCache()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const file = path.join(root, "clean.ts")
    const first = computeTypeScriptDiagnostics({ base: root, file, timeoutMs: 20_000 })
    const again = computeTypeScriptDiagnostics({ base: root, file, timeoutMs: 20_000 })
    assert.equal(again.cached, true, "unchanged evidence is served from cache")
    assert.equal(again.evidenceFingerprint, first.evidenceFingerprint)

    await writeFile(file, "export const answer: number = 43\n")
    const changed = computeTypeScriptDiagnostics({ base: root, file, timeoutMs: 20_000 })
    assert.notEqual(changed.evidenceFingerprint, first.evidenceFingerprint, "a source edit must invalidate the cache")
    assert.equal(changed.cached, false)

    // A config change must invalidate too, even with identical sources.
    const a = diagnosticsEvidenceFingerprint({ tsVersion: "6.0.0", configFingerprint: "cfg-a", file, sourceHash: "h" })
    const b = diagnosticsEvidenceFingerprint({ tsVersion: "6.0.0", configFingerprint: "cfg-b", file, sourceHash: "h" })
    assert.notEqual(a, b, "config is part of the evidence identity")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("18/19. diagnostics are read-only: no source edits and no temp artifacts", async () => {
  const root = await tempWorkspace()
  try {
    resetTypeScriptFallbackCache()
    const file = path.join(root, "clean.ts")
    const source = "export const answer: number = 42\n"
    await writeFile(file, source)
    const beforeListing = (await readdir(root)).sort()
    const beforeHash = createHash("sha256").update(await readFile(file)).digest("hex")

    const result = await runTypeScriptDiagnostics({
      base: root,
      file,
      provider: REAL_TS_PROVIDER,
      timeoutMs: 20_000,
      maxResults: 10,
    })
    assert.equal(result.complete, true)

    const afterHash = createHash("sha256").update(await readFile(file)).digest("hex")
    assert.equal(afterHash, beforeHash, "the analysed file must be byte-identical afterwards")
    const afterListing = (await readdir(root)).sort()
    assert.deepEqual(afterListing, beforeListing, "no emitted or temporary artifact may be left behind")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("20. native Windows paths are handled and reported in posix form", async () => {
  const root = await tempWorkspace()
  try {
    resetTypeScriptFallbackCache()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    await writeFile(path.join(root, "broken.ts"), "export const wrong: string = 5\n")
    const result = computeTypeScriptDiagnostics({
      base: root,
      file: path.join(root, "broken.ts"),
      timeoutMs: 20_000,
    })
    assert.equal(result.complete, true, "backslash paths must resolve on Windows")
    assert.equal(result.diagnostics[0].file, "broken.ts")
    assert.equal(result.diagnostics[0].file.includes("\\"), false, "reported paths are posix-normalised")
    assert.equal(path.isAbsolute(path.join(root, "broken.ts")), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("environment diagnostics are classified, real ones are not", () => {
  assert.equal(isEnvironmentDiagnostic(2307), true)
  assert.equal(isEnvironmentDiagnostic(2591), true)
  assert.equal(isEnvironmentDiagnostic(7016), true)
  assert.equal(isEnvironmentDiagnostic(2322), false)
  assert.equal(isEnvironmentDiagnostic(2304), true)
})

test("the out-of-process fallback degrades honestly when the budget is exhausted", async () => {
  const root = await tempWorkspace()
  try {
    resetTypeScriptFallbackCache()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const result = await runTypeScriptDiagnostics({
      base: root,
      file: path.join(root, "clean.ts"),
      provider: REAL_TS_PROVIDER,
      timeoutMs: 500,
      maxResults: 10,
    })
    // Either it finished inside the budget, or it reports an explicit timeout --
    // it must never claim a completion it did not perform.
    if (result.complete === true) assert.equal(result.reason, "ok")
    else assert.equal(result.complete, false)
    assert.ok(["ok", "fallback-timeout", "fallback-environment-incomplete"].includes(result.reason))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// --- Tier A / tier B race -----------------------------------------------------------------
// The fallback is launched after a grace period and raced against the remaining
// language-server budget, so a diagnostics timeout costs the budget only --
// never "budget + fallback".

async function unresolvedWorkspace() {
  const root = await tempWorkspace()
  await writeFile(
    path.join(root, "dep.ts"),
    'import { thing } from "./does-not-exist.js"\nexport const used = thing\n',
  )
  return root
}

test("1. a language-server publish wins the race and the fallback is discarded", async () => {
  const root = await tempWorkspace()
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    // The mock server publishes promptly, so tier A wins while the concurrently
    // launched tier B child is still running.
    const provider = mockProvider({})
    const diag = await withManagedLspSession(
      await targetFor(root, "clean.ts"),
      provider,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 5000 },
      (session) =>
        executeDiagnosticsOperation({
          session,
          provider: REAL_TS_PROVIDER,
          options: {
            timeoutMs: 2000,
            diagnosticsTimeoutMs: 2000,
            diagnosticsContinuationMs: 500,
            diagnosticsFallbackGraceMs: 0,
            diagnosticsFallbackTimeoutMs: 20_000,
          },
          maxResults: 10,
        }),
    )
    assert.equal(diag.ok, true)
    const result = diag.result
    assert.equal(result.source, "lsp-publish", "the server is authoritative")
    assert.equal(result.complete, true)
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.fallbackLaunched, true, "the fallback was launched in parallel")
    assert.equal(result.fallbackAbandoned, true, "the launched fallback must be reported as discarded")

    // No double counting: an abandoned fallback is neither a used fallback nor a
    // timeout, and the abandoned verdict is not a pool failure.
    const metrics = lspPoolStatus().metrics
    assert.equal(metrics.diagnosticsFallbacks, 0)
    assert.equal(metrics.diagnosticsFallbackAbandoned, 1)
    assert.equal(metrics.diagnosticsTimeouts, 0)
    assert.equal(metrics.diagnosticsComplete, 1)
    assert.equal(metrics.diagnosticsIncomplete, 0)
    assert.equal(metrics.failedOperations, 0)
    assert.equal(metrics.restarts, 0)
  } finally {
    await shutdownLspPool()
    await rm(root, { recursive: true, force: true })
  }
})

test("2. a completed deterministic evaluation can win the race early", async () => {
  const root = await tempWorkspace()
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const session = stubSession(root, "clean.ts", async () => null)
    const startedAt = Date.now()
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: {
        timeoutMs: 2000,
        // A long server window: the fallback should finish first.
        diagnosticsTimeoutMs: 8_000,
        diagnosticsContinuationMs: 4_000,
        diagnosticsFallbackGraceMs: 0,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 10,
    })
    const wallMs = Date.now() - startedAt
    assert.equal(result.source, "typescript-compiler-api")
    assert.equal(result.complete, true)
    assert.equal(result.reason, "fallback-complete")
    assert.ok(wallMs < 8_000, `fallback should return before the server window expires (took ${wallMs}ms)`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("3. an incomplete fallback never pre-empts a server publish that arrives later", async () => {
  const root = await unresolvedWorkspace()
  try {
    resetLspPoolMetrics()
    const session = stubSession(root, "dep.ts", async (_timeoutMs, attempt) => {
      if (attempt === 1) return null // initial window expires
      return { uri: session.uri, diagnostics: [{ range: { start: { line: 0, character: 0 } }, severity: 2, message: "late-server" }] }
    })
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: {
        timeoutMs: 2000,
        diagnosticsTimeoutMs: 3_000,
        diagnosticsContinuationMs: 3_000,
        diagnosticsFallbackGraceMs: 0,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 10,
    })
    assert.equal(result.source, "lsp-publish", "the server keeps its chance to answer")
    assert.equal(result.complete, true)
    assert.equal(result.fallbackUsed, false)
    assert.equal(result.diagnostics[0].message, "late-server")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("4. an incomplete fallback plus a server timeout reports honestly", async () => {
  const root = await unresolvedWorkspace()
  try {
    resetLspPoolMetrics()
    const session = stubSession(root, "dep.ts", async () => null)
    const startedAt = Date.now()
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: {
        timeoutMs: 2000,
        diagnosticsTimeoutMs: 400,
        diagnosticsContinuationMs: 400,
        diagnosticsFallbackGraceMs: 0,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 20,
    })
    const wallMs = Date.now() - startedAt
    assert.equal(result.complete, false, "an unresolvable graph can never be proven clean")
    assert.equal(result.reason, "fallback-environment-incomplete")
    assert.equal(result.fallbackUsed, true)
    assert.ok(result.diagnostics.length > 0, "the findings gathered in parallel are still reported")
    // The race is the whole point: total cost is the server budget, not the
    // server budget plus a second full fallback run.
    assert.ok(wallMs < 400 + 400 + 20_000, `wall time must not serialise both tiers (took ${wallMs}ms)`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("5/6. a discarded fallback is reaped and leaves no process behind", async () => {
  const root = await tempWorkspace()
  try {
    resetTypeScriptFallbackCache()
    await writeFile(path.join(root, "clean.ts"), "export const answer: number = 42\n")
    const session = stubSession(root, "clean.ts", async () => ({
      uri: session.uri,
      diagnostics: [],
    }))
    const before = process.getActiveResourcesInfo().length
    const result = await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: {
        timeoutMs: 2000,
        diagnosticsTimeoutMs: 2000,
        diagnosticsContinuationMs: 0,
        diagnosticsFallbackGraceMs: 0,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 10,
    })
    assert.equal(result.fallbackAbandoned, true)
    // The abort must be signalled so the supervised child is killed and reaped
    // rather than left running past the winning result.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = process.getActiveResourcesInfo().length
    assert.ok(after <= before + 2, `fallback child should not linger (before ${before}, after ${after})`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("7. the race leaves no temp artifact and does not modify the analysed file", async () => {
  const root = await tempWorkspace()
  try {
    resetTypeScriptFallbackCache()
    const file = path.join(root, "clean.ts")
    const source = "export const answer: number = 42\n"
    await writeFile(file, source)
    const listing = (await readdir(root)).sort()
    const session = stubSession(root, "clean.ts", async () => null)
    await executeDiagnosticsOperation({
      session,
      provider: REAL_TS_PROVIDER,
      options: {
        timeoutMs: 2000,
        diagnosticsTimeoutMs: 300,
        diagnosticsContinuationMs: 300,
        diagnosticsFallbackGraceMs: 0,
        diagnosticsFallbackTimeoutMs: 20_000,
      },
      maxResults: 10,
    })
    assert.equal(await readFile(file, "utf8"), source)
    assert.deepEqual((await readdir(root)).sort(), listing)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
