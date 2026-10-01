import { putEvidence } from "./evidence-store.mjs"
import { recordCompaction } from "./compaction-recall.mjs"
import { analyzeShellCommand } from "./command-intelligence.mjs"

const DEFAULT_LIMIT = 64 * 1024
const SIGNAL_LINE = /\b(error|errors|failed|failure|fail|fatal|exception|warning|warn|assert|timeout|timed out|panic|traceback|mismatch|conflict|rejected|passed|pass|tests?|exit(?: code)?|changed)\b/i

function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function hintFor(options = {}) {
  return String(options.command || options.source || options.kind || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
}

function uniqRows(rows, limit = 100) {
  const seen = new Set()
  const result = []
  for (const value of rows || []) {
    const row = String(value || "").trimEnd()
    if (!row || seen.has(row)) continue
    seen.add(row)
    result.push(row)
    if (result.length >= limit) break
  }
  return result
}

function matchingLines(source, patterns, limit = 100) {
  const rows = []
  for (const raw of String(source || "").split(/\r?\n/)) {
    if (patterns.some((pattern) => pattern.test(raw))) rows.push(raw)
    if (rows.length >= limit) break
  }
  return uniqRows(rows, limit)
}

function uniqueSignalLines(text, limit = 48) {
  return matchingLines(text, [SIGNAL_LINE], limit)
}

function npmTestRows(source, limit = 100) {
  return matchingLines(source, [
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
    /^not ok\b/i,
    /^ok\s+\d+\b/i,
    /^#\s+(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/i,
  ], limit)
}

function pytestRows(source, limit = 100) {
  return matchingLines(source, [
    /^(?:FAILED|ERROR)\b/,
    /^=+\s+.*(?:passed|failed|error|skipped|xfailed|xpassed).*\s+=+$/i,
    /^E\s{2,}/,
    /^_+\s+.+\s+_+$/,
    /^Traceback \(most recent call last\):/,
    /^\s*File ".+", line \d+/,
    /(?:AssertionError|ImportError|ModuleNotFoundError|pytest\.)/,
    /collected\s+\d+\s+items?/i,
  ], limit)
}

// `git diff` output is the semantic change record. A reducer that keeps only
// file/hunk headers hides the actual edits, so bounded added/removed lines are
// selected as well (headers first, then changes, both capped).
function gitDiffRows(source, limit = 140) {
  const headers = matchingLines(source, [
    /^diff --git /,
    /^index [0-9a-f.]+/i,
    /^@@ /,
    /^(?:---|\+\+\+) /,
    /^fatal:/i,
    /^error:/i,
    /^CONFLICT\b/i,
    /^rename (?:from|to) /,
    /^new file mode /,
    /^deleted file mode /,
    /^\s*\d+ files? changed/i,
  ], limit)
  const changes = []
  const headerSet = new Set(headers)
  const changeLimit = Math.max(24, Math.floor(limit * 1.5))
  for (const raw of String(source || "").split(/\r?\n/)) {
    if (headerSet.has(raw)) continue
    if (/^(?:\+|\-)/.test(raw) && raw !== "+++ " && raw !== "--- ") {
      changes.push(raw.length > 400 ? raw.slice(0, 400) + "..." : raw)
      if (changes.length >= changeLimit) break
    }
  }
  return uniqRows([...headers, ...changes], limit + changeLimit)
}

function gitStatusRows(source, limit = 120) {
  return matchingLines(source, [
    /^##\s+/,
    /^On branch\s+/i,
    /^Your branch\s+/i,
    /^Changes to be committed:/i,
    /^Changes not staged for commit:/i,
    /^Untracked files:/i,
    /^Unmerged paths:/i,
    /^\s*(?:nothing to commit|working tree clean)/i,
    /^[ MARCUD?!]{1,2}\s+\S+/,
  ], limit)
}

function gitLogRows(source, limit = 100) {
  return matchingLines(source, [
    /^commit\s+[0-9a-f]{7,40}\b/i,
    /^Author:\s+/i,
    /^Date:\s+/i,
    /^Merge:\s+/i,
    /^\s{4}\S+/,
    /^fatal:/i,
    /^error:/i,
  ], limit)
}

function verificationTestRows(source, limit = 120) {
  return matchingLines(source, [
    /^(?:ok|FAIL)\s+\S+/,
    /^---\s+(?:PASS|FAIL):\s+/,
    /^test result:\s+(?:ok|FAILED)\b/i,
    /^failures?:/i,
    /^running\s+\d+\s+tests?/i,
    /^Finished\s+test\b/i,
    /^Total tests:\s*\d+/i,
    /^\s*(?:Passed|Failed|Skipped):\s*\d+/i,
    /\b(?:panic|assertion failed|FAILED|FAILURE|ERROR)\b/i,
    /\berror\[E\d+\]/,
    /\bBUILD\s+(?:SUCCESS|FAILURE)\b/i,
    /\bTests run:\s*\d+/i,
  ], limit)
}

function pythonLintRows(source, limit = 120) {
  return matchingLines(source, [
    /^.+:\d+:\d+:\s+[A-Z]+\d+\s+/,
    /^.+:\d+:\d+:\s+(?:error|warning)\b/i,
    /^Found\s+\d+\s+errors?/i,
    /^All checks passed!?$/i,
    /^\d+\s+files?\s+(?:reformatted|left unchanged)/i,
    /\b(?:error|warning|failed)\b/i,
  ], limit)
}

function packageInstallRows(source, limit = 120) {
  return matchingLines(source, [
    /\b(?:added|removed|changed)\s+\d+\s+packages?\b/i,
    /\baudited\s+\d+\s+packages?\b/i,
    /\b\d+\s+packages?\s+(?:are\s+)?looking for funding\b/i,
    /\b\d+\s+vulnerabilit(?:y|ies)\b/i,
    /\b(?:deprecated|warning|warn|error|ERR!|ELIFECYCLE|ERR_)\b/i,
    /^Packages:\s+[+-]?\d+/i,
    /^Progress:\s+/i,
    /^Done in\s+/i,
  ], limit)
}

function rgRows(source, limit = 100) {
  const lines = String(source || "").split(/\r?\n/).filter(Boolean)
  const matched = []
  for (const line of lines) {
    if (
      /^(?:[^:\n]+:)?\d+(?::\d+)?:/.test(line) ||
      /^\.?[^:\n]+:\s/.test(line) ||
      /(?:error|permission denied|binary file|no such file)/i.test(line)
    ) matched.push(line)
    if (matched.length >= limit) break
  }
  const rows = matched.length ? matched : lines.slice(0, limit)
  return uniqRows(rows, limit)
}

function treeRows(source, limit = 120) {
  const lines = String(source || "").split(/\r?\n/).filter(Boolean)
  if (lines.length <= limit) return uniqRows(lines, limit)
  const head = lines.slice(0, Math.max(1, limit - 12))
  const tail = lines.slice(-12)
  return uniqRows([...head, `...[tree omitted ${Math.max(0, lines.length - head.length - tail.length)} rows]...`, ...tail], limit)
}

function tscRows(source, limit = 120) {
  return matchingLines(source, [
    /\berror\s+TS\d+\b/i,
    /^.+\(\d+,\d+\):\s+error\s+TS\d+/i,
    /^.+:\d+:\d+\s+-\s+error\s+TS\d+/i,
    /^Found\s+\d+\s+errors?/i,
    /\b(?:ELIFECYCLE|ERR_|exit code)\b/i,
  ], limit)
}

function eslintRows(source, limit = 120) {
  return matchingLines(source, [
    /^\/?[^\n]+\.[cm]?[jt]sx?$/i,
    /^\s*\d+:\d+\s+(?:error|warning)\s+/i,
    /\b\d+\s+problems?\b/i,
    /\b\d+\s+errors?\b/i,
    /\b\d+\s+warnings?\b/i,
    /^✖\s+/,
    /\beslint\b.*\b(?:error|warning|failed)\b/i,
  ], limit)
}

function dockerRows(source, limit = 120) {
  return matchingLines(source, [
    /^#\d+\s+/,
    /^\s*=>\s+/,
    /\b(?:error|failed|failure|fatal|warning|unhealthy|exited)\b/i,
    /^NAME\s+IMAGE\s+COMMAND/i,
    /^NAME\s+STATUS/i,
    /^\[?\+\]?\s+(?:Running|Started|Stopped|Created|Built|Recreated)/i,
    /(?:container|service|network|volume).*(?:created|started|stopped|failed|error)/i,
  ], limit)
}

function prismaRows(source, limit = 120) {
  return matchingLines(source, [
    /Prisma schema loaded from/i,
    /Datasource\s+".+"/i,
    /Applying migration/i,
    /migrations? found/i,
    /Generated Prisma Client/i,
    /Your database is now in sync/i,
    /The following migration/i,
    /\bP\d{4}\b/,
    /\b(?:error|failed|warning)\b/i,
    /schema\.prisma:\d+/i,
  ], limit)
}

function genericBuildRows(source, limit = 100) {
  return matchingLines(source, [
    /\b(?:compile|compiled|compilation|build)\b.*\b(?:failed|success|succeeded|complete|completed)\b/i,
    /\b(?:failed|fatal|exception|panic)\b/i,
    /\bwarning\b/i,
    /:\d+:\d+\b/,
    /\b(?:ELIFECYCLE|ERR_|exit code)\b/i,
  ], limit)
}

function jsonRows(source, limit = 80) {
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
    rows.push(`${prefix || "$"}: ${String(JSON.stringify(current)).slice(0, 160)}`)
  }
  visit(value, "", 0)
  return rows
}

const REDUCERS = Object.freeze([
  {
    family: "npm-test",
    match: (hint) => {
      const analysis = analyzeShellCommand(hint)
      const packageManagerTest =
        analysis.verificationFamily === "test" &&
        /(?:^|\s|["'\\/])(?:npm|pnpm|yarn|bun)(?:\.(?:cmd|exe))?(?:["']|\s|$)/i.test(hint)
      return packageManagerTest || /node\s+--test\b|\b(?:jest|vitest)\b/.test(hint)
    },
    rows: npmTestRows,
  },
  {
    family: "pytest",
    match: (hint) => /\b(?:pytest|py\.test)\b/.test(hint),
    rows: pytestRows,
  },
  {
    family: "git-status",
    match: (hint) => /\bgit\s+status\b/.test(hint),
    rows: gitStatusRows,
  },
  {
    family: "git-log",
    match: (hint) => /\bgit\s+log\b/.test(hint),
    rows: gitLogRows,
  },
  {
    family: "git-diff",
    match: (hint) => /\bgit\s+(?:diff|show)\b/.test(hint),
    rows: gitDiffRows,
  },
  {
    family: "ripgrep",
    match: (hint) => /(?:^|\s)(?:rg|ripgrep)(?:\s|$)|\bgrep\b/.test(hint),
    rows: rgRows,
  },
  {
    family: "tree",
    match: (hint) => /(?:^|[;&|]\s*|\s)(?:tree)(?:\s|$)/.test(hint) || hint === "tree",
    rows: treeRows,
  },
  {
    family: "tsc",
    match: (hint) => /\b(?:tsc|typescript|typecheck)\b/.test(hint),
    rows: tscRows,
  },
  {
    family: "eslint",
    match: (hint) => /\b(?:eslint|lint)\b/.test(hint),
    rows: eslintRows,
  },
  {
    family: "docker",
    match: (hint) => /\bdocker(?:\s+compose)?\b/.test(hint),
    rows: dockerRows,
  },
  {
    family: "prisma",
    match: (hint) => /\bprisma\b|schema\.prisma/.test(hint),
    rows: prismaRows,
  },
  {
    family: "package-install",
    match: (hint) => /(?:^|\s)(?:npm\s+(?:i|install|ci)|pnpm\s+(?:i|install|add)|yarn\s+(?:install|add))(?:\s|$)/.test(hint),
    rows: packageInstallRows,
  },
  {
    family: "verification-test",
    match: (hint) => /\b(?:go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test)\b/.test(hint),
    rows: verificationTestRows,
  },
  {
    family: "python-lint",
    match: (hint) => /\b(?:ruff|flake8|pylint)\b/.test(hint),
    rows: pythonLintRows,
  },
  {
    family: "build",
    match: (hint) => analyzeShellCommand(hint).verificationFamily === "build" || /\b(?:compile|build|gradle|maven|mvn|cargo\s+check|dotnet\s+build)\b/.test(hint),
    rows: genericBuildRows,
  },
])

export const COMMAND_REDUCER_FAMILIES = Object.freeze(REDUCERS.map((item) => item.family))

export function reduceCommandOutput(source, options = {}) {
  const text = String(source || "")
  const hint = hintFor(options)
  // A compound hint ("git status && git diff", "npm test && npx tsc") used to
  // select only the first matching family and silently drop the other command's
  // evidence. Match every family that applies and union their rows.
  const matched = REDUCERS.filter((item) => item.match(hint))
  if (matched.length) {
    const rows = uniqRows(matched.flatMap((item) => item.rows(text)))
    if (rows.length) {
      const families = matched.map((item) => item.family)
      const family = families.length === 1 ? families[0] : families.join("+")
      return {
        schemaVersion: 2,
        family,
        families,
        hint,
        rows,
        summary: `command-aware reducer=${family}; selected=${rows.length}; totalLines=${text.split(/\r?\n/).length}`,
      }
    }
  }

  if (/(?:--json|\bjson\b)/.test(hint) || /^[\s]*[\[{]/.test(text)) {
    const rows = jsonRows(text)
    if (rows.length) {
      return {
        schemaVersion: 2,
        family: "json",
        families: [],
        hint,
        rows,
        summary: `command-aware reducer=json; selected=${rows.length}`,
      }
    }
  }

  const rows = uniqueSignalLines(text)
  return {
    schemaVersion: 2,
    family: rows.length ? "signal" : "generic",
    families: [],
    hint,
    rows,
    summary: rows.length
      ? `generic signal reducer; selected=${rows.length}`
      : "generic head/tail fallback; no structured signal reducer matched",
  }
}

function legacyStrategyKind(source, options = {}) {
  const hint = hintFor(options)
  if (/(jest|vitest|pytest|test|spec)/.test(hint) && npmTestRows(source).length) return "test"
  if (/(eslint|lint|ruff|flake8|pylint|clippy)/.test(hint) && eslintRows(source).length) return "lint"
  if (/(typecheck|tsc|compile|build|gradle|maven|cargo check|dotnet build)/.test(hint) && genericBuildRows(source).length) return "build"
  if (/(git|diff|status)/.test(hint) && gitDiffRows(source).length) return "git"
  if ((/(json|--json)/.test(hint) || /^[\s]*[\[{]/.test(String(source || ""))) && jsonRows(source).length) return "json"
  return uniqueSignalLines(source).length ? "signal" : "generic"
}

function boundedPreview(text, maxChars, options = {}) {
  const source = String(text || "")
  const headBudget = Math.max(1536, Math.floor(maxChars * 0.18))
  const tailBudget = Math.max(2048, Math.floor(maxChars * 0.24))
  const signalBudget = Math.max(2048, maxChars - headBudget - tailBudget - 1900)
  const head = source.slice(0, headBudget)
  const tail = source.slice(Math.max(head.length, source.length - tailBudget))
  const reduced = reduceCommandOutput(source, options)
  let signalText = [reduced.summary, ...reduced.rows].join("\n")
  if (signalText.length > signalBudget) {
    signalText = signalText.slice(0, signalBudget) + "\n...[reducer output truncated]"
  }
  return { head, tail, signalText, reducer: reduced }
}

export async function compactReversibleOutput(root, text, options = {}) {
  const source = String(text ?? "")
  const maxChars = clampInt(options.maxChars, DEFAULT_LIMIT, 8 * 1024, 256 * 1024)
  if (source.length <= maxChars) {
    return {
      schemaVersion: 2,
      compacted: false,
      strategy: "raw",
      commandFamily: null,
      originalChars: source.length,
      returnedChars: source.length,
      evidenceRef: null,
      text: source,
    }
  }

  // Raw bytes are persisted before any model-visible reduction. Reducers never
  // become the verification source of truth; verifiers can recover exact data.
  const evidence = await putEvidence(root, source, {
    kind: options.kind || "raw-tool-output",
    source: options.source || options.command || "ues-performance-fabric-v2",
    summary: options.summary || `Raw output preserved before command-aware model-visible compaction (${source.length} chars)`,
  })
  const { head, tail, signalText, reducer } = boundedPreview(source, maxChars, options)
  const recovery = `Raw captured output: ${evidence.ref}. Recover exact captured bytes in slices with: ues store get ${evidence.ref} --start N --max 24000`
  let preview = [
    `[UES command-aware reversible compaction v2: ${source.length} -> <=${maxChars} chars; reducer=${reducer.family}]`,
    recovery,
    "",
    "--- reducer summary ---",
    signalText,
    "",
    "--- bounded head ---",
    head,
    "",
    "--- bounded tail ---",
    tail,
  ].filter(Boolean).join("\n")
  if (preview.length > maxChars) {
    const reserve = Math.min(1500, recovery.length + 200)
    preview = preview.slice(0, Math.max(0, maxChars - reserve)) + `\n...[model-visible preview truncated]\n${recovery}`
  }

  await recordCompaction(root, { ref: evidence.ref, reducer: reducer.family, level: "command", rawChars: source.length, returnedChars: preview.length, source: options.source || options.command || null }).catch(() => null)

  const compatibilityKind = legacyStrategyKind(source, options)
  return {
    schemaVersion: 2,
    compacted: true,
    // Keep the V14 public strategy contract stable for callers/tests while
    // exposing the richer V2 reducer identity separately.
    strategy: `reversible-head-${compatibilityKind}-tail`,
    strategyV2: `reversible-command-aware-${reducer.family}`,
    commandFamily: reducer.family,
    originalChars: source.length,
    returnedChars: preview.length,
    evidenceRef: evidence.ref,
    text: preview,
  }
}
