import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { lspOperation, lspProviderStatus, LSP_OPERATIONS } from "../lib/code-intelligence/lsp-provider.mjs"
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
