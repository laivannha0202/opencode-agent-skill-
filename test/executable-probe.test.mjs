import test from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { clearExecutableProbeCache, commandExists } from "../lib/executable-probe.mjs"

test("executable probe resolves PATH directly and invalidates cache when PATH changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-executable-probe-"))
  const oldPath = process.env.PATH
  const oldPathExt = process.env.PATHEXT
  try {
    const command = "ues-probe-tool"
    if (process.platform === "win32") {
      await writeFile(path.join(root, command + ".CMD"), "@echo off\r\nexit /b 0\r\n")
      process.env.PATHEXT = ".CMD"
    } else {
      const file = path.join(root, command)
      await writeFile(file, "#!/bin/sh\nexit 0\n")
      await chmod(file, 0o755)
    }

    process.env.PATH = root
    clearExecutableProbeCache()
    assert.equal(commandExists(command), true)

    process.env.PATH = ""
    assert.equal(commandExists(command), false)
    assert.equal(commandExists(process.execPath), true)
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPathExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = oldPathExt
    clearExecutableProbeCache()
    await rm(root, { recursive: true, force: true })
  }
})
