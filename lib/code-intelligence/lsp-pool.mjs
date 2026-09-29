import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { terminateProcessTree } from "../process-supervisor.mjs"
import { resolveWindowsCommand } from "../windows-shim.mjs"

const DEFAULT_IDLE_TTL_MS = 3 * 60_000
const DEFAULT_MAX_SERVERS = 4
const DEFAULT_MAX_PER_WORKSPACE = 2
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const DEFAULT_STARTUP_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RESTARTS = 1
const CONFIG_MAX_BYTES = 512 * 1024

const POOL = new Map()
const METRICS = {
  coldStarts: 0,
  warmHits: 0,
  restarts: 0,
  evictions: 0,
  fallbacks: 0,
  operations: 0,
  operationLatencyMs: 0,
}
let sweepTimer = null

function bounded(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

function configured(options = {}) {
  return {
    enabled: options.persistent !== false && String(process.env.UES_LSP_PERSISTENT || "1") !== "0",
    idleTtlMs: bounded(options.idleTtlMs ?? process.env.UES_LSP_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS, 5_000, 60 * 60_000),
    maxServers: bounded(options.maxServers ?? process.env.UES_LSP_MAX_SERVERS, DEFAULT_MAX_SERVERS, 1, 12),
    maxPerWorkspace: bounded(options.maxPerWorkspace ?? process.env.UES_LSP_MAX_PER_WORKSPACE, DEFAULT_MAX_PER_WORKSPACE, 1, 6),
    requestTimeoutMs: bounded(options.timeoutMs ?? process.env.UES_LSP_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, 500, 30_000),
    startupTimeoutMs: bounded(options.startupTimeoutMs ?? process.env.UES_LSP_STARTUP_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, 1_000, 60_000),
    maxRestarts: bounded(options.maxRestarts ?? process.env.UES_LSP_MAX_RESTARTS, DEFAULT_MAX_RESTARTS, 0, 2),
  }
}

function errorWithCode(message, code) {
  const error = new Error(message)
  error.code = code
  return error
}

function transientError(error) {
  return new Set([
    "LSP_REQUEST_TIMEOUT",
    "LSP_NOTIFICATION_TIMEOUT",
    "LSP_SESSION_CLOSED",
    "LSP_SERVER_EXIT",
    "LSP_SPAWN_ERROR",
    "LSP_WRITE_ERROR",
  ]).has(error?.code)
}

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8")
  return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\r\n\r\n", "ascii"), body])
}

function contentHash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

function providerConfigNames(providerId) {
  const id = String(providerId || "")
  if (id.includes("typescript")) return ["tsconfig.json", "jsconfig.json", "package.json"]
  if (id.includes("pyright") || id.includes("pylsp")) return ["pyrightconfig.json", "pyproject.toml", "setup.cfg", "setup.py", "requirements.txt"]
  if (id === "gopls") return ["go.mod", "go.sum", "go.work"]
  if (id === "rust-analyzer") return ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "rust-toolchain"]
  if (id === "clangd") return [".clangd", "compile_commands.json", "CMakeLists.txt"]
  return ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"]
}

function inside(base, target) {
  return target === base || target.startsWith(base + path.sep)
}

async function configurationFingerprint(base, file, provider) {
  const names = providerConfigNames(provider?.id)
  const found = []
  let dir = path.dirname(file)

  while (inside(base, dir)) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      const info = await stat(candidate).catch(() => null)
      if (!info?.isFile()) continue
      found.push({ file: candidate, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
    }
    if (dir === base) break
    const parent = path.dirname(dir)
    if (parent === dir || !inside(base, parent)) break
    dir = parent
  }

  found.sort((a, b) => a.file.localeCompare(b.file))
  const hash = createHash("sha256")
  hash.update(String(provider?.id || "unknown"))
  hash.update("\0")
  hash.update(String(provider?.command || ""))
  hash.update("\0")
  hash.update(JSON.stringify(provider?.initializationOptions || null))
  for (const item of found) {
    hash.update(path.relative(base, item.file).replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(String(item.size))
    hash.update("\0")
    if (item.size <= CONFIG_MAX_BYTES) {
      const content = await readFile(item.file).catch(() => null)
      if (content) hash.update(content)
      else hash.update(String(item.mtimeMs))
    } else {
      hash.update(String(item.mtimeMs))
    }
    hash.update("\0")
  }
  return hash.digest("hex").slice(0, 24)
}

class ManagedLspSession {
  constructor(base, provider, configFingerprint, options) {
    this.id = randomUUID()
    this.base = base
    this.provider = provider
    this.configFingerprint = configFingerprint
    this.options = options
    this.child = null
    this.buffer = Buffer.alloc(0)
    this.stderr = ""
    this.nextId = 1
    this.pending = new Map()
    this.notificationWaiters = new Map()
    this.notifications = new Map()
    this.documents = new Map()
    this.state = "STARTING"
    this.startedAt = Date.now()
    this.readyAt = null
    this.lastUsedAt = Date.now()
    this.requestCount = 0
    this.busy = 0
    this.closed = false
    this.queueTail = Promise.resolve()
    this.coldStartMs = null
  }

  alive() {
    return Boolean(
      !this.closed &&
      this.child &&
      this.child.exitCode == null &&
      !["CRASHED", "CLOSED", "EVICTING"].includes(this.state),
    )
  }

  publicStatus() {
    return {
      id: this.id,
      workspace: this.base,
      provider: this.provider.id,
      command: this.provider.command,
      state: this.state,
      pid: this.child?.pid || null,
      busy: this.busy,
      requestCount: this.requestCount,
      startedAt: new Date(this.startedAt).toISOString(),
      lastUsedAt: new Date(this.lastUsedAt).toISOString(),
      idleMs: Math.max(0, Date.now() - this.lastUsedAt),
      configFingerprint: this.configFingerprint,
      documents: this.documents.size,
      coldStartMs: this.coldStartMs,
    }
  }

  async start() {
    const started = Date.now()
    try {
      const execution = process.platform === "win32"
        ? resolveWindowsCommand(this.provider.command)
        : { executable: this.provider.command, argsPrefix: [] }
      if (!execution?.executable) {
        throw new Error("unable to resolve LSP executable: " + String(this.provider.command || ""))
      }
      this.child = spawn(execution.executable, [...(execution.argsPrefix || []), ...(this.provider.args || [])], {
        cwd: this.base,
        env: this.provider.env && typeof this.provider.env === "object"
          ? { ...process.env, ...Object.fromEntries(Object.entries(this.provider.env).map(([key, value]) => [String(key), String(value)])) }
          : process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
        detached: process.platform !== "win32",
      })
    } catch (error) {
      this.state = "CRASHED"
      throw errorWithCode("LSP spawn failed: " + String(error?.message || error), "LSP_SPAWN_ERROR")
    }

    this.child.stdout?.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)])
      this.parse()
    })
    this.child.stderr?.on("data", (chunk) => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk.toString()
    })
    this.child.on("error", (error) => this.crash("LSP spawn error: " + String(error?.message || error), "LSP_SPAWN_ERROR"))
    this.child.on("close", (code) => {
      if (!this.closed && this.state !== "EVICTING") {
        this.crash("LSP server exited: " + String(code ?? "unknown"), "LSP_SERVER_EXIT")
      }
    })

    const rootUri = pathToFileURL(this.base + path.sep).href
    await this.request("initialize", {
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
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.base) || "workspace" }],
      initializationOptions: this.provider.initializationOptions || undefined,
    }, this.options.startupTimeoutMs)
    this.notify("initialized", {})
    this.readyAt = Date.now()
    this.coldStartMs = this.readyAt - started
    this.state = "READY"
    this.lastUsedAt = Date.now()
    return this
  }

  crash(message, code) {
    if (this.closed) return
    this.state = "CRASHED"
    const error = errorWithCode(message, code)
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    for (const list of this.notificationWaiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    }
    this.notificationWaiters.clear()
  }

  send(payload) {
    if (!this.alive() || !this.child.stdin?.writable) {
      throw errorWithCode("LSP stdin unavailable", "LSP_SESSION_CLOSED")
    }
    try {
      this.child.stdin.write(encodeMessage(payload))
    } catch (error) {
      throw errorWithCode("LSP write failed: " + String(error?.message || error), "LSP_WRITE_ERROR")
    }
  }

  request(method, params, timeoutMs = this.options.requestTimeoutMs) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(errorWithCode("LSP request timed out: " + method, "LSP_REQUEST_TIMEOUT"))
      }, bounded(timeoutMs, this.options.requestTimeoutMs, 250, 60_000))
      timer.unref?.()
      this.pending.set(id, { resolve, reject, method, timer })
      try {
        this.send({ jsonrpc: "2.0", id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params })
  }

  waitForNotification(method, options = {}) {
    const predicate = typeof options.predicate === "function" ? options.predicate : () => true
    const afterAt = Number(options.afterAt || 0)
    const cached = (this.notifications.get(method) || [])
      .slice()
      .reverse()
      .find((item) => item.at >= afterAt && predicate(item.params))
    if (cached) return Promise.resolve(cached.params)

    return new Promise((resolve, reject) => {
      const timeoutMs = bounded(options.timeoutMs, this.options.requestTimeoutMs, 250, 60_000)
      const timer = setTimeout(() => {
        const list = this.notificationWaiters.get(method) || []
        this.notificationWaiters.set(method, list.filter((item) => item !== waiter))
        reject(errorWithCode("LSP notification timed out: " + method, "LSP_NOTIFICATION_TIMEOUT"))
      }, timeoutMs)
      timer.unref?.()
      const waiter = { resolve, reject, predicate, afterAt, timer }
      const list = this.notificationWaiters.get(method) || []
      list.push(waiter)
      this.notificationWaiters.set(method, list)
    })
  }

  dispatch(message) {
    if (message?.id != null && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) {
        const error = errorWithCode(String(message.error.message || "LSP request failed"), "LSP_REQUEST_REJECTED")
        waiter.reject(error)
      } else {
        waiter.resolve(message.result)
      }
      return
    }

    if (!message?.method) return
    if (message.id != null) {
      try {
        const result = message.method === "workspace/configuration"
          ? (Array.isArray(message.params?.items) ? message.params.items.map(() => null) : [])
          : null
        this.send({ jsonrpc: "2.0", id: message.id, result })
      } catch {}
      return
    }

    const event = { params: message.params, at: Date.now() }
    const cached = this.notifications.get(message.method) || []
    cached.push(event)
    if (cached.length > 24) cached.splice(0, cached.length - 24)
    this.notifications.set(message.method, cached)

    const waiters = this.notificationWaiters.get(message.method) || []
    const remaining = []
    for (const waiter of waiters) {
      if (event.at >= waiter.afterAt && waiter.predicate(event.params)) {
        clearTimeout(waiter.timer)
        waiter.resolve(event.params)
      } else {
        remaining.push(waiter)
      }
    }
    if (remaining.length) this.notificationWaiters.set(message.method, remaining)
    else this.notificationWaiters.delete(message.method)
  }

  parse() {
    while (!this.closed) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString("ascii")
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) return
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8")
      this.buffer = this.buffer.subarray(bodyStart + length)
      try { this.dispatch(JSON.parse(body)) } catch {}
    }
  }

  async syncDocument(target, languageId, options = {}) {
    const maxBytes = Math.max(8 * 1024, Math.min(4 * 1024 * 1024, Number(options.maxBytes || 1024 * 1024)))
    const info = target.info?.isFile?.() ? target.info : await stat(target.file)
    if (info.size > maxBytes) {
      throw new Error("LSP file exceeds limit (" + info.size + " > " + maxBytes + " bytes)")
    }
    const source = await readFile(target.file, "utf8")
    const hash = contentHash(source)
    const uri = pathToFileURL(target.file).href
    const previous = this.documents.get(uri)
    const syncedAt = Date.now()
    let changed = false
    let opened = false
    let version = previous?.version || 0

    if (!previous) {
      opened = true
      changed = true
      version = 1
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text: source },
      })
    } else if (previous.hash !== hash) {
      changed = true
      version += 1
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: source }],
      })
    }

    this.documents.set(uri, { hash, version, languageId, syncedAt })
    return { uri, sourceHash: hash, version, changed, opened, syncedAt }
  }

  async runExclusive(fn) {
    const previous = this.queueTail
    let release
    const gate = new Promise((resolve) => { release = resolve })
    this.queueTail = previous.catch(() => {}).then(() => gate)
    await previous.catch(() => {})
    this.busy += 1
    this.state = "BUSY"
    const started = Date.now()
    try {
      const result = await fn()
      this.requestCount += 1
      return { result, durationMs: Date.now() - started }
    } finally {
      this.busy = Math.max(0, this.busy - 1)
      this.lastUsedAt = Date.now()
      if (this.alive()) this.state = "READY"
      release()
    }
  }

  async stop(reason = "shutdown") {
    if (this.closed) return
    this.state = "EVICTING"
    this.closed = true
    const error = errorWithCode("LSP session closed: " + reason, "LSP_SESSION_CLOSED")
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
    for (const list of this.notificationWaiters.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer)
        waiter.reject(error)
      }
    }
    this.notificationWaiters.clear()
    try {
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", method: "exit", params: null }))
      }
    } catch {}
    if (this.child) terminateProcessTree(this.child, { graceMs: 500 })
    this.state = "CLOSED"
  }
}

function sessionKey(base, provider, fingerprint) {
  return [base, provider.id, provider.command, fingerprint].join("\u0000")
}

function sessionsForWorkspace(base) {
  return [...POOL.values()].filter((session) => session.base === base && session.alive())
}

async function removeSession(key, reason) {
  const session = POOL.get(key)
  if (!session) return
  POOL.delete(key)
  await session.stop(reason).catch(() => {})
}

async function evictExpired(options) {
  const now = Date.now()
  const targets = [...POOL.entries()]
    .filter(([, session]) => session.busy === 0 && now - session.lastUsedAt >= options.idleTtlMs)
  for (const [key] of targets) {
    METRICS.evictions += 1
    await removeSession(key, "idle-ttl")
  }
}

async function evictLru(candidates, reason) {
  const idle = candidates
    .filter((session) => session.busy === 0)
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  const victim = idle[0]
  if (!victim) return false
  const entry = [...POOL.entries()].find(([, session]) => session === victim)
  if (!entry) return false
  METRICS.evictions += 1
  await removeSession(entry[0], reason)
  return true
}

async function ensureCapacity(base, options) {
  await evictExpired(options)

  while (sessionsForWorkspace(base).length >= options.maxPerWorkspace) {
    const evicted = await evictLru(sessionsForWorkspace(base), "workspace-lru")
    if (!evicted) return false
  }

  while ([...POOL.values()].filter((session) => session.alive()).length >= options.maxServers) {
    const evicted = await evictLru([...POOL.values()], "global-lru")
    if (!evicted) return false
  }
  return true
}

function ensureSweeper() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const options = configured()
    void evictExpired(options).catch(() => {})
  }, 30_000)
  sweepTimer.unref?.()
}

async function acquire(target, provider, options) {
  ensureSweeper()
  const fingerprint = await configurationFingerprint(target.base, target.file, provider)
  const key = sessionKey(target.base, provider, fingerprint)
  const existing = POOL.get(key)
  if (existing?.alive()) {
    METRICS.warmHits += 1
    existing.lastUsedAt = Date.now()
    return { key, session: existing, poolHit: true }
  }
  if (existing) await removeSession(key, "stale-session")

  for (const [otherKey, session] of POOL) {
    if (
      session.base === target.base &&
      session.provider.id === provider.id &&
      session.configFingerprint !== fingerprint &&
      session.busy === 0
    ) {
      METRICS.evictions += 1
      await removeSession(otherKey, "config-changed")
    }
  }

  if (!await ensureCapacity(target.base, options)) return null
  const session = new ManagedLspSession(target.base, provider, fingerprint, options)
  POOL.set(key, session)
  try {
    await session.start()
    METRICS.coldStarts += 1
    return { key, session, poolHit: false }
  } catch (error) {
    POOL.delete(key)
    await session.stop("startup-failed").catch(() => {})
    throw error
  }
}

export async function withManagedLspSession(target, provider, inputOptions = {}, operation) {
  const options = configured(inputOptions)
  if (!options.enabled) {
    METRICS.fallbacks += 1
    return { ok: false, reason: "persistent-disabled", error: null }
  }

  let attempt = 0
  while (attempt <= options.maxRestarts) {
    let acquired
    try {
      acquired = await acquire(target, provider, options)
      if (!acquired) {
        METRICS.fallbacks += 1
        return { ok: false, reason: "pool-capacity-busy", error: null }
      }

      const session = acquired.session
      const executed = await session.runExclusive(async () => {
        const documentSync = await session.syncDocument(target, provider.languageId, inputOptions)
        const adapter = {
          request: (method, params) => session.request(method, params, options.requestTimeoutMs),
          notify: (method, params) => session.notify(method, params),
          waitForNotification: (method, waitOptions = {}) => session.waitForNotification(method, {
            timeoutMs: options.requestTimeoutMs,
            ...waitOptions,
          }),
          uri: documentSync.uri,
          base: target.base,
          file: path.relative(target.base, target.file).replaceAll("\\", "/"),
          documentSync,
        }
        return operation(adapter)
      })

      METRICS.operations += 1
      METRICS.operationLatencyMs += executed.durationMs
      return {
        ok: true,
        result: executed.result,
        meta: {
          persistent: true,
          poolHit: acquired.poolHit,
          warm: acquired.poolHit,
          sessionId: session.id,
          state: session.state,
          coldStartMs: acquired.poolHit ? 0 : session.coldStartMs,
          operationDurationMs: executed.durationMs,
          requestCount: session.requestCount,
          configFingerprint: session.configFingerprint,
        },
        stderr: session.stderr.trim().slice(0, 2000) || null,
      }
    } catch (error) {
      const transient = transientError(error)
      const canRestart = transient && attempt < options.maxRestarts
      if (transient && acquired?.key) {
        await removeSession(acquired.key, canRestart ? "bounded-restart" : "operation-failed")
      }
      if (!canRestart) {
        METRICS.fallbacks += 1
        return {
          ok: false,
          reason: transient ? "managed-lsp-failed" : "managed-lsp-request-rejected",
          error: String(error instanceof Error ? error.message : error).slice(0, 1200),
          errorCode: error?.code || null,
        }
      }
      METRICS.restarts += 1
      attempt += 1
    }
  }

  METRICS.fallbacks += 1
  return { ok: false, reason: "restart-budget-exhausted", error: null }
}

export function lspPoolStatus(options = {}) {
  const config = configured(options)
  const sessions = [...POOL.values()].filter((session) => session.alive())
  return {
    schemaVersion: 2,
    kind: "ues-managed-lsp-pool",
    enabled: config.enabled,
    limits: {
      maxServers: config.maxServers,
      maxPerWorkspace: config.maxPerWorkspace,
      idleTtlMs: config.idleTtlMs,
      requestTimeoutMs: config.requestTimeoutMs,
      startupTimeoutMs: config.startupTimeoutMs,
      maxRestarts: config.maxRestarts,
    },
    active: sessions.length,
    busy: sessions.filter((session) => session.busy > 0).length,
    metrics: {
      ...METRICS,
      averageOperationLatencyMs: METRICS.operations
        ? Number((METRICS.operationLatencyMs / METRICS.operations).toFixed(2))
        : null,
    },
    sessions: options.includeSessions === false ? [] : sessions.map((session) => session.publicStatus()),
  }
}

export async function shutdownLspPool(root = null) {
  const base = root ? path.resolve(root) : null
  const entries = [...POOL.entries()].filter(([, session]) => !base || session.base === base)
  for (const [key] of entries) await removeSession(key, "shutdown")
  if (!POOL.size && sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  return { schemaVersion: 2, stopped: entries.length, remaining: POOL.size }
}

export async function evictIdleLspSessions(options = {}) {
  const before = POOL.size
  await evictExpired(configured(options))
  return { schemaVersion: 2, evicted: Math.max(0, before - POOL.size), remaining: POOL.size }
}

export function resetLspPoolMetrics() {
  for (const key of Object.keys(METRICS)) METRICS[key] = 0
}
