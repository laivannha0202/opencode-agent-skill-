import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { buildRepoGraph } from "./repo-graph.mjs"
import { taskFiles } from "./task-graph.mjs"

function relative(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function unique(values) {
  return [...new Set(values)].sort()
}

export async function buildContextManifest(root, task, options = {}) {
  root = path.resolve(root)
  const files = taskFiles(task).slice(0, options.maxTaskFiles ?? 16)
  const graph = await buildRepoGraph(root, {
    maxFiles: options.maxGraphFiles ?? 1200,
    maxDepth: options.maxDepth ?? 8,
  })

  const fileSet = new Set(files)
  const neighbors = []
  for (const edge of graph.edges) {
    if (fileSet.has(edge.from)) neighbors.push(edge.to)
    if (fileSet.has(edge.to)) neighbors.push(edge.from)
  }

  const basenames = files.map((file) => path.basename(file).replace(/\.[^.]+$/, "").toLowerCase())
  const relevantTests = graph.nodes
    .map((node) => node.path)
    .filter((file) => /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|\.)|\.(?:test|spec)\./i.test(file))
    .filter((file) => basenames.some((base) => file.toLowerCase().includes(base)))
    .slice(0, options.maxTests ?? 12)

  const excerpts = {}
  let sourceBytes = 0
  const maxExcerptBytes = options.maxExcerptBytes ?? 3500
  const maxExcerptFiles = options.maxExcerptFiles ?? 8
  for (const file of files.slice(0, maxExcerptFiles)) {
    const full = path.resolve(root, file)
    if (!full.startsWith(root + path.sep) && full !== root) continue
    const info = await stat(full).catch(() => null)
    if (!info?.isFile() || info.size > 512 * 1024) continue
    const source = await readFile(full, "utf8").catch(() => "")
    excerpts[relative(root, full)] = source.slice(0, maxExcerptBytes)
    sourceBytes += Math.min(source.length, maxExcerptBytes)
  }

  return {
    schemaVersion: 1,
    taskID: task?.id || null,
    declaredFiles: files,
    dependencyNeighborhood: unique(neighbors).slice(0, options.maxNeighbors ?? 24),
    relevantTests: unique(relevantTests),
    hotspots: graph.hotspots.filter((item) => fileSet.has(item.path) || neighbors.includes(item.path)).slice(0, 12),
    excerpts,
    sourceBytes,
    graph: {
      scannedFiles: graph.scannedFiles,
      truncated: graph.truncated,
    },
  }
}
