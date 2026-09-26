import { createHash } from "node:crypto"

const DEFAULT_HASH_CHARS = 8

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

function hashText(value, chars = DEFAULT_HASH_CHARS) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, Math.max(6, Math.min(16, Number(chars || DEFAULT_HASH_CHARS))))
}

export function lineAnchor(lineNumber, lineText, options = {}) {
  const line = Math.max(1, Math.trunc(Number(lineNumber || 1)))
  return `L${line}:${hashText(lineText, options.hashChars)}`
}

export function parseLineAnchor(anchor) {
  const match = String(anchor || "").trim().match(/^L([1-9]\d*):([a-f0-9]{6,16})$/i)
  if (!match) return null
  return { line: Number(match[1]), hash: match[2].toLowerCase() }
}

export function anchoredLines(source, options = {}) {
  const text = normalizeNewlines(source)
  const lines = text.split("\n")
  const startLine = Math.max(1, Math.trunc(Number(options.startLine || 1)))
  const requestedEnd = options.endLine == null ? lines.length : Math.trunc(Number(options.endLine))
  const endLine = Math.max(startLine, Math.min(lines.length, requestedEnd || lines.length))
  const rows = []
  for (let line = startLine; line <= endLine; line += 1) {
    const value = lines[line - 1] ?? ""
    rows.push({ line, anchor: lineAnchor(line, value, options), text: value })
  }
  return {
    schemaVersion: 1,
    startLine,
    endLine,
    lineCount: lines.length,
    sourceHash: hashText(text, 16),
    rows,
    text: rows.map((row) => `${row.anchor}|${row.text}`).join("\n"),
  }
}

function validateAnchor(lines, rawAnchor, label, options = {}) {
  const parsed = parseLineAnchor(rawAnchor)
  if (!parsed) throw new Error(`${label} must use L<line>:<hash> format`)
  if (parsed.line > lines.length) throw new Error(`${label} points beyond end of file`)
  const actual = lineAnchor(parsed.line, lines[parsed.line - 1] ?? "", options)
  if (actual.toLowerCase() !== String(rawAnchor).toLowerCase()) {
    const error = new Error(`${label} is stale or ambiguous; re-read anchored source before editing`)
    error.code = "UES_STALE_ANCHOR"
    error.expected = actual
    error.received = String(rawAnchor)
    throw error
  }
  return parsed
}

export function applyAnchoredEdits(source, edits = [], options = {}) {
  const text = normalizeNewlines(source)
  const lines = text.split("\n")
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("at least one anchored edit is required")
  const maxEdits = Math.max(1, Math.min(200, Number(options.maxEdits || 50)))
  if (edits.length > maxEdits) throw new Error(`too many anchored edits; maximum is ${maxEdits}`)

  const prepared = edits.map((edit, index) => {
    const start = validateAnchor(lines, edit?.anchor || edit?.startAnchor, `edit[${index}].anchor`, options)
    const end = edit?.endAnchor
      ? validateAnchor(lines, edit.endAnchor, `edit[${index}].endAnchor`, options)
      : start
    if (end.line < start.line) throw new Error(`edit[${index}] endAnchor precedes anchor`)
    return {
      index,
      startLine: start.line,
      endLine: end.line,
      replacement: normalizeNewlines(edit?.replacement ?? ""),
    }
  })

  prepared.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine)
  for (let index = 1; index < prepared.length; index += 1) {
    if (prepared[index].startLine <= prepared[index - 1].endLine) {
      throw new Error(`anchored edits overlap at edit[${prepared[index].index}]`)
    }
  }

  const next = [...lines]
  for (const edit of [...prepared].sort((a, b) => b.startLine - a.startLine)) {
    const replacementLines = edit.replacement.split("\n")
    next.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacementLines)
  }
  const output = next.join("\n")
  return {
    schemaVersion: 1,
    sourceHash: hashText(text, 16),
    outputHash: hashText(output, 16),
    applied: prepared.length,
    text: output,
  }
}
