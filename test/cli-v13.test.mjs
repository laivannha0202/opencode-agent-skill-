import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "bin", "ocskill.mjs")

function run(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
}

for (const commandArgs of [
  ["work", "init", "--help"],
  ["work", "status", "--help"],
  ["work", "gate-receipt", "--help"],
  ["sandbox", "create", "--help"],
]) {
  test("help parses before positional validation: " + commandArgs.join(" "), () => {
    const result = run(commandArgs)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage:/)
    assert.doesNotMatch(result.stderr, /work slug must use/)
  })
}

test("work status . lists workspaces instead of treating dot as a slug", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-status-"))
  try {
    const result = run(["work", "status", "."], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.workspaces, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("--json returns structured CLI errors", () => {
  const result = run(["work", "unknown-action", "demo", "--json"])
  assert.notEqual(result.status, 0)
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.ok, false)
  assert.equal(typeof payload.error.code, "string")
  assert.match(payload.error.message, /Unknown work action/)
})


test("work status dot auto-resolves the only active workspace", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-status-one-"))
  try {
    const init = run(["work", "init", "only-work", ".", "--goal", "test status resolution"], dir)
    assert.equal(init.status, 0, init.stderr)
    const result = run(["work", "status", "."], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.autoResolved, true)
    assert.equal(payload.autoResolvedSlug, "only-work")
    assert.equal(payload.slug, "only-work")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})


test("top-level unknown command is structured with --json and does not dump a Node stack", () => {
  const result = run(["definitely-not-a-command", "--json"])
  assert.equal(result.status, 2)
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.error.code, "UES_USAGE")
  assert.match(payload.error.message, /Unknown command/)
  assert.doesNotMatch(result.stderr, /at main|node:internal/)
})


test("global help parser does not consume child --help after command separator", () => {
  const result = run(["definitely-not-a-command", "--", "--help", "--json"])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Unknown command/)
  assert.doesNotMatch(result.stdout, /Usage:/)
})
