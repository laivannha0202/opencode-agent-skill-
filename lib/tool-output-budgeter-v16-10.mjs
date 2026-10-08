// V16.10 Tool Output Budgeter.
//
// WHY THIS MODULE EXISTS
//
// The runtime already owns noise compression (`tool-output-economy-v16-6`) and
// reversible head/tail compaction (`performance-fabric.compactReversibleOutput`),
// but the SHAPING of a specific tool result - "show this symbol", "show these
// search hits", "show only the failing test" - was still done ad-hoc at each
// call site: `ues.ts` slices a read preview by character count, the child
// runtime slices a payload, and every new tool invents its own truncation. A
// second truncator is a second owner, and a truncator that drops signal without
// saying so is worse than no truncator at all.
//
// This module is the SINGLE owner of "what does the model actually see for this
// tool result, and what did we hide?". It does not re-implement compression: it
// is a PURE shaping function that the governor and the code-intelligence surface
// delegate to. It guarantees, by construction:
//
//   * TRUNCATION HONESTY: a shortened result ALWAYS carries original size,
//     visible size, omitted amount and a retrieval handle, so it can never be
//     mistaken for the complete output.
//   * HEAD/TAIL PRESERVATION: code and logs keep both ends (definitions and
//     failures live at both ends), never a blind prefix cut.
//   * TOOL-SPECIFIC SHAPE: a read shows a symbol body or a bounded line window;
//     a search shows concise routing rows; a test shows the failure, not the
//     thousands of passing lines; a diff shows changed files and hunks.
//   * EXPANSION: every truncation reports HOW to get more (more lines, an exact
//     symbol, another range, the full body). Quality is never blocked by the
//     budget because the budget is always reversible.
//   * STRUCTURAL PAIR SAFETY: `assertToolPairIntegrity` proves a reduced
//     conversation never contains a tool result without its call, or a call
//     without its required result.
//
// It owns NO evidence store, NO filesystem access and NO model call. The caller
// preserves the exact bytes (Evidence Store / reversible context) and passes the
// resulting handle in; the budgeter only shapes the model-visible view.

import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const TOOL_OUTPUT_BUDGETER_SCHEMA_VERSION = 1
export const TOOL_OUTPUT_BUDGETER_POLICY = "tool-output-budgeter-v16-10"

/** Tool-specific shaping strategies. One result has exactly one strategy. */
export const TOOL_OUTPUT_STRATEGY = Object.freeze({
  READ_FILE: "read-file",
  SEARCH: "search",
  TEST: "test",
  DIFF: "diff",
  GENERIC: "generic",
})

// A focused view, not a hard-coded universal number. The directive is explicit
// that 100 lines must not be a magic constant: the default window is a policy
// value the caller can raise or lower, and it is reported in the receipt.
export const DEFAULT_READ_WINDOW_LINES = 120
export const DEFAULT_SEARCH_MAX_RESULTS = 30
export const DEFAULT_TEST_STACK_FRAMES = 12
export const DEFAULT_DIFF_MAX_HUNKS = 40

const TEST_FAIL_PATTERN =
  /(?:^|\s)(?:not ok\b|FAIL\b|FAILED\b|✗|✖|✘|AssertionError|assertion failed|expected .* (?:to|but)|Error:|Exception:|Traceback|panic:)/i
const TEST_PASS_PATTERN = /^(?:ok\b|PASS\b|✓|✔|# pass\b|# tests\b|# fail\b|# suites\b)/i
const STACK_FRAME_PATTERN = /^\s*at\s|^\s+File "|^\s*\.{3}\s*\d+\s+more/
const DIFF_FILE_PATTERN = /^diff --git /
const DIFF_HUNK_PATTERN = /^@@ /
const SEARCH_ROW_PATTERN = /^(.+?):(\d+)(?::(\d+))?:(.*)$/

function str(value) {
  return String(value ?? "")
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function lineCountOf(text) {
  if (!text) return 0
  return str(text).split(/\r?\n/).length
}

/**
 * The structured omission notice. It is deliberately machine-readable and
 * always names the original size, the visible size, the omitted amount and the
 * retrieval handle, so a reader can never mistake a bounded view for the whole.
 */
export function omissionNotice(fields = {}) {
  const original = Number(fields.originalChars || 0)
  const visible = Number(fields.visibleChars || 0)
  const omitted = Math.max(0, Number(fields.omittedChars ?? original - visible))
  const unit = str(fields.unit || "chars")
  const handle = fields.handle ? ` retrieve=${fields.handle}` : ""
  const extra = fields.note ? `; ${fields.note}` : ""
  return `...[UES V16.10 output budget: ${unit} omitted; original=${original} visible=${visible} omitted=${omitted}${handle}${extra}]`
}

/**
 * Pick the strategy for a tool result. Deterministic: it reads the tool name
 * and, only when the tool name is unknown, falls back to the content shape. It
 * never consults a model and never guesses confidence.
 */
export function resolveStrategy(toolName, text, options = {}) {
  const name = str(toolName || options.kind || "").toLowerCase()
  if (options.strategy) return String(options.strategy)
  if (/ues_code/.test(name) && /read|context-expand/.test(name)) return TOOL_OUTPUT_STRATEGY.READ_FILE
  if (/(^|[_:.])(read|cat|view|open)([_:.]|$)/.test(name)) return TOOL_OUTPUT_STRATEGY.READ_FILE
  if (/(^|[_:.])(grep|search|find|rg|ripgrep|glob)([_:.]|$)/.test(name)) return TOOL_OUTPUT_STRATEGY.SEARCH
  if (/(^|[_:.])(test|jest|vitest|pytest|mocha|ava)([_:.]|$)/.test(name)) return TOOL_OUTPUT_STRATEGY.TEST
  if (/(^|[_:.])(diff|git-diff)([_:.]|$)/.test(name)) return TOOL_OUTPUT_STRATEGY.DIFF
  const source = str(text)
  if (DIFF_FILE_PATTERN.test(source)) return TOOL_OUTPUT_STRATEGY.DIFF
  if (/^(?:ok |not ok |PASS |FAIL )/m.test(source) && /# (?:tests|pass|fail)\b/.test(source)) return TOOL_OUTPUT_STRATEGY.TEST
  if (source.split(/\r?\n/).filter(Boolean).every((line) => SEARCH_ROW_PATTERN.test(line)) && source.split(/\r?\n/).filter(Boolean).length > 1) {
    return TOOL_OUTPUT_STRATEGY.SEARCH
  }
  return TOOL_OUTPUT_STRATEGY.GENERIC
}

function headTail(text, options = {}) {
  const source = str(text)
  const budget = boundedInt(options.budgetChars, 12_000, 512, 512_000)
  if (source.length <= budget) return { text: source, truncated: false, omittedChars: 0 }
  // V16.14: the omission notice we append is part of the model-visible output,
  // so it must be budgeted too. We reserve room for it, size head/tail from the
  // remaining budget, and then SHRINK until the shaped result provably fits -
  // a fixed reserve is only an estimate because the notice text itself varies
  // with the numbers it reports.
  const buildShaped = (headBudget, tailBudget) => {
    const head = source.slice(0, Math.max(0, headBudget))
    const tail = tailBudget > 0 ? source.slice(Math.max(head.length, source.length - tailBudget)) : ""
    return { head, tail, omittedChars: Math.max(0, source.length - head.length - tail.length) }
  }
  const noticeReserve = Math.max(0, Math.min(400, Math.floor(budget * 0.25)))
  const contentBudget = Math.max(1, budget - noticeReserve)
  let headBudget = Math.max(1, Math.floor(contentBudget * (options.headRatio ?? 0.6)))
  let tailBudget = Math.max(1, contentBudget - headBudget)
  let shaped = buildShaped(headBudget, tailBudget)
  // The notice is bounded and deterministic; converge in a few deterministic
  // passes instead of guessing a reserve that may be too small.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = omissionNotice({
      originalChars: source.length,
      visibleChars: shaped.head.length + shaped.tail.length,
      omittedChars: shaped.omittedChars,
      handle: options.handle || null,
    })
    const total = shaped.head.length + shaped.tail.length + probe.length + 2
    if (total <= budget) break
    const overflow = total - budget
    if (headBudget + tailBudget <= overflow) break
    if (headBudget >= tailBudget) headBudget = Math.max(0, headBudget - overflow)
    else tailBudget = Math.max(0, tailBudget - overflow)
    shaped = buildShaped(headBudget, tailBudget)
  }
  return { head: shaped.head, tail: shaped.tail, truncated: true, omittedChars: shaped.omittedChars }
}

/**
 * READ shaping.
 *
 * Hierarchy (matching the directive):
 *   1. exact symbol body + minimal surrounding context, when a symbol range is
 *      supplied;
 *   2. a bounded line window when an exact range is supplied;
 *   3. structure-first: a head window (declarations usually live near the top)
 *      plus a tail window, so both the API and the closing logic survive.
 * The model can always expand: the receipt names the range it showed and the
 * total line count.
 */
export function shapeReadFileOutput(text, options = {}) {
  const source = str(text)
  const maxLines = boundedInt(options.maxLines, DEFAULT_READ_WINDOW_LINES, 20, 2_000)
  const lines = source.split(/\r?\n/)
  const total = lines.length
  const startLine = Number(options.startLine)
  const endLine = Number(options.endLine)
  const hasRange = Number.isFinite(startLine) && Number.isFinite(endLine) && endLine >= startLine
  const symbolRange = options.symbolRange && Number.isFinite(Number(options.symbolRange.startLine))
    ? options.symbolRange
    : null

  if (total <= maxLines) {
    return {
      text: source,
      truncated: false,
      omittedChars: 0,
      shownLines: { start: 1, end: total },
      totalLines: total,
      expansion: null,
      note: "complete",
    }
  }

  let windowStart
  let windowEnd
  let mode
  if (symbolRange) {
    const pad = boundedInt(options.symbolPadding, 6, 0, 60)
    windowStart = Math.max(1, Math.trunc(Number(symbolRange.startLine)) - pad)
    windowEnd = Math.min(total, Math.trunc(Number(symbolRange.endLine ?? symbolRange.startLine)) + pad)
    mode = "symbol"
  } else if (hasRange) {
    windowStart = Math.max(1, Math.trunc(startLine))
    windowEnd = Math.min(total, Math.max(windowStart, Math.trunc(endLine)))
    mode = "range"
  } else {
    // Structure-first: head + tail. Both ends matter for code and logs.
    const headLines = Math.max(1, Math.floor(maxLines * 0.65))
    const tailLines = Math.max(1, maxLines - headLines)
    const head = lines.slice(0, headLines).join("\n")
    const tail = lines.slice(Math.max(headLines, total - tailLines)).join("\n")
    const notice = omissionNotice({
      originalChars: source.length,
      visibleChars: head.length + tail.length,
      omittedChars: source.length - head.length - tail.length,
      unit: `lines ${headLines + 1}-${total - tailLines}`,
      handle: options.handle || null,
      note: `showing head 1-${headLines} and tail ${total - tailLines + 1}-${total} of ${total}; request exact symbol/range or full read for the middle`,
    })
    const body = `${head}\n${notice}\n${tail}`
    return {
      text: body,
      truncated: true,
      omittedChars: source.length - head.length - tail.length,
      shownLines: { start: 1, end: total, gaps: [[headLines + 1, total - tailLines]] },
      totalLines: total,
      mode: "head-tail",
      expansion: { kind: "range", totalLines: total, hint: "ues_code read with startLine/endLine" },
      note: "head-tail",
    }
  }

  if (windowEnd - windowStart + 1 > maxLines) windowEnd = windowStart + maxLines - 1
  const window = lines.slice(windowStart - 1, windowEnd).join("\n")
  const before = windowStart > 1
  const after = windowEnd < total
  const omittedChars = source.length - window.length
  const parts = []
  if (before) {
    parts.push(omissionNotice({ originalChars: source.length, visibleChars: window.length, omittedChars, unit: `lines 1-${windowStart - 1}`, handle: options.handle || null }))
  }
  parts.push(window)
  if (after) {
    parts.push(omissionNotice({ originalChars: source.length, visibleChars: window.length, omittedChars, unit: `lines ${windowEnd + 1}-${total}`, handle: options.handle || null }))
  }
  return {
    text: parts.join("\n"),
    truncated: before || after,
    omittedChars,
    shownLines: { start: windowStart, end: windowEnd },
    totalLines: total,
    mode,
    expansion: {
      kind: mode === "symbol" ? "symbol" : "range",
      totalLines: total,
      hint: "request a larger range or an exact symbol; full read available on explicit request",
    },
    note: mode,
  }
}

/**
 * SEARCH shaping. A search result is ROUTING information, not a document dump:
 * path, line, symbol and a short preview only. Surrounding context is never
 * inlined for every hit; the model expands the rows it chooses.
 */
export function shapeSearchOutput(text, options = {}) {
  const source = str(text)
  const maxResults = boundedInt(options.maxResults, DEFAULT_SEARCH_MAX_RESULTS, 1, 500)
  const lines = source.split(/\r?\n/)
  const rows = []
  const passthrough = []
  for (const line of lines) {
    const match = line.match(SEARCH_ROW_PATTERN)
    if (match && match[1] && !/^[A-Za-z]:$/.test(match[1])) {
      const preview = str(match[4]).trim()
      rows.push({
        path: match[1].replaceAll("\\", "/"),
        line: Number(match[2]),
        column: match[3] ? Number(match[3]) : null,
        preview: preview.length > 160 ? preview.slice(0, 160) + "…" : preview,
      })
    } else if (line.trim()) {
      passthrough.push(line)
    }
  }
  if (!rows.length) {
    // Not a recognizable row format: fall back to bounded generic shaping.
    const shaped = headTail(source, { budgetChars: options.budgetChars })
    return {
      text: shaped.truncated
        ? `${shaped.head}\n${omissionNotice({ originalChars: source.length, visibleChars: shaped.head.length + shaped.tail.length, handle: options.handle || null })}\n${shaped.tail}`
        : source,
      truncated: shaped.truncated,
      omittedChars: shaped.omittedChars,
      rows: [],
      totalRows: 0,
      mode: "generic-fallback",
    }
  }
  const selected = rows.slice(0, maxResults)
  const omitted = rows.length - selected.length
  const header = `[search rows: total=${rows.length} shown=${selected.length}${omitted > 0 ? ` omitted=${omitted}` : ""}]`
  const body = selected.map((row) => `${row.path}:${row.line}${row.column ? `:${row.column}` : ""}: ${row.preview}`)
  const text_out = [header, ...body].join("\n")
  return {
    text: omitted > 0
      ? `${text_out}\n${omissionNotice({ originalChars: source.length, visibleChars: text_out.length, unit: `rows ${maxResults + 1}-${rows.length}`, handle: options.handle || null, note: "expand a specific row instead of dumping every hit" })}`
      : text_out,
    truncated: omitted > 0,
    omittedChars: source.length - text_out.length,
    rows: selected,
    totalRows: rows.length,
    mode: "routing-rows",
    expansion: { kind: "row", hint: "ues_code read at a specific path:line" },
  }
}

/**
 * TEST shaping.
 *
 * A failing run exposes the failing command, exit code, failed test names, the
 * first assertion, the root error and bounded stack frames. A large PASSING run
 * collapses to a count summary. Thousands of passing lines are never re-sent.
 */
export function shapeTestOutput(text, options = {}) {
  const source = str(text)
  const lines = source.split(/\r?\n/)
  const failed = []
  const failures = []
  const stack = []
  let passCount = null
  let failCount = null
  let totalCount = null
  let sawFailure = false
  for (const line of lines) {
    const trimmed = line.trim()
    const passMatch = trimmed.match(/^# pass\s+(\d+)/i)
    if (passMatch) passCount = Number(passMatch[1])
    const failMatch = trimmed.match(/^# fail\s+(\d+)/i)
    if (failMatch) failCount = Number(failMatch[1])
    const testsMatch = trimmed.match(/^# tests\s+(\d+)/i)
    if (testsMatch) totalCount = Number(testsMatch[1])
    if (TEST_FAIL_PATTERN.test(trimmed)) {
      sawFailure = true
      if (/^(?:not ok\b|FAIL\b|✗|✖|✘)/i.test(trimmed)) failed.push(trimmed.slice(0, 200))
      else if (failures.length < 20) failures.push(trimmed.slice(0, 400))
    }
    if (sawFailure && STACK_FRAME_PATTERN.test(line) && stack.length < DEFAULT_TEST_STACK_FRAMES) {
      stack.push(line.slice(0, 300))
    }
  }

  const failing = failCount != null ? failCount > 0 : sawFailure
  if (!failing) {
    const summary = {
      command: options.command || null,
      passed: passCount,
      failed: failCount ?? 0,
      skipped: null,
      total: totalCount,
      duration: options.durationMs ?? null,
      workspaceHash: options.workspaceHash ?? null,
    }
    const header = `[test summary: passed=${summary.passed ?? "?"} failed=${summary.failed} total=${summary.total ?? "?"}${options.durationMs != null ? ` durationMs=${options.durationMs}` : ""}]`
    // Honest truncation: the passing lines were collapsed, so the reader must be
    // told how much was hidden and how to retrieve it - never a silent summary.
    const text_out = `${header}\n${omissionNotice({ originalChars: source.length, visibleChars: header.length, note: "passing lines collapsed to a count summary", handle: options.handle || null })}\n${JSON.stringify(summary)}`
    return {
      text: text_out,
      truncated: true,
      omittedChars: Math.max(0, source.length - text_out.length),
      outcome: "pass",
      summary,
      failures: [],
      mode: "pass-summary",
      expansion: { kind: "full", handle: options.handle || null, hint: "full raw test log retrievable by handle" },
    }
  }

  const bounded = {
    command: options.command || null,
    exitCode: options.exitCode ?? null,
    failedTests: failed.slice(0, 25),
    firstAssertion: failures[0] || null,
    rootError: failures[1] || failures[0] || null,
    stackFrames: stack,
    affectedFiles: [...new Set(stack.map((frame) => (frame.match(/[\w./\\-]+\.[cm]?[jt]sx?/i) || [null])[0]).filter(Boolean))].slice(0, 12),
    rawHandle: options.handle || null,
  }
  const failedLabel = failCount ?? (failed.length || "?")
  const failureHeader = `[test failure: failed=${failedLabel}${bounded.exitCode != null ? ` exitCode=${bounded.exitCode}` : ""}]`
  // Honest truncation: passing lines and extra failures were dropped, so the
  // reader is told the original size and the handle to retrieve the full log.
  const text_out = `${failureHeader}\n${omissionNotice({ originalChars: source.length, visibleChars: failureHeader.length, note: "passing lines omitted; failing evidence kept", handle: options.handle || null })}\n${JSON.stringify(bounded, null, 2)}`
  return {
    text: text_out,
    truncated: true,
    omittedChars: Math.max(0, source.length - text_out.length),
    outcome: "fail",
    summary: { command: bounded.command, failed: failCount ?? failed.length, total: totalCount },
    failures: bounded,
    mode: "failure-delta",
    expansion: { kind: "full", handle: options.handle || null, hint: "full raw test log retrievable by handle" },
  }
}

/**
 * DIFF shaping. The model sees the changed file list and the hunks; unchanged
 * noise is summarized and the raw diff stays retrievable.
 */
export function shapeDiffOutput(text, options = {}) {
  const source = str(text)
  const maxHunks = boundedInt(options.maxHunks, DEFAULT_DIFF_MAX_HUNKS, 1, 500)
  const lines = source.split(/\r?\n/)
  const files = []
  let current = null
  let hunks = 0
  const kept = []
  for (const line of lines) {
    if (DIFF_FILE_PATTERN.test(line)) {
      const pathMatch = line.match(/ b\/(.+)$/)
      current = pathMatch ? pathMatch[1] : line.slice(5).trim()
      files.push(current)
      kept.push(line)
      continue
    }
    if (DIFF_HUNK_PATTERN.test(line)) {
      hunks += 1
      if (hunks <= maxHunks) kept.push(line)
      continue
    }
    if (hunks <= maxHunks) kept.push(line)
  }
  const truncated = hunks > maxHunks
  const body = kept.join("\n")
  const header = `[diff: files=${files.length} hunks=${hunks}${truncated ? ` shownHunks=${maxHunks}` : ""}]`
  const text_out = truncated
    ? `${header}\n${body}\n${omissionNotice({ originalChars: source.length, visibleChars: body.length, unit: `hunks ${maxHunks + 1}-${hunks}`, handle: options.handle || null })}`
    : `${header}\n${body}`
  return {
    text: text_out,
    truncated,
    omittedChars: Math.max(0, source.length - text_out.length),
    files,
    hunkCount: hunks,
    mode: "file-list-and-hunks",
    expansion: { kind: "full", handle: options.handle || null, hint: "full diff retrievable by handle" },
  }
}

/**
 * The single shaping entry point. PURE: no fs, no evidence store, no model.
 * Returns the model-visible text plus a receipt that proves what was hidden.
 */
export function shapeToolOutput(toolName, text, options = {}) {
  const source = str(text)
  const strategy = resolveStrategy(toolName, source, options)
  const budgetChars = boundedInt(options.budgetChars, 12_000, 256, 512_000)
  let shaped
  switch (strategy) {
    case TOOL_OUTPUT_STRATEGY.READ_FILE:
      shaped = shapeReadFileOutput(source, { ...options, budgetChars })
      break
    case TOOL_OUTPUT_STRATEGY.SEARCH:
      shaped = shapeSearchOutput(source, { ...options, budgetChars })
      break
    case TOOL_OUTPUT_STRATEGY.TEST:
      shaped = shapeTestOutput(source, { ...options, budgetChars })
      break
    case TOOL_OUTPUT_STRATEGY.DIFF:
      shaped = shapeDiffOutput(source, { ...options, budgetChars })
      break
    default: {
      const ht = headTail(source, { budgetChars })
      shaped = ht.truncated
        ? {
            text: `${ht.head}\n${omissionNotice({ originalChars: source.length, visibleChars: ht.head.length + ht.tail.length, handle: options.handle || null })}\n${ht.tail}`,
            truncated: true,
            omittedChars: ht.omittedChars,
            mode: "head-tail",
            expansion: { kind: "full", handle: options.handle || null },
          }
        : { text: source, truncated: false, omittedChars: 0, mode: "complete", expansion: null }
      break
    }
  }

  // V16.14 HARD BUDGET GUARANTEE. The strategy shapers above bound by
  // LINES/ROWS (a read window, a search row cap, a hunk cap), which is the right
  // unit for a focused view but is NOT a byte/char budget: 120 long lines can
  // still be far larger than the caller's budgetChars. The budget the caller
  // passed is a HARD limit, so we enforce it here as a last deterministic step
  // rather than reporting a receipt that claims a bound we did not honor.
  let finalText = shaped.text
  let finalTruncated = shaped.truncated === true
  let finalOmitted = shaped.omittedChars
  if (finalText.length > budgetChars) {
    const ht = headTail(finalText, { budgetChars })
    finalText = ht.truncated
      ? `${ht.head}\n${omissionNotice({
          originalChars: source.length,
          visibleChars: ht.head.length + ht.tail.length,
          omittedChars: Math.max(0, source.length - ht.head.length - ht.tail.length),
          handle: options.handle || null,
          note: "budget-enforced after strategy shaping",
        })}\n${ht.tail}`
      : finalText
    finalTruncated = true
    finalOmitted = Math.max(0, source.length - (finalText.length > 0 ? finalText.length : 0))
  }
  shaped = { ...shaped, text: finalText, truncated: finalTruncated, omittedChars: finalOmitted }

  const visibleChars = shaped.text.length
  const contentOmitted = Math.max(0, shaped.omittedChars ?? source.length - visibleChars)
  const receipt = {
    strategy,
    mode: shaped.mode || strategy,
    originalChars: source.length,
    visibleChars,
    // `omittedChars` is the CONTENT that was not shown. The notice we insert to
    // say so is metadata, so `visibleChars` may exceed `original - omitted`.
    omittedChars: contentOmitted,
    noticeOverheadChars: Math.max(0, visibleChars - (source.length - contentOmitted)),
    truncated: shaped.truncated === true,
    honest: true,
    retrievalHandle: options.handle || null,
    originalCharsProvenance: measured(source.length),
    visibleCharsProvenance: measured(visibleChars),
    // A shortened body can never look complete: if we truncated, the receipt
    // says so, and if a caller has no handle we say the expansion is unavailable
    // rather than pretending the view is whole.
    expansionAvailable: shaped.truncated === true ? Boolean(shaped.expansion) : false,
  }

  return {
    schemaVersion: TOOL_OUTPUT_BUDGETER_SCHEMA_VERSION,
    policy: TOOL_OUTPUT_BUDGETER_POLICY,
    strategy,
    text: shaped.text,
    originalChars: source.length,
    visibleChars,
    omittedChars: receipt.omittedChars,
    noticeOverheadChars: receipt.noticeOverheadChars,
    truncated: receipt.truncated,
    rows: shaped.rows || null,
    totalRows: shaped.totalRows ?? null,
    outcome: shaped.outcome || null,
    hunkCount: shaped.hunkCount ?? null,
    summary: shaped.summary || null,
    failures: shaped.failures || null,
    files: shaped.files || null,
    shownLines: shaped.shownLines || null,
    totalLines: shaped.totalLines ?? null,
    expansion: shaped.expansion || null,
    receipt,
    // Token counts are only ever ESTIMATED from chars here; the caller may
    // overwrite with provider-measured values. Never labeled MEASURED.
    tokens: { input: NOT_MEASURED, provenance: "NOT_MEASURED" },
  }
}

/**
 * STRUCTURAL PAIR SAFETY.
 *
 * Context reduction must never create a tool result with no tool call, or a
 * tool call with no required result. Given a normalized message list this
 * returns the ids that violate the invariant so a caller can fail closed
 * instead of shipping a malformed conversation to a model.
 *
 * A message is `{ role, toolCallId?, toolName?, kind? }`. `kind` is
 * "tool-call" or "tool-result" when the caller can distinguish them; otherwise
 * `role` decides (`assistant`+toolCallId => call, `tool`/`toolResult` => result).
 */
export function assertToolPairIntegrity(messages = []) {
  const calls = new Set()
  const results = new Set()
  const rows = Array.isArray(messages) ? messages : []
  for (const message of rows) {
    if (!message || typeof message !== "object") continue
    const id = message.toolCallId ?? message.tool_call_id ?? message.id ?? null
    if (!id) continue
    const kind = message.kind || null
    const role = String(message.role || "")
    if (kind === "tool-call" || (kind == null && (role === "assistant" || role === "call"))) calls.add(String(id))
    else if (kind === "tool-result" || (kind == null && (role === "tool" || role === "toolResult" || role === "result"))) results.add(String(id))
  }
  const orphanResults = [...results].filter((id) => !calls.has(id))
  const unansweredCalls = [...calls].filter((id) => !results.has(id))
  return {
    ok: orphanResults.length === 0 && unansweredCalls.length === 0,
    orphanResults,
    unansweredCalls,
    calls: calls.size,
    results: results.size,
  }
}

export const toolOutputBudgeterExports = Object.freeze({
  shapeToolOutput,
  resolveStrategy,
  omissionNotice,
  assertToolPairIntegrity,
  TOOL_OUTPUT_STRATEGY,
})
