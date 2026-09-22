import test from "node:test"
import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from "node:fs"
import { checkReleaseConsistency } from "../scripts/check-release-consistency.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const currentVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version

function copyFixture(rootDir, targetDir, excludes) {
  function copyRecursive(src, dest) {
    const stat = existsSync(src) ? (src.endsWith("/") || !src.includes(".") ? null : null) : null
    const relPath = path.relative(rootDir, src)
    for (const exclude of excludes) {
      if (relPath === exclude || relPath.startsWith(exclude + "/") || relPath.startsWith(exclude + "\\")) {
        return
      }
    }
    if (existsSync(src) && readFileSync(src, "utf8").length >= 0) {
      // just check it exists
    }
  }
}

test("checkReleaseConsistency() returns pass for current release state", () => {
  const result = checkReleaseConsistency(root)
  assert.equal(result.pass, true)
  assert.equal(result.version, currentVersion)
  assert.equal(result.skillCount, 48)
  assert.equal(result.commandCount, 11)
  assert.equal(result.subagentCount, 12)
})

test("checkReleaseConsistency() CLI exits 0 on current state", () => {
  const output = execSync(
    `node "${path.join(root, "scripts", "check-release-consistency.mjs")}"`,
    {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env },
      timeout: 30000,
    },
  )
  assert.match(output, /Release consistency check PASS/)
})

test("checkReleaseConsistency() fails on package/package-lock version mismatch", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const pkgPath = path.join(tmp, "package.json")
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    pkg.version = "99.99.99"
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((e) => e.includes("version")), "should have version mismatch error. Got: " + result.errors.join(", "))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("checkReleaseConsistency() fails on README current version mismatch", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const readmePath = path.join(tmp, "README.md")
    let readme = readFileSync(readmePath, "utf8")
    readme = readme.replace(/(Phiên bản hiện tại:\s*\n```text\n)\S+/, (_match, prefix) => prefix + "9.0.0")
    writeFileSync(readmePath, readme)
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((e) => e.includes("README")), "should have README error. Got: " + result.errors.join(", "))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("checkReleaseConsistency() fails on V11 doc with development status", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const docPath = path.join(tmp, "docs", "V11-PERCEPTION-ADAPTIVE.md")
    let content = readFileSync(docPath, "utf8")
    content = content.replace("Status: stable", "Status: development")
    writeFileSync(docPath, content)
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((e) => e.toLowerCase().includes("development")), "should have development status error. Got: " + result.errors.join(", "))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("checkReleaseConsistency() fails when CI missing evals:v11:validate", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const ciPath = path.join(tmp, ".github", "workflows", "ci.yml")
    let ci = readFileSync(ciPath, "utf8")
    ci = ci.replace("evals:v11:validate", "EVALS_V11_REMOVED")
    writeFileSync(ciPath, ci)
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((e) => e.includes("evals:v11:validate")), "should have evals:v11:validate error. Got: " + result.errors.join(", "))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("checkReleaseConsistency() fails when Security workflow missing Security Gate", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const secPath = path.join(tmp, ".github", "workflows", "security.yml")
    let sec = readFileSync(secPath, "utf8")
    sec = sec.replaceAll("Security Gate", "SECURITY_GATE_REMOVED")
    writeFileSync(secPath, sec)
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((e) => e.includes("Security Gate")), "should have Security Gate error. Got: " + result.errors.join(", "))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("checkReleaseConsistency() fails when CI missing docs:check", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    const ciPath = path.join(tmp, ".github", "workflows", "ci.yml")
    let ci = readFileSync(ciPath, "utf8")
    ci = ci.replace("docs:check", "DOCS_CHECK_REMOVED")
    writeFileSync(ciPath, ci)
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.pass, false)
    assert.ok(result.errors.some((e) => e.includes("docs:check")), "should have docs:check error. Got: " + result.errors.join(", "))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("checkReleaseConsistency() allows historical V9 sections with old counts", () => {
  const result = checkReleaseConsistency(root)
  assert.equal(result.pass, true)
})

function mkdirTemp() {
  return path.join(process.env.TEMP || "/tmp", "ues-consistency-test-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6))
}

function fillFixture(tmp) {
  mkdirSync(tmp, { recursive: true })
  cpSync(root, tmp, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src).replace(/\\/g, "/")
      if (rel === "node_modules" || rel.startsWith("node_modules/")) return false
      if (rel === ".git" || rel.startsWith(".git/")) return false
      if (rel.endsWith(".tgz")) return false
      if (rel.startsWith("node_modules")) return false
      return true
    },
  })
}

test("release checker ignores skill directories without SKILL.md", () => {
  const tmp = mkdirTemp()
  try {
    fillFixture(tmp)
    mkdirSync(path.join(tmp,"global-config","skills","not-a-skill"),{recursive:true})
    const result = checkReleaseConsistency(tmp)
    assert.equal(result.skillCount,48); assert.equal(result.pass,true)
  } finally { rmSync(tmp,{recursive:true,force:true}) }
})
test("release checker derives router scenario counts from eval JSON", () => {
  const result = checkReleaseConsistency(root)
  assert.equal(result.staticScenarioCount,43); assert.equal(result.routerCaseCount,129)
})
