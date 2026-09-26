import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const SCHEMA_VERSION = 1
const CACHE_DIR = ".ues-cache"
const CACHE_FILE = "semantic-index-v1.json"
const SOURCE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".java", ".kt", ".kts",
  ".cs", ".go", ".rs", ".rb", ".php", ".vue", ".svelte", ".dart", ".swift", ".sql",
])
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv",
  "Pods", "DerivedData", ".gradle", ".idea", ".cache", ".turbo", "target", "obj",
  ".ues-work", ".ues-learning", ".ues-memory", ".ues-dashboard", ".ues-sandboxes", ".ues-cache", ".ues-traces", ".ues-services",
])
const STOP_IDENTIFIERS = new Set([
  "const","let","var","function","class","interface","type","export","import","from","return",
  "async","await","if","else","for","while","switch","case","break","continue","true","false",
  "null","undefined","this","new","public","private","protected","static","final","void","string",
  "number","boolean","object","def","self","None","True","False","pass","with","yield","lambda",
  "package","using","namespace","struct","enum","trait","impl","func","map","range","select",
])

function rel(root, file) {
  return path.relative(root, file).replaceAll("\\", "/")
}

function safeFull(root, relative) {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, JSON.stringify(value) + "\n", "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function walk(root, options = {}) {
  const maxFiles = Math.max(100, Number(options.maxFiles || 6000))
  const maxDepth = Math.max(2, Number(options.maxDepth || 14))
  const files = []
  async function visit(dir, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full)
    }
  }
  await visit(root, 0)
  return { files, truncated: files.length >= maxFiles }
}

function symbolPatterns(ext) {
  const common = [
    { kind: "function", re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "class", re: /(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: "binding", re: /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/ },
  ]
  if ([".js",".mjs",".cjs",".jsx",".ts",".tsx",".vue",".svelte"].includes(ext)) return common
  if (ext === ".py") return [
    { kind: "function", re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: "class", re: /^\s*class\s+([A-Za-z_][\w]*)/ },
  ]
  if ([".java",".kt",".kts",".cs"].includes(ext)) return [
    { kind: "type", re: /\b(?:class|interface|record|enum|object)\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", re: /\b(?:public|private|protected|internal|static|final|virtual|override|async|synchronized|abstract|sealed|partial|readonly|suspend|open|inline|\s)+[\w<>,?\[\].:]+\s+([A-Za-z_$][\w$]*)\s*\(/ },
  ]
  if (ext === ".go") return [
    { kind: "function", re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/ },
    { kind: "type", re: /^\s*type\s+([A-Za-z_][\w]*)\s+/ },
  ]
  if (ext === ".rs") return [
    { kind: "function", re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/ },
    { kind: "type", re: /^\s*(?:pub\s+)?(?:struct|enum|trait|type)\s+([A-Za-z_][\w]*)/ },
  ]
  if (ext === ".dart") return [
    { kind: "class", re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_][\w]*)/ },
    { kind: "function", re: /^\s*(?:[\w<>,?\[\]]+\s+)+([A-Za-z_][\w]*)\s*\(/ },
  ]
  if (ext === ".swift") return [
    { kind: "type", re: /^\s*(?:public\s+|internal\s+|private\s+)?(?:class|struct|enum|protocol)\s+([A-Za-z_][\w]*)/ },
    { kind: "function", re: /^\s*(?:public\s+|internal\s+|private\s+)?func\s+([A-Za-z_][\w]*)/ },
  ]
  if (ext === ".sql") return [
    { kind: "table", re: /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?["`\[]?([A-Za-z_][\w$.-]*)/i },
    { kind: "view", re: /^\s*create\s+(?:or\s+replace\s+)?view\s+["`\[]?([A-Za-z_][\w$.-]*)/i },
    { kind: "function", re: /^\s*create\s+(?:or\s+replace\s+)?(?:function|procedure)\s+["`\[]?([A-Za-z_][\w$.-]*)/i },
  ]
  return common
}

function parseSource(source, ext) {
  const lines = String(source || "").split(/\r?\n/)
  const symbols = []
  const patterns = symbolPatterns(ext)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of patterns) {
      const match = line.match(pattern.re)
      if (match?.[1]) {
        symbols.push({
          name: match[1],
          kind: pattern.kind,
          line: index + 1,
          preview: line.trim().slice(0, 240),
        })
        break
      }
    }
  }

  const counts = new Map()
  for (const match of String(source || "").matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/g)) {
    const value = match[0]
    if (STOP_IDENTIFIERS.has(value)) continue
    counts.set(value, (counts.get(value) || 0) + 1)
  }
  const identifiers = Object.fromEntries(
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 320),
  )
  return { symbols: symbols.slice(0, 400), identifiers }
}

function cachePath(root) {
  return path.join(root, CACHE_DIR, CACHE_FILE)
}

async function readCache(root) {
  try {
    const parsed = JSON.parse(await readFile(cachePath(root), "utf8"))
    if (parsed?.schemaVersion !== SCHEMA_VERSION || typeof parsed.files !== "object") return null
    return parsed
  } catch {
    return null
  }
}

export async function buildSemanticIndex(root = process.cwd(), options = {}) {
  const started = Date.now()
  root = path.resolve(root)
  const previous = options.rebuild ? null : await readCache(root)
  const discovered = await walk(root, options)
  const nextFiles = {}
  let reused = 0
  let reparsed = 0
  let skippedLarge = 0
  const maxFileBytes = Math.max(64 * 1024, Number(options.maxFileBytes || 1024 * 1024))

  for (const full of discovered.files) {
    const info = await stat(full).catch(() => null)
    if (!info?.isFile()) continue
    const relative = rel(root, full)
    const signature = info.size + ":" + Math.trunc(info.mtimeMs)
    const old = previous?.files?.[relative]
    if (old?.signature === signature) {
      nextFiles[relative] = old
      reused += 1
      continue
    }
    if (info.size > maxFileBytes) {
      nextFiles[relative] = { signature, bytes: info.size, skipped: "too-large", symbols: [], identifiers: {} }
      skippedLarge += 1
      continue
    }
    const source = await readFile(full, "utf8").catch(() => "")
    const parsed = source ? parseSource(source, path.extname(relative).toLowerCase()) : { symbols: [], identifiers: {} }
    nextFiles[relative] = {
      signature,
      bytes: info.size,
      symbols: parsed.symbols,
      identifiers: parsed.identifiers,
    }
    reparsed += 1
  }

  const removed = previous
    ? Object.keys(previous.files || {}).filter((file) => !Object.hasOwn(nextFiles, file)).length
    : 0
  const index = {
    schemaVersion: SCHEMA_VERSION,
    kind: "ues-semantic-index",
    root,
    generatedAt: new Date().toISOString(),
    truncated: discovered.truncated,
    files: nextFiles,
  }
  const changed = !previous || reparsed > 0 || removed > 0 || skippedLarge > 0
  if (changed || options.rebuild) await atomicJson(cachePath(root), index)

  return {
    index,
    stats: {
      files: Object.keys(nextFiles).length,
      reused,
      reparsed,
      removed,
      skippedLarge,
      truncated: discovered.truncated,
      cacheFile: rel(root, cachePath(root)),
      durationMs: Date.now() - started,
    },
  }
}

function queryTerms(query) {
  return [...new Set(
    String(query || "")
      .split(/[^\p{L}\p{N}_$.-]+/u)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2),
  )].slice(0, 16)
}

export async function querySemanticIndex(root, query, options = {}) {
  const terms = queryTerms(query)
  if (!terms.length) return { query: String(query || ""), terms: [], results: [], stats: null }
  const built = options.builtIndex || await buildSemanticIndex(root, options)
  const lowerTerms = terms.map((term) => term.toLowerCase())
  const results = []

  for (const [file, entry] of Object.entries(built.index.files)) {
    let score = 0
    const reasons = []
    const definitions = []
    const lowerPath = file.toLowerCase()
    for (let i = 0; i < terms.length; i += 1) {
      const term = terms[i]
      const lower = lowerTerms[i]
      if (lowerPath.includes(lower)) {
        score += 4
        reasons.push("path:" + term)
      }
      for (const symbol of entry.symbols || []) {
        const name = String(symbol.name || "")
        const symbolLower = name.toLowerCase()
        if (symbolLower === lower) {
          score += 24
          definitions.push(symbol)
          reasons.push("definition:" + name)
        } else if (symbolLower.startsWith(lower) || symbolLower.includes(lower)) {
          score += 10
          definitions.push(symbol)
          reasons.push("symbol:" + name)
        }
      }
      const identifiers = entry.identifiers || {}
      const direct = Number(identifiers[term] || 0)
      let folded = direct
      if (!direct) {
        for (const [identifier, count] of Object.entries(identifiers)) {
          if (identifier.toLowerCase() === lower) {
            folded = Number(count || 0)
            break
          }
        }
      }
      if (folded > 0) {
        score += Math.min(12, 2 + Math.log2(folded + 1) * 2)
        reasons.push("reference:" + term + "x" + folded)
      }
    }
    if (score <= 0) continue
    results.push({
      path: file,
      score: Number(score.toFixed(3)),
      definitions: definitions
        .filter((item, index, list) => list.findIndex((other) => other.name === item.name && other.line === item.line) === index)
        .slice(0, 12),
      reasons: [...new Set(reasons)].slice(0, 12),
    })
  }

  results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return {
    schemaVersion: 1,
    kind: "ues-semantic-query",
    query: String(query || ""),
    terms,
    evidenceLevel: "syntax-aware-lexical",
    results: results.slice(0, Math.max(1, Math.min(Number(options.limit || 20), 100))),
    stats: built.stats,
  }
}

export async function semanticIndexStatus(root = process.cwd()) {
  root = path.resolve(root)
  const file = cachePath(root)
  const exists = existsSync(file)
  if (!exists) return { exists: false, cacheFile: rel(root, file) }
  const cached = await readCache(root)
  return {
    exists: Boolean(cached),
    cacheFile: rel(root, file),
    schemaVersion: cached?.schemaVersion || null,
    generatedAt: cached?.generatedAt || null,
    files: cached ? Object.keys(cached.files || {}).length : 0,
    truncated: Boolean(cached?.truncated),
  }
}

const RUNTIME_SEMANTIC_CACHE = new Map()
const RUNTIME_SEMANTIC_INFLIGHT = new Map()

export async function buildSemanticIndexCached(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const fingerprint = String(options.workspaceFingerprint || "")
  if (!fingerprint || fingerprint === "unknown") {
    return buildSemanticIndex(root, options)
  }

  const maxFiles = Number(options.maxFiles ?? 6000)
  const maxDepth = Number(options.maxDepth ?? 14)
  const maxBytes = Number(options.maxBytes ?? 768 * 1024)
  const key = [root, fingerprint, maxFiles, maxDepth, maxBytes].join("\u0000")
  if (RUNTIME_SEMANTIC_CACHE.has(key)) {
    const value = RUNTIME_SEMANTIC_CACHE.get(key)
    RUNTIME_SEMANTIC_CACHE.delete(key)
    RUNTIME_SEMANTIC_CACHE.set(key, value)
    return { ...value, runtimeCacheHit: true }
  }

  if (RUNTIME_SEMANTIC_INFLIGHT.has(key)) {
    const value = await RUNTIME_SEMANTIC_INFLIGHT.get(key)
    return { ...value, runtimeCacheHit: true, runtimeCacheCoalesced: true }
  }

  const pending = buildSemanticIndex(root, options)
    .then((built) => ({ ...built, runtimeCacheHit: false }))
  RUNTIME_SEMANTIC_INFLIGHT.set(key, pending)

  try {
    const value = await pending
    RUNTIME_SEMANTIC_CACHE.set(key, value)
    while (RUNTIME_SEMANTIC_CACHE.size > 6) {
      const oldest = RUNTIME_SEMANTIC_CACHE.keys().next().value
      if (!oldest) break
      RUNTIME_SEMANTIC_CACHE.delete(oldest)
    }
    return value
  } finally {
    RUNTIME_SEMANTIC_INFLIGHT.delete(key)
  }
}

export function clearSemanticIndexRuntimeCache() {
  RUNTIME_SEMANTIC_CACHE.clear()
  RUNTIME_SEMANTIC_INFLIGHT.clear()
}