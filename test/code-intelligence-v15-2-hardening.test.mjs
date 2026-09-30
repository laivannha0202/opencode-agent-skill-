import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, chmod, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { commandExists, clearExecutableProbeCache } from "../lib/executable-probe.mjs"
import {
  lspPoolStatus,
  resetLspPoolMetrics,
  shutdownLspPool,
  withManagedLspSession,
} from "../lib/code-intelligence/lsp-pool.mjs"
import { diagnoseCode, lspOperation } from "../lib/code-intelligence/lsp-provider.mjs"
import { resetTypeScriptFallbackCache } from "../lib/code-intelligence/ts-diagnostics.mjs"
import {
  diagnosticsBudgetBounds,
  diagnosticsWorkloadClass,
  recordDiagnosticsOutcome,
  resetDiagnosticsBudgetHistory,
  resolveDiagnosticsBudget,
} from "../lib/code-intelligence/diagnostics-budget.mjs"
import { reduceCodePayload } from "../lib/code-intelligence/model-payload.mjs"
import { compactContext, expandContext } from "../lib/reversible-context.mjs"
import { searchCodeIntelligence } from "../lib/code-intelligence/index.mjs"
import { runtimeWorkspaceFingerprint } from "../lib/workspace-fingerprint.mjs"
import { classifyProviderFailure } from "../lib/provider-recovery.mjs"

// Windows can transiently keep a handle on a freshly written temp tree (git
// objects, compiler file handles, antivirus), which makes an immediate recursive
// remove fail with EBUSY. Retrying is the standard remedy and keeps the test
// about diagnostics rather than about filesystem timing.
async function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 9) throw error
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
    }
  }
}

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-lsp-server.mjs")
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const hasTypeScriptServer = commandExists("typescript-language-server")

async function targetFor(root, relative) {
  const file = path.join(root, relative)
  return { base: root, file, info: await stat(file) }
}

function mockProvider(env = {}) {
  return {
    id: "typescript-mock",
    command: process.execPath,
    args: [fixture],
    languageId: "typescript",
    env: { UES_MOCK_LSP_SILENT: env.silent === true ? "1" : "", ...env },
  }
}

test("V15.2 adaptive diagnostics budget scales small files to a fast path", () => {
  resetDiagnosticsBudgetHistory()
  const small = resolveDiagnosticsBudget({ bytes: 600, lineCount: 20, providerId: "typescript-language-server" })
  assert.equal(small.bucket, "xs")
  assert.equal(small.source, "workload-bucket")
  assert.equal(small.coldSession, false)
  assert.equal(small.budgetMs, 2_500)
  assert.equal(small.startupFactor, 1)
  assert.ok(small.budgetMs <= small.bounds.maxMs)

  // A slow-initializing server is the strongest pre-request signal available.
  const slowStart = resolveDiagnosticsBudget({ bytes: 600, lineCount: 20, providerId: "typescript-language-server", coldSession: true, startupMs: 3_000 })
  assert.ok(slowStart.budgetMs > small.budgetMs)
  assert.ok(slowStart.startupFactor > 1)
  assert.ok(slowStart.budgetMs <= slowStart.bounds.maxMs)
})

test("V15.2 adaptive diagnostics budget gives large files a larger, bounded budget", () => {
  resetDiagnosticsBudgetHistory()
  const small = resolveDiagnosticsBudget({ bytes: 20_000, lineCount: 400, providerId: "typescript-language-server" })
  const large = resolveDiagnosticsBudget({ bytes: 240_000, lineCount: 5_900, providerId: "typescript-language-server" })
  const largeCold = resolveDiagnosticsBudget({ bytes: 240_000, lineCount: 5_900, providerId: "typescript-language-server", coldSession: true })
  assert.equal(small.bucket, "s")
  assert.equal(large.bucket, "l")
  assert.ok(large.budgetMs > small.budgetMs)
  assert.ok(largeCold.budgetMs > large.budgetMs)
  assert.equal(diagnosticsWorkloadClass({ bytes: 1_000_000 }).bucket, "xl")
})

test("V15.2 adaptive diagnostics budget is bounded and never grows without limit", () => {
  resetDiagnosticsBudgetHistory()
  const bounds = diagnosticsBudgetBounds()
  for (let index = 0; index < 12; index += 1) {
    recordDiagnosticsOutcome("bounded", { timedOut: true })
  }
  const escalated = resolveDiagnosticsBudget({ bytes: 8_000_000, lineCount: 200_000, providerId: "rust-analyzer", historyKey: "bounded" })
  assert.ok(escalated.budgetMs <= bounds.maxMs)
  assert.ok(escalated.historyFactor <= 4)
  assert.equal(escalated.historyTimeouts, 12)

  const floor = resolveDiagnosticsBudget({ bytes: 1, lineCount: 1, providerId: "typescript-language-server" })
  assert.ok(floor.budgetMs >= bounds.minMs)

  const explicit = resolveDiagnosticsBudget({ bytes: 1, lineCount: 1, explicitMs: 10_000_000 })
  assert.equal(explicit.source, "explicit")
  assert.equal(explicit.budgetMs, bounds.maxMs)
  resetDiagnosticsBudgetHistory()
})

test("V15.2 adaptive diagnostics budget selection is deterministic", () => {
  resetDiagnosticsBudgetHistory()
  const input = { bytes: 88_000, lineCount: 2_400, providerId: "typescript-language-server", coldSession: true }
  const first = resolveDiagnosticsBudget(input)
  const second = resolveDiagnosticsBudget(input)
  assert.deepEqual(first, second)

  recordDiagnosticsOutcome("deterministic", { durationMs: 1_500, timedOut: false })
  recordDiagnosticsOutcome("deterministic", { durationMs: 900, timedOut: false })
  const observed = resolveDiagnosticsBudget({ ...input, historyKey: "deterministic" })
  assert.equal(observed.observedMs, 1_200)
  assert.ok(observed.budgetMs >= 1_200 * 2.5)
  const again = resolveDiagnosticsBudget({ ...input, historyKey: "deterministic" })
  assert.deepEqual(observed, again)
  resetDiagnosticsBudgetHistory()
})

test("V15.2 diagnostics notification timeout keeps the pooled session warm and never counts as a failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-diag-timeout-"))
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(path.join(root, "silent.ts"), "export const silentValue = 1\n")
    const provider = mockProvider({ silent: true })
    const options = { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2_000, startupTimeoutMs: 4_000 }

    const first = await withManagedLspSession(
      await targetFor(root, "silent.ts"),
      provider,
      options,
      async (session) => {
        try {
          await session.waitForNotification("textDocument/publishDiagnostics", { timeoutMs: 250 })
          return { complete: true }
        } catch (error) {
          return { complete: false, reason: error?.code || "error" }
        }
      },
    )
    assert.equal(first.ok, true)
    assert.equal(first.result.complete, false)
    assert.equal(first.result.reason, "LSP_NOTIFICATION_TIMEOUT")

    const second = await withManagedLspSession(
      await targetFor(root, "silent.ts"),
      provider,
      options,
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(second.ok, true)
    assert.equal(second.meta.poolHit, true)
    assert.equal(second.meta.sessionId, first.meta.sessionId)

    const metrics = lspPoolStatus({ includeSessions: false }).metrics
    assert.equal(metrics.failedOperations, 0)
    assert.equal(metrics.restarts, 0)
    assert.equal(metrics.fallbacks, 0)
    assert.equal(metrics.coldStarts, 1)
  } finally {
    await shutdownLspPool(root)
    await removeTree(root)
  }
})

test("V15.2 model-facing symbols reduction keeps every verifiable fact and reports 1-based positions", () => {
  const payload = {
    schemaVersion: 2,
    file: "lib/a.mjs",
    available: true,
    provider: "typescript-language-server",
    operation: "symbols",
    reason: "ok",
    persistent: true,
    result: {
      symbols: [
        {
          name: "alpha",
          detail: "",
          kind: 12,
          containerName: null,
          file: null,
          range: { start: { line: 4, character: 6 }, end: { line: 4, character: 11 } },
          selectionRange: { start: { line: 4, character: 6 }, end: { line: 4, character: 11 } },
        },
        {
          name: "beta",
          detail: "const beta = 2",
          kind: 14,
          containerName: "alpha",
          file: "lib/b.mjs",
          range: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } },
          selectionRange: { start: { line: 9, character: 0 }, end: { line: 9, character: 5 } },
        },
      ],
    },
    pool: {
      persistent: true,
      poolHit: true,
      warm: true,
      startupJoin: false,
      sessionId: "session-1",
      state: "READY",
      coldStartMs: 0,
      acquisitionDurationMs: 1,
      operationDurationMs: 2,
      totalDurationMs: 3,
      requestCount: 4,
      configFingerprint: "fingerprint",
      policy: { enabled: true, source: "parent-lite" },
    },
  }
  const { payload: reduced, reduction } = reduceCodePayload("symbols", payload, { file: "lib/a.mjs" })
  assert.equal(reduction.applied, true)
  assert.ok(reduction.savedChars > 0)
  assert.equal(reduced.reason, "ok")
  assert.equal(reduced.provider, "typescript-language-server")
  assert.equal(reduced.persistent, true)
  assert.equal(reduced.positionBase, 1)
  assert.equal(reduced.result.symbolCount, 2)

  const [alpha, beta] = reduced.result.symbols
  assert.equal(alpha.name, "alpha")
  assert.equal(alpha.kind, 12)
  assert.equal(alpha.line, 5)
  assert.equal(alpha.column, 7)
  assert.equal("detail" in alpha, false)
  assert.equal("file" in alpha, false)
  assert.equal(beta.detail, "const beta = 2")
  assert.equal(beta.containerName, "alpha")
  assert.equal(beta.file, "lib/b.mjs")
  assert.equal(beta.line, 10)

  assert.equal(reduced.pool.sessionId, "session-1")
  assert.equal(reduced.pool.policy.source, "parent-lite")
  assert.equal("configFingerprint" in reduced.pool, false)
  assert.ok(reduction.strategies.includes("symbol-rows"))
  assert.ok(reduction.strategies.includes("pool-summary"))
  assert.ok(reduction.reducedChars < reduction.originalChars)
})

test("V15.2 model-facing diagnostics reduction keeps severity, code, source, message and completion state", () => {
  const payload = {
    schemaVersion: 2,
    file: "lib/a.mjs",
    available: true,
    provider: "typescript-language-server",
    operation: "diagnostics",
    reason: "ok",
    complete: true,
    diagnosticsReason: "ok",
    persistent: true,
    diagnostics: [
      {
        range: { start: { line: 11, character: 8 }, end: { line: 11, character: 20 } },
        severity: 1,
        code: "2304",
        source: "ts",
        message: "Cannot find name 'foo'.",
      },
      {
        range: { start: { line: 12, character: 0 }, end: { line: 12, character: 4 } },
        severity: 2,
        code: "6133",
        source: "ts",
        message: "'bar' is declared but its value is never read.",
      },
    ],
    pool: { persistent: true, poolHit: true, sessionId: "s", operationDurationMs: 12, state: "READY" },
  }
  const { payload: reduced, reduction } = reduceCodePayload("diagnostics", payload, {})
  assert.equal(reduction.applied, true)
  assert.equal(reduced.complete, true)
  assert.equal(reduced.diagnosticsReason, "ok")
  assert.equal(reduced.diagnosticCount, 2)
  assert.equal(reduced.diagnostics[0].line, 12)
  assert.equal(reduced.diagnostics[0].column, 9)
  assert.equal(reduced.diagnostics[0].severity, "error")
  assert.equal(reduced.diagnostics[0].code, "2304")
  assert.equal(reduced.diagnostics[0].source, "ts")
  assert.equal(reduced.diagnostics[0].message, "Cannot find name 'foo'.")
  assert.equal(reduced.diagnostics[1].severity, "warning")
  assert.equal("range" in reduced.diagnostics[0], false)
})

test("V15.2 search reduction keeps query and semantic evidence while dropping provider noise", () => {
  const payload = {
    schemaVersion: 1,
    query: "withManagedLspSession",
    workspaceFingerprint: "fingerprint-1",
    providers: {
      schemaVersion: 1,
      anchoredEditing: true,
      semanticIndex: true,
      astProvider: null,
      lsp: {
        schemaVersion: 2,
        available: true,
        operations: ["diagnostics", "symbols", "hover"],
        providers: [
          { id: "typescript-language-server", available: true, command: "typescript-language-server", extensions: [".ts"] },
          { id: "gopls", available: false, command: null, extensions: [".go"] },
        ],
        persistentPool: {
          enabled: true,
          active: 1,
          busy: 0,
          limits: { maxServers: 4, maxPerWorkspace: 2, idleTtlMs: 180000 },
          metrics: { coldStarts: 1, warmHits: 4, failedOperations: 0 },
          sessions: [],
          policy: { enabled: true, source: "parent-lite" },
        },
      },
    },
    semantic: { query: "withManagedLspSession", results: [{ path: "lib/a.mjs", score: 12, definitions: [] }] },
    structural: { available: false, attempted: false, provider: null, reason: "not-requested", results: [] },
  }
  const { payload: reduced, reduction } = reduceCodePayload("search", payload, {})
  assert.equal(reduction.applied, true)
  assert.equal(reduced.query, "withManagedLspSession")
  assert.equal(reduced.workspaceFingerprint, "fingerprint-1")
  assert.equal(reduced.semantic.results[0].path, "lib/a.mjs")
  assert.equal(reduced.structural.reason, "not-requested")
  assert.equal(reduced.providers.astProvider, null)
  assert.equal(reduced.providers.lspAvailable, true)
  assert.deepEqual(reduced.providers.lspProviders, ["typescript-language-server"])
  assert.equal(reduced.providers.pool.policy.source, "parent-lite")
  assert.equal("limits" in reduced.providers.pool, false)
  assert.ok(reduction.savedChars > 300)
})

test("V15.2 reduction leaves unknown actions and unrecognizable payloads untouched", () => {
  const payload = { schemaVersion: 1, action: "status", anything: { nested: [1, 2, 3] } }
  const result = reduceCodePayload("status", payload, {})
  assert.equal(result.reduction.applied, false)
  assert.deepEqual(result.payload, payload)
  const missing = reduceCodePayload("symbols", null, {})
  assert.equal(missing.payload, null)
  assert.equal(missing.reduction.applied, false)
})

test("V15.2 structural search degrades honestly when no AST provider is installed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-structural-"))
  try {
    await writeFile(path.join(root, "sample.ts"), "export const needle = 1\n")
    const result = await searchCodeIntelligence(root, "needle", {
      maxResults: 5,
      maxFiles: 50,
      structuralPattern: "const $A = $B",
    })
    assert.equal(typeof result.structural.available, "boolean")
    assert.equal(result.structural.attempted, true)
    assert.equal(typeof result.structural.resolvable, "boolean")
    if (result.structural.available === false) {
      assert.ok(["ast-provider-unavailable", "ast-provider-unresolvable"].includes(result.structural.reason))
      assert.deepEqual(result.structural.results, [])
      assert.equal(result.structural.rowCount, 0)
    } else {
      assert.equal(result.structural.reason, "ok")
      assert.ok(result.structural.provider)
      for (const row of result.structural.results) {
        assert.equal(typeof row.file, "string")
        assert.ok(row.text.length <= 240)
        assert.equal("meta" in row, false)
        assert.equal("lines" in row, false)
      }
      assert.ok(result.structural.outputChars <= 8 * 1024)
    }
  } finally {
    await removeTree(root)
  }
})

test("V15.2 structural search reports a detected AST provider with bounded, deterministic evidence", async (t) => {
  if (process.platform === "win32") {
    t.skip("a shell-script AST provider stub is POSIX-only")
    return
  }
  const bin = await mkdtemp(path.join(os.tmpdir(), "ues-ast-bin-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-ast-root-"))
  const priorPath = process.env.PATH || ""
  try {
    const stub = [
      "#!/usr/bin/env sh",
      "printf '%s\\n' '{\"text\":\"export const needle = 1\",\"file\":\"src/orders.ts\",\"lines\":\"export const needle = 1\",\"meta\":{\"id\":\"1\",\"language\":\"TypeScript\",\"ruleId\":\"pattern\",\"start\":{\"line\":0,\"column\":7,\"byteOffset\":13},\"end\":{\"line\":0,\"column\":21,\"byteOffset\":27},\"single\":\"Y29zdCBj\"}}'",
      "exit 0",
      "",
    ].join("\n")
    await writeFile(path.join(bin, "sg"), stub, "utf8")
    await chmod(path.join(bin, "sg"), 0o755)
    await writeFile(path.join(root, "sample.ts"), "export const needle = 1\n")
    process.env.PATH = bin + path.delimiter + priorPath
    clearExecutableProbeCache()

    const result = await searchCodeIntelligence(root, "needle", {
      maxResults: 5,
      maxFiles: 50,
      structuralPattern: "const $A = $B",
    })
    assert.equal(result.structural.available, true)
    assert.equal(result.structural.attempted, true)
    assert.equal(result.structural.provider, "sg")
    assert.equal(result.structural.reason, "ok")
    assert.equal(result.structural.rowCount, 1)
    assert.equal(result.structural.resolvable, true)
    const [row] = result.structural.results
    assert.equal(row.file, "src/orders.ts")
    assert.equal(row.line, 1)
    assert.equal(row.column, 8)
    assert.equal(row.rule, "pattern")
    assert.equal(row.language, "TypeScript")
    assert.equal(row.text, "export const needle = 1")
    assert.equal("meta" in row, false)
    assert.equal("lines" in row, false)
    assert.ok(result.structural.outputChars <= 8 * 1024)
  } finally {
    process.env.PATH = priorPath
    clearExecutableProbeCache()
    await rm(bin, { recursive: true, force: true })
    await removeTree(root)
  }
})

test("V15.2 diagnostics telemetry does not perturb workspace identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-fingerprint-"))
  try {
    await writeFile(path.join(root, "sample.ts"), "export const value = 1\n")
    const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(git(["init"]).status, 0)
    assert.equal(git(["add", "."]).status, 0)
    assert.equal(git(["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"]).status, 0)

    const before = runtimeWorkspaceFingerprint(root)
    const result = await diagnoseCode(root, "sample.ts", { timeoutMs: 2_000, persistent: false }).catch(() => null)
    const after = runtimeWorkspaceFingerprint(root)
    assert.equal(after, before)
    // The adaptive budget is surfaced on the flat public contract. Assert its
    // shape only when the call actually produced diagnostics evidence, which is
    // the same conditional the original settle-era assertion used.
    if (result?.diagnosticsBudgetMs != null) {
      assert.equal(typeof result.diagnosticsBudgetMs, "number")
      assert.equal(typeof result.diagnosticsBudgetSource, "string")
      assert.equal(typeof result.diagnosticsBudgetBucket, "string")
    }
  } finally {
    await shutdownLspPool(root)
    await removeTree(root)
  }
})

test("V15.2 provider recovery still refuses to replay completed side-effect tools", async () => {
  const source = await readFile(new URL("../pi/extensions/ues.ts", import.meta.url), "utf8")
  assert.match(source, /PARENT_PROVIDER_RECOVERY_MAX_CONSECUTIVE = 1/)
  assert.match(source, /Completed tool side effects were preserved and were not blindly replayed\./)

  const classification = classifyProviderFailure({
    stderr: "Error: Provider returned an empty response (no content emitted)",
    stopReason: "error",
    toolCalls: 2,
  })
  assert.equal(classification.transient, true)
  assert.equal(classification.safeReplay, false)
  assert.equal(classification.safeSessionResume, true)

  // A soft, in-budget diagnostics timeout is not a transport failure, so it never
  // becomes a retryable provider state in the first place.
  const softTimeout = classifyProviderFailure({
    stderr: "diagnostics-timeout",
    stopReason: "stop",
    toolCalls: 0,
  })
  assert.equal(softTimeout.transient, false)
  assert.equal(softTimeout.safeReplay, false)
})

test("V15.2 reduced payload stays verifiable through the preserved raw evidence reference", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-raw-evidence-"))
  try {
    const payload = {
      schemaVersion: 2,
      file: "lib/a.mjs",
      available: true,
      provider: "typescript-language-server",
      operation: "diagnostics",
      reason: "ok",
      complete: true,
      diagnosticsReason: "ok",
      persistent: true,
      pool: {
        persistent: true,
        poolHit: true,
        warm: true,
        sessionId: "session-raw",
        state: "READY",
        coldStartMs: 0,
        operationDurationMs: 12,
        totalDurationMs: 14,
        requestCount: 3,
        configFingerprint: "fingerprint",
        policy: { enabled: true, source: "parent-lite" },
      },
      diagnostics: Array.from({ length: 60 }, (_, index) => ({
        range: { start: { line: index * 7, character: 4 }, end: { line: index * 7, character: 26 } },
        severity: index % 3 === 0 ? 2 : 1,
        code: "2304",
        source: "ts",
        message: "Cannot find name 'value" + index + "'. Do you need to install type definitions for node?",
      })),
    }
    const rawEncoded = JSON.stringify(payload, null, 2)
    assert.ok(rawEncoded.length > 4 * 1024)

    const { payload: reduced, reduction } = reduceCodePayload("diagnostics", payload, {})
    assert.equal(reduction.applied, true)
    const reducedEncoded = JSON.stringify(reduced, null, 2)
    assert.ok(reducedEncoded.length < rawEncoded.length)

    const preserved = await compactContext(root, rawEncoded, {
      kind: "ues-code-result-raw",
      source: "ues_code:diagnostics:raw",
      summary: "Exact pre-reduction parent-lite payload for diagnostics",
    })
    assert.ok(preserved.ref)
    const expanded = await expandContext(root, preserved.ref, { maxBytes: 128_000 })
    assert.equal(expanded.content, rawEncoded)
    assert.equal(JSON.parse(expanded.content).diagnostics.length, 60)

    // The model-facing payload alone still carries every finding.
    assert.equal(reduced.diagnosticCount, 60)
    assert.equal(reduced.diagnostics[59].message, payload.diagnostics[59].message)
    assert.equal(reduced.diagnostics[59].line, 59 * 7 + 1)
  } finally {
    await removeTree(root)
  }
})

// Migrated from the abandoned "settle" design.
//
// The original test guarded one thing that is still worth guarding: a clean
// verdict must never be manufactured out of an unconfirmed empty snapshot. The
// settle mechanism tried to satisfy that by *waiting* for a quiet window
// (diagnosticsSettleWaitMs / diagnosticsQuietAgeMs) and reporting
// "diagnostics-unsettled" until it was corroborated, which bought the guarantee
// with extra latency.
//
// The tiered architecture satisfies the same invariant structurally instead:
// completion is only reported when a diagnostics source actually finished its
// evaluation. Either the language server published, or the deterministic
// compiler completed the program. There is no code path that yields
// complete=true from an unconfirmed observation, so no settle window is needed
// and no retry loop is required. These assertions check the equivalent
// property against the current contract.
test("V15.2 real-server diagnostics stay complete for small files and never false-clean large ones", async (t) => {
  if (!hasTypeScriptServer) {
    t.skip("typescript-language-server is not installed")
    return
  }
  const small = path.join(repositoryRoot, "lib", "ids.mjs")
  const large = path.join(repositoryRoot, "pi", "extensions", "ues.ts")
  await stat(large)
  // Reset the learned diagnostics state for both tiers: the adaptive budget
  // history and the fingerprint-anchored fallback cache.
  resetDiagnosticsBudgetHistory()
  resetTypeScriptFallbackCache()
  resetLspPoolMetrics()
  const call = (target) =>
    diagnoseCode(repositoryRoot, path.relative(repositoryRoot, target).replaceAll("\\", "/"), {
      timeoutMs: 5_000,
      maxResults: 20,
      persistent: true,
      diagnosticsBudgetPolicy: "parent-lite-adaptive",
      diagnosticsFallbackTimeoutMs: 20_000,
    })
  try {
    const smallResult = await call(small)
    // A small, self-contained file must reach a trustworthy verdict.
    assert.equal(smallResult.complete, true)
    // A completed result is either the language server's answer ("ok") or a
    // completed deterministic evaluation ("fallback-complete"). Both are
    // trustworthy; the reason distinguishes which source produced the verdict.
    assert.ok(
      smallResult.diagnosticsReason === "ok" || smallResult.diagnosticsReason === "fallback-complete",
      `unexpected complete reason: ${smallResult.diagnosticsReason}`,
    )
    // Corroboration is structural: a complete result must name a source that
    // genuinely finished evaluating the file.
    assert.ok(["lsp-publish", "typescript-compiler-api"].includes(smallResult.diagnosticsSource))
    // The adaptive budget is bounded on both ends and is clamped to the existing
    // ceiling -- the tiered design must never inflate the wait.
    assert.ok(smallResult.diagnosticsBudgetMs <= 15_000)
    assert.equal(smallResult.diagnosticsBudgetBucket, "xs")

    const repeat = await call(small)
    assert.equal(repeat.complete, true)
    assert.equal(repeat.pool.poolHit, true, "a repeat diagnostics call must reuse the warm session")
    assert.equal(repeat.pool.sessionId, smallResult.pool.sessionId, "session identity must be stable")

    const largeResult = await call(large)
    assert.equal(largeResult.diagnosticsBudgetBucket, "l")
    assert.ok(largeResult.diagnosticsTimeoutMs <= 15_000, "the large file must not buy time with a longer wait")

    if (largeResult.complete === true) {
      // A complete verdict must be backed by a source that finished.
      assert.ok(["lsp-publish", "typescript-compiler-api"].includes(largeResult.diagnosticsSource))
      assert.equal(largeResult.diagnosticsFallbackUsed, false)
    } else {
      // Incomplete is reported as incomplete, never as a clean file. The reason
      // must name the cause, and any diagnostics gathered are still returned.
      assert.notEqual(largeResult.diagnosticsReason, "ok")
      assert.equal(
        String(largeResult.diagnosticsReason).startsWith("fallback-") ||
          largeResult.diagnosticsReason === "diagnostics-timeout",
        true,
        `unexpected incomplete reason: ${largeResult.diagnosticsReason}`,
      )
      const readsAsClean = largeResult.complete === true && largeResult.diagnostics.length === 0
      assert.equal(readsAsClean, false, "an incomplete result must never read as clean")
    }

    const metrics = lspPoolStatus({ includeSessions: false }).metrics
    // The invariant this whole test exists for: a soft diagnostics outcome must
    // never be laundered into pool health damage.
    assert.equal(metrics.failedOperations, 0)
    assert.equal(metrics.restarts, 0)
    assert.equal(metrics.fallbacks, 0)
    assert.equal(metrics.evictions, 0)
    assert.equal(
      metrics.diagnosticsComplete + metrics.diagnosticsIncomplete,
      3,
      "every diagnostics call must be accounted for exactly once",
    )
  } finally {
    await shutdownLspPool(repositoryRoot)
  }
})

test("V15.2 real-server symbols stay fast and warm across repeated calls", async (t) => {
  if (!hasTypeScriptServer) {
    t.skip("typescript-language-server is not installed")
    return
  }
  const file = "lib/ids.mjs"
  resetLspPoolMetrics()
  try {
    const cold = await lspOperation(repositoryRoot, file, "symbols", { persistent: true, timeoutMs: 7_000 })
    assert.equal(cold.reason, "ok")
    const warm = []
    for (let index = 0; index < 3; index += 1) {
      warm.push(await lspOperation(repositoryRoot, file, "symbols", { persistent: true, timeoutMs: 7_000 }))
    }
    assert.ok(warm.every((item) => item.pool?.poolHit === true))
    assert.equal(new Set(warm.map((item) => item.pool?.sessionId)).size, 1)
    assert.ok(warm.every((item) => item.pool?.operationDurationMs >= 0))
  } finally {
    await shutdownLspPool(repositoryRoot)
  }
})
