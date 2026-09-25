import { putEvidence } from "./evidence-store.mjs"

const DEFAULT_LIMIT = 64 * 1024
const SIGNAL_LINE = /\b(error|errors|failed|failure|fail|fatal|exception|warning|warn|assert|timeout|timed out|panic|traceback|mismatch|conflict|rejected|passed|pass|tests?|exit(?: code)?|changed)\b/i

function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function uniqueSignalLines(text, limit = 48) {
  const seen = new Set()
  const rows = []
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || !SIGNAL_LINE.test(line) || seen.has(line)) continue
    seen.add(line)
    rows.push(line)
    if (rows.length >= limit) break
  }
  return rows
}

function testSummaryLines(source, limit = 80) {
  const rows = []
  const seen = new Set()
  const patterns = [
    /^FAIL\b/i,
    /^PASS\b/i,
    /^Test Suites:/i,
    /^Tests:/i,
    /^Snapshots:/i,
    /^Time:/i,
    /^Ran all test suites/i,
    /Jest did not exit/i,
    /Exceeded timeout/i,
    /^\s*●\s+/,
    /^\s*at\s+.+:\d+:\d+/,
    /(?:AssertionError|Expected|Received|Traceback|panic:|FAILED\s)/i,
  ]
  for (const raw of String(source || "").split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || seen.has(line) || !patterns.some((re) => re.test(line))) continue
    seen.add(line)
    rows.push(line)
    if (rows.length >= limit) break
  }
  return rows
}

function gitSummaryLines(source, limit = 120) {
  const rows = []
  for (const raw of String(source || "").split(/\r?\n/)) {
    if (
      /^diff --git /.test(raw) ||
      /^@@ /.test(raw) ||
      /^(?:---|\+\+\+) /.test(raw) ||
      /^fatal:/i.test(raw) ||
      /^error:/i.test(raw) ||
      /^CONFLICT\b/i.test(raw)
    ) {
      rows.push(raw)
      if (rows.length >= limit) break
    }
  }
  return rows
}


function lintSummaryLines(source, limit = 100) {
  const rows = []
  const seen = new Set()
  const patterns = [
    /\b(?:error|warning)\b/i,
    /\b\d+\s+problems?\b/i,
    /\b\d+\s+errors?\b/i,
    /\b\d+\s+warnings?\b/i,
    /\b(?:eslint|ruff|flake8|pylint|clippy)\b/i,
    /:\d+:\d+\b/,
    /^✖\s+/,
  ]
  for (const raw of String(source || "").split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || seen.has(line) || !patterns.some((pattern) => pattern.test(line))) continue
    seen.add(line)
    rows.push(line)
    if (rows.length >= limit) break
  }
  return rows
}

function buildSummaryLines(source, limit = 100) {
  const rows = []
  const seen = new Set()
  const patterns = [
    /\berror\s+TS\d+\b/i,
    /\b(?:compile|compiled|compilation|build)\b.*\b(?:failed|success|succeeded|complete|completed)\b/i,
    /\b(?:failed|fatal|exception|panic)\b/i,
    /\bwarning\b/i,
    /:\d+:\d+\b/,
    /\b(?:ELIFECYCLE|ERR_|exit code)\b/i,
  ]
  for (const raw of String(source || "").split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (!line || seen.has(line) || !patterns.some((pattern) => pattern.test(line))) continue
    seen.add(line)
    rows.push(line)
    if (rows.length >= limit) break
  }
  return rows
}

function jsonSummaryLines(source, limit = 80) {
  const text = String(source || "").trim()
  if (!text || text.length > 4 * 1024 * 1024 || !/^[\[{]/.test(text)) return []
  let value
  try { value = JSON.parse(text) } catch { return [] }

  const rows = []
  const visit = (current, prefix, depth) => {
    if (rows.length >= limit || depth > 3) return
    if (Array.isArray(current)) {
      rows.push(`${prefix || "$"}: array(${current.length})`)
      current.slice(0, 8).forEach((item, index) => visit(item, `${prefix || "$"}[${index}]`, depth + 1))
      return
    }
    if (current && typeof current === "object") {
      const keys = Object.keys(current)
      rows.push(`${prefix || "$"}: object(${keys.length}) keys=[${keys.slice(0, 16).join(", ")}]`)
      for (const key of keys.slice(0, 12)) {
        visit(current[key], prefix ? `${prefix}.${key}` : key, depth + 1)
        if (rows.length >= limit) break
      }
      return
    }
    const rendered = JSON.stringify(current)
    rows.push(`${prefix || "$"}: ${String(rendered).slice(0, 160)}`)
  }
  visit(value, "", 0)
  return rows
}

function structuredSignalLines(source, options = {}) {
  const hint = String(options.kind || options.source || options.command || "").toLowerCase()
  if (/(jest|vitest|pytest|test|spec)/.test(hint)) {
    const rows = testSummaryLines(source)
    if (rows.length) return { kind: "test", rows }
  }
  if (/(eslint|lint|ruff|flake8|pylint|clippy)/.test(hint)) {
    const rows = lintSummaryLines(source)
    if (rows.length) return { kind: "lint", rows }
  }
  if (/(typecheck|tsc|compile|build|gradle|maven|cargo check|dotnet build)/.test(hint)) {
    const rows = buildSummaryLines(source)
    if (rows.length) return { kind: "build", rows }
  }
  if (/(git|diff|status)/.test(hint)) {
    const rows = gitSummaryLines(source)
    if (rows.length) return { kind: "git", rows }
  }
  if (/(json|--json)/.test(hint) || /^[\s]*[\[{]/.test(String(source || ""))) {
    const rows = jsonSummaryLines(source)
    if (rows.length) return { kind: "json", rows }
  }
  const rows = uniqueSignalLines(source)
  return { kind: rows.length ? "signal" : "generic", rows }
}

function boundedPreview(text, maxChars, options = {}) {
  const source = String(text || "")
  const headBudget = Math.max(2048, Math.floor(maxChars * 0.24))
  const tailBudget = Math.max(4096, Math.floor(maxChars * 0.30))
  const signalBudget = Math.max(2048, maxChars - headBudget - tailBudget - 1800)
  const head = source.slice(0, headBudget)
  const tail = source.slice(Math.max(head.length, source.length - tailBudget))
  const structured = structuredSignalLines(source, options)
  let signalText = structured.rows.join("\n")
  if (signalText.length > signalBudget) signalText = signalText.slice(0, signalBudget) + "\n...[signal lines truncated]"
  return { head, tail, signalText, signalKind: structured.kind }
}

export async function compactReversibleOutput(root, text, options = {}) {
  const source = String(text ?? "")
  const maxChars = clampInt(options.maxChars, DEFAULT_LIMIT, 8 * 1024, 256 * 1024)
  if (source.length <= maxChars) {
    return {
      schemaVersion: 1,
      compacted: false,
      strategy: "raw",
      originalChars: source.length,
      returnedChars: source.length,
      evidenceRef: null,
      text: source,
    }
  }

  const evidence = await putEvidence(root, source, {
    kind: options.kind || "raw-tool-output",
    source: options.source || "ues-performance-fabric",
    summary: options.summary || `Raw output preserved before model-visible compaction (${source.length} chars)`,
  })
  const { head, tail, signalText, signalKind } = boundedPreview(source, maxChars, options)
  const recovery = `Raw captured output: ${evidence.ref}. Recover exact captured bytes in slices with: ues store get ${evidence.ref} --start N --max 24000`
  let preview = [
    `[UES reversible output compaction: ${source.length} -> <=${maxChars} chars; reducer=${signalKind}]`,
    recovery,
    "",
    "--- head ---",
    head,
    signalText ? "\n--- high-signal lines ---\n" + signalText : "",
    "\n--- tail ---",
    tail,
  ].filter(Boolean).join("\n")
  if (preview.length > maxChars) {
    const reserve = Math.min(1400, recovery.length + 160)
    preview = preview.slice(0, Math.max(0, maxChars - reserve)) + `\n...[model-visible preview truncated]\n${recovery}`
  }

  return {
    schemaVersion: 1,
    compacted: true,
    strategy: `reversible-head-${signalKind}-tail`,
    originalChars: source.length,
    returnedChars: preview.length,
    evidenceRef: evidence.ref,
    text: preview,
  }
}