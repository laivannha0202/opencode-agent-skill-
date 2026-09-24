import { spawn, spawnSync } from "node:child_process"

function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function terminateProcessTree(proc, options = {}) {
  if (!proc?.pid) return false
  const graceMs = clamp(options.graceMs, 1500, 0, 30_000)

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return result.status === 0
  }

  // Processes created with detached=true become their own process group.
  try {
    process.kill(-proc.pid, "SIGTERM")
  } catch {
    try { proc.kill("SIGTERM") } catch {}
  }

  if (graceMs > 0) {
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL")
      } catch {
        try { proc.kill("SIGKILL") } catch {}
      }
    }, graceMs)
    timer.unref?.()
  }
  return true
}

export async function runSupervisedProcess(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd()
  const stdoutLimit = clamp(options.stdoutLimit, 512 * 1024, 1024, 64 * 1024 * 1024)
  const stderrLimit = clamp(options.stderrLimit, 128 * 1024, 1024, 64 * 1024 * 1024)
  const hardTimeoutMs = clamp(options.hardTimeoutMs, 0, 0, 24 * 60 * 60_000)
  const idleTimeoutMs = clamp(options.idleTimeoutMs, 0, 0, 24 * 60 * 60_000)
  const drainTimeoutMs = clamp(options.drainTimeoutMs, 1500, 50, 30_000)
  const signal = options.signal

  return await new Promise((resolve) => {
    const startedAt = Date.now()
    let lastActivityAt = startedAt
    let stdout = ""
    let stderr = ""
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let exitSeen = false
    let exitCode = null
    let exitSignal = null
    let stopReason = null
    let hardTimer = null
    let idleTimer = null
    let drainTimer = null

    const proc = spawn(command, args, {
      cwd,
      env: options.env || process.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: options.stdin === "pipe" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    })

    const clear = () => {
      if (hardTimer) clearTimeout(hardTimer)
      if (idleTimer) clearInterval(idleTimer)
      if (drainTimer) clearTimeout(drainTimer)
      if (signal && abortListener) signal.removeEventListener("abort", abortListener)
    }

    const finish = () => {
      if (settled) return
      settled = true
      clear()
      resolve({
        pid: proc.pid || null,
        exitCode: Number.isInteger(exitCode) ? exitCode : stopReason ? 124 : 1,
        signal: exitSignal,
        stopReason,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      })
    }

    const stop = (reason) => {
      if (settled || stopReason) return
      stopReason = reason
      terminateProcessTree(proc, { graceMs: options.killGraceMs })
      // Do not wait forever for inherited stdout/stderr descriptors held by grandchildren.
      drainTimer = setTimeout(finish, drainTimeoutMs)
      drainTimer.unref?.()
    }

    const append = (kind, chunk) => {
      lastActivityAt = Date.now()
      const text = String(chunk)
      if (kind === "stdout") {
        const room = stdoutLimit - stdout.length
        if (room > 0) stdout += text.slice(0, room)
        if (text.length > Math.max(0, room)) stdoutTruncated = true
      } else {
        const room = stderrLimit - stderr.length
        if (room > 0) stderr += text.slice(0, room)
        if (text.length > Math.max(0, room)) stderrTruncated = true
      }
      try { options.onOutput?.({ kind, text, at: Date.now() }) } catch {}
    }

    proc.stdout?.on("data", (data) => append("stdout", data))
    proc.stderr?.on("data", (data) => append("stderr", data))

    proc.on("error", (error) => {
      stderr += (stderr ? "\n" : "") + String(error?.message || error)
      exitCode = 1
      finish()
    })

    proc.on("exit", (code, sig) => {
      exitSeen = true
      exitCode = code
      exitSignal = sig
      // close can be delayed forever if a grandchild inherited the pipe.
      drainTimer = setTimeout(finish, drainTimeoutMs)
      drainTimer.unref?.()
    })
    proc.on("close", (code, sig) => {
      if (code !== null) exitCode = code
      if (sig) exitSignal = sig
      finish()
    })

    if (options.stdin === "pipe" && typeof options.input === "string") {
      proc.stdin?.on("error", () => {})
      proc.stdin?.end(options.input)
    }

    if (hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => stop("hard-timeout"), hardTimeoutMs)
      hardTimer.unref?.()
    }

    if (idleTimeoutMs > 0) {
      idleTimer = setInterval(() => {
        if (!settled && !exitSeen && Date.now() - lastActivityAt >= idleTimeoutMs) {
          stop("idle-timeout")
        }
      }, Math.min(1000, Math.max(100, Math.floor(idleTimeoutMs / 10))))
      idleTimer.unref?.()
    }

    const abortListener = () => stop("aborted")
    if (signal) {
      if (signal.aborted) abortListener()
      else signal.addEventListener("abort", abortListener, { once: true })
    }
  })
}
