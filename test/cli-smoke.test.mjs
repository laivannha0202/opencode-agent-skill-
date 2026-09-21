import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cli = path.join(root, "bin", "ocskill.mjs")
const packageVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version

function runCli(args, cwd = root) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" })
}

async function makeFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ocskill-cli-smoke-"))
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0" }))
  await writeFile(path.join(dir, "package-lock.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0", lockfileVersion: 3 }))
  return dir
}

test("cli version matches package.json", () => {
  const result = runCli(["version"])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), packageVersion)
})

test("cli help exits cleanly and lists commands", () => {
  const result = runCli(["help"])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Usage:/)
  assert.match(result.stdout, /ocskill work <action>/)
})

test("cli task-policy emits parseable JSON with a classified mode", () => {
  const result = runCli(["task-policy", "refactor the checkout flow across modules"])
  assert.equal(result.status, 0, result.stderr)
  const policy = JSON.parse(result.stdout)
  assert.ok(policy.mode)
})

test("cli inspect maps the fixture stack deterministically", async () => {
  const dir = await makeFixture()
  try {
    const result = runCli(["inspect", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.stack.root, dir)
    assert.equal(report.stack.packageManager, "npm")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli working-tree reports a non-git directory as such", async () => {
  const dir = await makeFixture()
  try {
    const result = runCli(["working-tree", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.git, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli impact requires a query and returns a scoped match report", async () => {
  const dir = await makeFixture()
  try {
    const result = runCli(["impact", "fixture-app", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.root, dir)
    assert.equal(report.query, "fixture-app")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli learn status reads the fixture via a refactored positional dir", async () => {
  const dir = await makeFixture()
  try {
    await mkdir(path.join(dir, ".ues-learning"), { recursive: true })
    await writeFile(path.join(dir, ".ues-learning", "LEARNINGS.json"), JSON.stringify({ updatedAt: "2026-01-02T00:00:00.000Z", proposals: [], accepted: [] }))
    const result = runCli(["learn", "status", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.updatedAt, "2026-01-02T00:00:00.000Z")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli unknown commands fail with exit code 1", () => {
  const result = runCli(["definitely-not-a-command"])
  assert.equal(result.status, 1)
})

test("cli index build writes and index status reads the semantic cache", async () => {
  const dir = await makeFixture()
  try {
    await mkdir(path.join(dir, "src"), { recursive: true })
    await writeFile(path.join(dir, "src", "alpha.js"), "export const smokeTokenAlpha = 1\n")
    await writeFile(path.join(dir, "src", "beta.js"), "export const smokeTokenBeta = 2\n")

    const built = runCli(["index", "build", dir])
    assert.equal(built.status, 0, built.stderr)
    const buildReport = JSON.parse(built.stdout)
    assert.equal(buildReport.action, "build")
    assert.equal(buildReport.stats.files, 2)

    const statusResult = runCli(["index", "status", dir])
    assert.equal(statusResult.status, 0, statusResult.stderr)
    const status = JSON.parse(statusResult.stdout)
    assert.equal(status.exists, true)
    assert.equal(status.cacheFile, ".ues-cache/semantic-index-v1.json")
    assert.equal(status.files, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli aci search emits schemaVersion/kind and clamps results via --limit", async () => {
  const dir = await makeFixture()
  try {
    await mkdir(path.join(dir, "src"), { recursive: true })
    await writeFile(path.join(dir, "src", "alpha.js"), "export const smokeTokenAlpha = 1\n")
    await writeFile(path.join(dir, "src", "beta.js"), "export const smokeTokenBeta = 2\n")

    const result = runCli(["aci", "search", "smokeToken", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.kind, "ues-semantic-query")
    assert.equal(report.results.length, 2)

    const bounded = runCli(["aci", "search", "smokeToken", dir, "--limit", "1"])
    assert.equal(bounded.status, 0, bounded.stderr)
    const boundedReport = JSON.parse(bounded.stdout)
    assert.ok(boundedReport.results.length <= 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli aci view renders a small fixture file as parseable JSON", async () => {
  const dir = await makeFixture()
  try {
    await mkdir(path.join(dir, "src"), { recursive: true })
    await writeFile(path.join(dir, "src", "alpha.js"), "export const smokeTokenAlpha = 1\n")

    const result = runCli(["aci", "view", "src/alpha.js", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.path, "src/alpha.js")
    assert.ok(report.totalLines >= 1)
    assert.match(report.text, /smokeTokenAlpha/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli task-graph validates a minimal plan file as valid with no errors", async () => {
  const dir = await makeFixture()
  try {
    const plan = {
      schemaVersion: 1,
      goal: "smoke task graph validation",
      tasks: [
        {
          id: "t1",
          title: "Smoke task one",
          summary: "a summary text",
          dependsOn: [],
          acceptance: ["observable criterion"],
          verification: ["node --test"],
          risk: "low",
          files: ["src/alpha.js"],
        },
      ],
    }
    await writeFile(path.join(dir, "PLAN.json"), JSON.stringify(plan, null, 2))
    const result = runCli(["task-graph", path.join(dir, "PLAN.json")])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.valid, true)
    assert.equal(report.errors.length, 0)
    assert.equal(report.taskCount, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli review-scope reports a non-git fixture as such", async () => {
  const dir = await makeFixture()
  try {
    const result = runCli(["review-scope"], dir)
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.git, false)
    assert.equal(report.root, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli verification-plan builds project-native recommendations for the fixture", async () => {
  const dir = await makeFixture()
  try {
    const result = runCli(["verification-plan", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.root, dir)
    assert.equal(report.workingTree.git, false)
    assert.equal(report.scope.git, false)
    assert.ok(Array.isArray(report.recommended))
    assert.ok(Array.isArray(report.acceptancePrompts))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli evidence aggregates stack, verification and git state", async () => {
  const dir = await makeFixture()
  try {
    const result = runCli(["evidence", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.root, dir)
    assert.ok(report.collectedAt)
    assert.equal(report.stack.packageManager, "npm")
    assert.equal(report.workingTree.git, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli work init round-trips --goal and creates the .ues-work state dir", async () => {
  const dir = await makeFixture()
  const slug = "smoke-goal-roundtrip"
  try {
    const goal = `smoke-goal-roundtrip-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const result = runCli(["work", "init", slug, dir, "--goal", goal])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.goal, goal)
    assert.equal(report.slug, slug)
    const workDir = path.join(dir, ".ues-work", slug)
    assert.ok(existsSync(workDir))
    const state = JSON.parse(readFileSync(path.join(workDir, "STATE.json"), "utf8"))
    assert.equal(state.slug, slug)
    assert.equal(state.goal, goal)
    assert.equal(state.status, "planning")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cli hermes status reports a boolean availability", () => {
  const result = runCli(["hermes", "status"])
  assert.equal(result.status, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(typeof report.available, "boolean")
})

test("cli sandbox list works on a git-initialized fixture without branches", async () => {
  const dir = await makeFixture()
  try {
    const init = spawnSync("git", ["init"], { cwd: dir, encoding: "utf8" })
    assert.equal(init.status, 0, init.stderr)
    const result = runCli(["sandbox", "list", dir])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.ok(Array.isArray(report))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})