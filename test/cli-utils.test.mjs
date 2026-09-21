import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  clipOutput,
  errorMessage,
  optionInt,
  optionIntOrUndefined,
  optionValue,
  positionalArg,
  readJsonFile,
  readTextFile,
} from "../lib/cli-utils.mjs"

test("clipOutput passes short output through unchanged", () => {
  const text = "short"
  assert.equal(clipOutput(text), text)
})

test("clipOutput keeps both ends with a truncation marker", () => {
  const text = "a".repeat(10_000) + "TAIL"
  const clipped = clipOutput(text, { head: 8, tail: 4 })
  assert.equal(clipped, "aaaaaaaa" + "\n...[truncated]\n" + "TAIL")
})

test("clipOutput passes output up to the combined budget unchanged", () => {
  const text = "x".repeat(8000 + 8000)
  assert.equal(clipOutput(text).length, 8000 + 8000)
})

test("clipOutput coerces undefined to an empty string", () => {
  assert.equal(clipOutput(undefined), "")
})

test("positionalArg returns the value at the requested index", () => {
  assert.equal(positionalArg(["a", "b", "c"], 1), "b")
})

test("positionalArg returns null for a missing, empty, flag or separator value", () => {
  const args = ["", "--force", "flag", "--"]
  assert.equal(positionalArg(args, 5), null)
  assert.equal(positionalArg(args, 0), null)
  assert.equal(positionalArg(args, 1), null)
  assert.equal(positionalArg(args, 3), null)
  assert.equal(positionalArg(args, 2), "flag")
})

test("readJsonFile parses a JSON file and rejects a missing one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocskill-cli-utils-"))
  try {
    const file = path.join(dir, "data.json")
    await writeFile(file, '{"kind":"fixture","n":1}')
    assert.deepEqual(readJsonFile(file), { kind: "fixture", n: 1 })
    assert.throws(() => readJsonFile(path.join(dir, "missing.json")), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("optionInt falls back when the option is missing and parses explicit values", () => {
  assert.equal(optionInt([], "--limit", 200), 200)
  assert.equal(optionInt(["--limit", "5"], "--limit", 200), 5)
  assert.equal(optionInt(["--limit", "0"], "--limit", 200), 0)
})

test("optionIntOrUndefined matches the lease-style zero-or-missing semantics", () => {
  assert.equal(optionIntOrUndefined([], "--lease-ms"), undefined)
  assert.equal(optionIntOrUndefined(["--lease-ms", "0"], "--lease-ms"), undefined)
  assert.equal(optionIntOrUndefined(["--lease-ms", "5000"], "--lease-ms"), 5000)
})

test("errorMessage extracts Error message and passes other values through", () => {
  assert.equal(errorMessage(new Error("boom")), "boom")
  assert.equal(errorMessage("plain"), "plain")
  const realError = errorMessage(new Error("boom"))
  assert.ok(typeof realError === "string")
})

test("optionValue returns the next token for a present flag and null when missing", () => {
  const args = ["--limit", "5", "--line", "1"]
  assert.equal(optionValue(args, "--limit"), "5")
  assert.equal(optionValue(args, "--line"), "1")
  assert.equal(optionValue(args, "--missing"), null)
  assert.equal(optionValue([], "--missing"), null)
})

test("optionValue returns undefined when the flag is the last token", () => {
  const args = ["--limit", "5", "--flag"]
  assert.equal(optionValue(args, "--flag"), undefined)
})

test("readTextFile resolves the path and returns UTF-8 text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocskill-cli-utils-"))
  try {
    const file = path.join(dir, "data.txt")
    await writeFile(file, "héllo 世界\nnext", "utf8")
    const relative = path.relative(process.cwd(), file)
    assert.equal(readTextFile(file), "héllo 世界\nnext")
    assert.equal(readTextFile(relative), "héllo 世界\nnext")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("readTextFile propagates the error for a missing file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocskill-cli-utils-"))
  try {
    assert.throws(() => readTextFile(path.join(dir, "missing.txt")), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})