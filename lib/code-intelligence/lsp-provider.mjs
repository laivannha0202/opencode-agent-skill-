import { spawn, spawnSync } from "node:child_process"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const PROVIDERS = [
  { id: "typescript-language-server", extensions: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]), commands: [["typescript-language-server", ["--stdio"]]], languageId: (ext) => [".ts", ".tsx"].includes(ext) ? "typescript" : "javascript" },
  { id: "pyright-langserver", extensions: new Set([".py"]), commands: [["pyright-langserver", ["--stdio"]], ["pylsp", []]], languageId: () => "python" },
  { id: "gopls", extensions: new Set([".go"]), commands: [["gopls", []]], languageId: () => "go" },
  { id: "rust-analyzer", extensions: new Set([".rs"]), commands: [["rust-analyzer", []]], languageId: () => "rust" },
  { id: "clangd", extensions: new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"]), commands: [["clangd", []]], languageId: (ext) => [".c", ".h"].includes(ext) ? "c" : "cpp" },
]

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

function inside(root, target) {
  return target === root || target.startsWith(root + path.sep)
}

async function safeFile(root, relative) {
  const base = await realpath(path.resolve(root)).catch(() => path.resolve(root))
  const requested = path.resolve(base, String(relative || ""))
  if (!inside(base, requested)) throw new Error("diagnostic path escapes workspace root")
  const info = await lstat(requested)
  if (!info.isFile()) throw new Error("diagnostic path is not a file")
  const actual = await realpath(requested)
  if (!inside(base, actual)) throw new Error("diagnostic symlink escapes workspace root")
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
  return { schemaVersion: 1, extension: ext, available: providers.some((row) => row.available), providers }
}

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body])
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

export async function diagnoseCode(root, relative, options = {}) {
  const target = await safeFile(root, relative)
  const provider = providerFor(target.file)
  const relativeFile = path.relative(target.base, target.file).replaceAll("\\", "/")
  if (!provider?.command) {
    return { schemaVersion: 1, file: relativeFile, available: false, provider: provider?.id || null, diagnostics: [], reason: provider ? "lsp-command-unavailable" : "unsupported-extension" }
  }

  const maxBytes = Math.max(8 * 1024, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 1024 * 1024)))
  if (target.info.size > maxBytes) throw new Error("diagnostic file exceeds limit (" + target.info.size + " > " + maxBytes + " bytes)")
  const source = await readFile(target.file, "utf8")
  const uri = pathToFileURL(target.file).href
  const rootUri = pathToFileURL(target.base + path.sep).href
  const timeoutMs = Math.max(500, Math.min(10_000, Number(options.timeoutMs || 3000)))
  const maxDiagnostics = Math.max(1, Math.min(500, Number(options.maxDiagnostics || 100)))

  return await new Promise((resolve) => {
    const child = spawn(provider.command, provider.args, { cwd: target.base, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false })
    let buffer = Buffer.alloc(0)
    let stderr = ""
    let settled = false
    let initialized = false
    let diagnostics = []
    let timer = null

    const finish = (reason, error = null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      try {
        if (initialized && child.stdin.writable) {
          child.stdin.write(encodeMessage({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }))
          child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "exit", params: null }))
        }
      } catch {}
      setTimeout(() => { try { child.kill() } catch {} }, 50).unref?.()
      resolve({
        schemaVersion: 1,
        file: relativeFile,
        available: true,
        provider: provider.id,
        command: provider.command,
        diagnostics: diagnostics.slice(0, maxDiagnostics),
        reason,
        stderr: stderr.trim().slice(0, 2000) || null,
        error: error ? String(error instanceof Error ? error.message : error).slice(0, 1000) : null,
      })
    }

    const handle = (message) => {
      if (message?.id === 1 && message?.result) {
        initialized = true
        try {
          child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "initialized", params: {} }))
          child.stdin.write(encodeMessage({
            jsonrpc: "2.0",
            method: "textDocument/didOpen",
            params: { textDocument: { uri, languageId: provider.languageId, version: 1, text: source } },
          }))
        } catch (error) {
          finish("write-failed", error)
        }
        return
      }
      if (message?.method === "textDocument/publishDiagnostics" && message?.params?.uri === uri) {
        diagnostics = Array.isArray(message.params.diagnostics) ? message.params.diagnostics.map(sanitizeDiagnostic).slice(0, maxDiagnostics) : []
        finish("publishDiagnostics")
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
        try { handle(JSON.parse(body)) } catch {}
      }
    }

    child.stdout.on("data", (chunk) => { buffer = Buffer.concat([buffer, Buffer.from(chunk)]); parse() })
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString() })
    child.on("error", (error) => finish("spawn-error", error))
    child.on("close", (code) => { if (!settled) finish("server-exit:" + (code ?? "unknown")) })

    try {
      child.stdin.write(encodeMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: process.pid,
          rootUri,
          capabilities: { textDocument: { publishDiagnostics: { relatedInformation: true } } },
          workspaceFolders: [{ uri: rootUri, name: path.basename(target.base) || "workspace" }],
        },
      }))
    } catch (error) {
      finish("initialize-write-failed", error)
    }
    timer = setTimeout(() => finish("timeout"), timeoutMs)
    timer.unref?.()
  })
}
