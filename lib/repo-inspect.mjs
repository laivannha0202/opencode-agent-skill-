import { existsSync } from "node:fs"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv",
  "Pods", "DerivedData", ".gradle", ".idea", ".cache", ".turbo", "target", "bin", "obj",
])

const TEXT_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".jsonc", ".md", ".py",
  ".java", ".kt", ".kts", ".cs", ".go", ".rs", ".rb", ".php", ".vue", ".svelte",
  ".yml", ".yaml", ".toml", ".xml", ".gradle", ".properties", ".sql", ".sh", ".ps1",
])

function runGit(cwd, args) {
  return spawnSync("git", args, { cwd, encoding: "utf8" })
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return null
  }
}

async function listTopLevel(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function detectStack(root = process.cwd()) {
  root = path.resolve(root)
  const packageJson = await readJson(path.join(root, "package.json"))
  const stacks = []
  const evidence = []

  if (packageJson) {
    const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }
    stacks.push("node")
    evidence.push("package.json")
    if (deps.react) stacks.push("react")
    if (deps["react-native"]) stacks.push("react-native")
    if (deps.next) stacks.push("nextjs")
    if (deps["@nestjs/core"]) stacks.push("nestjs")
    if (deps.express) stacks.push("express")
    if (deps.fastify) stacks.push("fastify")
    if (deps.typescript) stacks.push("typescript")
  }

  const markers = [
    ["pyproject.toml", "python"], ["requirements.txt", "python"], ["manage.py", "django"],
    ["pom.xml", "java-maven"], ["build.gradle", "java-gradle"], ["build.gradle.kts", "kotlin-gradle"],
    ["*.csproj", "dotnet"], ["pubspec.yaml", "flutter"], ["go.mod", "go"], ["Cargo.toml", "rust"],
  ]

  for (const [marker, stack] of markers) {
    if (marker.startsWith("*.")) {
      const suffix = marker.slice(1)
      const entries = await readdir(root).catch(() => [])
      if (entries.some((name) => name.endsWith(suffix))) {
        stacks.push(stack)
        evidence.push(marker)
      }
    } else if (existsSync(path.join(root, marker))) {
      stacks.push(stack)
      evidence.push(marker)
    }
  }

  let packageManager = null
  for (const [file, manager] of [
    ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lockb", "bun"],
    ["bun.lock", "bun"], ["package-lock.json", "npm"],
  ]) {
    if (existsSync(path.join(root, file))) {
      packageManager = manager
      evidence.push(file)
      break
    }
  }

  return {
    root,
    packageManager,
    stacks: [...new Set(stacks)],
    evidence: [...new Set(evidence)],
    node: packageJson ? {
      name: packageJson.name || null,
      version: packageJson.version || null,
      type: packageJson.type || null,
      engines: packageJson.engines || null,
    } : null,
  }
}

export async function detectTestCommands(root = process.cwd()) {
  root = path.resolve(root)
  const commands = []
  const packageJson = await readJson(path.join(root, "package.json"))

  if (packageJson?.scripts) {
    const manager = existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm"
      : existsSync(path.join(root, "yarn.lock")) ? "yarn"
      : existsSync(path.join(root, "bun.lock")) || existsSync(path.join(root, "bun.lockb")) ? "bun"
      : "npm"

    for (const name of ["test", "typecheck", "check", "lint", "build", "ci"]) {
      if (!packageJson.scripts[name]) continue
      const command = `${manager} run ${name}`
      commands.push({ kind: name, command, source: "package.json" })
    }
  }

  if (existsSync(path.join(root, "pyproject.toml")) || existsSync(path.join(root, "pytest.ini"))) {
    commands.push({ kind: "test", command: "python -m pytest", source: "python project markers" })
  }
  if (existsSync(path.join(root, "pom.xml"))) {
    commands.push({ kind: "test", command: "mvn test", source: "pom.xml" })
  }
  if (existsSync(path.join(root, "gradlew")) || existsSync(path.join(root, "gradlew.bat"))) {
    commands.push({ kind: "test", command: process.platform === "win32" ? "gradlew.bat test" : "./gradlew test", source: "Gradle wrapper" })
  }
  const entries = await readdir(root).catch(() => [])
  if (entries.some((name) => name.endsWith(".sln") || name.endsWith(".csproj"))) {
    commands.push({ kind: "test", command: "dotnet test", source: ".NET project" })
  }
  if (existsSync(path.join(root, "pubspec.yaml"))) {
    commands.push({ kind: "test", command: "flutter test", source: "pubspec.yaml" })
    commands.push({ kind: "analyze", command: "flutter analyze", source: "pubspec.yaml" })
  }

  const seen = new Set()
  return commands.filter((item) => {
    if (seen.has(item.command)) return false
    seen.add(item.command)
    return true
  })
}

export async function repoMap(root = process.cwd()) {
  root = path.resolve(root)
  const topLevel = await listTopLevel(root)
  const packageJson = await readJson(path.join(root, "package.json"))
  const workspaces = Array.isArray(packageJson?.workspaces)
    ? packageJson.workspaces
    : Array.isArray(packageJson?.workspaces?.packages)
      ? packageJson.workspaces.packages
      : []

  const important = [
    "README.md", "AGENTS.md", "CONTRIBUTING.md", "package.json", "pyproject.toml",
    "pom.xml", "build.gradle", "build.gradle.kts", "pubspec.yaml", "go.mod", "Cargo.toml",
    "Dockerfile", "docker-compose.yml", "docker-compose.yaml",
  ].filter((name) => existsSync(path.join(root, name)))

  return {
    root,
    topLevel,
    important,
    workspaces,
    stack: await detectStack(root),
    verification: await detectTestCommands(root),
  }
}

async function walk(root, options = {}) {
  const maxFiles = options.maxFiles ?? 2000
  const maxDepth = options.maxDepth ?? 6
  const files = []

  async function visit(dir, depth) {
    if (files.length >= maxFiles || depth > maxDepth) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile()) files.push(full)
    }
  }

  await visit(root, 0)
  return files
}

export async function impactMap(root = process.cwd(), query = "") {
  root = path.resolve(root)
  query = String(query || "").trim()
  if (!query) throw new Error("impactMap requires a non-empty query")

  const needle = query.toLowerCase()
  const files = await walk(root)
  const matches = []

  for (const file of files) {
    const relative = path.relative(root, file)
    if (relative.toLowerCase().includes(needle)) {
      matches.push({ path: relative, kind: "path", lines: [] })
      continue
    }

    const ext = path.extname(file).toLowerCase()
    if (!TEXT_EXTENSIONS.has(ext) && !["Dockerfile", "Makefile"].includes(path.basename(file))) continue

    const info = await stat(file).catch(() => null)
    if (!info || info.size > 512 * 1024) continue

    const source = await readFile(file, "utf8").catch(() => "")
    const lines = source.split(/\r?\n/)
    const hitLines = []
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].toLowerCase().includes(needle)) {
        hitLines.push({ line: index + 1, text: lines[index].trim().slice(0, 240) })
        if (hitLines.length >= 5) break
      }
    }
    if (hitLines.length) matches.push({ path: relative, kind: "content", lines: hitLines })
    if (matches.length >= 100) break
  }

  return { root, query, matches, truncated: matches.length >= 100 }
}

export async function checkWorkingTree(root = process.cwd()) {
  root = path.resolve(root)
  const status = runGit(root, ["status", "--porcelain=v1", "--branch"])
  if (status.status !== 0) {
    return { root, git: false, error: (status.stderr || status.stdout || "").trim() }
  }

  const lines = status.stdout.split(/\r?\n/).filter(Boolean)
  const branch = lines[0]?.replace(/^##\s*/, "") || null
  const changes = lines.slice(1)
  const head = runGit(root, ["rev-parse", "HEAD"])
  return {
    root,
    git: true,
    branch,
    head: head.status === 0 ? head.stdout.trim() : null,
    clean: changes.length === 0,
    changes,
  }
}

export async function collectEvidence(root = process.cwd()) {
  root = path.resolve(root)
  const [map, workingTree] = await Promise.all([repoMap(root), checkWorkingTree(root)])
  return {
    collectedAt: new Date().toISOString(),
    root,
    stack: map.stack,
    verification: map.verification,
    important: map.important,
    workspaces: map.workspaces,
    workingTree,
  }
}
