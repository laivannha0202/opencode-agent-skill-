import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
  assert.equal(payload.error.code, "UES_USAGE")
  assert.equal(payload.exitCode, 2)
  assert.match(payload.error.message, /Unknown work action/)
})

test("invalid work slug is a recoverable structured usage error", () => {
  const result = run(["work", "status", "BAD_SLUG", "--json"])
  assert.equal(result.status, 2)
  const payload = JSON.parse(result.stderr)
  assert.equal(payload.error.code, "UES_USAGE")
  assert.equal(payload.error.recoverable, true)
  assert.match(payload.error.message, /BAD_SLUG/)
  assert.match(payload.error.hint, /recovery-2-foundation/)
})


test("text-read gives OpenCode v1 a bounded UTF-16-safe reader", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-text-read-"))
  try {
    const file = path.join(dir, "PLAN.json")
    const body = JSON.stringify({ schemaVersion: 1, goal: "safe text" }, null, 2)
    await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]))
    const result = run(["text-read", file, "--json"], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.truncated, false)
    assert.match(payload.text, /"goal": "safe text"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("work plan accepts PowerShell-style UTF-16LE JSON", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-utf-plan-"))
  try {
    const init = run(["work", "init", "utf-plan", ".", "--goal", "UTF plan recovery"], dir)
    assert.equal(init.status, 0, init.stderr)
    const planFile = path.join(dir, "PLAN-UTF16.json")
    const plan = JSON.stringify({
      schemaVersion: 1,
      goal: "UTF plan recovery",
      tasks: [{
        id: "T1",
        title: "Recover plan",
        summary: "Accept a UTF-16 plan file",
        dependsOn: [],
        files: { modify: ["src/a.js"] },
        acceptance: ["plan imports"],
        verification: ["node --version"],
        risk: "low",
      }],
    }, null, 2)
    await writeFile(planFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(plan, "utf16le")]))
    const imported = run(["work", "plan", "utf-plan", planFile, "."], dir)
    assert.equal(imported.status, 0, imported.stderr)
    const payload = JSON.parse(imported.stdout)
    assert.equal(payload.analysis.valid, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("work status can recover legacy UTF-16LE durable STATE.json", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-utf-state-"))
  try {
    const init = run(["work", "init", "utf-state", ".", "--goal", "UTF state recovery"], dir)
    assert.equal(init.status, 0, init.stderr)
    const stateFile = path.join(dir, ".ues-work", "utf-state", "STATE.json")
    const stateText = await readFile(stateFile, "utf8")
    await writeFile(stateFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(stateText, "utf16le")]))
    const status = run(["work", "status", "utf-state", "."], dir)
    assert.equal(status.status, 0, status.stderr)
    assert.equal(JSON.parse(status.stdout).slug, "utf-state")

    const discovered = run(["work", "status", "."], dir)
    assert.equal(discovered.status, 0, discovered.stderr)
    const discoveredPayload = JSON.parse(discovered.stdout)
    assert.equal(discoveredPayload.autoResolved, true)
    assert.equal(discoveredPayload.autoResolvedSlug, "utf-state")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("repo-graph compact mode keeps initial large-repo evidence bounded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-graph-"))
  try {
    const src = path.join(dir, "src")
    await mkdir(src, { recursive: true })
    await writeFile(path.join(src, "a.js"), "import './b.js'\nexport const a = 1\n", "utf8")
    await writeFile(path.join(src, "b.js"), "export const b = 2\n", "utf8")
    const result = run(["repo-graph", ".", "--compact"], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.nodeCount, 2)
    assert.equal(payload.edgeCount, 1)
    assert.equal("nodes" in payload, false)
    assert.equal("edges" in payload, false)
    assert.ok(Array.isArray(payload.hotspots))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("top-level ues-work is never treated as canonical durable state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ues-v13-noncanonical-"))
  try {
    const fake = path.join(dir, "ues-work", "fake-work")
    await mkdir(fake, { recursive: true })
    await writeFile(path.join(fake, "STATE.json"), JSON.stringify({ slug: "fake-work" }), "utf8")
    const result = run(["work", "status", "."], dir)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.workspaces, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
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
