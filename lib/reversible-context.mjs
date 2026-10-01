import { putEvidence, getEvidence, getEvidenceSelected } from "./evidence-store.mjs"
import { recordCompaction, recordCompactionRecall } from "./compaction-recall.mjs"

function normalize(value) { return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n") }
function significantLines(text) {
  const lines = normalize(text).split("\n")
  const scored = lines.map((line, index) => {
    const trimmed = line.trim(); let score = 0
    if (/^#{1,6}\s/.test(trimmed)) score += 8
    if (/^(?:[-*+] |\d+[.)]\s)/.test(trimmed)) score += 5
    if (/\b(?:error|fail|warning|todo|fixme|pass|test|result|summary|important|must|required)\b/i.test(trimmed)) score += 4
    if (/^(?:export|import|class|function|def|interface|type|CREATE|ALTER)\b/i.test(trimmed)) score += 3
    if (trimmed.length > 0 && trimmed.length <= 180) score += 1
    return { index, line, score }
  })
  return { lines, scored }
}
function summary(text, maxChars) {
  const { lines, scored } = significantLines(text)
  if (normalize(text).length <= maxChars) return normalize(text)
  const wanted = new Set(scored.filter((row) => row.score > 0).sort((a,b) => b.score - a.score || a.index - b.index).slice(0,80).map((row) => row.index))
  for (let i = Math.max(0, lines.length - 8); i < lines.length; i += 1) wanted.add(i)
  let out = ""
  for (const index of [...wanted].sort((a,b) => a-b)) {
    const candidate = (out ? out + "\n" : "") + lines[index]
    if (candidate.length > maxChars) break
    out = candidate
  }
  return out || normalize(text).slice(0, maxChars)
}
export async function compactContext(root, content, options = {}) {
  const raw = normalize(content)
  const stored = await putEvidence(root, raw, { kind: options.kind || "context-block", source: options.source || "ues-context", summary: options.summary || "Reversible raw context block" })
  const levels = { T1: summary(raw, Math.max(512, Number(options.t1Chars || 1600))), T2: summary(raw, Math.max(1200, Number(options.t2Chars || 5000))), T3: summary(raw, Math.max(2400, Number(options.t3Chars || 12000))) }
  await recordCompaction(root, { ref: stored.ref, reducer: options.reducer || options.kind || "context-heuristic", level: "T1/T2/T3", rawChars: raw.length, returnedChars: levels.T1.length, source: options.source || "ues-context" }).catch(() => null)
  return { schemaVersion: 1, ref: stored.ref, originalChars: raw.length, levels }
}
export async function expandContext(root, ref, options = {}) {
  const result = await getEvidenceSelected(root, ref, { start: Math.max(0, Number(options.start || 0)), maxBytes: Math.max(1, Math.min(128_000, Number(options.maxBytes || 16_000))) })
  await recordCompactionRecall(root, { ref, kind: "expand", start: result.start, returnedBytes: result.returnedBytes }).catch(() => null)
  return result
}
export async function searchContext(root, ref, query, options = {}) {
  const maxBytes = Math.max(16_000, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 512_000)))
  const evidence = await getEvidence(root, ref, { maxBytes })
  const source = normalize(evidence?.content ?? evidence ?? "")
  const terms = [...new Set(String(query || "").toLowerCase().split(/[^\p{L}\p{N}_$.-]+/u).filter((item) => item.length >= 2))].slice(0, 16)
  const lines = source.split("\n"); const radius = Math.max(0, Math.min(12, Number(options.radius || 2))); const maxMatches = Math.max(1, Math.min(50, Number(options.maxMatches || 10))); const hits = []
  for (let index = 0; index < lines.length && hits.length < maxMatches; index += 1) {
    const lower = lines[index].toLowerCase(); const matched = terms.filter((term) => lower.includes(term)); if (!matched.length) continue
    hits.push({ line: index + 1, terms: matched, excerpt: lines.slice(Math.max(0,index-radius), Math.min(lines.length,index+radius+1)).join("\n") })
  }
  const result = { schemaVersion: 1, ref, query: String(query || ""), terms, hits, truncatedSource: source.length >= maxBytes }
  await recordCompactionRecall(root, { ref, kind: "search", query, returnedBytes: Buffer.byteLength(JSON.stringify(hits), "utf8") }).catch(() => null)
  return result
}
