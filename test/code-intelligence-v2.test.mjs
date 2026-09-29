import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { lspOperation, lspPersistencePolicy, lspProviderStatus, resolveTypeScriptTsserverFallback, LSP_OPERATIONS } from "../lib/code-intelligence/lsp-provider.mjs"
import { probeCodeIntelligence } from "../lib/code-intelligence/index.mjs"

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
