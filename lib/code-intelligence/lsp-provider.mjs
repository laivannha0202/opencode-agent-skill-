import { spawn } from "node:child_process"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { commandExists } from "../executable-probe.mjs"
import { lspPoolStatus as managedLspPoolStatus, shutdownLspPool as shutdownManagedLspPool, withManagedLspSession } from "./lsp-pool.mjs"
import { fileURLToPath, pathToFileURL } from "node:url"

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

function providerFor(file) {
  const ext = path.extname(file).toLowerCase()
  for (const provider of PROVIDERS) {
    if (!provider.extensions.has(ext)) continue
    for (const [command, args] of provider.commands) {
      if (commandExists(command)) return { ...provider, command, args, languageId: provider.languageId(ext) }
    }
    return { ...provider, command: null, args: [], languageId: provider.languageId(ext) }
  }
  return null
}

export function lspProviderStatus(file = "") {
  const ext = path.extname(String(file || "")).toLowerCase()
  const providers = PROVIDERS
    .filter((provider) => !ext || provider.extensions.has(ext))
    .map((provider) => {
      const selected = provider.commands.find(([command]) => commandExists(command)) || null
      return { id: provider.id, available: Boolean(selected), command: selected?.[0] || null, extensions: [...provider.extensions] }
    })
  return {
    schemaVersion: 2,
    extension: ext,
    available: providers.some((row) => row.available),
    operations: [...LSP_OPERATIONS],
    persistentPool: managedLspPoolStatus({ includeSessions: false }),
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

  return await new Promise((resolve) => {
    const child = spawn(provider.command, provider.args, {
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
      setTimeout(() => { try { child.kill() } catch {} }, 50).unref?.()
      resolve({
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
      })
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
      const params = await session.waitForNotification("textDocument/publishDiagnostics", {
        predicate: (value) => !value?.uri || value.uri === session.uri,
        afterAt: session.documentSync?.changed ? session.documentSync.syncedAt : 0,
      })
      const values = Array.isArray(params?.diagnostics) ? params.diagnostics : []
      return { diagnostics: values.slice(0, maxResults).map(sanitizeDiagnostic) }
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

  const managed = await withManagedLspSession(
    target,
    provider,
    { ...options, operation: op },
    execute,
  ).catch((error) => ({
    ok: false,
    reason: "managed-lsp-exception",
    error: String(error instanceof Error ? error.message : error).slice(0, 1200),
  }))

  if (managed?.ok) {
    return {
      schemaVersion: 2,
      file: relativeFile,
      available: true,
      provider: provider.id,
      command: provider.command,
      operation: op,
      reason: "ok",
      result: managed.result,
      stderr: managed.stderr || null,
      error: null,
      persistent: true,
      pool: managed.meta,
    }
  }

  const fallback = await withEphemeralLspSession(root, relative, { ...options, operation: op }, execute)
  return {
    ...fallback,
    persistent: false,
    fallbackFrom: managed?.reason || "managed-lsp-unavailable",
    managedError: managed?.error || null,
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
  return {
    ...result,
    diagnostics: result?.result?.diagnostics || [],
    result: undefined,
  }
}
