import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { querySemanticIndex } from "../semantic-index.mjs"
import { anchoredLines, applyAnchoredEdits } from "./edit-anchor.mjs"
import { diagnoseCode, lspProviderStatus } from "./lsp-provider.mjs"

const AST_COMMANDS = ["ast-grep", "sg"]
const commandCache = new Map()
const COMMAND_TTL_MS = 60_000

function commandExists(command) {
  const now = Date.now()
  const cached = commandCache.get(command)
  if (cached && now - cached.at < COMMAND_TTL_MS) return cached.available
  const finder = process.platform === "win32" ? "where" : "which"
  const available = spawnSync(finder, [command], { stdio: "ignore", windowsHide: true }).status === 0
  commandCache.set(command, { available, at: now })
  return available
}

function inside(root, target) { return target === root || target.startsWith(root + path.sep) }

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

export function probeCodeIntelligence(file = "") {
  const astProvider = AST_COMMANDS.find(commandExists) || null
  return {
    schemaVersion: 1,
    anchoredEditing: true,
    semanticIndex: true,
    astProvider,
    lsp: lspProviderStatus(file),
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

function runAstGrep(root, pattern, language, limit) {
  const command = AST_COMMANDS.find(commandExists) || null
  if (!command || !String(pattern || "").trim()) return { provider: null, results: [], error: null }
  const args = ["run", "--pattern", String(pattern), "--json=stream"]
  if (language) args.push("--lang", String(language))
  args.push(".")
  const result = spawnSync(command, args, { cwd: path.resolve(root), encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })
  if (result.status !== 0) return { provider: command, results: [], error: String(result.stderr || ("ast-grep exit " + result.status)).trim().slice(0, 1000) }
  const rows = String(result.stdout || "").split(/\r?\n/).filter(Boolean).slice(0, limit).map((line) => {
    try { return JSON.parse(line) } catch { return { raw: line } }
  })
  return { provider: command, results: rows, error: null }
}

export async function searchCodeIntelligence(root, query, options = {}) {
  const maxResults = Math.max(1, Math.min(50, Number(options.maxResults || 12)))
  const semantic = await querySemanticIndex(root, query, { maxFiles: options.maxFiles || 6000, limit: maxResults })
  const structural = options.structuralPattern ? runAstGrep(root, options.structuralPattern, options.language, maxResults) : { provider: null, results: [], error: null }
  return {
    schemaVersion: 1,
    query: String(query || ""),
    providers: probeCodeIntelligence(options.file || ""),
    semantic: { ...semantic, results: (semantic.results || []).slice(0, maxResults) },
    structural,
  }
}

export { diagnoseCode, lspProviderStatus } from "./lsp-provider.mjs"
