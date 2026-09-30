import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { commandExists } from "../executable-probe.mjs"
import { resolveWindowsCommand } from "../windows-shim.mjs"
import { lspPoolStatus as managedLspPoolStatus, shutdownLspPool as shutdownManagedLspPool, withManagedLspSession } from "./lsp-pool.mjs"
import { diagnosticsHistoryKey, recordDiagnosticsOutcome, resolveDiagnosticsBudget } from "./diagnostics-budget.mjs"
import { runTypeScriptDiagnostics } from "./ts-diagnostics.mjs"
import { fileURLToPath, pathToFileURL } from "node:url"

// Monotonic request identity for diagnostics history. One id is minted per
// `executeDiagnosticsOperation` call so the budget history can enforce exactly
// one terminal outcome per request, independently of how many exit points the
// tier A / tier B race has.
let diagnosticsRequestSequence = 0

// Only the TypeScript/JavaScript providers have a deterministic in-process
// compiler available. Every other provider keeps the tier A behaviour and its
// honest `complete: false` rather than being handed a fabricated answer.
const TYPESCRIPT_FAMILY_PROVIDERS = new Set([
  "typescript-language-server",
  "typescript",
  "vscode-typescript",
  "deno-lsp",
])

function isTypeScriptFamily(providerId) {
  return TYPESCRIPT_FAMILY_PROVIDERS.has(String(providerId || ""))
}

const TYPESCRIPT_FALLBACK_CACHE_TTL_MS = 60_000
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 10_000
const DEFAULT_DIAGNOSTICS_CONTINUATION_MS = 5_000
const MAX_DIAGNOSTICS_TIMEOUT_MS = 60_000
let typescriptFallbackCache = null

const PROVIDERS = [
  { id: "typescript-language-server", extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]), commands: [["typescript-language-server", ["--stdio"]]], languageId: (ext) => [".ts", ".tsx"].includes(ext) ? "typescript" : "javascript" },
  { id: "pyright-langserver", extensions: new Set([".py"]), commands: [["pyright-langserver", ["--stdio"]], ["pylsp", []]], languageId: () => "python" },
  { id: "gopls", extensions: new Set([".go"]), commands: [["gopls", []]], languageId: () => "go" },
  { id: "rust-analyzer", extensions: new Set([".rs"]), commands: [["rust-analyzer", []]], languageId: () => "rust" },
  { id: "clangd", extensions: new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"]), commands: [["clangd", []]], languageId: (ext) => [".c", ".h"].includes(ext) ? "c" : "cpp" },
]

export const LSP_OPERATIONS = Object.freeze([
  "diagnostics",
  "definition",
  "references",
  "symbols",
  "hover",
  "rename-preview",
  "incoming-calls",
  "outgoing-calls",
])

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep)
}

async function safeFile(root, relative) {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root))
  const requested = path.resolve(base, String(relative || ""))
  if (!inside(base, requested)) throw new Error("LSP path escapes workspace root")
  const info = await lstat(requested)
  if (!info.isFile()) throw new Error("LSP path is not a file")
  const actual = await realpath(requested)
  if (!inside(base, actual)) throw new Error("LSP symlink escapes workspace root")
  return { base, file: actual, info }
}

export function clearTypeScriptTsserverFallbackCache() {
  typescriptFallbackCache = null
}

function deriveTypeScriptTsserverFallback(execution) {
  const candidates = [
    execution?.entry,
    ...(Array.isArray(execution?.argsPrefix) ? execution.argsPrefix : []),
  ].filter(Boolean)

  for (const value of candidates) {
    const entry = path.resolve(String(value))
    const binDir = path.dirname(entry)
    const packageRoot = path.basename(binDir).toLowerCase() === "bin"
      ? path.dirname(binDir)
      : null
    const preferred = packageRoot ? path.join(packageRoot, "lib", "tsserver.js") : null
    if (preferred && existsSync(preferred)) return preferred
    if (existsSync(entry)) return entry
  }
  return null
}

export function resolveTypeScriptTsserverFallback(options = {}) {
  const explicit = String(options.explicitPath ?? process.env.UES_TYPESCRIPT_TSSERVER_PATH ?? "").trim()
  if (explicit && existsSync(path.resolve(explicit))) return path.resolve(explicit)

  const platform = String(options.platform || process.platform)
  if (platform !== "win32") return null

  // Explicit injected executions are deterministic probes used by tests/callers;
  // do not mix them into the host PATH cache.
  if (options.execution) return deriveTypeScriptTsserverFallback(options.execution)

  const cacheKey = [
    explicit,
    String(process.env.PATH || ""),
    String(process.env.PATHEXT || ""),
  ].join("\u0000")
  const ttlMs = Math.max(0, Math.min(
    5 * 60_000,
    Number(options.cacheTtlMs ?? process.env.UES_LSP_PROVIDER_PROBE_TTL_MS ?? TYPESCRIPT_FALLBACK_CACHE_TTL_MS),
  ))
  const now = Date.now()
  if (
    typescriptFallbackCache &&
    typescriptFallbackCache.key === cacheKey &&
    now - typescriptFallbackCache.checkedAt < ttlMs
  ) {
    return typescriptFallbackCache.value
  }

  const resolver = typeof options.resolveCommand === "function"
    ? options.resolveCommand
    : resolveWindowsCommand
  const value = deriveTypeScriptTsserverFallback(resolver("tsserver"))
  typescriptFallbackCache = { key: cacheKey, checkedAt: now, value }
  return value
}

function providerRuntimeOptions(provider) {
  if (provider?.id !== "typescript-language-server") return {}
  const fallbackPath = resolveTypeScriptTsserverFallback()
  return fallbackPath
    ? { initializationOptions: { tsserver: { fallbackPath } } }
    : {}
}

function providerFor(file) {
  const ext = path.extname(file).toLowerCase()
  for (const provider of PROVIDERS) {
    if (!provider.extensions.has(ext)) continue
    for (const [command, args] of provider.commands) {
      if (commandExists(command)) {
        return {
          ...provider,
          ...providerRuntimeOptions(provider),
          command,
          args,
          languageId: provider.languageId(ext),
        }
      }
    }
    return { ...provider, command: null, args: [], languageId: provider.languageId(ext) }
  }
  return null
}

export function lspPersistencePolicy(options = {}) {
  if (typeof options.persistent === "boolean") {
    return { enabled: options.persistent, source: "explicit-option" }
  }
  const env = String(process.env.UES_LSP_PERSISTENT || "").trim()
  if (env === "0") return { enabled: false, source: "env-disabled" }
  if (env === "1") return { enabled: true, source: "env-enabled" }
  if (process.env.UES_CHILD_PROCESS === "1") {
    return { enabled: true, source: "pi-child-runtime" }
  }
  return { enabled: false, source: "short-lived-default" }
}

function boundedTimeout(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function diagnosticsTimeoutPolicy(options = {}) {
  const requestTimeoutMs = boundedTimeout(
    options.timeoutMs ?? process.env.UES_LSP_REQUEST_TIMEOUT_MS,
    5_000,
    500,
    30_000,
  )
  const initialTimeoutMs = boundedTimeout(
    options.diagnosticsTimeoutMs ?? process.env.UES_LSP_DIAGNOSTICS_TIMEOUT_MS,
    Math.max(DEFAULT_DIAGNOSTICS_TIMEOUT_MS, requestTimeoutMs),
    500,
    30_000,
  )
  const continuationInput =
    options.diagnosticsContinuationMs ?? process.env.UES_LSP_DIAGNOSTICS_CONTINUATION_MS
  const continuationTimeoutMs = boundedTimeout(
    continuationInput,
    DEFAULT_DIAGNOSTICS_CONTINUATION_MS,
    0,
    30_000,
  )
  return {
    initialTimeoutMs,
    continuationTimeoutMs,
    totalTimeoutMs: Math.min(
      MAX_DIAGNOSTICS_TIMEOUT_MS,
      initialTimeoutMs + continuationTimeoutMs,
    ),
  }
}

export function lspProviderStatus(file = "", options = {}) {
  const ext = path.extname(String(file || "")).toLowerCase()
  const providers = PROVIDERS
    .filter((provider) => !ext || provider.extensions.has(ext))
    .map((provider) => {
      const selected = provider.commands.find(([command]) => commandExists(command)) || null
      return { id: provider.id, available: Boolean(selected), command: selected?.[0] || null, extensions: [...provider.extensions] }
    })
  const basePolicy = lspPersistencePolicy(options)
  const policy = options.policySource
    ? { ...basePolicy, source: String(options.policySource) }
    : basePolicy
  return {
    schemaVersion: 2,
    extension: ext,
    available: providers.some((row) => row.available),
    operations: [...LSP_OPERATIONS],
    persistentPool: {
      ...managedLspPoolStatus({
        includeSessions: options.includeSessions === true,
        persistent: policy.enabled,
      }),
      policy,
    },
    providers,
  }
}

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body])
}

function relativeUri(base, uri) {
  try {
    if (!String(uri || "").startsWith("file:")) return String(uri || "")
    const file = fileURLToPath(uri)
    if (!inside(base, file)) return String(uri || "")
    return path.relative(base, file).replaceAll("\\", "/")
  } catch {
    return String(uri || "")
  }
}

function position(options = {}) {
  const line = Math.max(1, Math.trunc(Number(options.line || 1)))
  const character = Math.max(1, Math.trunc(Number(options.character || 1)))
  return { line: line - 1, character: character - 1 }
}

function sanitizeDiagnostic(value = {}) {
  return {
    range: value.range || null,
    severity: Number.isFinite(Number(value.severity)) ? Number(value.severity) : null,
    code: value.code == null ? null : String(value.code),
    source: value.source == null ? null : String(value.source),
    message: String(value.message || "").slice(0, 4000),
  }
}

function sanitizeLocations(base, value, limit = 120) {
  const list = Array.isArray(value) ? value : value ? [value] : []
  return list.slice(0, limit).map((item) => {
    if (item?.targetUri) {
      return {
        file: relativeUri(base, item.targetUri),
        range: item.targetRange || null,
        selectionRange: item.targetSelectionRange || null,
        originSelectionRange: item.originSelectionRange || null,
      }
    }
    return {
      file: relativeUri(base, item?.uri),
      range: item?.range || null,
    }
  })
}

function flattenSymbols(base, values, output, parent = null, limit = 160) {
  for (const item of Array.isArray(values) ? values : []) {
    if (output.length >= limit) break
    output.push({
      name: String(item?.name || "").slice(0, 300),
      detail: item?.detail == null ? null : String(item.detail).slice(0, 500),
      kind: item?.kind ?? null,
      containerName: item?.containerName || parent,
      file: item?.location?.uri ? relativeUri(base, item.location.uri) : null,
      range: item?.range || item?.location?.range || null,
      selectionRange: item?.selectionRange || null,
    })
    if (Array.isArray(item?.children)) flattenSymbols(base, item.children, output, item?.name || parent, limit)
  }
  return output
}

function hoverText(contents) {
  if (contents == null) return ""
  if (typeof contents === "string") return contents
  if (Array.isArray(contents)) {
    return contents.map((item) => typeof item === "string" ? item : item?.value || "").filter(Boolean).join("\n")
  }
  if (typeof contents === "object") return String(contents.value || "")
  return String(contents)
}

function sanitizeWorkspaceEdit(base, edit, limit = 240) {
  const rows = []
  for (const [uri, edits] of Object.entries(edit?.changes || {})) {
    for (const item of Array.isArray(edits) ? edits : []) {
      rows.push({ file: relativeUri(base, uri), range: item.range || null, newText: String(item.newText || "").slice(0, 4000) })
      if (rows.length >= limit) return { edits: rows, truncated: true }
    }
  }
  for (const change of Array.isArray(edit?.documentChanges) ? edit.documentChanges : []) {
    const uri = change?.textDocument?.uri
    for (const item of Array.isArray(change?.edits) ? change.edits : []) {
      rows.push({ file: relativeUri(base, uri), range: item.range || null, newText: String(item.newText || "").slice(0, 4000) })
      if (rows.length >= limit) return { edits: rows, truncated: true }
    }
  }
  return { edits: rows, truncated: false }
}

function sanitizeHierarchyItem(base, item) {
  if (!item) return null
  return {
    name: String(item.name || "").slice(0, 300),
    detail: item.detail == null ? null : String(item.detail).slice(0, 500),
    kind: item.kind ?? null,
    file: relativeUri(base, item.uri),
    range: item.range || null,
    selectionRange: item.selectionRange || null,
    _raw: item,
  }
}

function sanitizeHierarchyCalls(base, values, direction, limit = 120) {
  return (Array.isArray(values) ? values : []).slice(0, limit).map((call) => {
    const item = direction === "incoming" ? call.from : call.to
    const clean = sanitizeHierarchyItem(base, item)
    if (clean) delete clean._raw
    return {
      item: clean,
      ranges: direction === "incoming" ? (call.fromRanges || []) : (call.fromRanges || []),
    }
  })
}

async function withEphemeralLspSession(root, relative, options, operation) {
  const target = await safeFile(root, relative)
  const provider = providerFor(target.file)
  const relativeFile = path.relative(target.base, target.file).replaceAll("\\", "/")
  if (!provider?.command) {
    return {
      schemaVersion: 2,
      file: relativeFile,
      available: false,
      provider: provider?.id || null,
      operation: options.operation || null,
      reason: provider ? "lsp-command-unavailable" : "unsupported-extension",
      result: null,
    }
  }

  const maxBytes = Math.max(8 * 1024, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 1024 * 1024)))
  if (target.info.size > maxBytes) throw new Error("LSP file exceeds limit (" + target.info.size + " > " + maxBytes + " bytes)")
  const source = await readFile(target.file, "utf8")
  const uri = pathToFileURL(target.file).href
  const rootUri = pathToFileURL(target.base + path.sep).href
  const timeoutMs = Math.max(500, Math.min(15_000, Number(options.timeoutMs || 5000)))

  const execution = process.platform === "win32"
    ? resolveWindowsCommand(provider.command)
    : { executable: provider.command, argsPrefix: [] }
  if (!execution?.executable) {
    return {
      schemaVersion: 2,
      file: relativeFile,
      available: true,
      provider: provider.id,
      command: provider.command,
      operation: options.operation || null,
      reason: "spawn-error",
      result: null,
      stderr: null,
      error: "unable to resolve LSP executable: " + provider.command,
    }
  }

  return await new Promise((resolve) => {
    const child = spawn(execution.executable, [...(execution.argsPrefix || []), ...provider.args], {
      cwd: target.base,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    })
    let buffer = Buffer.alloc(0)
    let stderr = ""
    let settled = false
    let nextId = 1
    const pending = new Map()
    const notificationWaiters = new Map()
    const recentNotifications = new Map()
    let timer = null

    const finish = (reason, result = null, error = null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      for (const waiter of pending.values()) waiter.reject(new Error("LSP session settled: " + reason))
      pending.clear()
      try {
        if (child.stdin.writable) child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "exit", params: null }))
      } catch {}
      // The ephemeral server must be gone before this call resolves. Previously
      // the kill was a detached 50ms timer, so the child outlived the call: it
      // kept a live handle on the workspace directory (which breaks an
      // immediate directory removal on Windows) and leaked a process per call.
      // The result is now delivered only once the child has actually exited,
      // with a bound so a wedged process can never hang the caller.
      const exitSettled = new Promise((done) => {
        let settledExit = false
        const settle = () => {
          if (settledExit) return
          settledExit = true
          done()
        }
        child.once("close", settle)
        child.once("exit", settle)
        const killTimer = setTimeout(() => { try { child.kill() } catch {} }, 50)
        killTimer.unref?.()
        const guard = setTimeout(settle, 2_000)
        guard.unref?.()
      })
      exitSettled.then(() => resolve({
        schemaVersion: 2,
        file: relativeFile,
        available: true,
        provider: provider.id,
        command: provider.command,
        operation: options.operation || null,
        reason,
        result,
        stderr: stderr.trim().slice(0, 2000) || null,
        error: error ? String(error instanceof Error ? error.message : error).slice(0, 1200) : null,
      }))
    }

    const send = (payload) => {
      if (settled || !child.stdin.writable) throw new Error("LSP stdin unavailable")
      child.stdin.write(encodeMessage(payload))
    }

    const request = (method, params) => new Promise((res, rej) => {
      const id = nextId++
      pending.set(id, { resolve: res, reject: rej, method })
      try { send({ jsonrpc: "2.0", id, method, params }) }
      catch (error) { pending.delete(id); rej(error) }
    })

    const notify = (method, params) => send({ jsonrpc: "2.0", method, params })

    const waitForNotification = (method) => {
      if (recentNotifications.has(method)) {
        const value = recentNotifications.get(method)
        recentNotifications.delete(method)
        return Promise.resolve(value)
      }
      return new Promise((res) => {
        const list = notificationWaiters.get(method) || []
        list.push(res)
        notificationWaiters.set(method, list)
      })
    }

    const dispatch = (message) => {
      if (message?.id != null && pending.has(message.id)) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(String(message.error.message || "LSP request failed")))
        else waiter.resolve(message.result)
        return
      }
      if (message?.method) {
        // Language servers may issue configuration/capability requests. Reply
        // deterministically so the server does not stall waiting on a client UI.
        if (message.id != null) {
          try {
            const result = message.method === "workspace/configuration"
              ? (Array.isArray(message.params?.items) ? message.params.items.map(() => null) : [])
              : null
            send({ jsonrpc: "2.0", id: message.id, result })
          } catch {}
        }
        const waiters = notificationWaiters.get(message.method) || []
        if (waiters.length) {
          notificationWaiters.delete(message.method)
          for (const waiter of waiters) waiter(message.params)
        } else {
          recentNotifications.set(message.method, message.params)
          if (recentNotifications.size > 16) {
            const oldest = recentNotifications.keys().next().value
            if (oldest) recentNotifications.delete(oldest)
          }
        }
      }
    }

    const parse = () => {
      while (!settled) {
        const headerEnd = buffer.indexOf("\r\n\r\n")
        if (headerEnd < 0) return
        const header = buffer.subarray(0, headerEnd).toString("ascii")
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) { buffer = buffer.subarray(headerEnd + 4); continue }
        const length = Number(match[1])
        const bodyStart = headerEnd + 4
        if (buffer.length < bodyStart + length) return
        const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
        buffer = buffer.subarray(bodyStart + length)
        try { dispatch(JSON.parse(body)) } catch {}
      }
    }

    child.stdout.on("data", (chunk) => { buffer = Buffer.concat([buffer, Buffer.from(chunk)]); parse() })
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString() })
    child.on("error", (error) => finish("spawn-error", null, error))
    child.on("close", (code) => { if (!settled) finish("server-exit:" + (code ?? "unknown")) })

    timer = setTimeout(() => finish("timeout"), timeoutMs)
    timer.unref?.()

    ;(async () => {
      try {
        await request("initialize", {
          processId: process.pid,
          rootUri,
          capabilities: {
            textDocument: {
              publishDiagnostics: { relatedInformation: true },
              definition: { linkSupport: true },
              references: {},
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              rename: { prepareSupport: true },
              callHierarchy: {},
            },
            workspace: { workspaceFolders: true, applyEdit: false },
          },
          workspaceFolders: [{ uri: rootUri, name: path.basename(target.base) || "workspace" }],
          initializationOptions: provider.initializationOptions || undefined,
        })
        notify("initialized", {})
        notify("textDocument/didOpen", {
          textDocument: { uri, languageId: provider.languageId, version: 1, text: source },
        })
        const result = await operation({
          request,
          notify,
          waitForNotification,
          uri,
          base: target.base,
          file: relativeFile,
        })
        finish("ok", result)
      } catch (error) {
        finish("request-error", null, error)
      }
    })()
  })
}

// Tiered diagnostics execution, extracted so the tier A/B contract is directly
// testable against a mock language server without duplicating the logic.
//
// Tier A waits, bounded, for the server push. Tier B runs concurrently with
// that wait, not after it, so a tier A timeout costs the budget only. Neither
// tier can end a session: a missed notification is a request-level outcome.
export async function executeDiagnosticsOperation({ session, provider, options = {}, maxResults = 120 }) {
  const budget = diagnosticsTimeoutPolicy(options)
  const coldSession = session.meta?.coldSession === true
  // Adaptive learning is keyed on the workload, not on the language-server
  // process. `session.meta.sessionId` is a fresh `randomUUID()` on every start,
  // so keying on it meant every idle-TTL eviction, bounded restart or config
  // re-acquisition silently discarded the timings learned so far.
  const historyKey = diagnosticsHistoryKey({
    workspace: session.base,
    providerId: provider.id,
    configFingerprint: session.meta?.configFingerprint,
    file: session.file,
    coldSession,
  })
  // Tier A stays a bounded wait on the server push. The adaptive policy may
  // *shrink* that wait for small files, but is deliberately clamped to the
  // existing ceiling: tier B exists precisely so that a missed push does not
  // have to be bought back with a longer wait.
  const adaptive = resolveDiagnosticsBudget({
    bytes: session.documentSync?.bytes,
    lineCount: session.documentSync?.lineCount,
    providerId: provider.id,
    coldSession,
    startupMs: session.meta?.coldStartMs,
    historyKey,
    policy: options.diagnosticsBudgetPolicy,
  })
  const initialTimeoutMs = Math.max(250, Math.min(adaptive.budgetMs, budget.initialTimeoutMs))
  const continuationTimeoutMs = Math.max(
    0,
    Math.min(budget.continuationTimeoutMs, Math.max(0, budget.totalTimeoutMs - initialTimeoutMs)),
  )
  const requestId = `diagnostics-${(diagnosticsRequestSequence += 1)}`
  const startedAt = Date.now()

  // Exactly one terminal outcome per request. The race has several exits and a
  // single request can pass through more than one of them (an incomplete tier B
  // that settles mid-window, then a continuation that later times out). Recording
  // on every exit double-counted one request and inflated the next budget twice.
  let terminalRecorded = false
  const recordTerminal = (outcome) => {
    if (terminalRecorded) return
    terminalRecorded = true
    recordDiagnosticsOutcome(historyKey, { ...outcome, requestId, coldSession })
  }

  const waitForDiagnostics = (timeoutMs) =>
    session.waitForNotification("textDocument/publishDiagnostics", {
      predicate: (value) =>
        (!value?.uri || value.uri === session.uri) &&
        (value?.version == null || Number(value.version) >= Number(session.documentSync?.version || 0)),
      afterAt: session.documentSync?.changed ? session.documentSync.syncedAt : 0,
      timeoutMs,
    })

  // A short grace keeps the healthy fast path byte-for-byte unchanged: when the
  // server answers promptly no child process is ever spawned.
  // Tier B only ever applies to the TypeScript/JavaScript family; every other
  // provider keeps tier A alone and its honest `complete: false`.
  //
  // The grace is clamped to half the initial server window. Without that clamp a
  // short server budget could expire before the fallback was ever launched, which
  // would waste the tier entirely; with it, the fallback always starts *inside*
  // the existing budget so the two genuinely overlap.
  //
  // `graceMs` is the EFFECTIVE value and is what every result shape reports, so
  // telemetry describes the runtime behaviour rather than the raw option. It is
  // resolved before the race starts so a win on any lane can still report it.
  const fallbackEligible = isTypeScriptFamily(provider.id)
  const configuredGraceMs = fallbackEligible
    ? boundedTimeout(
        options.diagnosticsFallbackGraceMs ?? process.env.UES_LSP_DIAGNOSTICS_FALLBACK_GRACE_MS,
        1_500,
        0,
        30_000,
      )
    : null
  const graceMs =
    configuredGraceMs == null
      ? null
      : Math.min(configuredGraceMs, Math.floor(initialTimeoutMs / 2))

  const completed = (params, continuationUsed = false) => {
    const values = Array.isArray(params?.diagnostics) ? params.diagnostics : []
    return {
      diagnostics: values.slice(0, maxResults).map(sanitizeDiagnostic),
      complete: true,
      reason: "ok",
      source: "lsp-publish",
      timeoutMs: budget.totalTimeoutMs,
      initialTimeoutMs,
      continuationTimeoutMs,
      continuationUsed,
      budgetSource: adaptive.source,
      budgetBucket: adaptive.bucket,
      budgetMs: initialTimeoutMs + continuationTimeoutMs,
      fallbackUsed: false,
      fallbackReason: null,
      fallbackDurationMs: null,
      fallbackGraceMs: graceMs,
      evidenceFingerprint: null,
    }
  }

  // Tier B runs concurrently with the tier A wait, not after it.
  //
  // The previous shape waited out the full 15s budget and only then spent
  // another ~2.4s on the compiler, so a timeout cost 15s + fallback. Here the
  // fallback is launched after a short grace period and raced against the
  // remaining language-server budget, so the total is bounded by whichever
  // finishes first and never becomes "budget + fallback".
  //
  // Races are resolved on trust, not on speed:
  //   - a tier A publish always wins: it is the authoritative server answer;
  //   - tier B may only win early when it is genuinely complete;
  //   - an incomplete tier B result is held, never used to fake a clean file,
  //     and the language server keeps its full bounded window.
  const fallbackAbort = new AbortController()
  let fallbackInFlight = null
  let fallbackOutcome = null
  let fallbackLaunched = false
  // True once tier B has produced a terminal result of its own. This -- not
  // "was the pointer moved" -- is what takes tier B out of the race.
  let fallbackSettled = false
  let fallbackAbandoned = false

  // One long-lived promise meaning "tier B has produced a result".
  //
  // The previous implementation built the race inside the retry loop and read a
  // `fallbackPromise` variable at that instant. With a non-zero grace the variable
  // was still `null` when the first `Promise.race` was constructed, so tier B was
  // raced against a never-settling promise; when the grace timer later assigned
  // the real promise, the already-constructed race was not rebuilt and could
  // never observe it. The continuation then explicitly nulled the variable. The
  // net effect was that with the DEFAULT grace a tier B finishing complete after
  // ~800ms still could not win, and the call ran the full initial + continuation
  // budget (measured before the fix: 10259ms, versus 881ms when the grace was 0).
  //
  // A single deferred created up front fixes this structurally: every window
  // races the *same* promise, so a tier B result becomes winnable the instant it
  // exists, whichever window happens to be open at the time.
  let resolveFallbackSignal = null
  const fallbackSignal = new Promise((resolve) => { resolveFallbackSignal = resolve })

  const launchFallback = () => {
    if (fallbackLaunched) return
    if (!isTypeScriptFamily(provider.id)) return
    fallbackLaunched = true
    // `fallbackInFlight` is the durable handle and is never cleared; it must stay
    // awaitable after the race so cleanup can reap the child before returning.
    fallbackInFlight = runTypeScriptDiagnostics({
      base: session.base,
      // The pooled adapter reports `file` relative to the workspace root, so it
      // must be re-anchored; process.cwd() would silently analyse the wrong file
      // whenever the caller is not running from the workspace root.
      file: path.resolve(session.base, session.file),
      provider: { id: provider.id, command: provider.command },
      timeoutMs: options.diagnosticsFallbackTimeoutMs,
      maxResults,
      signal: fallbackAbort.signal,
    })
      .catch((error) => ({
        complete: false,
        reason: "fallback-error",
        diagnostics: [],
        source: "typescript-compiler-api",
        evidenceFingerprint: null,
        compilerVersion: null,
        environmentDiagnosticCount: 0,
        error: String(error instanceof Error ? error.message : error).slice(0, 400),
        durationMs: 0,
      }))
      .then((outcome) => {
        fallbackOutcome = outcome
        fallbackSettled = true
        resolveFallbackSignal(outcome)
        return outcome
      })
  }

  let graceTimer = null
  if (graceMs != null && graceMs === 0) launchFallback()
  else if (graceMs != null && graceMs > 0) {
    graceTimer = setTimeout(launchFallback, graceMs)
    graceTimer.unref?.()
  }

  // Deterministic child cleanup: whichever way we leave, the fallback process is
  // signalled once and its timer cleared, so nothing is left running or pending
  // a reap.
  const settleFallback = (abandoned) => {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    fallbackAbandoned = Boolean(abandoned && fallbackLaunched)
    try {
      fallbackAbort.abort()
    } catch {}
  }

  const timedOutShape = (continuationUsed) => ({
    diagnostics: [],
    complete: false,
    reason: "diagnostics-timeout",
    source: "lsp-publish",
    timeoutMs: budget.totalTimeoutMs,
    initialTimeoutMs,
    continuationTimeoutMs,
    continuationUsed,
    budgetSource: adaptive.source,
    budgetBucket: adaptive.bucket,
    budgetMs: initialTimeoutMs + continuationTimeoutMs,
    fallbackUsed: false,
    fallbackReason: null,
    fallbackDurationMs: null,
    fallbackGraceMs: graceMs,
    evidenceFingerprint: null,
    fallbackLaunched,
    fallbackAbandoned,
  })

  const fallbackShape = (outcome, continuationUsed) => ({
    diagnostics: Array.isArray(outcome?.diagnostics) ? outcome.diagnostics : [],
    complete: outcome?.complete === true,
    reason:
      outcome?.complete === true
        ? "fallback-complete"
        : String(outcome?.reason || "fallback-incomplete"),
    source: "typescript-compiler-api",
    timeoutMs: budget.totalTimeoutMs,
    initialTimeoutMs,
    continuationTimeoutMs,
    continuationUsed,
    budgetSource: adaptive.source,
    budgetBucket: adaptive.bucket,
    budgetMs: initialTimeoutMs + continuationTimeoutMs,
    fallbackUsed: true,
    fallbackReason: String(outcome?.reason || "unknown"),
    fallbackDurationMs: Number(outcome?.durationMs) || 0,
    fallbackGraceMs: graceMs,
    evidenceFingerprint: outcome?.evidenceFingerprint || null,
    fallbackCompilerVersion: outcome?.compilerVersion || null,
    fallbackEnvironmentDiagnosticCount: Number(outcome?.environmentDiagnosticCount) || 0,
    fallbackLaunched: true,
    fallbackAbandoned: false,
  })

  // A promise that never settles, used to hold a lane out of the race entirely:
  // tier B that already settled INCOMPLETE, or was never launched.
  const pending = () => new Promise(() => {})

  let continuationUsed = false
  // Tier A's window is an ABSOLUTE deadline measured from the start of the
  // operation, never a fresh per-iteration allowance.
  //
  // An incomplete tier B result resumes the loop, and re-arming a whole new
  // initial window there would silently re-grant budget the request had already
  // spent: the large-file incomplete case then cost
  // grace + fallback + initial + continuation (measured 19019ms) instead of
  // initial + continuation. Resuming with the *remaining* time keeps the whole
  // operation bounded by the policy regardless of how the race resolves.
  let windowDeadline = startedAt + initialTimeoutMs
  while (true) {
    const remainingMs = windowDeadline - Date.now()
    if (remainingMs <= 0) break // this window is already spent
    const lspAttempt = waitForDiagnostics(remainingMs).then(
      (value) => ({ kind: "lsp", value }),
      (error) => ({ kind: "lsp-error", error }),
    )
    // An in-flight tier B keeps racing -- including inside the continuation
    // window, so a complete fallback can still win there. Only a tier B that has
    // already settled is held out; if that settlement was COMPLETE the call has
    // already returned.
    const fallbackAttempt = fallbackSettled
      ? pending()
      : fallbackSignal.then((value) => ({ kind: "fallback", value }))
    const winner = await Promise.race([lspAttempt, fallbackAttempt])

    if (winner.kind === "lsp") {
      // The server answered, so any tier B work still in flight is abandoned and
      // reaped rather than awaited for a result.
      settleFallback(true)
      // Deterministic cleanup: wait for the abandoned child to actually exit
      // before returning. Without this the caller could observe a process (and on
      // Windows, a transiently locked working directory) that is still on its way
      // out, which breaks immediate post-call cleanup.
      if (fallbackInFlight) await fallbackInFlight.catch(() => null)
      recordTerminal({
        durationMs: Date.now() - startedAt,
        timedOut: false,
        complete: true,
        source: "lsp-publish",
      })
      const ok = completed(winner.value, continuationUsed)
      return { ...ok, fallbackLaunched, fallbackAbandoned }
    }

    if (winner.kind === "lsp-error") {
      if (winner.error?.code !== "LSP_NOTIFICATION_TIMEOUT") {
        settleFallback(true)
        // Reap before propagating: a caller that reacts by removing the workspace
        // must not find a stray child still holding it.
        if (fallbackInFlight) await fallbackInFlight.catch(() => null)
        throw winner.error
      }
      // The language server still has its continuation window. An incomplete
      // tier B result is deliberately ignored here: it may not stand in for a
      // clean file, so the server keeps its chance to answer. An in-flight tier B
      // deliberately keeps racing -- only a settled tier B is held out above.
      if (continuationTimeoutMs > 0 && !continuationUsed) {
        continuationUsed = true
        windowDeadline = Date.now() + continuationTimeoutMs
        continue
      }
      break
    }

    // Tier B settled first.
    if (winner.value?.complete === true) {
      settleFallback(false)
      recordTerminal({
        durationMs: Date.now() - startedAt,
        timedOut: false,
        complete: true,
        source: "typescript-compiler-api",
      })
      return { ...fallbackShape(winner.value, continuationUsed), fallbackAbandoned: false }
    }
    // Incomplete tier B: hold the evidence (`fallbackOutcome` keeps it) and keep
    // waiting on the language server until its bounded deadline, then report
    // honestly. `fallbackSettled` is now true, so the next iteration waits on tier A
    // alone -- it can no longer resolve this race spuriously -- and it resumes with
    // whatever is left of the current window rather than a fresh one. Nothing is
    // recorded here: the request has not reached its terminal outcome yet.
  }

  // Tier A is exhausted. Use the tier B result if one was produced -- complete or
  // not -- because it is real evidence gathered in parallel. An in-flight fallback
  // is awaited rather than thrown away: it was already paid for during the overlap
  // and carries its own hard bound, so this is not a second serialised run. Waiting
  // on it is what keeps a short server budget from silently discarding real
  // diagnostics.
  //
  // If the grace window never elapsed the fallback was not started yet; start it now
  // rather than surrendering the tier entirely. This happens *before* the cleanup
  // abort so a just-launched child is not cancelled by the signal meant to reap an
  // abandoned one.
  if (fallbackEligible && !fallbackLaunched) launchFallback()
  const outcome =
    fallbackOutcome || (fallbackInFlight ? await fallbackInFlight.catch(() => null) : null)
  settleFallback(false)
  const durationMs = Date.now() - startedAt
  if (outcome) {
    recordTerminal({
      durationMs,
      timedOut: true,
      complete: outcome.complete === true,
      source: "typescript-compiler-api",
    })
    return { ...fallbackShape(outcome, true), fallbackLaunched: true, fallbackAbandoned: false }
  }
  recordTerminal({ durationMs, timedOut: true, complete: false, source: "lsp-publish" })
  return { ...timedOutShape(true), fallbackAbandoned: false }
}
export async function lspOperation(root, relative, operation, options = {}) {
  const op = String(operation || "")
  if (!LSP_OPERATIONS.includes(op)) throw new Error("unsupported LSP operation: " + op)

  const target = await safeFile(root, relative)
  const provider = providerFor(target.file)
  const relativeFile = path.relative(target.base, target.file).replaceAll("\\", "/")
  if (!provider?.command) {
    return {
      schemaVersion: 2,
      file: relativeFile,
      available: false,
      provider: provider?.id || null,
      operation: op,
      reason: provider ? "lsp-command-unavailable" : "unsupported-extension",
      result: null,
      persistent: false,
    }
  }

  const maxResults = Math.max(1, Math.min(500, Number(options.maxResults || 120)))
  const execute = async (session) => {
    const pos = position(options)
    const textDocument = { uri: session.uri }

    if (op === "diagnostics") {
      return await executeDiagnosticsOperation({ session, provider, options, maxResults })
    }
    if (op === "definition") {
      const result = await session.request("textDocument/definition", { textDocument, position: pos })
      return { locations: sanitizeLocations(session.base, result, maxResults) }
    }
    if (op === "references") {
      const result = await session.request("textDocument/references", {
        textDocument,
        position: pos,
        context: { includeDeclaration: options.includeDeclaration !== false },
      })
      return { locations: sanitizeLocations(session.base, result, maxResults) }
    }
    if (op === "symbols") {
      const result = await session.request("textDocument/documentSymbol", { textDocument })
      return { symbols: flattenSymbols(session.base, result, [], null, maxResults) }
    }
    if (op === "hover") {
      const result = await session.request("textDocument/hover", { textDocument, position: pos })
      return {
        range: result?.range || null,
        markdown: hoverText(result?.contents).slice(0, Number(options.maxHoverChars || 12000)),
      }
    }
    if (op === "rename-preview") {
      const newName = String(options.newName || "").trim()
      if (!newName) throw new Error("rename-preview requires newName")
      let prepared = null
      try {
        prepared = await session.request("textDocument/prepareRename", { textDocument, position: pos })
      } catch {}
      const result = await session.request("textDocument/rename", { textDocument, position: pos, newName })
      return {
        prepared: prepared || null,
        newName,
        ...sanitizeWorkspaceEdit(session.base, result, maxResults),
        applied: false,
      }
    }
    if (op === "incoming-calls" || op === "outgoing-calls") {
      const prepared = await session.request("textDocument/prepareCallHierarchy", { textDocument, position: pos })
      const item = Array.isArray(prepared) ? prepared[0] : prepared
      if (!item) return { root: null, calls: [] }
      const method = op === "incoming-calls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls"
      const result = await session.request(method, { item })
      const rootItem = sanitizeHierarchyItem(session.base, item)
      if (rootItem) delete rootItem._raw
      return {
        root: rootItem,
        calls: sanitizeHierarchyCalls(session.base, result, op === "incoming-calls" ? "incoming" : "outgoing", maxResults),
      }
    }
    return null
  }

  const persistence = lspPersistencePolicy(options)
  const managed = await withManagedLspSession(
    target,
    provider,
    { ...options, persistent: persistence.enabled, operation: op },
    execute,
  ).catch((error) => ({
    ok: false,
    reason: "managed-lsp-exception",
    error: String(error instanceof Error ? error.message : error).slice(0, 1200),
  }))

  if (managed?.ok) {
    const operationReason =
      op === "diagnostics" && managed.result?.complete === false
        ? String(managed.result?.reason || "diagnostics-incomplete")
        : "ok"
    return {
      schemaVersion: 2,
      file: relativeFile,
      available: true,
      provider: provider.id,
      command: provider.command,
      operation: op,
      reason: operationReason,
      transportReason: "ok",
      result: managed.result,
      stderr: managed.stderr || null,
      error: null,
      persistent: true,
      pool: { ...managed.meta, policy: persistence },
    }
  }

  const fallback = await withEphemeralLspSession(root, relative, { ...options, operation: op }, execute)
  return {
    ...fallback,
    persistent: false,
    fallbackFrom: managed?.reason || "managed-lsp-unavailable",
    managedError: managed?.error || null,
    persistencePolicy: persistence,
  }
}

export function lspPoolStatus(options = {}) {
  return managedLspPoolStatus(options)
}

export async function shutdownLspPool(root = null) {
  return shutdownManagedLspPool(root)
}

export async function diagnoseCode(root, relative, options = {}) {
  const result = await lspOperation(root, relative, "diagnostics", options)
  const complete = result?.result?.complete ?? (result?.reason === "ok")
  const diagnosticsReason = result?.result?.reason || result?.reason || null
  const transportReason = result?.transportReason || result?.reason || null
  // An empty diagnostics array is only ever paired with `complete: true` when a
  // source actually finished evaluating. The two are reported together and must
  // be read together: `complete: false` means "not proven", never "clean".
  return {
    ...result,
    transportReason,
    reason: complete ? transportReason : diagnosticsReason,
    diagnostics: result?.result?.diagnostics || [],
    complete,
    diagnosticsReason,
    diagnosticsSource: result?.result?.source || (complete ? "lsp-publish" : "none"),
    diagnosticsTimeoutMs: result?.result?.timeoutMs || null,
    diagnosticsInitialTimeoutMs: result?.result?.initialTimeoutMs || null,
    diagnosticsContinuationTimeoutMs: result?.result?.continuationTimeoutMs || null,
    diagnosticsContinuationUsed: result?.result?.continuationUsed === true,
    diagnosticsFallbackUsed: result?.result?.fallbackUsed === true,
    diagnosticsFallbackReason: result?.result?.fallbackReason || null,
    diagnosticsFallbackDurationMs: result?.result?.fallbackDurationMs ?? null,
    diagnosticsEvidenceFingerprint: result?.result?.evidenceFingerprint || null,
    diagnosticsBudgetSource: result?.result?.budgetSource || null,
    diagnosticsBudgetBucket: result?.result?.budgetBucket || null,
    diagnosticsBudgetMs: result?.result?.budgetMs ?? null,
    diagnosticsFallbackCompilerVersion: result?.result?.fallbackCompilerVersion || null,
    diagnosticsFallbackEnvironmentCount: result?.result?.fallbackEnvironmentDiagnosticCount ?? null,
    diagnosticsFallbackLaunched: result?.result?.fallbackLaunched === true,
    diagnosticsFallbackAbandoned: result?.result?.fallbackAbandoned === true,
    // The EFFECTIVE grace, taken from the operation result rather than from the
    // raw option. `executeDiagnosticsOperation` clamps the configured grace to
    // half the resolved initial window, so reporting the raw option described an
    // intent the runtime never used -- with the default path it reported `null`
    // even though a real 1500ms grace was in force. Providers whose fallback is
    // not eligible legitimately report `null` because no grace exists at all.
    diagnosticsFallbackGraceMs: result?.result?.fallbackGraceMs ?? null,
    result: undefined,
  }
}
