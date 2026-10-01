import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { decodeTextBuffer } from "./text-encoding.mjs"
import { isUesRuntimeArtifactPath, sourceFacingPaths, sourceGitPathspecs } from "./runtime-artifacts.mjs"
import { safeRemovePath } from "./fs-cleanup.mjs"

const CODE_EXTENSIONS = new Set([
  ".js", ".cjs", ".mjs", ".jsx", ".ts", ".cts", ".mts", ".tsx",
  ".py", ".pyi", ".java", ".kt", ".kts", ".go", ".rs", ".c", ".h",
  ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".php", ".rb", ".swift",
  ".scala", ".vue", ".svelte", ".html", ".htm", ".css", ".scss", ".sass",
  ".less", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml", ".sql",
  ".graphql", ".gql", ".sh", ".bash", ".zsh", ".ps1", ".cmd", ".bat",
])

const CODE_BASENAMES = new Set([
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile",
  ".eslintrc", ".prettierrc", ".babelrc",
])

const KNOWN_SCRATCH = Object.freeze([
  ".ues-cache/fast-acceptance.test.mjs",
  ".ues-cache/tmp",
  ".ues-cache/scratch",
])

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/^\/+/, "")
}

function withinRoot(root, relative) {
  const resolvedRoot = path.resolve(root)
  const file = path.resolve(resolvedRoot, relative)
  if (file !== resolvedRoot && !file.startsWith(resolvedRoot + path.sep)) {
    throw new Error("workspace hygiene path escapes root: " + relative)
  }
  return file
}

function fileState(root, relative) {
  const normalized = normalizePath(relative)
  if (!normalized) return { exists: false, kind: "missing", size: 0, hash: null }
  let file
  try {
    file = withinRoot(root, normalized)
  } catch {
    return { exists: false, kind: "escape", size: 0, hash: null }
  }
  if (!existsSync(file)) return { exists: false, kind: "missing", size: 0, hash: null }
  try {
    const info = lstatSync(file)
    if (info.isSymbolicLink()) {
      const target = readlinkSync(file)
      return {
        exists: true,
        kind: "symlink",
        size: Buffer.byteLength(target),
        hash: createHash("sha256").update(target).digest("hex"),
      }
    }
    if (info.isFile()) {
      const bytes = readFileSync(file)
      return {
        exists: true,
        kind: "file",
        size: bytes.length,
        hash: createHash("sha256").update(bytes).digest("hex"),
      }
    }
    if (info.isDirectory()) return { exists: true, kind: "directory", size: 0, hash: null }
    return { exists: true, kind: "other", size: Number(info.size || 0), hash: null }
  } catch {
    return { exists: false, kind: "unreadable", size: 0, hash: null }
  }
}

function sameState(left, right) {
  return Boolean(left) && Boolean(right) &&
    left.exists === right.exists &&
    left.kind === right.kind &&
    Number(left.size || 0) === Number(right.size || 0) &&
    String(left.hash || "") === String(right.hash || "")
}

function parseGitStatusEntries(statusOutput) {
  const tokens = String(statusOutput || "").split("\0").filter(Boolean)
  const rows = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.length < 3 || token[2] !== " ") continue
    const status = token.slice(0, 2)
    const current = normalizePath(token.slice(3))
    let original = null
    if (/[RC]/.test(status) && index + 1 < tokens.length) {
      original = normalizePath(tokens[index + 1])
      index += 1
    }
    if (current && !isUesRuntimeArtifactPath(current)) rows.push({ status, path: current, originalPath: original })
  }
  return rows
}

function gitStatusEntries(root, workspaceState = null) {
  const resolved = path.resolve(root)
  if (
    workspaceState &&
    typeof workspaceState === "object" &&
    workspaceState.root &&
    path.resolve(workspaceState.root) === resolved &&
    typeof workspaceState.statusOutput === "string"
  ) {
    return parseGitStatusEntries(workspaceState.statusOutput)
  }
  const result = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...sourceGitPathspecs()], {
    cwd: resolved,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || "git status failed").trim())
  }
  return parseGitStatusEntries(result.stdout)
}

function snapshotDirty(root, workspaceState = null) {
  const rows = gitStatusEntries(root, workspaceState)
  const paths = sourceFacingPaths(rows.flatMap((row) => [row.path, row.originalPath].filter(Boolean))).sort()
  const entries = {}
  for (const relative of paths) {
    const row = rows.find((item) => item.path === relative || item.originalPath === relative)
    entries[relative] = {
      status: row?.status || "??",
      state: fileState(root, relative),
    }
  }
  return { paths, entries }
}

export function captureWorkspaceHygieneBaseline(root = process.cwd(), options = {}) {
  const resolved = path.resolve(root)
  const dirty = snapshotDirty(resolved, options.workspaceState || null)
  const scratch = {}
  for (const relative of KNOWN_SCRATCH) {
    scratch[relative] = fileState(resolved, relative)
  }
  return {
    schemaVersion: 1,
    root: resolved,
    capturedAt: new Date().toISOString(),
    paths: dirty.paths,
    entries: dirty.entries,
    scratch,
  }
}

export function isAuditableSourcePath(relative) {
  const normalized = normalizePath(relative)
  if (!normalized || isUesRuntimeArtifactPath(normalized)) return false
  const base = path.posix.basename(normalized).toLowerCase()
  const ext = path.posix.extname(base).toLowerCase()
  return CODE_EXTENSIONS.has(ext) || CODE_BASENAMES.has(base)
}

function locationAt(text, utf16Index) {
  const prefix = String(text || "").slice(0, Math.max(0, utf16Index))
  const rows = prefix.split("\n")
  return {
    line: rows.length,
    column: [...(rows.at(-1) || "")].length + 1,
  }
}

function codePointLabel(cp) {
  return "U+" + cp.toString(16).toUpperCase().padStart(4, "0")
}

function finding(file, kind, message, index, text, codePoint = null) {
  const loc = locationAt(text, index)
  return {
    severity: "error",
    blocking: true,
    file: normalizePath(file),
    kind,
    line: loc.line,
    column: loc.column,
    codePoint: codePoint == null ? null : codePointLabel(codePoint),
    message,
  }
}

export function auditUnicodeSource(text, options = {}) {
  const source = String(text ?? "")
  const file = normalizePath(options.file || "<memory>")
  const findings = []
  let utf16Index = 0

  for (const char of source) {
    const cp = char.codePointAt(0)
    const width = char.length
    const isAllowedWhitespace = cp === 0x09 || cp === 0x0a || cp === 0x0d
    if ((cp < 0x20 && !isAllowedWhitespace) || (cp >= 0x7f && cp <= 0x9f)) {
      findings.push(finding(file, "control-character", "Unexpected control character in source", utf16Index, source, cp))
    } else if (cp === 0xfffd) {
      findings.push(finding(file, "replacement-character", "Unicode replacement character indicates corrupted or lossy text", utf16Index, source, cp))
    } else if (cp === 0xfeff && utf16Index !== 0) {
      findings.push(finding(file, "embedded-bom", "BOM/zero-width no-break space is only allowed at the start of a file", utf16Index, source, cp))
    } else if (
      cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 ||
      cp === 0x180e
    ) {
      findings.push(finding(file, "zero-width-character", "Invisible zero-width/joining character is not allowed in audited source", utf16Index, source, cp))
    } else if (
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069)
    ) {
      findings.push(finding(file, "bidi-control", "Bidirectional override/isolate control is blocked to prevent visually misleading source", utf16Index, source, cp))
    }
    utf16Index += width
  }

  const identifierLike = /[\p{L}_$][\p{L}\p{N}\p{Mn}\p{Mc}_$]*/gu
  for (const match of source.matchAll(identifierLike)) {
    const token = match[0]
    const latin = /\p{Script=Latin}/u.test(token)
    const cyrillic = /\p{Script=Cyrillic}/u.test(token)
    const greek = /\p{Script=Greek}/u.test(token)
    if (latin && (cyrillic || greek)) {
      findings.push(finding(
        file,
        "mixed-script-token",
        "Token mixes Latin with Cyrillic/Greek characters and may contain a homoglyph",
        Number(match.index || 0),
        source,
        null,
      ))
    }
  }

  return {
    schemaVersion: 1,
    file,
    safe: findings.length === 0,
    findings,
  }
}

async function auditUnicodeFiles(root, files, options = {}) {
  const reports = []
  const maxBytes = Math.max(64 * 1024, Math.min(Number(options.maxBytes || 4 * 1024 * 1024), 16 * 1024 * 1024))
  for (const relative of sourceFacingPaths(files).filter(isAuditableSourcePath)) {
    const absolute = withinRoot(root, relative)
    if (!existsSync(absolute)) continue
    const info = lstatSync(absolute)
    if (!info.isFile()) continue
    if (info.size > maxBytes) {
      reports.push({
        schemaVersion: 1,
        file: relative,
        safe: false,
        findings: [{
          severity: "error",
          blocking: true,
          file: relative,
          kind: "source-too-large",
          line: null,
          column: null,
          codePoint: null,
          message: `Changed source exceeds hygiene audit byte limit (${info.size} > ${maxBytes})`,
        }],
      })
      continue
    }
    try {
      const text = decodeTextBuffer(readFileSync(absolute))
      reports.push(auditUnicodeSource(text, { file: relative }))
    } catch (error) {
      reports.push({
        schemaVersion: 1,
        file: relative,
        safe: false,
        findings: [{
          severity: "error",
          blocking: true,
          file: relative,
          kind: "text-decode-failed",
          line: null,
          column: null,
          codePoint: null,
          message: error instanceof Error ? error.message : String(error),
        }],
      })
    }
  }
  return {
    safe: reports.every((report) => report.safe),
    reports,
    findings: reports.flatMap((report) => report.findings || []),
  }
}

export function classifyTransientArtifact(relative) {
  const normalized = normalizePath(relative)
  const lower = normalized.toLowerCase()
  const base = path.posix.basename(lower)

  if (
    /\.(?:tmp|temp|swp|swo|orig|rej|bak)$/.test(base) ||
    /~$/.test(base) ||
    [".ds_store", "thumbs.db", "npm-debug.log", "yarn-debug.log", "yarn-error.log", "pnpm-debug.log"].includes(base) ||
    /(?:^|\/)(?:__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|coverage|test-results|playwright-report)(?:\/|$)/.test(lower)
  ) {
    return { transient: true, confidence: "high", reason: "known-generated-or-temporary-artifact" }
  }

  if (
    /^(?:debug|scratch|tmp|temp|trial|experiment|playground|test-try|try)[-_.]/.test(base)
  ) {
    return { transient: true, confidence: "suspicious", reason: "debug-scratch-or-generated-output-name" }
  }

  return { transient: false, confidence: "none", reason: null }
}

function taskMentionsPath(taskText, relative) {
  const task = String(taskText || "").toLowerCase().replaceAll("\\", "/")
  const normalized = normalizePath(relative).toLowerCase()
  const base = path.posix.basename(normalized)
  return Boolean(
    normalized && task.includes(normalized) ||
    base.length >= 4 && task.includes(base)
  )
}

async function cleanupScratchCreatedAfterBaseline(root, baseline) {
  const removed = []
  for (const relative of KNOWN_SCRATCH) {
    const before = baseline?.scratch?.[relative]
    const after = fileState(root, relative)
    if (after.exists && !before?.exists) {
      const target = withinRoot(root, relative)
      await safeRemovePath(target)
      if (!existsSync(target)) removed.push(relative)
    }
  }
  return removed
}

async function removeHighConfidenceCreatedArtifacts(root, createdPaths, taskText) {
  const removed = []
  for (const relative of createdPaths) {
    const classification = classifyTransientArtifact(relative)
    if (!classification.transient || classification.confidence !== "high") continue
    if (taskMentionsPath(taskText, relative)) continue
    const target = withinRoot(root, relative)
    await safeRemovePath(target).catch(() => {})
    if (!existsSync(target)) removed.push(relative)
  }
  return removed
}

function deltaFromBaseline(root, baseline) {
  const current = snapshotDirty(root)
  const beforeEntries = baseline?.entries || {}
  const all = new Set([...(baseline?.paths || []), ...current.paths])
  const changed = []
  const created = []

  for (const relative of all) {
    const before = beforeEntries[relative]?.state || null
    const nowEntry = current.entries[relative] || null
    const after = nowEntry?.state || fileState(root, relative)
    if (before && sameState(before, after)) continue
    if (!before && !nowEntry) continue
    changed.push(relative)
    const status = String(nowEntry?.status || "")
    if (!before && (status === "??" || status.startsWith("A"))) created.push(relative)
  }
  return { current, changed: sourceFacingPaths(changed), created: sourceFacingPaths(created) }
}

function renderFinding(item) {
  const where = item.line ? `:${item.line}:${item.column || 1}` : ""
  const codePoint = item.codePoint ? ` ${item.codePoint}` : ""
  return `${item.file}${where} [${item.kind}]${codePoint} ${item.message}`
}

async function auditWorkspaceDelta(root, options = {}) {
  const baseline = options.baseline || captureWorkspaceHygieneBaseline(root)
  let delta = deltaFromBaseline(root, baseline)
  const removedScratch = options.autoClean === false
    ? []
    : await cleanupScratchCreatedAfterBaseline(root, baseline)
  const removedTransient = options.autoClean === false
    ? []
    : await removeHighConfidenceCreatedArtifacts(root, delta.created, options.taskText)
  if (removedScratch.length || removedTransient.length) delta = deltaFromBaseline(root, baseline)

  const unicode = await auditUnicodeFiles(root, delta.changed, options)
  const artifactFindings = []
  for (const relative of delta.created) {
    const classification = classifyTransientArtifact(relative)
    if (!classification.transient) continue
    if (classification.confidence === "high" && removedTransient.includes(relative)) continue
    if (taskMentionsPath(options.taskText, relative)) continue
    artifactFindings.push({
      severity: "error",
      blocking: true,
      file: relative,
      kind: "unexplained-transient-artifact",
      line: null,
      column: null,
      codePoint: null,
      message: `New file looks like a debug/scratch/generated artifact (${classification.reason})`,
    })
  }

  const allowed = new Set(sourceFacingPaths(options.allowedPaths || []))
  const scopeFindings = options.strictScope === true
    ? delta.changed
        .filter((relative) => !allowed.has(relative))
        .map((relative) => ({
          severity: "error",
          blocking: true,
          file: relative,
          kind: "undeclared-source-change",
          line: null,
          column: null,
          codePoint: null,
          message: "Source changed outside the declared final write scope",
        }))
    : []

  const readOnlyFindings = options.allowSourceMutations === false && delta.changed.length
    ? delta.changed.map((relative) => ({
        severity: "error",
        blocking: true,
        file: relative,
        kind: "read-only-agent-mutation",
        line: null,
        column: null,
        codePoint: null,
        message: "Read-only specialist mutated source/runtime-visible project files",
      }))
    : []

  const findings = [
    ...unicode.findings,
    ...artifactFindings,
    ...scopeFindings,
    ...readOnlyFindings,
  ]
  return {
    schemaVersion: 1,
    safe: findings.length === 0,
    changed: delta.changed,
    created: delta.created,
    removed: [...removedScratch, ...removedTransient],
    unicode,
    findings,
    summary: findings.length
      ? findings.slice(0, 20).map(renderFinding).join("\n")
      : `workspace hygiene PASS; changed=${delta.changed.length}; cleaned=${removedScratch.length + removedTransient.length}`,
  }
}

export async function postRunFileHygiene(root, options = {}) {
  return auditWorkspaceDelta(path.resolve(root), {
    ...options,
    autoClean: options.autoClean !== false,
  })
}

export async function preFinalWorkspaceAudit(root, options = {}) {
  return auditWorkspaceDelta(path.resolve(root), {
    ...options,
    autoClean: false,
  })
}
