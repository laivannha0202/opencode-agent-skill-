import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { buildSemanticIndex, querySemanticIndex } from "./semantic-index.mjs"

function safeFull(root, relative) {
  const base = path.resolve(root)
  const full = path.resolve(base, relative)
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error("path escapes repository root")
  }
  return full
}

export async function aciSearch(root, query, options = {}) {
  const result = await querySemanticIndex(root, query, {
    limit: options.limit ?? 20,
    rebuild: options.rebuild === true,
  })
  return {
    ...result,
    contract: {
      evidenceOnly: true,
      note: "Results are deterministic syntax-aware lexical evidence, not a claim of semantic correctness.",
    },
  }
}

export async function aciReferences(root, symbol, options = {}) {
  const name = String(symbol || "").trim()
  if (!/^[A-Za-z_$][A-Za-z0-9_$.-]*$/.test(name)) {
    throw new Error("reference symbol must be a concrete identifier")
  }
  const built = await buildSemanticIndex(root, { rebuild: options.rebuild === true })
  const results = []
  for (const [file, entry] of Object.entries(built.index.files)) {
    const exact = Number(entry.identifiers?.[name] || 0)
    const folded = exact || Object.entries(entry.identifiers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || 0
    const definitions = (entry.symbols || []).filter((item) => String(item.name).toLowerCase() === name.toLowerCase())
    if (!folded && !definitions.length) continue
    results.push({
      path: file,
      references: Number(folded || 0),
      definitions: definitions.slice(0, 12),
      evidence: definitions.length ? "definition+lexical-reference" : "lexical-reference",
    })
  }
  results.sort((a, b) => (b.definitions.length - a.definitions.length) || b.references - a.references || a.path.localeCompare(b.path))
  return {
    schemaVersion: 1,
    symbol: name,
    evidenceLevel: "syntax-aware-lexical",
    results: results.slice(0, Math.max(1, Math.min(Number(options.limit || 40), 200))),
    stats: built.stats,
  }
}

export async function aciView(root, relative, options = {}) {
  root = path.resolve(root)
  const full = safeFull(root, relative)
  const info = await stat(full).catch(() => null)
  if (!info?.isFile()) throw new Error("file does not exist: " + relative)
  const maxBytes = Math.max(4 * 1024, Math.min(Number(options.maxBytes || 256 * 1024), 1024 * 1024))
  if (info.size > maxBytes) throw new Error("file exceeds bounded viewer limit; request a smaller generated artifact or use repository-native tooling")
  const source = await readFile(full, "utf8")
  if (source.includes("\0")) throw new Error("binary file is not supported by bounded viewer")
  const lines = source.split(/\r?\n/)
  const center = Math.max(1, Number(options.line || 1))
  const count = Math.max(1, Math.min(Number(options.lines || 120), 240))
  const start = Math.max(1, Math.min(
    Number(options.startLine || 0) || (center - Math.floor(count / 3)),
    Math.max(1, lines.length),
  ))
  const end = Math.min(lines.length, start + count - 1)
  const width = String(end).length
  return {
    schemaVersion: 1,
    path: path.relative(root, full).replaceAll("\\", "/"),
    startLine: start,
    endLine: end,
    totalLines: lines.length,
    truncated: start > 1 || end < lines.length,
    text: lines.slice(start - 1, end)
      .map((line, index) => String(start + index).padStart(width, " ") + " | " + line)
      .join("\n"),
  }
}

export async function aciTextSearch(root, query, options = {}) {
  const value = String(query || "").trim()
  if (value.length < 2) throw new Error("search query must contain at least two characters")
  const candidateLimit = Math.max(1, Math.min(Number(options.candidateLimit || 500), 5000))
  const resultLimit = Math.max(1, Math.min(Number(options.limit || 80), 200))
  const semantic = await querySemanticIndex(root, value, { limit: Math.min(candidateLimit, 100) })
  const built = await buildSemanticIndex(root)
  const allIndexed = Object.entries(built.index.files)
    .filter(([, entry]) => !entry?.skipped)
    .map(([file]) => file)
  const candidates = [...new Set([
    ...semantic.results.map((item) => item.path),
    ...allIndexed,
  ])].slice(0, candidateLimit)
  const matches = []
  const needle = options.caseSensitive ? value : value.toLowerCase()
  for (const file of candidates) {
    const full = safeFull(root, file)
    const source = await readFile(full, "utf8").catch(() => "")
    if (!source) continue
    const lines = source.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const haystack = options.caseSensitive ? lines[index] : lines[index].toLowerCase()
      if (!haystack.includes(needle)) continue
      matches.push({ path: file, line: index + 1, preview: lines[index].trim().slice(0, 300) })
      if (matches.length >= resultLimit) break
    }
    if (matches.length >= resultLimit) break
  }
  return {
    schemaVersion: 1,
    query: value,
    evidenceLevel: "exact-text",
    matches,
    candidatesScanned: candidates.length,
    candidatePool: allIndexed.length,
    candidateTruncated: candidates.length < allIndexed.length,
    resultsTruncated: matches.length >= resultLimit,
    semanticStats: built.stats,
  }
}
