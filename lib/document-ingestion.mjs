import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { runSupervisedProcess } from "./process-supervisor.mjs"

const BUILTIN_TEXT_EXTENSIONS = new Set([".txt",".md",".markdown",".json",".jsonl",".csv",".tsv",".xml",".html",".htm",".yaml",".yml",".toml",".ini",".log",".js",".mjs",".cjs",".jsx",".ts",".tsx",".py",".java",".kt",".kts",".cs",".go",".rs",".rb",".php",".sql",".css",".scss"])
const MARKITDOWN_EXTENSIONS = new Set([".pdf",".docx",".pptx",".xlsx",".xls",".epub",".zip"])
const CACHE_SCHEMA = 2
const CACHE_DIR = ".ues-cache/document-ingestion-v2"
const DEFAULT_CACHE_ENTRIES = 64
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024
const CONVERSION_INFLIGHT = new Map()

function inside(root, target) { return target === root || target.startsWith(root + path.sep) }
async function safeFile(root, relative) {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root))
  const requested = path.resolve(base, String(relative || ""))
  if (!inside(base, requested)) throw new Error("document path escapes workspace root")
  const info = await lstat(requested)
  if (!info.isFile()) throw new Error("document path is not a file")
  const actual = await realpath(requested)
  if (!inside(base, actual)) throw new Error("document symlink escapes workspace root")
  return { base, file: actual, info }
}
function positiveInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}
function cacheRoot(root) { return path.join(path.resolve(root), CACHE_DIR) }
function cacheIdentity(options = {}) { return String(options.converterIdentity || process.env.UES_MARKITDOWN_CACHE_ID || "markitdown:auto-v1").slice(0, 160) }
function contentHash(bytes) { return createHash("sha256").update(bytes).digest("hex") }

export function documentCacheKey(bytes, extension, options = {}) {
  const digest = contentHash(bytes)
  const identity = cacheIdentity(options)
  const key = createHash("sha256").update("ues-document-v2\0" + String(extension || "") + "\0" + identity + "\0" + digest).digest("hex")
  return { key, contentSha256: digest, converterIdentity: identity }
}
async function readCached(root, key, expected) {
  const file = path.join(cacheRoot(root), key + ".json")
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    if (parsed?.schemaVersion !== CACHE_SCHEMA || parsed?.key !== key || parsed?.contentSha256 !== expected.contentSha256 || parsed?.converterIdentity !== expected.converterIdentity || typeof parsed?.markdown !== "string") return null
    return { ...parsed, cacheFile: file }
  } catch { return null }
}
async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true })
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, value, "utf8")
  try { await rename(temp, file) } catch (error) { await rm(temp, { force: true }).catch(() => {}); throw error }
}
async function pruneCache(root, options = {}) {
  const dir = cacheRoot(root)
  const maxEntries = positiveInt(options.maxCacheEntries, DEFAULT_CACHE_ENTRIES, 4, 512)
  const maxBytes = positiveInt(options.maxCacheBytes, DEFAULT_CACHE_BYTES, 1024 * 1024, 512 * 1024 * 1024)
  const entries = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const file = path.join(dir, entry.name)
    const info = await stat(file).catch(() => null)
    if (info?.isFile()) entries.push({ file, bytes: info.size, mtimeMs: info.mtimeMs })
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let keptEntries = 0, keptBytes = 0
  for (const row of entries) {
    if (keptEntries < maxEntries && keptBytes + row.bytes <= maxBytes) { keptEntries += 1; keptBytes += row.bytes; continue }
    await rm(row.file, { force: true }).catch(() => {})
  }
}
async function writeCached(root, key, payload, options = {}) {
  const file = path.join(cacheRoot(root), key + ".json")
  await atomicWrite(file, JSON.stringify(payload) + "\n")
  await pruneCache(root, options).catch(() => {})
  return file
}
function attemptList() {
  return process.platform === "win32"
    ? [["markitdown.exe",[]],["markitdown",[]],["py",["-m","markitdown"]],["python",["-m","markitdown"]]]
    : [["markitdown",[]],["python3",["-m","markitdown"]],["python",["-m","markitdown"]]]
}
async function runMarkItDownAsync(file, options = {}) {
  if (typeof options.markitdownRunner === "function") return options.markitdownRunner(file, options)
  const timeout = positiveInt(options.timeoutMs, 30_000, 5_000, 120_000)
  const maxBuffer = positiveInt(options.maxBuffer, 4 * 1024 * 1024, 256 * 1024, 16 * 1024 * 1024)
  let lastError = "MarkItDown command/module was not found"
  for (const [command, prefix] of attemptList()) {
    const result = await runSupervisedProcess(command, [...prefix, file], {
      cwd: path.dirname(file), hardTimeoutMs: timeout, idleTimeoutMs: timeout,
      stdoutLimit: maxBuffer, stderrLimit: Math.min(maxBuffer, 512 * 1024),
      drainTimeoutMs: 800, killGraceMs: 800, signal: options.signal,
    })
    if (result.exitCode === 0 && !result.stdoutTruncated && String(result.stdout || "").trim()) {
      return { provider: prefix.length ? "markitdown-python" : "markitdown-cli", command, markdown: String(result.stdout), durationMs: result.durationMs }
    }
    if (result.stdoutTruncated) return { provider: "markitdown-unavailable", error: "MarkItDown output exceeded the configured output cap" }
    const diagnostic = String(result.stderr || result.stopReason || ("exit " + result.exitCode)).trim()
    lastError = diagnostic || lastError
    if (!/ENOENT|not found|cannot find|is not recognized/i.test(diagnostic)) return { provider: "markitdown-unavailable", error: lastError }
  }
  return { provider: "markitdown-unavailable", error: lastError }
}
async function awaitSharedConversion(entry, signal) {
  entry.waiters += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    entry.waiters = Math.max(0, entry.waiters - 1)
  }
  try {
    if (!signal) return await entry.promise
    if (signal.aborted) {
      release()
      if (entry.waiters === 0 && !entry.settled) entry.controller.abort()
      const error = new Error("document ingestion aborted")
      error.code = "ABORT_ERR"
      throw error
    }
    return await new Promise((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        release()
        if (entry.waiters === 0 && !entry.settled) entry.controller.abort()
        const error = new Error("document ingestion aborted")
        error.code = "ABORT_ERR"
        reject(error)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      entry.promise.then(
        (value) => { signal.removeEventListener("abort", onAbort); resolve(value) },
        (error) => { signal.removeEventListener("abort", onAbort); reject(error) },
      )
    })
  } finally {
    release()
  }
}
export function documentIngestionSupport(file = "") {
  const ext = path.extname(String(file)).toLowerCase()
  return { schemaVersion: 2, extension: ext, builtin: BUILTIN_TEXT_EXTENSIONS.has(ext), markitdown: MARKITDOWN_EXTENSIONS.has(ext), supported: BUILTIN_TEXT_EXTENSIONS.has(ext) || MARKITDOWN_EXTENSIONS.has(ext) }
}
export async function ingestDocument(root, relative, options = {}) {
  const target = await safeFile(root, relative)
  const support = documentIngestionSupport(target.file)
  const maxBytes = positiveInt(options.maxBytes, 4 * 1024 * 1024, 16 * 1024, 32 * 1024 * 1024)
  if (target.info.size > maxBytes) throw new Error(`document exceeds ingestion limit (${target.info.size} > ${maxBytes} bytes)`)
  if (support.builtin) {
    const content = await readFile(target.file, "utf8")
    return { schemaVersion: 2, provider: "builtin-text", file: path.relative(target.base, target.file).replaceAll("\\","/"), bytes: target.info.size, markdown: content, optionalDependency: false, cacheHit: false, contentSha256: contentHash(Buffer.from(content, "utf8")) }
  }
  if (!support.markitdown) throw new Error(`unsupported document extension: ${support.extension || "(none)"}`)
  const bytes = await readFile(target.file)
  const identity = documentCacheKey(bytes, support.extension, options)
  const cached = await readCached(target.base, identity.key, identity)
  if (cached) return { schemaVersion: 2, provider: cached.provider, file: path.relative(target.base, target.file).replaceAll("\\","/"), bytes: target.info.size, markdown: cached.markdown, optionalDependency: true, cacheHit: true, contentSha256: identity.contentSha256, converterIdentity: identity.converterIdentity, durationMs: 0 }

  const inflightKey = target.base + "\0" + identity.key
  let shared = CONVERSION_INFLIGHT.get(inflightKey)
  if (!shared) {
    const controller = new AbortController()
    shared = { controller, waiters: 0, settled: false, promise: null }
    shared.promise = (async () => {
      const converted = await runMarkItDownAsync(target.file, { ...options, signal: controller.signal })
      if (!converted?.markdown) {
        const error = new Error(`${converted?.error || "MarkItDown conversion failed"}. Install Microsoft MarkItDown only when Office/PDF ingestion is needed.`)
        error.code = "UES_MARKITDOWN_UNAVAILABLE"
        throw error
      }
      const payload = { schemaVersion: CACHE_SCHEMA, key: identity.key, contentSha256: identity.contentSha256, converterIdentity: identity.converterIdentity, provider: converted.provider, command: converted.command || null, createdAt: new Date().toISOString(), markdown: String(converted.markdown) }
      await writeCached(target.base, identity.key, payload, options)
      return { converted, payload }
    })().finally(() => {
      shared.settled = true
      CONVERSION_INFLIGHT.delete(inflightKey)
    })
    CONVERSION_INFLIGHT.set(inflightKey, shared)
  }
  const { converted, payload } = await awaitSharedConversion(shared, options.signal)
  return { schemaVersion: 2, provider: payload.provider, file: path.relative(target.base, target.file).replaceAll("\\","/"), bytes: target.info.size, markdown: payload.markdown, optionalDependency: true, cacheHit: false, contentSha256: identity.contentSha256, converterIdentity: identity.converterIdentity, durationMs: Number(converted.durationMs || 0) }
}
