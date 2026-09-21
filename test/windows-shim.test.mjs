import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveNodeShimEntry, resolveWindowsCommandCandidates } from "../lib/windows-shim.mjs"

test("Windows shim resolver accepts extensionless Node bin entries inside node_modules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-win-shim-"))
  try {
    const entry = path.join(root, "node_modules", "opencode-ai", "bin", "opencode")
    await mkdir(path.dirname(entry), { recursive: true })
    await writeFile(entry, "#!/usr/bin/env node\nconsole.log('1.18.31')\n")
    const shim = path.join(root, "opencode.cmd")
    await writeFile(
      shim,
      '@ECHO off\r\n"%~dp0%\\node.exe" "%~dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*\r\n',
    )

    assert.equal(resolveNodeShimEntry(shim), entry)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("Windows shim resolver rejects extensionless non-Node targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-win-shim-reject-"))
  try {
    const entry = path.join(root, "node_modules", "example", "bin", "tool")
    await mkdir(path.dirname(entry), { recursive: true })
    await writeFile(entry, "not a node script\n")
    const shim = path.join(root, "tool.cmd")
    await writeFile(
      shim,
      '@ECHO off\r\n"%~dp0%\\node.exe" "%~dp0%\\node_modules\\example\\bin\\tool" %*\r\n',
    )

    assert.equal(resolveNodeShimEntry(shim), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("Windows command resolution skips unsupported batch shims in favor of a native executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-win-command-"))
  try {
    const badShim = path.join(root, "opencode.cmd")
    const native = path.join(root, "opencode.exe")
    await writeFile(badShim, "@ECHO off\r\necho unsupported\r\n")
    await writeFile(native, "placeholder")

    const resolved = resolveWindowsCommandCandidates([badShim, native])
    assert.equal(resolved?.kind, "native")
    assert.equal(resolved?.executable, native)
    assert.deepEqual(resolved?.argsPrefix, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})


test("Windows shim resolver falls back to adjacent package.json bin metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-win-shim-metadata-"))
  try {
    const packageDir = path.join(root, "node_modules", "opencode-ai")
    const entry = path.join(packageDir, "bin", "opencode")
    await mkdir(path.dirname(entry), { recursive: true })
    await writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "opencode-ai",
        version: "1.18.31",
        bin: { opencode: "./bin/opencode" },
      }),
    )
    await writeFile(entry, "#!/usr/bin/env node\nconsole.log('1.18.31')\n")

    const shim = path.join(root, "opencode.cmd")
    await writeFile(shim, "@ECHO off\r\nREM intentionally non-standard shim text\r\n")

    assert.equal(resolveNodeShimEntry(shim), entry)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
