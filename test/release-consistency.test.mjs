import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from "node:fs"
import { checkReleaseConsistency } from "../scripts/check-release-consistency.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const currentVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version

function mkdirTemp() {
  return path.join(
    process.env.TEMP || "/tmp",
    "ues-consistency-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  )
}

function fillFixture(tmp) {
  mkdirSync(tmp, { recursive: true })
  cpSync(root, tmp, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src).replace(/\\/g, "/")
      const runtimeRoots = ["node_modules", ".git", ".ues-cache", ".ues-evals", ".ues-work"]
      if (runtimeRoots.some((name) => rel === name || rel.startsWith(name + "/"))) return false
      if (rel === "nul" || rel.endsWith(".tgz")) return false
      return true
    },
  })
}

test("checkReleaseConsistency() passes the current Pi-native release state", () => {
  const result = checkReleaseConsistency(root)
  assert.equal(result.pass, true, result.errors.join("\n"))
  assert.equal(result.version, currentVersion)
  assert.equal(result.skillCount, 48)
  assert.equal(result.commandCount, 11)
  assert.equal(result.subagentCount, 12)
  assert.equal(result.promptCount, 11)
})

test("checkReleaseConsistency() CLI exits 0 on current state", () => {
  const output = execSync(
    `node "${path.join(root, "scripts", "check-release-consistency.mjs")}"`,
    {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
      timeout: 30_000,
    },
  )
  assert.match(output, /Release consistency check PASS/)
})

test("release checker fails on package/package-lock version mismatch", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const pkgPath = path.join(tmp, "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.version = "99.99.99"
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((error) => error.includes("version")))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("release checker fails on README current version mismatch", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const readmePath = path.join(tmp, "README.md")
    const original = readFileSync(readmePath, "utf8")
    const readme = original.replace(
      /(Phiên bản package hiện tại:\*\*\s*<code>)[^<]+(<\/code>)/i,
      (_match, prefix, suffix) => prefix + "9.0.0" + suffix,
    )
    assert.notEqual(readme, original, "README version fixture mutation did not match current format")
    writeFileSync(readmePath, readme)
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((error) => error.includes("README.md")))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("release checker fails when the Pi extension manifest drifts", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const pkgPath = path.join(tmp, "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.pi.extensions = ["./pi/extensions/other.ts"]
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((error) => error.includes("Pi extension entry drift")))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("release checker protects the Pi-native task-policy canonical source", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const orchestratorPath = path.join(tmp, "lib", "orchestrator-policy.mjs")
    writeFileSync(
      orchestratorPath,
      'export { classifyEngineeringTask } from "../global-config/plugins/ues-router/policy-runtime.js"\n',
    )
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((error) => error.includes("must delegate to Pi-native")))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("release checker is independent of GitHub Actions workflow files", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    rmSync(path.join(tmp, ".github", "workflows"), { recursive: true, force: true })
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, true, result.errors.join("\n"))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("release checker ignores skill directories without SKILL.md", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    mkdirSync(path.join(tmp, "global-config", "skills", "not-a-skill"), { recursive: true })
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.skillCount, 48)
    assert.equal(result.pass, true, result.errors.join("\n"))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("release checker still derives legacy eval counts without making them Pi release gates", () => {
  const result = checkReleaseConsistency(root)
  assert.equal(result.staticScenarioCount, 43)
  assert.equal(result.routerCaseCount, 129)
})


test("release checker fails when CI drops packed install smoke", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const pkgPath = path.join(tmp, "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.scripts.ci = String(pkg.scripts.ci || "").replace(/\s*&&\s*npm run smoke:packed/, "")
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((error) => error.includes("ci must include smoke:packed")))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
