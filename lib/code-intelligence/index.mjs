import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { commandExists } from "../executable-probe.mjs"
import { runSupervisedProcess } from "../process-supervisor.mjs"
import { resolveWindowsCommand } from "../windows-shim.mjs"
import { buildSemanticIndexCached, querySemanticIndex } from "../semantic-index.mjs"
import { anchoredLines, applyAnchoredEdits } from "./edit-anchor.mjs"
import { runtimeWorkspaceSnapshot } from "../workspace-fingerprint.mjs"
import { diagnoseCode, lspOperation, lspPoolStatus, lspProviderStatus, shutdownLspPool, LSP_OPERATIONS } from "./lsp-provider.mjs"

const AST_COMMANDS = ["ast-grep", "sg"]
const AST_ROW_TEXT_LIMIT = 240
const AST_RESULT_CHAR_LIMIT = 8 * 1024
function inside(root, target) { return target === root || target.startsWith(root + path.sep) }

// Capability detection is a single cached probe. ast-grep stays an optional
// provider: it is never a hard dependency, and a missing binary degrades to
// available=false with an explicit reason instead of an error.
//
// Detection and launchability are reported separately: a command can exist on
// PATH yet be unlaunchable without a shell (an unresolvable Windows shim), and
// calling that "available" would be a false capability claim.
function astProviderCommand() {
  const command = AST_COMMANDS.find(commandExists) || null
  if (!command) return { command: null, execution: null, resolvable: false }
  const execution = process.platform === "win32"
    ? resolveWindowsCommand(command)
    : { executable: command, argsPrefix: [] }
  return { command, execution, resolvable: Boolean(execution?.executable) }
}

// ast-grep streams one verbose JSON object per match (full line context, base64
// single-node payload, byte offsets). That is far too much to put in front of a
// weak model, so matches are compacted to the evidence a model actually uses:
// file, 1-based position, rule/language and a bounded source snippet.
function compactStructuralRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { file: null, line: null, column: null, rule: null, language: null, text: String(row ?? "").slice(0, AST_ROW_TEXT_LIMIT) }
  }
  const meta = row.meta && typeof row.meta === "object" ? row.meta : {}
  const start = meta.start && typeof meta.start === "object" ? meta.start : {}
  const end = meta.end && typeof meta.end === "object" ? meta.end : {}
  const line = Number(start.line)
  const column = Number(start.column)
  const endLine = Number(end.line)
  const endColumn = Number(end.column)
  return {
    file: row.file == null ? null : String(row.file).replaceAll("\\", "/"),
    line: Number.isFinite(line) ? line + 1 : null,
    column: Number.isFinite(column) ? column + 1 : null,
    endLine: Number.isFinite(endLine) ? endLine + 1 : null,
    endColumn: Number.isFinite(endColumn) ? endColumn + 1 : null,
    rule: meta.ruleId == null ? null : String(meta.ruleId),
    language: meta.language == null ? null : String(meta.language),
    text: String(row.text ?? "").slice(0, AST_ROW_TEXT_LIMIT),
  }
}

async function safeFile(root, relative) {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root))
  const requested = path.resolve(base, String(relative || ""))
  if (!inside(base, requested)) throw new Error("code path escapes workspace root")
  const info = await lstat(requested)
  if (!info.isFile()) throw new Error("code path is not a file")
  const actual = await realpath(requested)
  if (!inside(base, actual)) throw new Error("code symlink escapes workspace root")
  return { base, file: actual, info }
}

export function probeCodeIntelligence(file = "", options = {}) {
  const ast = astProviderCommand()
  return {
    schemaVersion: 1,
    anchoredEditing: true,
    semanticIndex: true,
    astProvider: ast.command,
    astProviderLaunchable: ast.resolvable,
    lsp: lspProviderStatus(file, options),
    lspOperations: [...LSP_OPERATIONS],
  }
}

export async function readAnchoredCode(root, relative, options = {}) {
  const target = await safeFile(root, relative)
  const maxBytes = Math.max(8 * 1024, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 512 * 1024)))
  if (target.info.size > maxBytes) throw new Error("code file exceeds anchored-read limit (" + target.info.size + " > " + maxBytes + " bytes)")
  const source = await readFile(target.file, "utf8")
  return { file: path.relative(target.base, target.file).replaceAll("\\", "/"), ...anchoredLines(source, options) }
}

export async function applyAnchoredFileEdits(root, relative, edits, options = {}) {
  const target = await safeFile(root, relative)
  const maxBytes = Math.max(8 * 1024, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 512 * 1024)))
  if (target.info.size > maxBytes) throw new Error("code file exceeds anchored-edit limit (" + target.info.size + " > " + maxBytes + " bytes)")
  const source = await readFile(target.file, "utf8")
  const result = applyAnchoredEdits(source, edits, options)
  const relativeFile = path.relative(target.base, target.file).replaceAll("\\", "/")
  if (options.dryRun === true) return { ...result, file: relativeFile, dryRun: true }
  const temp = target.file + "." + process.pid + "." + Date.now() + ".ues.tmp"
  await writeFile(temp, result.text, "utf8")
  try { await rename(temp, target.file) } catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error }
  return { ...result, file: relativeFile, dryRun: false }
}

async function runAstGrep(root, pattern, language, limit) {
  const ast = astProviderCommand()
  const attempted = Boolean(String(pattern || "").trim())
  if (!ast.command) {
    return {
      available: false,
      attempted,
      provider: null,
      resolvable: false,
      reason: "ast-provider-unavailable",
      results: [],
      error: null,
      rowCount: 0,
    }
  }
  if (!ast.resolvable) {
    return {
      available: false,
      attempted,
      provider: ast.command,
      resolvable: false,
      reason: "ast-provider-unresolvable",
      results: [],
      error: null,
      rowCount: 0,
    }
  }
  if (!attempted) {
    return {
      available: true,
      attempted: false,
      provider: ast.command,
      resolvable: true,
      reason: "structural-pattern-empty",
      results: [],
      error: null,
      rowCount: 0,
    }
  }
  const args = ["run", "--pattern", String(pattern), "--json=stream"]
  if (language) args.push("--lang", String(language))
  args.push(".")
  const executable = ast.execution.executable
  const executionArgs = [...(ast.execution.argsPrefix || []), ...args]
  const result = await runSupervisedProcess(executable, executionArgs, {
    cwd: path.resolve(root),
    hardTimeoutMs: 20_000,
    idleTimeoutMs: 10_000,
    stdoutLimit: 4 * 1024 * 1024,
    stderrLimit: 64 * 1024,
    drainTimeoutMs: 500,
  })
  if (result.exitCode !== 0) {
    const reason = result.stopReason ? `ast-grep ${result.stopReason}` : `ast-grep exit ${result.exitCode}`
    return {
      available: true,
      attempted: true,
      provider: ast.command,
      resolvable: true,
      reason: "ast-provider-error",
      results: [],
      error: String(result.stderr || reason).trim().slice(0, 1000),
      rowCount: 0,
    }
  }
  const lines = String(result.stdout || "").split(/\r?\n/).filter(Boolean)
  const results = []
  let chars = 0
  let truncated = result.stdoutTruncated === true
  for (const line of lines) {
    if (results.length >= limit) {
      truncated = true
      break
    }
    let row
    try { row = compactStructuralRow(JSON.parse(line)) } catch { row = compactStructuralRow(line) }
    const cost = JSON.stringify(row).length
    if (chars + cost > AST_RESULT_CHAR_LIMIT) {
      truncated = true
      break
    }
    chars += cost
    results.push(row)
  }
  return {
    available: true,
    attempted: true,
    provider: ast.command,
    resolvable: true,
    reason: "ok",
    results,
    error: null,
    rowCount: results.length,
    truncated,
    outputChars: chars,
  }
}

export async function searchCodeIntelligence(root, query, options = {}) {
  root = path.resolve(root)
  const maxResults = Math.max(1, Math.min(50, Number(options.maxResults || 12)))
  const maxFiles = options.maxFiles || 6000
  const workspace = runtimeWorkspaceSnapshot(root, {
    workspaceState: options.workspaceState,
  })
  const semanticSnapshot = await buildSemanticIndexCached(root, {
    maxFiles,
    workspaceFingerprint: workspace.cacheable ? workspace.fingerprint : "",
  })
  const semantic = await querySemanticIndex(root, query, {
    maxFiles,
    limit: maxResults,
    builtIndex: semanticSnapshot,
  })
  const astProvider = astProviderCommand()
  const structural = options.structuralPattern
    ? await runAstGrep(root, options.structuralPattern, options.language, maxResults)
    : {
        available: astProvider.resolvable,
        attempted: false,
        provider: astProvider.command,
        resolvable: astProvider.resolvable,
        reason: "not-requested",
        results: [],
        error: null,
        rowCount: 0,
      }
  return {
    schemaVersion: 1,
    query: String(query || ""),
    workspaceFingerprint: workspace.cacheable ? workspace.fingerprint : null,
    providers: probeCodeIntelligence(options.file || "", {
      persistent: options.persistent,
      policySource: options.policySource,
      includeSessions: options.includeSessions,
    }),
    semantic: {
      ...semantic,
      runtimeCacheHit: semanticSnapshot.runtimeCacheHit === true,
      runtimeCacheCoalesced: semanticSnapshot.runtimeCacheCoalesced === true,
      results: (semantic.results || []).slice(0, maxResults),
    },
    structural,
  }
}

export { diagnoseCode, lspOperation, lspPoolStatus, lspProviderStatus, shutdownLspPool, LSP_OPERATIONS } from "./lsp-provider.mjs"
