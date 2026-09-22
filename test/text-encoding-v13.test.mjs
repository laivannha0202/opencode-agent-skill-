import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readTextFile } from "../lib/cli-utils.mjs"
import { readProjectText } from "../global-config/plugins/ues-router/text-runtime.js"

test("UTF-16LE PowerShell-style redirected diff is decoded as text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-encoding-"))
  try {
    const file = path.join(dir, "dirty.diff")
    const body = "diff --git a/a.txt b/a.txt\r\n+hello\r\n"
    const encoded = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")])
    await writeFile(file, encoded)
    assert.equal(readTextFile(file), body)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("binary NUL-heavy input is rejected instead of silently corrupted", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-binary-"))
  try {
    const file = path.join(dir, "binary.dat")
    await writeFile(file, Buffer.from([0, 1, 0, 2, 0, 3, 255, 0, 4, 0, 5]))
    assert.throws(() => readTextFile(file), /binary/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test("router text_read decodes UTF-16 diff without creating a converted copy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-router-text-"))
  try {
    const file = path.join(dir, "dirty.diff")
    const body = "diff --git a/x b/x\r\n-old\r\n+new\r\n"
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]))
    const result = readProjectText(dir, "dirty.diff", { maxChars: 1000 })
    assert.equal(result.encoding, "utf16le")
    assert.equal(result.text, body)
    assert.equal(result.truncated, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
