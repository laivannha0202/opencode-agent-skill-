import { existsSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

const TEST_RE = /(?:^|[/.\\])(?:__tests__|tests?|spec)(?:[/.\\]|$)|\.(?:test|spec|e2e-spec)\.[cm]?[jt]sx?$/i
const SOURCE_EXT = new Set([".js",".jsx",".mjs",".cjs",".ts",".tsx",".py",".java",".kt",".kts",".cs",".go",".rs",".dart",".swift"])
const SKIP = new Set([".git","node_modules",".next","dist","build","coverage",".venv","venv","target","Pods","DerivedData",".gradle",".ues-cache",".ues-work",".ues-sandboxes"])

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
}

function normalize(file) {
  return String(file || "").replaceAll("\\", "/").replace(/^\.\//, "")
}

function stem(file) {
  return path.basename(file)
    .replace(/\.(?:test|spec|e2e-spec)(?=\.)/i, "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
}

function tokens(file) {
  return [...new Set(normalize(file).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 3))]
}

async function walk(root, options = {}) {
  const maxFiles = Math.max(200, Number(options.maxFiles || 6000))
  const rows = []
  async function visit(dir, depth) {
    if (rows.length >= maxFiles || depth > 14) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (rows.length >= maxFiles) break
      if (entry.isDirectory() && SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile()) rows.push(full)
    }
  }
  await visit(root, 0)
  return rows
}

export function gitChangedFiles(root = process.cwd()) {
  root = path.resolve(root)
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0) return []

  const names = new Set()
  for (const args of [
    ["diff", "--name-only", "--"],
    ["diff", "--cached", "--name-only", "--"],
    ["ls-files", "--others", "--exclude-standard"],
  ]) {
    const result = git(root, args)
    if (result.status !== 0) continue
    for (const row of String(result.stdout || "").split(/\r?\n/)) {
      const file = normalize(row.trim())
      if (file) names.add(file)
    }
  }
  return [...names]
}

function scoreTest(testFile, changedFile, content = "") {
  const test = normalize(testFile).toLowerCase()
  const changed = normalize(changedFile).toLowerCase()
  let score = 0
  const reasons = []
  const changedStem = stem(changed)
  const testStem = stem(test)

  if (changedStem && testStem.includes(changedStem)) {
    score += 35
    reasons.push("same-stem")
  }
  const testDir = path.posix.dirname(test)
  const changedDir = path.posix.dirname(changed)
  if (testDir === changedDir) {
    score += 20
    reasons.push("same-directory")
  } else if (testDir.startsWith(changedDir + "/") || changedDir.startsWith(testDir + "/")) {
    score += 10
    reasons.push("nearby-directory")
  }

  const changedTokens = tokens(changed)
  const overlap = changedTokens.filter((token) => test.includes(token)).length
  if (overlap) {
    score += Math.min(20, overlap * 4)
    reasons.push("path-token-overlap")
  }

  const base = path.basename(changed).replace(/\.[^.]+$/, "")
  if (base.length >= 3 && content.toLowerCase().includes(base.toLowerCase())) {
    score += 25
    reasons.push("content-reference")
  }

  return { score, reasons }
}

async function nearestPackage(root, file) {
  let dir = path.dirname(path.resolve(root, file))
  const base = path.resolve(root)
  while (dir === base || dir.startsWith(base + path.sep)) {
    const packageFile = path.join(dir, "package.json")
    if (existsSync(packageFile)) {
      try {
        return { dir, json: JSON.parse(await readFile(packageFile, "utf8")) }
      } catch {}
    }
    if (dir === base) break
    dir = path.dirname(dir)
  }
  return null
}

function packageManager(root) {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn"
  if (existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb"))) return "bun"
  return "npm"
}

function targetedCommand(root, pkg, testFile) {
  const script = String(pkg?.json?.scripts?.test || "")
  if (!script || !/(jest|vitest|node\s+--test|tsx\s+--test)/i.test(script)) return null
  const manager = packageManager(root)
  const relativeDir = normalize(path.relative(root, pkg.dir)) || "."
  const relativeTest = normalize(path.relative(pkg.dir, path.resolve(root, testFile)))

  if (manager === "pnpm") {
    return { command: "pnpm", args: ["--dir", relativeDir, "run", "test", "--", relativeTest], confidence: "high" }
  }
  if (manager === "yarn") {
    return { command: "yarn", args: ["--cwd", relativeDir, "test", relativeTest], confidence: "high" }
  }
  if (manager === "bun") {
    return { command: "bun", args: ["--cwd", relativeDir, "run", "test", "--", relativeTest], confidence: "high" }
  }
  return { command: "npm", args: ["--prefix", relativeDir, "test", "--", relativeTest], confidence: "high" }
}

export async function resolveAffectedTests(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const changed = (options.changedFiles || gitChangedFiles(root))
    .map(normalize)
    .filter((file) => SOURCE_EXT.has(path.extname(file).toLowerCase()) && !TEST_RE.test(file))
  if (!changed.length) {
    return { schemaVersion: 1, root, changedFiles: [], tests: [], suggestedCommands: [], truncated: false }
  }

  const files = await walk(root, options)
  const tests = files
    .map((file) => normalize(path.relative(root, file)))
    .filter((file) => TEST_RE.test(file))

  const ranked = []
  for (const testFile of tests) {
    const info = await stat(path.join(root, testFile)).catch(() => null)
    const content = info?.size && info.size <= 512 * 1024
      ? await readFile(path.join(root, testFile), "utf8").catch(() => "")
      : ""
    let best = { score: 0, reasons: [], changedFile: null }
    for (const changedFile of changed) {
      const current = scoreTest(testFile, changedFile, content)
      if (current.score > best.score) best = { ...current, changedFile }
    }
    if (best.score > 0) ranked.push({ path: testFile, ...best })
  }

  ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  const limit = Math.max(1, Math.min(40, Number(options.limit || 12)))
  const selected = ranked.slice(0, limit)
  const suggestedCommands = []
  const seen = new Set()
  for (const item of selected.slice(0, 8)) {
    const pkg = await nearestPackage(root, item.path)
    const command = pkg ? targetedCommand(root, pkg, item.path) : null
    if (!command) continue
    const key = JSON.stringify([command.command, command.args])
    if (seen.has(key)) continue
    seen.add(key)
    suggestedCommands.push({ ...command, test: item.path })
  }

  return {
    schemaVersion: 1,
    root,
    changedFiles: changed,
    tests: selected,
    suggestedCommands,
    truncated: ranked.length > selected.length,
  }
}
