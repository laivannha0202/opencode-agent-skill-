import { existsSync, readFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"

function quoteCmd(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(text)) return text
  return '"' + text.replaceAll('"', '""') + '"'
}

function findWindowsCommand(name) {
  if (path.isAbsolute(name) && existsSync(name)) return name
  const result = spawnSync("where", [name], { encoding: "utf8" })
  if (result.status !== 0 || !result.stdout) return null
  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return matches.find((item) => /\.(exe|cmd|bat)$/i.test(item)) || matches[0] || null
}

function findNodeShimEntry(cmdPath) {
  const dir = path.dirname(cmdPath)
  let shim = ""
  try {
    shim = readFileSync(cmdPath, "utf8")
  } catch {
    return null
  }
  const match = shim.match(/node_modules[\\/][^\s"]+?\.(?:js|mjs)/gi)?.at(-1)
  if (!match) return null
  const entry = path.resolve(dir, match)
  return existsSync(entry) ? entry : null
}

export function resolveProcessCommand(executable, commandArgs = []) {
  if (process.platform !== "win32") return { executable, args: commandArgs }

  const resolved = findWindowsCommand(executable)
  if (!resolved) return null
  if (!/\.(cmd|bat)$/i.test(resolved)) return { executable: resolved, args: commandArgs }

  const entry = findNodeShimEntry(resolved)
  if (entry) return { executable: process.execPath, args: [entry, ...commandArgs] }

  const line = [resolved, ...commandArgs].map(quoteCmd).join(" ")
  return {
    executable: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", line],
  }
}

function appendBounded(current, chunk, maxBuffer) {
  const next = current + String(chunk)
  if (next.length <= maxBuffer) return next
  return next.slice(next.length - maxBuffer)
}

function killTree(child) {
  if (!child?.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    child.kill("SIGTERM")
  } catch {}
  setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL")
    } catch {}
  }, 1500).unref?.()
}

export async function runProcess(executable, commandArgs = [], options = {}) {
  const resolved = resolveProcessCommand(executable, commandArgs)
  if (!resolved) {
    return {
      status: 127,
      signal: null,
      stdout: "",
      stderr: "Command not found: " + executable,
      durationMs: 0,
      timedOut: false,
      idleTimedOut: false,
      cancelled: false,
    }
  }

  const started = Date.now()
  let stdout = ""
  let stderr = ""
  let lastActivity = started
  let timedOut = false
  let idleTimedOut = false
  let cancelled = false
  let settled = false
  const maxBuffer = Math.max(1024, Number(options.maxBuffer) || 4 * 1024 * 1024)
  const heartbeatMs = Math.max(1000, Number(options.heartbeatMs) || 30_000)
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0)
  const idleTimeoutMs = Math.max(0, Number(options.idleTimeoutMs) || 0)

  return await new Promise((resolve) => {
    const child = spawn(resolved.executable, resolved.args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const finish = (status, signal = null) => {
      if (settled) return
      settled = true
      clearInterval(heartbeat)
      clearInterval(watchdog)
      options.signal?.removeEventListener?.("abort", onAbort)
      resolve({
        status: Number.isInteger(status) ? status : 1,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        idleTimedOut,
        cancelled,
      })
    }

    child.stdout?.on("data", (chunk) => {
      lastActivity = Date.now()
      stdout = appendBounded(stdout, chunk, maxBuffer)
      options.onStdout?.(String(chunk))
    })
    child.stderr?.on("data", (chunk) => {
      lastActivity = Date.now()
      stderr = appendBounded(stderr, chunk, maxBuffer)
      options.onStderr?.(String(chunk))
    })
    child.on("error", (error) => {
      stderr = appendBounded(stderr, String(error?.message || error), maxBuffer)
      finish(error?.code === "ENOENT" ? 127 : 1)
    })
    child.on("close", (code, signal) => finish(code, signal))

    const heartbeat = setInterval(() => {
      options.onHeartbeat?.({
        pid: child.pid,
        elapsedMs: Date.now() - started,
        idleMs: Date.now() - lastActivity,
      })
    }, heartbeatMs)
    heartbeat.unref?.()

    const watchdog = setInterval(() => {
      const elapsed = Date.now() - started
      const idle = Date.now() - lastActivity
      if (timeoutMs > 0 && elapsed >= timeoutMs) {
        timedOut = true
        killTree(child)
      } else if (idleTimeoutMs > 0 && idle >= idleTimeoutMs) {
        idleTimedOut = true
        killTree(child)
      }
    }, 500)
    watchdog.unref?.()

    const onAbort = () => {
      cancelled = true
      killTree(child)
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener?.("abort", onAbort, { once: true })
  })
}
