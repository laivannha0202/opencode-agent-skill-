import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { buildRepoGraph } from "./repo-graph.mjs"
import { taskFiles } from "./task-graph.mjs"

const ROOT_INSTRUCTIONS = [
  "AGENTS.md",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|cs|go|rs|swift|dart|vue|svelte|sql)$/i

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function safeFull(root, relative) {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}

async function fileInfo(root, relative) {
  const full = safeFull(root, relative)
  if (!full) return null
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) return null
  return { path: rel(root, full), bytes: info.size }
}

async function excerpt(root, relative, limit) {
  const full = safeFull(root, relative)
  if (!full) return null
  const source = await readFile(full, "utf8").catch(() => "")
  if (!source) return null
  return {
    path: rel(root, full),
    text: source.length <= limit ? source : source.slice(0, limit) + "\n...[truncated]",
  }
}

function taskTerms(task) {
  const source = [
    task?.title,
    task?.summary,
    ...(task?.acceptance || []),
    ...(task?.verification || []),
  ].filter(Boolean).join(" ").toLowerCase()

  const stop = new Set([
    "this","that","with","from","into","then","than","when","where","what","your",
    "task","test","tests","file","files","code","change","changes","should","must",
    "được","các","cho","với","trong","này","một","những","không","theo","sau",
  ])
  return unique(
    source
      .split(/[^\p{L}\p{N}_$.-]+/u)
      .map((item) => item.replace(/^[-.$]+|[-.$]+$/g, ""))
      .filter((item) => item.length >= 4 && !stop.has(item)),
  ).slice(0, 24)
}

function gitChangedFiles(root) {
  const result = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  )
  if (result.status !== 0) return []
  return unique(
    result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.slice(3).trim())
      .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1) : value)
      .map((value) => value.replaceAll("\\", "/")),
  )
}

async function nearbyInstructions(root, declared) {
  const found = new Set()
  for (const name of ROOT_INSTRUCTIONS) {
    if (existsSync(path.join(root, name))) found.add(name)
  }

  for (const file of declared) {
    let dir = path.dirname(file)
    while (dir && dir !== ".") {
      for (const name of ["AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"]) {
        const candidate = path.posix.join(dir.replaceAll("\\", "/"), name)
        if (existsSync(path.join(root, candidate))) found.add(candidate)
      }
      const next = path.dirname(dir)
      if (next === dir) break
      dir = next
    }
  }
  return [...found]
}

async function rankedReferences(root, nodes, terms, declared, changed, limit = 24) {
  if (!terms.length) return []
  const declaredSet = new Set(declared)
  const changedSet = new Set(changed)
  const candidates = nodes
    .map((node) => node.path)
    .filter((file) => SOURCE_EXT.test(file))
    .filter((file) => !declaredSet.has(file))
    .slice(0, 500)

  const scored = []
  for (const file of candidates) {
    const lowerPath = file.toLowerCase()
    let score = changedSet.has(file) ? 8 : 0
    for (const term of terms) {
      if (lowerPath.includes(term)) score += 6
    }

    const full = safeFull(root, file)
    const info = full ? await stat(full).catch(() => null) : null
    if (!info?.isFile() || info.size > 512 * 1024) {
      if (score > 0) scored.push({ path: file, score, matches: [] })
      continue
    }

    const source = (await readFile(full, "utf8").catch(() => "")).toLowerCase()
    if (!source) continue
    const matches = []
    for (const term of terms) {
      const index = source.indexOf(term)
      if (index >= 0) {
        score += 2
        if (matches.length < 8) matches.push(term)
      }
    }
    if (score > 0) scored.push({ path: file, score, matches })
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

export async function buildContextManifest(root, task, options = {}) {
  root = path.resolve(root)
  const budget = Math.max(4_000, Number(options.budget ?? 24_000))
  const declared = taskFiles(task)
  const terms = taskTerms(task)
  const changed = gitChangedFiles(root)
  const graph = await buildRepoGraph(root, { maxFiles: options.maxFiles ?? 2500 })
  const nodeMap = new Map(graph.nodes.map((node) => [node.path, node]))
  const incoming = new Map()

  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) || []
    list.push(edge.from)
    incoming.set(edge.to, list)
  }

  const related = []
  for (const file of declared) {
    related.push(...(nodeMap.get(file)?.localImports || []))
    related.push(...(incoming.get(file) || []))
  }

  const baseNames = declared.map((file) => path.basename(file, path.extname(file)).toLowerCase())
  const tests = graph.nodes
    .map((node) => node.path)
    .filter((file) => /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(file))
    .map((file) => ({
      file,
      score: baseNames.reduce((sum, name) => sum + (name && file.toLowerCase().includes(name) ? 2 : 0), 0) +
        terms.reduce((sum, term) => sum + (file.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 24)
    .map((item) => item.file)

  const instructions = await nearbyInstructions(root, declared)
  const ranked = await rankedReferences(root, graph.nodes, terms, declared, changed)
  const changedRelevant = changed
    .filter((file) => graph.nodes.some((node) => node.path === file) || declared.includes(file))
    .slice(0, 30)

  const priority = unique([
    ...declared,
    ...tests,
    ...related.slice(0, 20),
    ...ranked.map((item) => item.path),
    ...changedRelevant,
    ...instructions,
  ])

  const files = []
  for (const file of priority) {
    const info = await fileInfo(root, file)
    if (info) files.push(info)
  }

  let remaining = budget
  const excerpts = []
  for (const file of priority) {
    if (remaining <= 0) break
    const isDeclared = declared.includes(file)
    const isTest = tests.includes(file)
    const isInstruction = instructions.includes(file)
    const desired = isDeclared ? 6_000 : isTest ? 4_000 : isInstruction ? 3_000 : 2_500
    const perFile = Math.min(desired, remaining)
    const item = await excerpt(root, file, perFile)
    if (!item) continue
    remaining -= item.text.length
    excerpts.push({
      ...item,
      role: isDeclared ? "declared" : isTest ? "test" : isInstruction ? "instruction" : "reference",
    })
  }

  return {
    schemaVersion: 2,
    task: task?.id || null,
    queryTerms: terms,
    declared,
    related: unique(related).filter((file) => !declared.includes(file)).slice(0, 30),
    tests,
    instructions,
    changed: changedRelevant,
    rankedReferences: ranked,
    files,
    excerpts,
    graph: {
      scannedFiles: graph.scannedFiles,
      truncated: graph.truncated,
      hotspots: graph.hotspots.slice(0, 12),
    },
    budget,
    used: budget - remaining,
  }
}
