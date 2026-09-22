import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "bin", "ocskill.mjs")

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
}

test("V11 capabilities CLI detects visual browser needs", () => {
  const result = run(["capabilities", "Use Playwright to match this screenshot in the browser"])
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.required.vision, true)
  assert.equal(value.required.browser, true)
})

test("V11 store status works in an empty workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-store-cli-"))
  try {
    const result = run(["store", "status", dir])
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.entries, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V11 browser capability reports cli-first mode without requiring Playwright", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-browser-cli-"))
  try {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }))
    const result = run(["browser", "capability", dir])
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.modePreference, "cli-first")
    assert.equal(typeof value.playwright.available, "boolean")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V11 visual spec CLI validates a compact spec", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-visual-cli-"))
  try {
    const file = path.join(dir, "VISUAL_SPEC.json")
    await writeFile(file, JSON.stringify({
      viewport: { width: 390, height: 844 },
      elements: [{ id: "cta", x: 10, y: 20, width: 100, height: 44 }],
    }))
    const result = run(["visual", "spec", file])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).valid, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V11 skill lint sees the bundled expanded catalog", () => {
  const result = run(["skills", "lint", root])
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.valid, true)
  assert.ok(value.skillCount >= 48)
})
