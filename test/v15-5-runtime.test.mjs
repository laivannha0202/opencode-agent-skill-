import assert from "node:assert/strict"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { buildTaskTelemetry } from "../lib/run-telemetry.mjs"
import { diagnosticsFallbackGracePolicy } from "../lib/code-intelligence/diagnostics-budget.mjs"
import { executeDiagnosticsOperation } from "../lib/code-intelligence/lsp-provider.mjs"
import { lspPoolStatus, resetLspPoolMetrics, shutdownLspPool, withManagedLspSession } from "../lib/code-intelligence/lsp-pool.mjs"
import { buildPolicySnapshot, childPolicyMayLoosen } from "../lib/policy-snapshot.mjs"
import { ISOLATED_WRITE_MAX_WIDTH, TOOL_CONCURRENCY_CLASS, resolveIsolatedWriteWidth, toolCallsConflict, toolConcurrencyContract } from "../lib/tool-concurrency.mjs"

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-lsp-server.mjs")

async function targetFor(root, relative) {
  const file = path.join(root, relative)
  return { base: root, file, info: await stat(file) }
}

function provider(counterFile, env = {}) {
  return {
    id: "typescript-mock",
    command: process.execPath,
    args: [fixture],
    languageId: "typescript",
    env: { UES_MOCK_LSP_COUNTER_FILE: counterFile, ...env },
  }
}

test("V15.5 telemetry accepts Pi compact token aliases without manufacturing missing values", () => {
  const row = buildTaskTelemetry({
    exitCode: 0,
    usage: { input: 120, output: 30, cacheRead: 40, cacheWrite: 5 },
    timing: { providerWaitMs: 11, modelGenerationMs: 22, toolQueueMs: 3, toolRoutingMs: 4, toolExecutionMs: 15, toolResultProcessingMs: 2 },
    diagnosticsTelemetry: { lspPrimaryAttempts: 1, lspPrimarySuccess: 1, lspPullAttempts: 0, lspFallbackAttempts: 0 },
  })
  assert.equal(row.metrics.inputTokens, 120)
  assert.equal(row.metrics.outputTokens, 30)
  assert.equal(row.metrics.cacheReadTokens, 40)
  assert.equal(row.metrics.cacheWriteTokens, 5)
  assert.equal(row.metrics.totalTokens, 150)
  assert.equal(row.metrics.providerWaitMs, 11)
  assert.equal(row.metrics.toolExecutionMs, 15)
  assert.equal(row.metrics.lspPrimaryAttempts, 1)
  const missing = buildTaskTelemetry({ exitCode: 0, usage: {} })
  assert.equal(missing.metrics.inputTokens, null)
  assert.equal(missing.metrics.outputTokens, null)
  assert.equal(missing.metrics.totalTokens, null)
  assert.equal(missing.metrics.providerWaitMs, null)
  assert.equal(missing.metrics.lspPrimaryAttempts, null)
})

test("V15.5 large TypeScript files start deterministic fallback earlier without skipping primary", () => {
  const small = diagnosticsFallbackGracePolicy({ bytes: 2_000, providerId: "typescript-language-server" })
  const large = diagnosticsFallbackGracePolicy({ bytes: 300 * 1024, providerId: "typescript-language-server" })
  const xl = diagnosticsFallbackGracePolicy({ bytes: 900 * 1024, providerId: "typescript-language-server" })
  assert.equal(small.recommendedMs, 1_500)
  assert.equal(large.recommendedMs, 500)
  assert.equal(xl.recommendedMs, 250)
  assert.equal(xl.primarySkipped, false)
  assert.equal(diagnosticsFallbackGracePolicy({ bytes: 900 * 1024, providerId: "gopls" }).recommendedMs, 1_500)
})

test("V15.5 pooled diagnostics retrigger an unchanged document when first push was lost", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v155-first-push-"))
  const counterFile = path.join(root, "starts.log")
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "demo.ts"), "export const value = 1\n")
    const p = provider(counterFile, { UES_MOCK_LSP_SKIP_FIRST_DIAGNOSTICS: "1" })
    const target = await targetFor(root, "demo.ts")
    const warm = await withManagedLspSession(
      target, p,
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 1_000, startupTimeoutMs: 3_000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(warm.ok, true)
    const diagnostics = await withManagedLspSession(
      target, p,
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 1_000, startupTimeoutMs: 3_000, operation: "diagnostics" },
      async (session) => session.waitForNotification("textDocument/publishDiagnostics", {
        predicate: (value) => value?.uri === session.uri && Number(value?.version || 0) >= Number(session.documentSync?.version || 0),
        afterAt: session.documentSync.syncedAt,
        timeoutMs: 1_000,
      }),
    )
    assert.equal(diagnostics.ok, true)
    assert.equal(diagnostics.meta.poolHit, true)
    assert.equal(diagnostics.result.version, 2)
    assert.equal(lspPoolStatus().metrics.diagnosticsRetriggers, 1)
  } finally {
    await shutdownLspPool(root)
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.5 LSP 3.17 pull diagnostics are used only when the server advertises support", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v155-pull-"))
  try {
    const session = {
      base: root,
      file: "demo.ts",
      uri: "file:///demo.ts",
      documentSync: { bytes: 80, lineCount: 2, version: 1, changed: true, syncedAt: Date.now() },
      meta: { coldSession: false, coldStartMs: 0, configFingerprint: "fixture", supportsDiagnosticPull: true },
      request: async (method) => {
        assert.equal(method, "textDocument/diagnostic")
        return {
          kind: "full",
          items: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, source: "pull-fixture", message: "pull diagnostic" }],
        }
      },
      waitForNotification: async () => {
        const error = new Error("push should not be required")
        error.code = "LSP_NOTIFICATION_TIMEOUT"
        throw error
      },
    }
    const result = await executeDiagnosticsOperation({
      session,
      provider: { id: "pull-fixture" },
      options: { diagnosticsTimeoutMs: 800, diagnosticsContinuationMs: 0 },
      maxResults: 10,
    })
    assert.equal(result.complete, true)
    assert.equal(result.source, "lsp-pull")
    assert.equal(result.pullUsed, true)
    assert.equal(result.diagnostics.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("V15.5 tool concurrency is explicit and unknown mutations fail serial", () => {
  assert.equal(toolConcurrencyContract("read").class, TOOL_CONCURRENCY_CLASS.READ_PARALLEL_SAFE)
  assert.equal(toolConcurrencyContract("edit", { path: "src/a.ts" }).class, TOOL_CONCURRENCY_CLASS.WRITE_SERIAL)
  assert.equal(toolConcurrencyContract("custom_mcp_mutation").class, TOOL_CONCURRENCY_CLASS.UNKNOWN_SERIAL)
  assert.equal(toolCallsConflict({ tool: "read" }, { tool: "grep" }), false)
  assert.equal(toolCallsConflict({ tool: "read" }, { tool: "edit", input: { path: "src/a.ts" } }), true)
})

// ---------------------------------------------------------------------------
// V16.15: the isolated-write lane. A sandbox/worktree write cannot be observed
// by the root, so two of them in DIFFERENT sandboxes over DISJOINT files may
// overlap - but the lane is trusted-only, bounded, and never overlaps the root.
// ---------------------------------------------------------------------------
test("V16.15 tool concurrency: a model-authored isolated flag never promotes a root write", () => {
  const forged = toolConcurrencyContract("edit", { path: "src/a.ts", isolated: true, sandboxId: "forged" })
  assert.equal(forged.class, TOOL_CONCURRENCY_CLASS.WRITE_SERIAL)
  assert.notEqual(forged.class, TOOL_CONCURRENCY_CLASS.ISOLATED_WRITE)
  assert.equal(forged.isolated, undefined)

  const trusted = toolConcurrencyContract("edit", { path: "src/a.ts" }, { sandboxId: "sandbox-a" })
  assert.equal(trusted.class, TOOL_CONCURRENCY_CLASS.ISOLATED_WRITE)
  assert.equal(trusted.isolated, true)
  assert.equal(trusted.sandboxId, "sandbox-a")
  // It is NOT `parallelSafe`: that flag means "safe to overlap anything", and an
  // isolated write may only overlap other isolated writes.
  assert.equal(trusted.parallelSafe, false)
  assert.equal(trusted.mutation, true)
})

test("V16.15 tool concurrency: two isolated writers overlap only across distinct sandboxes and disjoint files", () => {
  const write = (sandboxId, path) => ({ tool: "edit", input: { path }, options: { sandboxId } })

  // Different sandbox + disjoint file: the new legal overlap.
  assert.equal(toolCallsConflict(write("a", "lib/a.mjs"), write("b", "lib/b.mjs")), false)
  // Same sandbox: same worktree, a real conflict.
  assert.equal(toolCallsConflict(write("a", "lib/a.mjs"), write("a", "lib/b.mjs")), true)
  // Same file in different sandboxes: still two writers on one path.
  assert.equal(toolCallsConflict(write("a", "lib/a.mjs"), write("b", "lib/a.mjs")), true)
  // No declared resource: unknown, so it conflicts.
  assert.equal(toolCallsConflict({ tool: "edit", options: { sandboxId: "a" } }, write("b", "lib/b.mjs")), true)
})

test("V16.15 tool concurrency: an isolated writer never overlaps the root, a read, or an unknown tool", () => {
  const isolated = { tool: "edit", input: { path: "lib/a.mjs" }, options: { sandboxId: "a" } }
  assert.equal(toolCallsConflict(isolated, { tool: "edit", input: { path: "lib/b.mjs" } }), true)
  assert.equal(toolCallsConflict(isolated, { tool: "read", input: { path: "lib/b.mjs" } }), true)
  assert.equal(toolCallsConflict(isolated, { tool: "custom_mcp_mutation" }), true)
  assert.equal(toolCallsConflict(isolated, { tool: "bash", input: { command: "npm test" } }), true)
})

test("V16.15 tool concurrency: the isolated-write width is bounded and cannot be raised", () => {
  assert.equal(ISOLATED_WRITE_MAX_WIDTH, 3)
  assert.equal(resolveIsolatedWriteWidth(undefined), 2)
  assert.equal(resolveIsolatedWriteWidth(99), ISOLATED_WRITE_MAX_WIDTH)
  assert.equal(resolveIsolatedWriteWidth(1), 1)
  assert.equal(resolveIsolatedWriteWidth(0), 2)
  assert.equal(resolveIsolatedWriteWidth("nope"), 2)
})

test("V15.5 policy snapshots are deterministic and reject implicit child loosening", () => {
  const input = {
    agent: "ues-executor",
    workspaceRoot: process.cwd(),
    tools: ["read", "edit"],
    allowLocalEnvWrite: false,
    destructiveActions: false,
    workspaceContainment: true,
    verificationTimeoutSec: 300,
  }
  const left = buildPolicySnapshot(input)
  const right = buildPolicySnapshot({ ...input, tools: ["edit", "read"] })
  assert.equal(left.id, right.id)
  assert.match(left.id, /^policy:sha256:[0-9a-f]{64}$/)
  const child = buildPolicySnapshot({ ...input, allowLocalEnvWrite: true })
  const inheritance = childPolicyMayLoosen(left, child)
  assert.equal(inheritance.safe, false)
  assert.ok(inheritance.reasons.includes("local-env-write-loosened"))
})


test("V15.5 bidirectional JSON-RPC keeps server request ownership when IDs collide", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-v155-request-owner-"))
  const counterFile = path.join(root, "starts.log")
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "demo.ts"), "export const owner = 1\n")
    const p = provider(counterFile, { UES_MOCK_LSP_REGISTER_DIAGNOSTICS_ON_SYMBOL: "1" })
    const result = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 1_000, startupTimeoutMs: 3_000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.result?.[0]?.name, "mockSymbol")

    const status = lspPoolStatus()
    assert.equal(status.sessions[0].supportsDiagnosticPull, true)
    assert.equal(status.sessions[0].dynamicRegistrations, 1)
    assert.equal(status.metrics.dynamicRegistrations, 1)
  } finally {
    await shutdownLspPool(root)
    await rm(root, { recursive: true, force: true })
  }
})
