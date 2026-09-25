import path from "node:path"
import { buildSemanticIndex } from "./semantic-index.mjs"

const DEFAULT_L0 = 256
const DEFAULT_L1 = 4000
const STOP = new Set([
  "this","that","with","from","into","then","than","when","where","what","your","have","will",
  "task","code","file","files","fix","update","change","changes","được","các","cho","với","trong","này","một","những","không","theo",
])

function terms(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^\p{L}\p{N}_$.-]+/u)
      .map((item) => item.replace(/^[-.$]+|[-.$]+$/g, ""))
      .filter((item) => item.length >= 2 && !STOP.has(item)),
  )].slice(0, 32)
}

function ancestors(file) {
  const parts = String(file || "").replaceAll("\\", "/").split("/").filter(Boolean)
  const result = ["."]
  let current = ""
  for (let index = 0; index < parts.length - 1; index += 1) {
    current = current ? `${current}/${parts[index]}` : parts[index]
    result.push(current)
  }
  return result
}

function parentDir(dir) {
  if (!dir || dir === ".") return null
  const value = path.posix.dirname(dir)
  return value === "." ? "." : value
}

function clip(value, limit) {
  const text = String(value || "")
  return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 15)) + "...[truncated]"
}

function topCounts(map, limit) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

function buildNodeSummary(node, children, options = {}) {
  const l0Limit = Math.max(96, Number(options.l0Chars || DEFAULT_L0))
  const l1Limit = Math.max(512, Number(options.l1Chars || DEFAULT_L1))
  const symbols = topCounts(node.symbols, 18)
  const extensions = topCounts(node.extensions, 10)
  const files = [...node.files].sort()
  const childNames = (children.get(node.path) || []).sort()
  const l0 = clip([
    `${node.path}: ${files.length} source file(s), ${node.bytes} bytes.`,
    symbols.length ? `Key symbols: ${symbols.slice(0, 8).map((item) => item.name).join(", ")}.` : "",
    childNames.length ? `Child areas: ${childNames.slice(0, 6).join(", ")}.` : "",
  ].filter(Boolean).join(" "), l0Limit)
  const l1 = clip([
    l0,
    childNames.length ? `Children: ${childNames.join(", ")}` : "",
    extensions.length ? `Extensions: ${extensions.map((item) => `${item.name || "(none)"}:${item.count}`).join(", ")}` : "",
    symbols.length ? `Symbols: ${symbols.map((item) => `${item.name}:${item.count}`).join(", ")}` : "",
    files.length ? `Files: ${files.slice(0, 60).join(", ")}` : "",
  ].filter(Boolean).join("\n"), l1Limit)
  return {
    path: node.path,
    fileCount: files.length,
    bytes: node.bytes,
    files,
    symbols,
    children: childNames,
    l0,
    l1,
  }
}

export async function buildContextHierarchy(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const built = options.builtIndex || await buildSemanticIndex(root, {
    maxFiles: options.maxFiles ?? 6000,
    maxDepth: options.maxDepth ?? 14,
  })
  const nodes = new Map()
  const children = new Map()
  const ensure = (dir) => {
    if (!nodes.has(dir)) {
      nodes.set(dir, { path: dir, files: new Set(), bytes: 0, symbols: new Map(), extensions: new Map() })
    }
    return nodes.get(dir)
  }

  ensure(".")
  for (const [file, entry] of Object.entries(built.index.files || {})) {
    const dirs = ancestors(file)
    const extension = path.posix.extname(file).toLowerCase()
    for (const dir of dirs) {
      const node = ensure(dir)
      node.files.add(file)
      node.bytes += Number(entry.bytes || 0)
      node.extensions.set(extension, (node.extensions.get(extension) || 0) + 1)
      for (const symbol of entry.symbols || []) {
        const name = String(symbol.name || "")
        if (!name) continue
        node.symbols.set(name, (node.symbols.get(name) || 0) + 1)
      }
    }
  }

  for (const dir of nodes.keys()) {
    const parent = parentDir(dir)
    if (!parent) continue
    const list = children.get(parent) || []
    if (!list.includes(dir)) list.push(dir)
    children.set(parent, list)
  }

  const summaries = [...nodes.values()]
    .map((node) => buildNodeSummary(node, children, options))
    .sort((a, b) => a.path.localeCompare(b.path))

  return {
    schemaVersion: 1,
    kind: "ues-context-hierarchy",
    root,
    generatedAt: new Date().toISOString(),
    levels: {
      L0: { maxChars: Math.max(96, Number(options.l0Chars || DEFAULT_L0)), purpose: "routing abstract" },
      L1: { maxChars: Math.max(512, Number(options.l1Chars || DEFAULT_L1)), purpose: "scope overview" },
      L2: { purpose: "source excerpts loaded on demand by the context manifest" },
    },
    nodes: summaries,
    stats: built.stats,
  }
}

function containsFile(scope, file) {
  if (scope === ".") return true
  return file === scope || file.startsWith(scope + "/")
}

function scopesOverlap(left, right) {
  if (left === "." || right === ".") return true
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/")
}

export function selectDiverseHierarchyScopes(rows = [], maxScopes = 6) {
  const limit = Math.max(1, Math.min(Number(maxScopes || 6), 20))
  const selected = []
  for (const row of rows) {
    if (selected.length >= limit) break
    if (selected.some((item) => scopesOverlap(item.path, row.path))) continue
    selected.push(row)
  }
  if (!selected.length && rows.length) selected.push(rows[0])
  return selected
}

export async function queryContextHierarchy(root, query, options = {}) {
  const hierarchy = await buildContextHierarchy(root, options)
  const wanted = terms(query)
  const declared = (options.declaredFiles || []).map((file) => String(file || "").replaceAll("\\", "/")).filter(Boolean)
  const scored = hierarchy.nodes.map((node) => {
    const lowerPath = node.path.toLowerCase()
    const symbolText = node.symbols.map((item) => item.name.toLowerCase()).join(" ")
    const fileText = node.files.slice(0, 100).join(" ").toLowerCase()
    let score = node.path === "." ? 0.25 : 0
    const reasons = []
    for (const term of wanted) {
      if (lowerPath.includes(term)) {
        score += 8
        reasons.push("path:" + term)
      }
      if (symbolText.includes(term)) {
        score += 5
        reasons.push("symbol:" + term)
      }
      if (fileText.includes(term)) {
        score += 2
        reasons.push("file:" + term)
      }
    }
    const declaredHits = declared.filter((file) => containsFile(node.path, file)).length
    if (declaredHits) {
      score += 20 + declaredHits * 4
      reasons.push("declared:" + declaredHits)
    }
    const depth = node.path === "." ? 0 : node.path.split("/").length
    if (score > 0) score += Math.min(3, depth * 0.4)
    score -= Math.min(2.5, Math.log1p(node.fileCount) * 0.15)
    return { ...node, score: Number(score.toFixed(3)), reasons: [...new Set(reasons)].slice(0, 12) }
  })

  const maxScopes = Math.max(1, Math.min(Number(options.maxScopes || 6), 20))
  const positive = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.fileCount - b.fileCount || a.path.localeCompare(b.path))
  const scopes = selectDiverseHierarchyScopes(
    positive.length ? positive : scored.filter((item) => item.path === "."),
    maxScopes,
  )

  return {
    schemaVersion: 1,
    kind: "ues-context-hierarchy-query",
    query: String(query || ""),
    terms: wanted,
    levels: hierarchy.levels,
    scopes,
    stats: hierarchy.stats,
  }
}