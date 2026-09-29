import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { clearTypeScriptTsserverFallbackCache, lspOperation, lspPersistencePolicy, lspProviderStatus, resolveTypeScriptTsserverFallback, LSP_OPERATIONS } from "../lib/code-intelligence/lsp-provider.mjs"
import { probeCodeIntelligence, searchCodeIntelligence } from "../lib/code-intelligence/index.mjs"

test("Code Intelligence V2 advertises deterministic LSP operations", () => {
  for (const operation of ["definition", "references", "symbols", "hover", "rename-preview", "incoming-calls", "outgoing-calls"]) {
    assert.equal(LSP_OPERATIONS.includes(operation), true)
  }
  const probe = probeCodeIntelligence("demo.ts")
  assert.equal(probe.lspOperations.includes("definition"), true)
  assert.equal(probe.lspOperations.includes("rename-preview"), true)
})

test("LSP V2 fails closed for unsupported files without requiring a language server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-lsp-v2-"))
  try {
    await writeFile(path.join(root, "notes.txt"), "hello\n")
    const result = await lspOperation(root, "notes.txt", "symbols")
    assert.equal(result.available, false)
    assert.equal(result.reason, "unsupported-extension")
    assert.equal(result.operation, "symbols")
    await assert.rejects(() => lspOperation(root, "../escape.txt", "symbols"), /escapes workspace root/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("LSP provider status reports V2 operation surface independently of local server availability", () => {
  const status = lspProviderStatus("sample.py")
  assert.equal(status.schemaVersion, 2)
  assert.equal(status.operations.includes("references"), true)
  assert.equal(status.operations.includes("incoming-calls"), true)
})

test("LSP provider status can expose the parent-lite persistence policy explicitly", () => {
  const status = lspProviderStatus("sample.ts", {
    persistent: true,
    policySource: "parent-lite",
    includeSessions: false,
  })
  assert.equal(status.persistentPool.enabled, true)
  assert.equal(status.persistentPool.policy.enabled, true)
  assert.equal(status.persistentPool.policy.source, "parent-lite")
  assert.equal(status.persistentPool.sessionsIncluded, false)
})


test("LSP persistence is scoped to long-lived Pi child runtimes by default", () => {
  const priorChild = process.env.UES_CHILD_PROCESS
  const priorPersistent = process.env.UES_LSP_PERSISTENT
  try {
    delete process.env.UES_CHILD_PROCESS
    delete process.env.UES_LSP_PERSISTENT
    assert.deepEqual(lspPersistencePolicy(), { enabled: false, source: "short-lived-default" })

    process.env.UES_CHILD_PROCESS = "1"
    assert.deepEqual(lspPersistencePolicy(), { enabled: true, source: "pi-child-runtime" })

    process.env.UES_LSP_PERSISTENT = "0"
    assert.deepEqual(lspPersistencePolicy(), { enabled: false, source: "env-disabled" })

    process.env.UES_LSP_PERSISTENT = "1"
    assert.deepEqual(lspPersistencePolicy(), { enabled: true, source: "env-enabled" })

    assert.deepEqual(lspPersistencePolicy({ persistent: false }), { enabled: false, source: "explicit-option" })
    assert.deepEqual(lspPersistencePolicy({ persistent: true }), { enabled: true, source: "explicit-option" })
  } finally {
    if (priorChild == null) delete process.env.UES_CHILD_PROCESS
    else process.env.UES_CHILD_PROCESS = priorChild
    if (priorPersistent == null) delete process.env.UES_LSP_PERSISTENT
    else process.env.UES_LSP_PERSISTENT = priorPersistent
  }
})


test("TypeScript LSP can derive a Windows global tsserver fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-global-tsserver-"))
  try {
    const binEntry = path.join(root, "node_modules", "typescript", "bin", "tsserver")
    const libEntry = path.join(root, "node_modules", "typescript", "lib", "tsserver.js")
    await mkdir(path.dirname(binEntry), { recursive: true })
    await mkdir(path.dirname(libEntry), { recursive: true })
    await writeFile(binEntry, "#!/usr/bin/env node\n")
    await writeFile(libEntry, "console.log('mock tsserver')\n")

    const resolved = resolveTypeScriptTsserverFallback({
      platform: "win32",
      execution: { entry: binEntry, argsPrefix: [binEntry] },
    })
    assert.equal(resolved, libEntry)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("TypeScript global fallback resolution caches the Windows PATH probe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-global-tsserver-cache-"))
  try {
    const binEntry = path.join(root, "node_modules", "typescript", "bin", "tsserver")
    const libEntry = path.join(root, "node_modules", "typescript", "lib", "tsserver.js")
    await mkdir(path.dirname(binEntry), { recursive: true })
    await mkdir(path.dirname(libEntry), { recursive: true })
    await writeFile(binEntry, "#!/usr/bin/env node\n")
    await writeFile(libEntry, "console.log('mock tsserver')\n")

    clearTypeScriptTsserverFallbackCache()
    let probes = 0
    const options = {
      platform: "win32",
      cacheTtlMs: 60_000,
      resolveCommand() {
        probes += 1
        return { entry: binEntry, argsPrefix: [binEntry] }
      },
    }
    assert.equal(resolveTypeScriptTsserverFallback(options), libEntry)
    assert.equal(resolveTypeScriptTsserverFallback(options), libEntry)
    assert.equal(probes, 1)

    clearTypeScriptTsserverFallbackCache()
    assert.equal(resolveTypeScriptTsserverFallback(options), libEntry)
    assert.equal(probes, 2)
  } finally {
    clearTypeScriptTsserverFallbackCache()
    await rm(root, { recursive: true, force: true })
  }
})


test("Parent code search reuses semantic runtime cache for an unchanged Git workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-code-search-cache-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "orders.ts"), "export const cachedSearchNeedle = 1\n")
    const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" })
    assert.equal(git(["init"]).status, 0)
    assert.equal(git(["add", "."]).status, 0)
    assert.equal(git(["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"]).status, 0)

    const options = {
      maxFiles: 100,
      persistent: true,
      policySource: "parent-lite",
    }
    const first = await searchCodeIntelligence(root, "cachedSearchNeedle", options)
    const second = await searchCodeIntelligence(root, "cachedSearchNeedle", options)
    assert.equal(first.semantic.results[0]?.path, "src/orders.ts")
    assert.equal(first.semantic.runtimeCacheHit, false)
    assert.equal(second.semantic.runtimeCacheHit, true)
    assert.equal(first.providers.lsp.persistentPool.enabled, true)
    assert.equal(first.providers.lsp.persistentPool.policy.source, "parent-lite")
    assert.equal(typeof first.structural.available, "boolean")
    assert.equal(first.structural.attempted, false)
    assert.equal(first.structural.reason, "not-requested")

    await writeFile(path.join(root, "src", "orders.ts"), "export const cachedSearchNeedle = 2\n")
    const changed = await searchCodeIntelligence(root, "cachedSearchNeedle", options)
    assert.equal(changed.semantic.runtimeCacheHit, false)
    assert.notEqual(changed.workspaceFingerprint, second.workspaceFingerprint)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("diagnostics surface semantic timeout reason without hiding transport success", async () => {
  const { readFile } = await import("node:fs/promises")
  const source = await readFile(new URL("../lib/code-intelligence/lsp-provider.mjs", import.meta.url), "utf8")
  assert.match(source, /transportReason:/)
  assert.match(source, /reason: complete \? result\?\.reason : diagnosticsReason/)
  assert.match(source, /diagnosticsTimeoutMs/)
})
