import { spawn, spawnSync } from "node:child_process"

function appendBounded(current, chunk, limit) {
  const next = current + String(chunk || "")
  if (next.length <= limit) return next
  return next.slice(next.length - limit)
}

function killTree(child) {
  if (!child?.pid) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    try { child.kill("SIGTERM") } catch {}
  }
}

export function runProcess(executable, args = [], options = {}) {
  const startedAt = Date.now()
  const heartbeatMs = Math.max(0, Number(options.heartbeatMs ?? 30_000))
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0))
  const idleTimeoutMs = Math.max(0, Number(options.idleTimeoutMs ?? 0))
  const maxBuffer = Math.max(1024, Number(options.maxBuffer ?? 4 * 1024 * 1024))

  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let lastOutputAt = Date.now()
    let timedOut = false
    let idleTimedOut = false
    let aborted = false
    let finished = false

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    })

    const cleanup = () => {
      clearInterval(heartbeatTimer)
      clearInterval(watchdogTimer)
      if (options.signal) options.signal.removeEventListener("abort", onAbort)
    }

    const finish = (status, signal, spawnError = null) => {
      if (finished) return
      finished = true
      cleanup()
      resolve({
        status: Number.isInteger(status) ? status : (spawnError || signal || timedOut || idleTimedOut || aborted) ? 1 : 0,
        signal: signal || null,
        stdout,
        stderr: spawnError ? appendBounded(stderr, String(spawnError.message || spawnError), maxBuffer) : stderr,
        durationMs: Date.now() - startedAt,
        timedOut,
        idleTimedOut,
        aborted,
      })
    }

    child.stdout?.on("data", (chunk) => {
      lastOutputAt = Date.now()
      stdout = appendBounded(stdout, chunk, maxBuffer)
      options.onStdout?.(String(chunk))
    })
    child.stderr?.on("data", (chunk) => {
      lastOutputAt = Date.now()
      stderr = appendBounded(stderr, chunk, maxBuffer)
      options.onStderr?.(String(chunk))
    })

    child.on("error", (error) => finish(1, null, error))
    child.on("close", (code, signal) => finish(code ?? 1, signal))

    const heartbeatTimer = heartbeatMs > 0
      ? setInterval(() => {
          options.onHeartbeat?.({
            pid: child.pid,
            elapsedMs: Date.now() - startedAt,
            idleMs: Date.now() - lastOutputAt,
          })
        }, heartbeatMs)
      : null

    const watchdogTimer = (timeoutMs > 0 || idleTimeoutMs > 0)
      ? setInterval(() => {
          const now = Date.now()
          if (timeoutMs > 0 && now - startedAt >= timeoutMs) {
            timedOut = true
            killTree(child)
            return
          }
          if (idleTimeoutMs > 0 && now - lastOutputAt >= idleTimeoutMs) {
            idleTimedOut = true
            killTree(child)
          }
        }, 500)
      : null

    function onAbort() {
      aborted = true
      killTree(child)
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
