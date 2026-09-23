import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "bin", "ocskill.mjs")

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
}

test("V14 capability-fabric status exposes selected deterministic providers", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-cli-v14-cap-"))
  try {
    const result = run(["capability-fabric", "status", "."], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.capabilities.memory.selected.id, "ues-memory")
    assert.equal(payload.capabilities["code.search"].selected.id, "ues-semantic-index")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V14 hierarchy CLI returns progressive context scopes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-cli-v14-hierarchy-"))
  try {
    await mkdir(path.join(dir, "src", "orders"), { recursive: true })
    await writeFile(path.join(dir, "src", "orders", "checkout.mjs"), "export function checkout(){ return true }\n")
    const result = run(["hierarchy", "checkout orders", "."], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.ok(payload.scopes.some((item) => item.path.includes("src/orders")))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("V14 memory CLI reports an empty persistent store without creating false memories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-cli-v14-memory-"))
  try {
    const result = run(["memory", "status", "."], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.entries, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
