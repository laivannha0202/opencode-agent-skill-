import { existsSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { buildRepoGraph } from "./repo-graph.mjs"
import { taskFiles } from "./task-graph.mjs"
import { querySemanticIndex } from "./semantic-index.mjs"

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

function centeredSlice(source, terms, limit) {
  if (source.length <= limit) return { text: source, startOffset: 0, centerTerm: null }
  const lower = source.toLowerCase()
  let matchIndex = -1
  let centerTerm = null
  for (const term of terms || []) {
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (matchIndex < 0 || index < matchIndex)) {
      matchIndex = index
      centerTerm = term
    }
  }
  if (matchIndex < 0) return { text: source.slice(0, limit) + "\n...[truncated]", startOffset: 0, centerTerm: null }
  const start = Math.max(0, Math.min(matchIndex - Math.floor(limit / 3), source.length - limit))
  const prefix = start > 0 ? "...[truncated]\n" : ""
  const suffix = start + limit < source.length ? "\n...[truncated]" : ""
  return {
    text: prefix + source.slice(start, start + limit) + suffix,
    startOffset: start,
    centerTerm,
  }
}

async function excerpt(root, relative, limit, terms = []) {
  const full = safeFull(root, relative)
  if (!full) return null
  const source = await readFile(full, "utf8").catch(() => "")
  if (!source) return null
  const slice = centeredSlice(source, terms, limit)
  return {
    path: rel(root, full),
    ...slice,
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

function tokenCounts(text, wantedTerms) {
  const counts = new Map()
  const wanted = new Set(wantedTerms)
  const tokens = String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_$.-]+/u)
    .filter(Boolean)
  for (const token of tokens) {
    if (!wanted.has(token)) continue
    counts.set(token, (counts.get(token) || 0) + 1)
  }
  return { counts, length: tokens.length }
}

function symbolHits(source, terms, limit = 12) {
  const hits = []
  const lines = String(source || "").split(/\r?\n/)
  const patterns = [
    /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/,
    /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)/,
    /^\s*class\s+([A-Za-z_][\w]*)/,
    /^\s*(?:public|private|protected|internal|static|final|virtual|override|async|synchronized|abstract|sealed|partial|readonly|\s)+[\w<>,?\[\].:]+\s+([A-Za-z_$][\w$]*)\s*\(/,
  ]
  for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
    const line = lines[index]
    let symbol = null
    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (match?.[1]) {
        symbol = match[1]
        break
      }
    }
    if (!symbol) continue
    const haystack = (symbol + " " + line).toLowerCase()
    const matches = terms.filter((term) => haystack.includes(term.toLowerCase()))
    if (!matches.length) continue
    hits.push({ symbol, line: index + 1, matches: unique(matches).slice(0, 6), preview: line.trim().slice(0, 240) })
  }
  return hits
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

  const docs = []
  const documentFrequency = new Map(terms.map((term) => [term, 0]))
  for (const file of candidates) {
    const full = safeFull(root, file)
    const info = full ? await stat(full).catch(() => null) : null
    if (!info?.isFile() || info.size > 512 * 1024) continue
    const source = await readFile(full, "utf8").catch(() => "")
    if (!source) continue
    const stats = tokenCounts(source, terms)
    for (const term of terms) {
      if ((stats.counts.get(term) || 0) > 0) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1)
      }
    }
    docs.push({ file, source, stats })
  }

  const population = Math.max(1, docs.length)
  const scored = []
  for (const doc of docs) {
    const lowerPath = doc.file.toLowerCase()
    let score = changedSet.has(doc.file) ? 8 : 0
    const matches = []
    for (const term of terms) {
      if (lowerPath.includes(term)) score += 6
      const tf = doc.stats.counts.get(term) || 0
      if (tf > 0) {
        const df = documentFrequency.get(term) || 0
        const idf = Math.log((population + 1) / (df + 1)) + 1
        score += (1 + Math.log(tf)) * idf * 3
        if (matches.length < 8) matches.push(term)
      }
    }
    const symbols = symbolHits(doc.source, terms)
    score += symbols.length * 4
    if (score > 0) {
      scored.push({
        path: doc.file,
        score: Number(score.toFixed(3)),
        matches,
        symbolHits: symbols,
      })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
}

export async function buildContextManifest(root, task, options = {}) {
  root = path.resolve(root)
  const budget = Math.max(4_000, Number(options.evidenceBudget?.total ?? options.budget ?? 24_000))
  const evidenceBudget = options.evidenceBudget || null
  const declared = taskFiles(task)
  const terms = taskTerms(task)
  const changed = gitChangedFiles(root)
  const strategy = String(options.strategy || "semantic+graph+git")
  const queryText = [
    task?.title,
    task?.summary,
    ...(task?.acceptance || []),
    ...(task?.verification || []),
  ].filter(Boolean).join(" ")

  const semantic = await querySemanticIndex(root, queryText, {
    limit: 32,
    maxFiles: options.semanticMaxFiles ?? 6000,
  }).catch(() => null)
  const semanticPaths = semantic?.results?.map((item) => item.path) || []

  const useGraph = strategy.includes("graph")
  const graph = useGraph
    ? await buildRepoGraph(root, { maxFiles: options.maxFiles ?? 2500 })
    : { nodes: [], edges: [], hotspots: [], scannedFiles: 0, truncated: false }
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
  const graphTestCandidates = graph.nodes.map((node) => node.path)
  const semanticTestCandidates = semanticPaths
  const tests = unique([...graphTestCandidates, ...semanticTestCandidates])
    .filter((file) => /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\./i.test(file))
    .map((file) => ({
      file,
      score: baseNames.reduce((sum, name) => sum + (name && file.toLowerCase().includes(name) ? 2 : 0), 0) +
        terms.reduce((sum, term) => sum + (file.toLowerCase().includes(term) ? 1 : 0), 0),
    }))
    .filter((item) => item.score > 0 || semanticPaths.includes(item.file))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, 24)
    .map((item) => item.file)

  const instructions = await nearbyInstructions(root, declared)
  const ranked = semantic?.results?.length
    ? semantic.results.map((item) => ({
        path: item.path,
        score: item.score,
        matches: item.reasons || [],
        symbolHits: item.definitions || [],
        evidenceLevel: semantic.evidenceLevel,
      }))
    : useGraph
      ? await rankedReferences(root, graph.nodes, terms, declared, changed)
      : []
  const changedRelevant = changed
    .filter((file) =>
      declared.includes(file) ||
      semanticPaths.includes(file) ||
      graph.nodes.some((node) => node.path === file),
    )
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
  const categoryRemaining = {
    declared: evidenceBudget?.buckets?.declared ?? Math.round(budget * 0.42),
    test: evidenceBudget?.buckets?.tests ?? Math.round(budget * 0.20),
    instruction: evidenceBudget?.buckets?.instructions ?? Math.round(budget * 0.12),
    reference: evidenceBudget?.buckets?.references ?? Math.round(budget * 0.26),
  }
  const excerpts = []
  for (const file of priority) {
    if (remaining <= 0) break
    const isDeclared = declared.includes(file)
    const isTest = tests.includes(file)
    const isInstruction = instructions.includes(file)
    const role = isDeclared ? "declared" : isTest ? "test" : isInstruction ? "instruction" : "reference"
    const desired = isDeclared ? 6_000 : isTest ? 4_000 : isInstruction ? 3_000 : 2_500
    const category = Math.max(0, Number(categoryRemaining[role] || 0))
    if (category <= 0) continue
    const perFile = Math.min(desired, remaining, category)
    const item = await excerpt(root, file, perFile, terms)
    if (!item) continue
    remaining -= item.text.length
    categoryRemaining[role] = Math.max(0, categoryRemaining[role] - item.text.length)
    excerpts.push({
      ...item,
      role,
    })
  }

  return {
    schemaVersion: 4,
    task: task?.id || null,
    strategy,
    queryTerms: terms,
    declared,
    related: unique(related).filter((file) => !declared.includes(file)).slice(0, 30),
    tests,
    instructions,
    changed: changedRelevant,
    rankedReferences: ranked,
    files,
    excerpts,
    semantic: semantic ? {
      evidenceLevel: semantic.evidenceLevel,
      resultCount: semantic.results.length,
      stats: semantic.stats,
    } : null,
    graph: {
      enabled: useGraph,
      scannedFiles: graph.scannedFiles,
      truncated: graph.truncated,
      hotspots: graph.hotspots.slice(0, 12),
    },
    budget,
    evidenceBudget,
    categoryRemaining,
    used: budget - remaining,
  }
}

