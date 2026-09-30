// Deterministic retrieval scoring shared by the repo-map benchmark and the
// repo-map regression tests.
//
// A ranking gate is only as good as its metric. Every function here is pure,
// order-stable and free of wall-clock input so a before/after run is comparable
// byte-for-byte. "Irrelevant" is defined against the fixture's own expected set,
// not against a hand-tuned allow list, so the number cannot be gamed by shrinking
// the answer key.

import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const RETRIEVAL_QUERY_FILE = path.join(HERE, "queries.json")

export async function loadRetrievalQueries(file = RETRIEVAL_QUERY_FILE) {
  const parsed = JSON.parse(await readFile(file, "utf8"))
  const queries = Array.isArray(parsed.queries) ? parsed.queries : []
  return queries.map((row) => ({
    id: String(row.id || ""),
    class: String(row.class || "unclassified"),
    query: String(row.query || ""),
    primary: row.primary == null ? null : String(row.primary),
    expect: (row.expect || []).map((value) => String(value)).sort(),
    declared: (row.declared || []).map((value) => String(value)),
    changed: (row.changed || []).map((value) => String(value)),
  }))
}

function rankOf(entries, target) {
  const index = entries.findIndex((entry) => (entry && entry.path ? entry.path : entry) === target)
  return index < 0 ? 0 : index + 1
}

export function scoreRetrievalRun(cases) {
  const rows = []
  for (const item of cases) {
    const ranked = item.ranked || []
    const relevant = new Set(item.expect || [])
    const hitsAt = (k) => ranked.slice(0, k).filter((entry) => relevant.has(entry.path || entry)).length
    const irrelevant = ranked.filter((entry) => {
      const file = entry.path || entry
      return file && !relevant.has(file)
    }).length
    const primary = item.primary == null ? 0 : rankOf(ranked, item.primary)
    rows.push({
      id: item.id,
      class: item.class,
      recallAt1: relevant.size ? hitsAt(1) / relevant.size : 0,
      recallAt3: relevant.size ? hitsAt(3) / relevant.size : 0,
      recallAt5: relevant.size ? hitsAt(5) / relevant.size : 0,
      primaryRank: primary,
      reciprocalRank: primary ? 1 / primary : 0,
      irrelevant,
      contextChars: Number(item.contextChars || 0),
      buildMs: Number(item.buildMs || 0),
      queryMs: Number(item.queryMs || 0),
      selected: ranked.length,
    })
  }

  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
  return {
    schemaVersion: 1,
    kind: "ues-retrieval-quality",
    queries: rows.length,
    rows,
    summary: {
      recallAt1: Number(mean(rows.map((row) => row.recallAt1)).toFixed(6)),
      recallAt3: Number(mean(rows.map((row) => row.recallAt3)).toFixed(6)),
      recallAt5: Number(mean(rows.map((row) => row.recallAt5)).toFixed(6)),
      mrr: Number(mean(rows.map((row) => row.reciprocalRank)).toFixed(6)),
      primaryHitRate: Number(mean(rows.map((row) => (row.primaryRank === 1 ? 1 : 0))).toFixed(6)),
      irrelevantPerQuery: Number(mean(rows.map((row) => row.irrelevant)).toFixed(4)),
      contextCharsPerQuery: Number(mean(rows.map((row) => row.contextChars)).toFixed(2)),
      buildMs: Number(mean(rows.map((row) => row.buildMs)).toFixed(3)),
      queryMs: Number(mean(rows.map((row) => row.queryMs)).toFixed(3)),
    },
  }
}
