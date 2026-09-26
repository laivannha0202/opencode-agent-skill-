import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { putEvidence } from "./evidence-store.mjs"
import { terminateProcessTree } from "./process-supervisor.mjs"
import { resolveWindowsCommand } from "./windows-shim.mjs"

const SERVICES = new Map()
const MAX_SERVICES = 8
const DEFAULT_READY_TIMEOUT_MS = 30_000
const DEFAULT_LOG_LIMIT_BYTES = 4 * 1024 * 1024
const DEFAULT_TAIL_CHARS = 64 * 1024

function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeName(name) {
  const value = String(name || "").trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("UES service name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}")
  }
  return value
}

function within(root, candidate) {
  const base = path.resolve(root)
  const full = path.resolve(candidate)
  return full === base || full.startsWith(base + path.sep)
}

function safeRootAndCwd(root, requestedCwd) {
  const base = realpathSync(path.resolve(root))
  const cwdCandidate = path.resolve(base, requestedCwd || ".")
  if (!within(base, cwdCandidate)) throw new Error("UES service cwd escapes workspace root")
  const cwd = realpathSync(cwdCandidate)
  if (!within(base, cwd)) throw new Error("UES service cwd resolves outside workspace root")
  return { root: base, cwd }
}

function serviceDir(root) {
  return path.join(root, ".ues-services")
}

function servicePaths(root, name) {
  const dir = serviceDir(root)
  return {
    dir,
    meta: path.join(dir, name + ".json"),
    log: path.join(dir, name + ".log"),
  }
}

function keyFor(root, name) {
  return path.resolve(root) + "\u0000" + normalizeName(name)
}

function boundedArgs(args) {
  if (!Array.isArray(args)) return []
  if (args.length > 128) throw new Error("UES service args exceed 128 items")
  return args.map((item) => {
    const value = String(item)
    if (value.length > 16_384) throw new Error("UES service argument exceeds 16 KiB")
    if (value.includes("\u0000")) throw new Error("UES service argument contains NUL")
    return value
  })
}

function executionFor(command) {
  const value = String(command || "").trim()
  if (!value || value.includes("\u0000")) throw new Error("UES service command is required")
  if (process.platform !== "win32") return { executable: value, argsPrefix: [], source: value }
  const resolved = resolveWindowsCommand(value)
  if (!resolved) throw new Error("UES service command could not be resolved safely on Windows: " + value)
  return resolved
}

function publicState(state) {
  return {
    schemaVersion: 1,
    name: state.name,
    pid: state.proc?.pid || state.pid || null,
    status: state.status,
    alive: state.status === "running" && Boolean(state.proc) && state.proc.exitCode == null,
    command: state.command,
    args: [...state.args],
    cwd: state.cwd,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt || null,
    exitCode: state.exitCode ?? null,
    signal: state.signal || null,
    ready: state.ready === true,
    readiness: {
      host: state.readyHost || null,
      port: state.readyPort || null,
      log: state.readyLog || null,
    },
    logFile: path.relative(state.root, state.logFile).replaceAll("\\", "/"),
    logBytes: state.logBytes,
    logTruncated: state.logTruncated,
  }
}

function persist(state) {
  try {
    mkdirSync(path.dirname(state.metaFile), { recursive: true })
    writeFileSync(state.metaFile, JSON.stringify(publicState(state), null, 2) + "\n", "utf8")
  } catch {}
}

function appendLog(state, stream, chunk) {
  const text = String(chunk || "")
  if (!text) return
  const tagged = `[${stream}] ${text}`
  state.tail = (state.tail + tagged).slice(-DEFAULT_TAIL_CHARS)
  const bytes = Buffer.byteLength(tagged)
  if (state.logBytes >= state.logLimitBytes) {
    if (!state.logTruncated) {
      state.logTruncated = true
      try { appendFileSync(state.logFile, "\n[ues] service log capture limit reached; further output omitted\n", "utf8") } catch {}
    }
    return
  }
  const remaining = state.logLimitBytes - state.logBytes
  const buffer = Buffer.from(tagged, "utf8")
  const slice = buffer.subarray(0, Math.min(buffer.length, remaining))
  if (slice.length) {
    try { appendFileSync(state.logFile, slice) } catch {}
    state.logBytes += slice.length
  }
  if (slice.length < buffer.length) state.logTruncated = true
}

function processIsAlive(state) {
  return Boolean(
    state?.proc &&
    state.proc.exitCode == null &&
    !["exited", "failed", "stopped", "stop-timeout"].includes(String(state.status || "")),
  )
}

async function portReady(host, port) {
  return await new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(600)
    socket.once("connect", () => finish(true))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
    socket.connect(port, host)
  })
}

function logContains(state, needle) {
  if (!needle) return true
  if (state.tail.includes(needle)) return true
  try {
    const text = readFileSync(state.logFile, "utf8")
    return text.slice(-DEFAULT_TAIL_CHARS).includes(needle)
  } catch {
    return false
  }
}

async function readiness(state) {
  if (!processIsAlive(state)) {
    return { ready: false, reason: "process-exited" }
  }
  const checks = []
  if (state.readyPort) {
    checks.push({
      kind: "port",
      ready: await portReady(state.readyHost || "127.0.0.1", state.readyPort),
    })
  }
  if (state.readyLog) {
    checks.push({ kind: "log", ready: logContains(state, state.readyLog) })
  }
  if (!checks.length) return { ready: true, reason: "process-running", checks: [] }
  return {
    ready: checks.every((item) => item.ready),
    reason: checks.every((item) => item.ready) ? "readiness-satisfied" : "readiness-pending",
    checks,
  }
}

export function looksLikeLongRunningServiceCommand(command) {
  const text = String(command || "").trim()
  if (!text) return false
  const patterns = [
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start(?::[\w.-]+)?|serve|preview)(?:\s|$)/i,
    /^(?:npx\s+)?(?:next\s+(?:dev|start)|vite(?:\s|$)|nest\s+start|react-scripts\s+start|expo\s+start)(?:\s|$)/i,
    /^(?:node|bun)\s+["']?[^;&|\r\n]*(?:^|[\\/])(?:main|server|app)\.(?:mjs|cjs|js|ts)(?:["']?\s|$)/i,
    /^(?:python|python3|py)\s+(?:-m\s+http\.server|[^\r\n]*(?:uvicorn|gunicorn|manage\.py\s+runserver))(?:\s|$)/i,
    /^(?:uvicorn|gunicorn|flask\s+run|dotnet\s+run|mvn\s+spring-boot:run|gradle\s+bootRun)(?:\s|$)/i,
    /^docker\s+compose\s+up(?![^\r\n]*\s-d(?:\s|$))/i,
  ]
  return patterns.some((pattern) => pattern.test(text))
}

export async function waitForService(root, name, options = {}) {
  name = normalizeName(name)
  root = realpathSync(path.resolve(root))
  const state = SERVICES.get(keyFor(root, name))
  if (!state) {
    return { schemaVersion: 1, name, ready: false, status: "not-owned", reason: "service-not-active-in-this-runtime" }
  }

  const timeoutMs = clamp(options.timeoutMs, DEFAULT_READY_TIMEOUT_MS, 100, 10 * 60_000)
  const pollMs = clamp(options.pollMs, 150, 50, 2_000)
  const deadline = Date.now() + timeoutMs
  do {
    const probe = await readiness(state)
    if (probe.ready) {
      state.ready = true
      persist(state)
      return { ...publicState(state), ready: true, reason: probe.reason, checks: probe.checks || [] }
    }
    if (!processIsAlive(state)) {
      persist(state)
      return { ...publicState(state), ready: false, reason: "process-exited", checks: probe.checks || [] }
    }
    await sleep(pollMs)
  } while (Date.now() < deadline)

  const probe = await readiness(state)
  state.ready = probe.ready
  persist(state)
  return {
    ...publicState(state),
    ready: probe.ready,
    reason: probe.ready ? probe.reason : "readiness-timeout",
    checks: probe.checks || [],
  }
}

export async function startService(root = process.cwd(), options = {}) {
  const name = normalizeName(options.name)
  const scoped = safeRootAndCwd(root, options.cwd)
  root = scoped.root
  const key = keyFor(root, name)
  const existing = SERVICES.get(key)
  if (existing && processIsAlive(existing)) {
    throw new Error("UES service already running: " + name)
  }
  if ([...SERVICES.values()].filter(processIsAlive).length >= MAX_SERVICES) {
    throw new Error("UES service limit reached (" + MAX_SERVICES + ")")
  }

  const command = String(options.command || "").trim()
  const args = boundedArgs(options.args)
  const execution = executionFor(command)
  const readyPort = options.readyPort == null
    ? null
    : clamp(options.readyPort, 0, 1, 65535)
  if (options.readyPort != null && !readyPort) throw new Error("UES service readyPort must be 1..65535")
  const readyLog = options.readyLog == null ? null : String(options.readyLog)
  if (readyLog && readyLog.length > 512) throw new Error("UES service readyLog exceeds 512 characters")
  const readyHost = String(options.readyHost || "127.0.0.1").trim() || "127.0.0.1"
  if (readyHost.length > 255) throw new Error("UES service readyHost is too long")

  const paths = servicePaths(root, name)
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.log, "", "utf8")

  const state = {
    name,
    root,
    cwd: scoped.cwd,
    command,
    args,
    executable: execution.executable,
    executionArgs: [...(execution.argsPrefix || []), ...args],
    readyPort,
    readyHost,
    readyLog,
    ready: false,
    status: "starting",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    proc: null,
    metaFile: paths.meta,
    logFile: paths.log,
    logBytes: 0,
    logLimitBytes: clamp(options.logLimitBytes, DEFAULT_LOG_LIMIT_BYTES, 64 * 1024, 32 * 1024 * 1024),
    logTruncated: false,
    tail: "",
    startOptions: {
      name,
      command,
      args,
      cwd: path.relative(root, scoped.cwd) || ".",
      readyPort,
      readyHost,
      readyLog,
      timeoutMs: options.timeoutMs,
      logLimitBytes: options.logLimitBytes,
    },
  }

  const proc = spawn(execution.executable, state.executionArgs, {
    cwd: scoped.cwd,
    env: options.env && typeof options.env === "object"
      ? { ...process.env, ...Object.fromEntries(Object.entries(options.env).map(([key, value]) => [String(key), String(value)])) }
      : process.env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  state.proc = proc
  state.status = "running"
  SERVICES.set(key, state)
  persist(state)

  proc.stdout?.on("data", (chunk) => appendLog(state, "stdout", chunk))
  proc.stderr?.on("data", (chunk) => appendLog(state, "stderr", chunk))
  proc.on("error", (error) => {
    appendLog(state, "error", String(error?.message || error) + "\n")
    state.status = "failed"
    state.finishedAt = new Date().toISOString()
    state.exitCode = 1
    persist(state)
  })
  proc.on("exit", (code, signal) => {
    state.exitCode = Number.isInteger(code) ? code : null
    state.signal = signal || null
    state.status = state.status === "stopping" ? "stopped" : "exited"
    state.finishedAt = new Date().toISOString()
    persist(state)
  })

  const shouldWait = options.waitReady !== false
  if (!shouldWait) return { ...publicState(state), ready: false, reason: "readiness-not-requested" }

  // Give spawn errors and immediate exits a chance to surface even when no
  // explicit readiness probe was supplied.
  if (!readyPort && !readyLog) await sleep(200)
  const result = await waitForService(root, name, {
    timeoutMs: readyPort || readyLog ? options.timeoutMs : Math.min(1000, Number(options.timeoutMs || 500)),
  })
  if (!readyPort && !readyLog && result.ready) state.ready = true
  persist(state)

  if (result.ready) {
    const evidence = await serviceLogs(root, name, { maxChars: 32_000, evidence: true }).catch(() => null)
    return { ...result, evidenceRef: evidence?.evidenceRef || null }
  }
  return result
}

export async function serviceStatus(root = process.cwd(), name) {
  name = normalizeName(name)
  root = realpathSync(path.resolve(root))
  const state = SERVICES.get(keyFor(root, name))
  if (state) {
    const probe = await readiness(state)
    state.ready = probe.ready
    persist(state)
    return { ...publicState(state), ready: probe.ready, reason: probe.reason, checks: probe.checks || [] }
  }

  const paths = servicePaths(root, name)
  if (!existsSync(paths.meta)) {
    return { schemaVersion: 1, name, status: "not-found", alive: false, ready: false }
  }
  try {
    const prior = JSON.parse(readFileSync(paths.meta, "utf8"))
    return {
      ...prior,
      status: "not-owned",
      alive: false,
      ready: false,
      reason: "historical-service-metadata-only",
    }
  } catch {
    return { schemaVersion: 1, name, status: "unknown", alive: false, ready: false }
  }
}

export async function serviceLogs(root = process.cwd(), name, options = {}) {
  name = normalizeName(name)
  root = realpathSync(path.resolve(root))
  const state = SERVICES.get(keyFor(root, name))
  const paths = servicePaths(root, name)
  const maxChars = clamp(options.maxChars, 24_000, 256, 128_000)
  let content = state?.tail || ""
  if (!content && existsSync(paths.log)) {
    try { content = readFileSync(paths.log, "utf8").slice(-maxChars) } catch {}
  } else {
    content = content.slice(-maxChars)
  }

  let evidenceRef = null
  if (options.evidence !== false && content) {
    const evidence = await putEvidence(root, content, {
      kind: "service-log",
      source: "ues-service:" + name,
      summary: "Bounded managed-service log snapshot for " + name,
    })
    evidenceRef = evidence.ref
  }
  return {
    schemaVersion: 1,
    name,
    content,
    returnedChars: content.length,
    truncated: Boolean(state?.logTruncated),
    evidenceRef,
    logFile: path.relative(root, paths.log).replaceAll("\\", "/"),
  }
}

export async function stopService(root = process.cwd(), name, options = {}) {
  name = normalizeName(name)
  root = realpathSync(path.resolve(root))
  const key = keyFor(root, name)
  const state = SERVICES.get(key)
  if (!state) {
    return { schemaVersion: 1, name, stopped: false, reason: "service-not-active-in-this-runtime" }
  }
  if (!processIsAlive(state)) {
    SERVICES.delete(key)
    persist(state)
    return { ...publicState(state), stopped: true, reason: "already-exited" }
  }

  state.status = "stopping"
  persist(state)
  terminateProcessTree(state.proc, { graceMs: clamp(options.graceMs, 1500, 0, 30_000) })

  const deadline = Date.now() + clamp(options.timeoutMs, 5_000, 100, 30_000)
  while (processIsAlive(state) && Date.now() < deadline) await sleep(50)
  if (processIsAlive(state)) {
    try { state.proc.kill("SIGKILL") } catch {}
    await sleep(50)
  }
  state.status = processIsAlive(state) ? "stop-timeout" : "stopped"
  state.finishedAt ||= new Date().toISOString()
  persist(state)
  SERVICES.delete(key)
  return { ...publicState(state), stopped: !processIsAlive(state), reason: processIsAlive(state) ? "stop-timeout" : "stopped" }
}

export async function restartService(root = process.cwd(), name, options = {}) {
  name = normalizeName(name)
  root = realpathSync(path.resolve(root))
  const state = SERVICES.get(keyFor(root, name))
  if (!state?.startOptions) throw new Error("UES service cannot restart an unowned service: " + name)
  const startOptions = { ...state.startOptions, ...options, name }
  await stopService(root, name, options)
  return startService(root, startOptions)
}

export async function stopAllServices(root = null) {
  const base = root ? realpathSync(path.resolve(root)) : null
  const targets = [...SERVICES.values()].filter((state) => !base || state.root === base)
  const results = []
  for (const state of targets) {
    results.push(await stopService(state.root, state.name).catch((error) => ({
      schemaVersion: 1,
      name: state.name,
      stopped: false,
      reason: error instanceof Error ? error.message : String(error),
    })))
  }
  return results
}

export function managedServiceCount() {
  return [...SERVICES.values()].filter(processIsAlive).length
}
