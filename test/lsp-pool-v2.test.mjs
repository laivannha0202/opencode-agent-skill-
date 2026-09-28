import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  lspPoolStatus,
  resetLspPoolMetrics,
  shutdownLspPool,
  withManagedLspSession,
} from "../lib/code-intelligence/lsp-pool.mjs"

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-lsp-server.mjs")

async function targetFor(root, relative) {
  const file = path.join(root, relative)
  return { base: root, file, info: await stat(file) }
}

function provider(counterFile) {
  return {
    id: "typescript-mock",
    command: process.execPath,
    args: [fixture],
    languageId: "typescript",
    env: { UES_MOCK_LSP_COUNTER_FILE: counterFile },
  }
}

test("LSP V2 reuses one warm server and synchronizes edited documents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-pool-v2-"))
  const counterFile = path.join(root, "starts.log")
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(path.join(root, "demo.ts"), "export const firstValue = 1\n")
    const p = provider(counterFile)

    const first = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(first.ok, true)
    assert.equal(first.meta.poolHit, false)

    const second = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/hover", {
        textDocument: { uri: session.uri },
        position: { line: 0, character: 1 },
      }),
    )
    assert.equal(second.ok, true)
    assert.equal(second.meta.poolHit, true)

    const starts = (await readFile(counterFile, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert.equal(starts.length, 1)

    await writeFile(path.join(root, "demo.ts"), "export const secondValue = 2\n")
    const diagnostics = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => {
        const params = await session.waitForNotification("textDocument/publishDiagnostics", {
          predicate: (value) =>
            value?.uri === session.uri &&
            Number(value?.version || 0) >= Number(session.documentSync?.version || 0),
          afterAt: session.documentSync.changed ? session.documentSync.syncedAt : 0,
        })
        return params
      },
    )
    assert.equal(diagnostics.ok, true)
    assert.equal(diagnostics.meta.poolHit, true)
    assert.equal(diagnostics.result.version, 2)
    assert.match(diagnostics.result.diagnostics[0].message, /mock-version-2/)

    const status = lspPoolStatus()
    assert.equal(status.active, 1)
    assert.equal(status.metrics.coldStarts, 1)
    assert.ok(status.metrics.warmHits >= 2)
    assert.equal(status.sessions[0].documents, 1)
    assert.ok(status.sessions[0].requestCount >= 3)
  } finally {
    const stopped = await shutdownLspPool(root)
    assert.equal(stopped.remaining, 0)
    await rm(root, { recursive: true, force: true })
  }
})

test("LSP V2 isolates workspaces instead of sharing one global server", async () => {
  const left = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-left-"))
  const right = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-right-"))
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(left, "demo.ts"), "export const leftValue = 1\n")
    await writeFile(path.join(right, "demo.ts"), "export const rightValue = 1\n")
    const leftCounter = path.join(left, "starts.log")
    const rightCounter = path.join(right, "starts.log")

    for (const [root, counter] of [[left, leftCounter], [right, rightCounter]]) {
      const result = await withManagedLspSession(
        await targetFor(root, "demo.ts"),
        provider(counter),
        { maxServers: 4, maxPerWorkspace: 2, timeoutMs: 2000, startupTimeoutMs: 3000 },
        async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
      )
      assert.equal(result.ok, true)
    }

    const status = lspPoolStatus()
    assert.equal(status.active, 2)
    assert.equal(new Set(status.sessions.map((item) => item.workspace)).size, 2)
  } finally {
    await shutdownLspPool()
    await rm(left, { recursive: true, force: true })
    await rm(right, { recursive: true, force: true })
  }
})


test("LSP V2 invalidates warm reuse when workspace configuration changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-config-v2-"))
  const counterFile = path.join(root, "starts.log")
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version: 1 }))
    await writeFile(path.join(root, "demo.ts"), "export const value = 1\n")
    const p = provider(counterFile)
    const run = async () => withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 2, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )

    const first = await run()
    assert.equal(first.ok, true)
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version: 2 }))
    const second = await run()
    assert.equal(second.ok, true)
    assert.equal(second.meta.poolHit, false)

    const starts = (await readFile(counterFile, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert.equal(starts.length, 2)
    assert.ok(lspPoolStatus().metrics.evictions >= 1)
  } finally {
    await shutdownLspPool(root)
    await rm(root, { recursive: true, force: true })
  }
})

test("LSP V2 performs at most one bounded restart for a transient startup failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-restart-v2-"))
  const counterFile = path.join(root, "starts.log")
  const failOnceFile = path.join(root, "failed-once.flag")
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "demo.ts"), "export const restartValue = 1\n")
    const p = {
      ...provider(counterFile),
      env: {
        UES_MOCK_LSP_COUNTER_FILE: counterFile,
        UES_MOCK_LSP_FAIL_ONCE_FILE: failOnceFile,
      },
    }
    const result = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 2, maxPerWorkspace: 1, maxRestarts: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(result.ok, true)
    const starts = (await readFile(counterFile, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert.equal(starts.length, 2)
    assert.equal(lspPoolStatus().metrics.restarts, 1)
  } finally {
    await shutdownLspPool(root)
    await rm(root, { recursive: true, force: true })
  }
})


test("LSP V2 applies global LRU eviction instead of growing without bound", async () => {
  const left = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-lru-left-"))
  const right = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-lru-right-"))
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(left, "demo.ts"), "export const leftValue = 1\n")
    await writeFile(path.join(right, "demo.ts"), "export const rightValue = 1\n")

    const leftRun = await withManagedLspSession(
      await targetFor(left, "demo.ts"),
      provider(path.join(left, "starts.log")),
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(leftRun.ok, true)

    const rightRun = await withManagedLspSession(
      await targetFor(right, "demo.ts"),
      provider(path.join(right, "starts.log")),
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(rightRun.ok, true)

    const status = lspPoolStatus({ maxServers: 1 })
    assert.equal(status.active, 1)
    assert.equal(status.sessions[0].workspace, right)
    assert.ok(status.metrics.evictions >= 1)
  } finally {
    await shutdownLspPool()
    await rm(left, { recursive: true, force: true })
    await rm(right, { recursive: true, force: true })
  }
})


test("LSP V2 keeps a healthy warm session after a non-transient operation rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-rejection-v2-"))
  const counterFile = path.join(root, "starts.log")
  try {
    resetLspPoolMetrics()
    await writeFile(path.join(root, "demo.ts"), "export const stableValue = 1\n")
    const p = provider(counterFile)

    const rejected = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async () => {
        throw new Error("semantic request rejection")
      },
    )
    assert.equal(rejected.ok, false)
    assert.equal(rejected.reason, "managed-lsp-request-rejected")

    const recovered = await withManagedLspSession(
      await targetFor(root, "demo.ts"),
      p,
      { maxServers: 1, maxPerWorkspace: 1, timeoutMs: 2000, startupTimeoutMs: 3000 },
      async (session) => session.request("textDocument/documentSymbol", { textDocument: { uri: session.uri } }),
    )
    assert.equal(recovered.ok, true)
    assert.equal(recovered.meta.poolHit, true)

    const starts = (await readFile(counterFile, "utf8")).trim().split(/\r?\n/).filter(Boolean)
    assert.equal(starts.length, 1)
  } finally {
    await shutdownLspPool(root)
    await rm(root, { recursive: true, force: true })
  }
})
