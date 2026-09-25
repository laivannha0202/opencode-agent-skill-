import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"
import { runtimeWorkspaceFingerprint } from "./workspace-fingerprint.mjs"

const SKIP = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv",
  "Pods", "DerivedData", ".gradle", ".idea", ".cache", ".turbo", "target", "obj",
  ".ues-work", ".ues-cache", ".ues-traces", ".ues-learning", ".ues-dashboard",
  ".ues-sandboxes", ".ues-memory", ".ues-evals",
])

const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".java", ".kt", ".kts",
  ".cs", ".go", ".rs", ".rb", ".php", ".vue", ".svelte",
])

async function walk(root, maxFiles = 2500, maxDepth = 8) {
  const files = []
  async function visit(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  await visit(root, 0)
  return files
}

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function importsFor(source, ext) {
  const imports = []
  const push = (value) => {
    const clean = String(value || "").trim()
    if (clean && !imports.includes(clean)) imports.push(clean)
  }

  if ([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".vue", ".svelte"].includes(ext)) {
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/g)) push(match[1])
    for (const match of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) push(match[1])
    for (const match of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) push(match[1])
  } else if (ext === ".py") {
    for (const match of source.matchAll(/^\s*from\s+([A-Za-z0-9_\.]+)\s+import\s+/gm)) push(match[1])
    for (const match of source.matchAll(/^\s*import\s+([A-Za-z0-9_\.]+)/gm)) push(match[1])
  } else if ([".java", ".kt", ".kts"].includes(ext)) {
    for (const match of source.matchAll(/^\s*import\s+([A-Za-z0-9_.*]+)/gm)) push(match[1])
  } else if (ext === ".cs") {
    for (const match of source.matchAll(/^\s*using\s+([A-Za-z0-9_.]+)/gm)) push(match[1])
  } else if (ext === ".go") {
    for (const match of source.matchAll(/import\s+(?:\([^)]*?["']([^"']+)["']|["']([^"']+)["'])/gs)) push(match[1] || match[2])
  } else if (ext === ".rs") {
    for (const match of source.matchAll(/^\s*use\s+([^;]+);/gm)) push(match[1])
  }
  return imports
}

function resolveRelativeImport(root, importer, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null
  const base = path.resolve(path.dirname(importer), specifier)
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map((ext) => base + ext),
    ...[...SOURCE_EXTENSIONS].map((ext) => path.join(base, "index" + ext)),
  ]
  for (const candidate of candidates) {
    const relative = rel(root, candidate)
    if (fileSet.has(relative)) return relative
  }
  return null
}

export async function buildRepoGraph(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const maxFiles = options.maxFiles ?? 2500
  const files = await walk(root, maxFiles, options.maxDepth ?? 8)
  const fileSet = new Set(files.map((file) => rel(root, file)))
  const nodes = []
  const edges = []
  const external = new Map()

  for (const file of files) {
    const info = await stat(file).catch(() => null)
    if (!info || info.size > 768 * 1024) continue
    const source = await readFile(file, "utf8").catch(() => "")
    const relative = rel(root, file)
    const ext = path.extname(file).toLowerCase()
    const imports = importsFor(source, ext)
    const local = []

    for (const specifier of imports) {
      const resolved = resolveRelativeImport(root, file, specifier, fileSet)
      if (resolved) {
        local.push(resolved)
        edges.push({ from: relative, to: resolved, kind: "local-import" })
      } else {
        const parts = specifier.split("/")
        const key = parts[0].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
        external.set(key, (external.get(key) || 0) + 1)
      }
    }

    nodes.push({ path: relative, imports: imports.length, localImports: [...new Set(local)].sort() })
  }

  const incoming = new Map()
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) || 0) + 1)
  const hotspots = nodes
    .map((node) => ({
      path: node.path,
      incoming: incoming.get(node.path) || 0,
      outgoing: node.localImports.length,
      score: (incoming.get(node.path) || 0) + node.localImports.length,
    }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, 30)

  return {
    schemaVersion: 1,
    root,
    scannedFiles: files.length,
    truncated: files.length >= maxFiles,
    nodes,
    edges,
    hotspots,
    externalImports: [...external.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 50),
  }
}

const RUNTIME_GRAPH_CACHE = new Map()

export async function buildRepoGraphCached(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const maxFiles = Number(options.maxFiles ?? 2500)
  const maxDepth = Number(options.maxDepth ?? 8)
  let fingerprint = String(options.workspaceFingerprint || "")
  if (!fingerprint || fingerprint === "unknown") {
    try {
      fingerprint = runtimeWorkspaceFingerprint(root)
    } catch {
      return buildRepoGraph(root, options)
    }
  }
  const key = [root, fingerprint, maxFiles, maxDepth].join("\u0000")
  if (RUNTIME_GRAPH_CACHE.has(key)) {
    const value = RUNTIME_GRAPH_CACHE.get(key)
    RUNTIME_GRAPH_CACHE.delete(key)
    RUNTIME_GRAPH_CACHE.set(key, value)
    return value
  }

  const graph = await buildRepoGraph(root, options)
  RUNTIME_GRAPH_CACHE.set(key, graph)
  while (RUNTIME_GRAPH_CACHE.size > 8) {
    const oldest = RUNTIME_GRAPH_CACHE.keys().next().value
    if (!oldest) break
    RUNTIME_GRAPH_CACHE.delete(oldest)
  }
  return graph
}

export function clearRepoGraphRuntimeCache() {
  RUNTIME_GRAPH_CACHE.clear()
}