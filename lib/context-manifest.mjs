import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { buildRepoGraph } from "./repo-graph.mjs"
import { taskFiles } from "./task-graph.mjs"

const INSTRUCTION_FILES = ["AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"]

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

async function fileInfo(root, relative) {
  const full = path.resolve(root, relative)
  if (!full.startsWith(path.resolve(root) + path.sep) && full !== path.resolve(root)) return null
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) return null
  return { path: rel(root, full), bytes: info.size }
}

async function excerpt(root, relative, limit) {
  const full = path.resolve(root, relative)
  const source = await readFile(full, "utf8").catch(() => "")
  if (!source) return null
  return {
    path: rel(root, full),
    text: source.length <= limit ? source : source.slice(0, limit) + "\n...[truncated]",
  }
}

export async function buildContextManifest(root, task, options = {}) {
  root = path.resolve(root)
  const budget = Math.max(4_000, Number(options.budget ?? 24_000))
  const declared = taskFiles(task)
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
    .filter((file) => baseNames.some((name) => name && file.toLowerCase().includes(name)))
    .slice(0, 20)

  const instructions = []
  for (const name of INSTRUCTION_FILES) {
    if (existsSync(path.join(root, name))) instructions.push(name)
  }

  const candidates = unique([...declared, ...related.slice(0, 30), ...tests, ...instructions])
  const files = []
  for (const file of candidates) {
    const info = await fileInfo(root, file)
    if (info) files.push(info)
  }

  let remaining = budget
  const excerpts = []
  for (const file of unique([...declared, ...tests, ...related.slice(0, 12), ...instructions])) {
    if (remaining <= 0) break
    const perFile = Math.min(4_000, remaining)
    const item = await excerpt(root, file, perFile)
    if (!item) continue
    remaining -= item.text.length
    excerpts.push(item)
  }

  return {
    schemaVersion: 1,
    task: task?.id || null,
    declared,
    related: unique(related).filter((file) => !declared.includes(file)).slice(0, 30),
    tests,
    instructions,
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
