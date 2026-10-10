import { spawn } from "node:child_process"
import { createTailByteBuffer, terminateProcessTreeAsync } from "./process-supervisor.mjs"

export function runProcess(executable, args = [], options = {}) {
  const startedAt = Date.now()
  const heartbeatMs = Math.max(0, Number(options.heartbeatMs ?? 30_000))
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? 0))
  const idleTimeoutMs = Math.max(0, Number(options.idleTimeoutMs ?? 0))
  const maxBuffer = Math.max(1024, Number(options.maxBuffer ?? 4 * 1024 * 1024))
  // Bounded drain: a parent can exit while a grandchild inherits the stdio
  // pipes, in which case "close" never arrives. Never wait for it forever.
  const drainMs = Math.max(50, Math.min(30_000, Number(options.drainTimeoutMs ?? 1500)))

  return new Promise((resolve) => {
    // V16.17.1: tail-only byte buffers owned by lib/process-supervisor.mjs.
    // The old `stdout += chunk` tail-slice copied up to `maxBuffer` chars on
    // EVERY data event (O(n^2) churn) and accounted CHARS against a byte-sized
    // budget. Buffers queue chunk Buffers (O(1) per event, O(limit) memory)
    // and render the tail once at settlement. Render shape is unchanged
    // (tail-only), so the pinned maxBuffer contract is preserved exactly.
    const stdoutCapture = createTailByteBuffer(maxBuffer)
    const stderrCapture = createTailByteBuffer(maxBuffer)
    let lastOutputAt = Date.now()
    let timedOut = false
    let idleTimedOut = false
    let aborted = false
    let finished = false
    let exitStatus = null
    let escalationTimer = null
    let drainTimer = null

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
      if (escalationTimer) clearTimeout(escalationTimer)
      if (drainTimer) clearTimeout(drainTimer)
      if (options.signal) options.signal.removeEventListener("abort", onAbort)
    }

    const finish = (status, signal, spawnError = null) => {
      if (finished) return
      finished = true
      cleanup()
      if (spawnError) stderrCapture.append(String(spawnError.message || spawnError))
      resolve({
        status: (spawnError || signal || timedOut || idleTimedOut || aborted)
          ? (Number.isInteger(status) && status !== 0 ? status : 1)
          : (Number.isInteger(status) ? status : 0),
        signal: signal || null,
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        stdoutOmittedBytes: stdoutCapture.omittedBytes,
        stderrOmittedBytes: stderrCapture.omittedBytes,
        durationMs: Date.now() - startedAt,
        timedOut,
        idleTimedOut,
        aborted,
      })
    }

    child.stdout?.on("data", (chunk) => {
      lastOutputAt = Date.now()
      stdoutCapture.append(chunk)
      options.onStdout?.(String(chunk))
    })
    child.stderr?.on("data", (chunk) => {
      lastOutputAt = Date.now()
      stderrCapture.append(chunk)
      options.onStderr?.(String(chunk))
    })

    child.on("error", (error) => finish(1, null, error))
    // "close" waits for inherited stdio descriptors: a surviving grandchild
    // can delay it forever. "exit" arms the same bounded drain as a stop.
    child.on("exit", (code) => {
      if (Number.isInteger(code)) exitStatus = code
      armDrain()
    })
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

    // Drain fallback is armed BEFORE the kill helper runs: even a hanging
    // taskkill cannot delay settlement past drainMs.
    const armDrain = () => {
      if (finished || drainTimer) return
      // A natural exit observed without a stop keeps its real status; a
      // stop or error still resolves nonzero through finish().
      drainTimer = setTimeout(() => finish(exitStatus, null), drainMs)
      drainTimer.unref?.()
    }

    const requestStop = () => {
      armDrain()
      void terminateProcessTreeAsync(child, {
        graceMs: Math.max(100, Number(options.killGraceMs ?? 2_000)),
      }).catch(() => {})
      if (process.platform !== "win32" && !escalationTimer) {
        const graceMs = Math.max(100, Number(options.killGraceMs ?? 2_000))
        escalationTimer = setTimeout(() => {
          if (!finished) {
            void terminateProcessTreeAsync(child, { graceMs: 0 }).catch(() => {})
          }
        }, graceMs)
        escalationTimer.unref?.()
      }
    }

    const watchdogTimer = (timeoutMs > 0 || idleTimeoutMs > 0)
      ? setInterval(() => {
          const now = Date.now()
          if (timeoutMs > 0 && now - startedAt >= timeoutMs) {
            if (!timedOut) {
              timedOut = true
              requestStop()
            }
            return
          }
          if (idleTimeoutMs > 0 && now - lastOutputAt >= idleTimeoutMs) {
            if (!idleTimedOut) {
              idleTimedOut = true
              requestStop()
            }
          }
        }, 500)
      : null

    function onAbort() {
      if (aborted) return
      aborted = true
      requestStop()
    }

    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }
  })
}
