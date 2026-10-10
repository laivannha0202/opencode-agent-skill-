import { spawn, spawnSync } from "node:child_process"

function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

// Bound for the synchronous Windows legacy path below. It is intentionally
// short: a synchronous taskkill MUST never block the event loop unboundedly.
// Hot paths (timeout/cancellation) must use terminateProcessTreeAsync instead.
const SYNC_TASKKILL_TIMEOUT_MS = 5_000

// Default deadline for the async Windows taskkill helper. The helper itself
// must never become a hang source: it is raced against this bound and killed.
const DEFAULT_KILL_TIMEOUT_MS = 5_000

// One in-flight async kill per pid: concurrent stop() callers share the same
// bounded attempt instead of spawning competing taskkill helpers.
const IN_FLIGHT_KILLS = new Map()

function killResult(partial = {}) {
  return {
    attempted: partial.attempted === true,
    terminated: partial.terminated === true,
    timedOut: partial.timedOut === true,
    method: partial.method || "none",
    pid: Number.isFinite(Number(partial.pid)) ? Number(partial.pid) : null,
    durationMs: Math.max(0, Math.trunc(Number(partial.durationMs) || 0)),
    error: partial.error == null ? null : String(partial.error),
  }
}

function targetAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function terminatePosixAsync(pid, directKill, options = {}) {
  const startedAt = Date.now()
  const graceMs = clamp(options.graceMs, 1500, 0, 30_000)
  let signaled = false
  try {
    process.kill(-pid, "SIGTERM")
    signaled = true
  } catch {
    try {
      signaled = directKill("SIGTERM") !== false
    } catch {
      signaled = false
    }
  }
  if (!signaled) {
    return killResult({
      attempted: true,
      terminated: !targetAlive(pid),
      method: targetAlive(pid) ? "signal-failed" : "already-exited",
      pid,
      durationMs: Date.now() - startedAt,
    })
  }
  if (graceMs > 0 && groupAlive(pid)) await sleepMs(graceMs)
  if (groupAlive(pid)) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      try { directKill("SIGKILL") } catch {}
    }
    await sleepMs(250)
  }
  const alive = targetAlive(pid) || groupAlive(pid)
  return killResult({
    attempted: true,
    terminated: !alive,
    method: alive ? "signal-escalated" : "signal",
    pid,
    durationMs: Date.now() - startedAt,
  })
}

function spawnTaskkill(pid, spawnImpl) {
  return spawnImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  })
}

async function terminateWindowsAsync(pid, options = {}) {
  const startedAt = Date.now()
  const killTimeoutMs = clamp(options.killTimeoutMs, DEFAULT_KILL_TIMEOUT_MS, 500, 15_000)
  const spawnImpl = typeof options.spawnImpl === "function" ? options.spawnImpl : spawn
  if (!targetAlive(pid)) {
    return killResult({ attempted: true, terminated: false, method: "already-exited", pid, durationMs: Date.now() - startedAt })
  }
  let helper = null
  try {
    helper = spawnTaskkill(pid, spawnImpl)
  } catch (error) {
    return killResult({ attempted: true, terminated: !targetAlive(pid), method: "spawn-failed", pid, durationMs: Date.now() - startedAt, error: error?.message || error })
  }
  if (!helper || typeof helper.once !== "function") {
    return killResult({ attempted: true, terminated: !targetAlive(pid), method: "spawn-failed", pid, durationMs: Date.now() - startedAt, error: "kill helper unavailable" })
  }
  const outcome = await new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { helper.kill("SIGKILL") } catch {}
      resolve({ helperTimedOut: true, code: null })
    }, killTimeoutMs)
    timer.unref?.()
    helper.once("error", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ helperTimedOut: false, code: null })
    })
    helper.once("exit", (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ helperTimedOut: false, code })
    })
  })
  const alive = targetAlive(pid)
  return killResult({
    attempted: true,
    terminated: !alive,
    timedOut: outcome.helperTimedOut === true,
    method: outcome.helperTimedOut ? "taskkill-timeout" : (outcome.code === 0 ? "taskkill" : "taskkill-failed"),
    pid,
    durationMs: Date.now() - startedAt,
    error: outcome.helperTimedOut ? "taskkill helper exceeded its deadline" : null,
  })
}

/**
 * Non-blocking, bounded, idempotent process-tree termination.
 *
 * This is the owner every timeout/cancellation hot path must use. It never
 * blocks the event loop: POSIX signals are syscalls and the Windows taskkill
 * helper runs asynchronously behind its own deadline (`killTimeoutMs`).
 * Concurrent calls for the same pid share one in-flight attempt.
 *
 * Callers must arm their finalization/drain fallback BEFORE awaiting this:
 * a helper timeout must never delay settlement.
 */
export function terminateProcessTreeAsync(proc, options = {}) {
  const pid = Number(proc?.pid)
  if (!Number.isFinite(pid) || pid <= 0) {
    return Promise.resolve(killResult({ attempted: false, method: "no-pid" }))
  }
  const existing = IN_FLIGHT_KILLS.get(pid)
  if (existing) return existing
  const directKill = (signal) => proc.kill(signal)
  const attempt = (process.platform === "win32"
    ? terminateWindowsAsync(pid, options)
    : terminatePosixAsync(pid, directKill, options)
  ).then(
    (result) => {
      if (IN_FLIGHT_KILLS.get(pid) === attempt) IN_FLIGHT_KILLS.delete(pid)
      return result
    },
    (error) => {
      if (IN_FLIGHT_KILLS.get(pid) === attempt) IN_FLIGHT_KILLS.delete(pid)
      return killResult({ attempted: true, method: "internal-error", pid, error: error?.message || error })
    },
  )
  IN_FLIGHT_KILLS.set(pid, attempt)
  return attempt
}

/**
 * Legacy synchronous process-tree termination. Kept for call sites that
 * consume the boolean synchronously (cleanup decision branches).
 *
 * The Windows path is BOUNDED (spawnSync `timeout`) so it can never block the
 * event loop forever, but it still blocks while the helper runs. New
 * timeout/cancellation hot paths must use terminateProcessTreeAsync instead.
 */
export function terminateProcessTree(proc, options = {}) {
  if (!proc?.pid) return false
  const graceMs = clamp(options.graceMs, 1500, 0, 30_000)

  if (process.platform === "win32") {
    let result = null
    try {
      result = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: SYNC_TASKKILL_TIMEOUT_MS,
      })
    } catch {
      return false
    }
    return result != null && result.status === 0
  }

  // Processes created with detached=true become their own process group.
  let signaled = false
  try {
    process.kill(-proc.pid, "SIGTERM")
    signaled = true
  } catch {
    try {
      signaled = proc.kill("SIGTERM") !== false
    } catch {}
  }

  if (signaled && graceMs > 0) {
    const processGroupId = proc.pid
    const timer = setTimeout(() => {
      // The direct child can exit while a descendant survives and keeps an
      // inherited pipe open. Probe the process group itself before escalation.
      let groupAlive = false
      try {
        process.kill(-processGroupId, 0)
        groupAlive = true
      } catch {}
      if (!groupAlive) return
      try {
        process.kill(-processGroupId, "SIGKILL")
      } catch {
        try { proc.kill("SIGKILL") } catch {}
      }
    }, graceMs)
    timer.unref?.()
  }
  return signaled
}

/**
 * Bounded byte-accurate output capture with head/tail preservation.
 *
 * Laws:
 * - memory is O(limitBytes): a fixed bounded head plus a rolling bounded
 *   tail plus a total counter. Once the head quota is filled the middle is
 *   never retained; the tail keeps only the most recent tailBytes. Retained
 *   payload is headKept + tailKept <= limitBytes plus at most one in-flight
 *   chunk, and MUST NOT grow with total emitted output;
 * - trimmed slices are COPIED so no retained view pins a giant original
 *   Buffer;
 * - accounting is BYTES (Buffer lengths), never JS string `.length`, so
 *   Vietnamese/CJK/emoji output cannot silently exceed a byte cap;
 * - small outputs resolve byte-identical (no marker injected);
 * - large outputs keep the head (first bytes) and the tail (last bytes, where
 *   errors surface) and report the omitted middle honestly;
 * - chunk boundaries are preferred whole: only an oversized region edge is
 *   byte-sliced, and Buffer.toString marks the cut with U+FFFD exactly where
 *   bytes were omitted (never silent corruption elsewhere);
 * - no O(n^2) behavior: append is amortized O(1) (queue with lazy
 *   compaction, one bounded copy at most), concatenation happens once at
 *   render.
 */
export function createBoundedOutputBuffer(limitBytes) {
  const parsed = Number(limitBytes)
  const limit = Number.isFinite(parsed)
    ? Math.max(256, Math.min(64 * 1024 * 1024, Math.trunc(parsed)))
    : 512 * 1024
  const headBytes = Math.min(limit, Math.max(4096, Math.floor(limit / 4)))
  const tailBytes = Math.max(0, limit - headBytes)
  const headParts = []
  let headKept = 0
  let tailParts = []
  let tailStart = 0
  let tailKept = 0
  let totalBytes = 0
  let truncated = false

  function liveTailParts() {
    if (tailStart === 0) return tailParts
    return tailParts.slice(tailStart)
  }

  function compactTailIfNeeded() {
    if (tailStart > 1024 && tailStart * 2 >= tailParts.length) {
      tailParts = tailParts.slice(tailStart)
      tailStart = 0
    }
  }

  function pushTail(buf) {
    if (tailBytes === 0 || buf.length === 0) return
    let input = buf
    if (buf.length > tailBytes) {
      // Copy: retaining a subarray view would pin the giant original.
      input = Buffer.from(buf.subarray(buf.length - tailBytes))
    }
    tailParts.push(input)
    tailKept += input.length
    while (tailParts.length - tailStart > 1 && tailKept - tailParts[tailStart].length >= tailBytes) {
      tailKept -= tailParts[tailStart].length
      tailParts[tailStart] = null
      tailStart += 1
    }
    if (tailKept > tailBytes) {
      const excess = tailKept - tailBytes
      const first = tailParts[tailStart]
      // Copy: the sliced view would otherwise pin the oversized chunk.
      tailParts[tailStart] = Buffer.from(first.subarray(excess))
      tailKept = tailBytes
    }
    compactTailIfNeeded()
  }

  function append(chunk) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk ?? ""), "utf8")
    if (buf.length === 0) return
    totalBytes += buf.length
    if (totalBytes > limit) truncated = true
    if (headKept < headBytes) {
      const need = headBytes - headKept
      if (buf.length <= need) {
        // buf itself is bounded by headBytes here; sharing the reference
        // with the tail queue avoids a copy while staying O(limit).
        headParts.push(buf)
        headKept += buf.length
      } else {
        // Copy: retaining buf.subarray(0, need) would pin the giant original.
        headParts.push(Buffer.from(buf.subarray(0, need)))
        headKept = headBytes
      }
    }
    pushTail(buf)
  }

  function decode(bufs) {
    if (bufs.length === 0) return ""
    if (bufs.length === 1) return bufs[0].toString("utf8")
    return Buffer.concat(bufs).toString("utf8")
  }

  function skipPrefixBytes(bufs, skip) {
    if (skip <= 0) return bufs
    const out = []
    let remaining = skip
    for (const buf of bufs) {
      if (remaining <= 0) {
        out.push(buf)
        continue
      }
      if (buf.length <= remaining) {
        remaining -= buf.length
        continue
      }
      out.push(buf.subarray(remaining))
      remaining = 0
    }
    return out
  }

  function text() {
    if (!truncated) {
      if (totalBytes === 0) return ""
      // total <= limit, so head [0,headKept) plus tail [total-tailKept,total)
      // cover the whole stream with overlap headKept+tailKept-total.
      if (headKept === totalBytes) return decode(headParts)
      const live = liveTailParts()
      if (tailKept === totalBytes) return decode(live)
      const overlap = headKept + tailKept - totalBytes
      const suffix = skipPrefixBytes(live, overlap)
      if (headParts.length === 0) return decode(suffix)
      if (suffix.length === 0) return decode(headParts)
      return decode(headParts.concat(suffix))
    }
    // A byte slice can cut a multi-byte character at the omission boundary;
    // Buffer.toString renders the cut as U+FFFD exactly where bytes were
    // omitted, which is honest. Whole chunks are never re-sliced, so text
    // away from the boundary is never corrupted.
    const live = liveTailParts()
    const omitted = Math.max(0, totalBytes - headKept - tailKept)
    return decode(headParts)
      + `\n...[omitted ${omitted} bytes of output]...\n`
      + decode(live)
  }

  return {
    append,
    text,
    get bytes() { return totalBytes },
    get omittedBytes() {
      if (!truncated) return 0
      return Math.max(0, totalBytes - headKept - tailKept)
    },
    get truncated() { return truncated },
    get limitBytes() { return limit },
    get retainedBytes() { return headKept + tailKept },
    get headBytes() { return headBytes },
    get tailBytes() { return tailBytes },
  }
}

/**
 * Bounded tail-only byte buffer for capped stream capture (process-runner,
 * git-async-runtime, child stderr accumulators).
 *
 * Laws (shared owner with createBoundedOutputBuffer, different render shape):
 * - memory is O(limitBytes): head buffers are DROPPED as new bytes arrive,
 *   so a 50 MB stream behind a 1 MB cap holds ~1 MB, never the full stream;
 * - accounting is BYTES (Buffer lengths), never JS string `.length`, so
 *   multibyte output cannot silently exceed the cap;
 * - render shape is tail-only (last `limitBytes`), matching the pinned
 *   `maxBuffer`/`maxBytes` tail contracts; `truncated`/`omittedBytes`/`bytes`
 *   report honestly;
 * - no O(n^2) string copying: Buffers are queued and concatenated once at
 *   render; decode happens once.
 */
export function createTailByteBuffer(limitBytes) {
  const parsed = Number(limitBytes)
  const limit = Number.isFinite(parsed)
    ? Math.max(256, Math.min(64 * 1024 * 1024, Math.trunc(parsed)))
    : 512 * 1024
  const parts = []
  let keptBytes = 0
  let totalBytes = 0

  function append(chunk) {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk ?? ""), "utf8")
    if (buf.length === 0) return
    totalBytes += buf.length
    parts.push(buf)
    keptBytes += buf.length
    while (parts.length > 1 && keptBytes - parts[0].length >= limit) {
      const dropped = parts.shift()
      keptBytes -= dropped.length
    }
    if (keptBytes > limit) {
      const excess = keptBytes - limit
      // Copy: a subarray view would retain the whole oversized chunk in RAM.
      parts[0] = Buffer.from(parts[0].subarray(excess))
      keptBytes = limit
    }
  }

  function text() {
    if (parts.length === 0) return ""
    if (parts.length === 1) return parts[0].toString("utf8")
    return Buffer.concat(parts).toString("utf8")
  }

  return {
    append,
    text,
    get bytes() { return totalBytes },
    get omittedBytes() { return Math.max(0, totalBytes - keptBytes) },
    get truncated() { return totalBytes > limit },
    get limitBytes() { return limit },
  }
}

export async function runSupervisedProcess(command, args = [], options = {}) {
  const cwd = options.cwd || process.cwd()
  const hardTimeoutMs = clamp(options.hardTimeoutMs, 0, 0, 24 * 60 * 60_000)
  const idleTimeoutMs = clamp(options.idleTimeoutMs, 0, 0, 24 * 60 * 60_000)
  const drainTimeoutMs = clamp(options.drainTimeoutMs, 1500, 50, 30_000)
  const signal = options.signal

  return await new Promise((resolve) => {
    const startedAt = Date.now()
    let lastActivityAt = startedAt
    const stdoutCapture = createBoundedOutputBuffer(options.stdoutLimit)
    const stderrCapture = createBoundedOutputBuffer(options.stderrLimit)
    let settled = false
    let exitSeen = false
    let exitCode = null
    let exitSignal = null
    let stopReason = null
    let hardTimer = null
    let idleTimer = null
    let drainTimer = null
    let abortListener = null
    let proc = null

    try {
      proc = spawn(command, args, {
        cwd,
        env: options.env || process.env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: options.stdin === "pipe" ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      resolve({
        pid: null,
        exitCode: 1,
        signal: null,
        stopReason: "spawn-error",
        stdout: "",
        stderr: String(error?.message || error),
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutOmittedBytes: 0,
        stderrOmittedBytes: 0,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      })
      return
    }

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
      const stdout = stdoutCapture.text()
      const stderr = stderrCapture.text()
      resolve({
        pid: proc.pid || null,
        exitCode: stopReason === "aborted"
          ? 130
          : stopReason
            ? 124
            : Number.isInteger(exitCode)
              ? exitCode
              : 1,
        signal: exitSignal,
        stopReason,
        stdout,
        stderr,
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        stdoutOmittedBytes: stdoutCapture.omittedBytes,
        stderrOmittedBytes: stderrCapture.omittedBytes,
        stdoutBytes: stdoutCapture.bytes,
        stderrBytes: stderrCapture.bytes,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
      })
    }

    // The drain fallback is armed BEFORE (or independently of) the kill
    // helper: if taskkill itself hangs, settlement still happens on time.
    const armDrain = () => {
      if (settled || drainTimer) return
      drainTimer = setTimeout(finish, drainTimeoutMs)
      drainTimer.unref?.()
    }

    const stop = (reason) => {
      if (settled || stopReason) return
      if (exitSeen) {
        // The process already exited; close is only waiting on an inherited
        // pipe. Killing is pointless and must not reclassify a natural exit
        // as a timeout/abort.
        armDrain()
        return
      }
      stopReason = reason
      armDrain()
      void terminateProcessTreeAsync(proc, { graceMs: options.killGraceMs }).catch(() => {})
    }

    const append = (kind, chunk) => {
      lastActivityAt = Date.now()
      const capture = kind === "stdout" ? stdoutCapture : stderrCapture
      capture.append(chunk)
      try { options.onOutput?.({ kind, text: String(chunk), at: Date.now() }) } catch {}
    }

    proc.stdout?.on("data", (data) => append("stdout", data))
    proc.stderr?.on("data", (data) => append("stderr", data))

    proc.on("error", (error) => {
      append("stderr", String(error?.message || error) + "\n")
      if (!stopReason) {
        exitCode = 1
        finish()
      } else {
        armDrain()
      }
    })

    proc.on("exit", (code, sig) => {
      exitSeen = true
      exitCode = code
      exitSignal = sig
      // close can be delayed forever if a grandchild inherited the pipe.
      armDrain()
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

    abortListener = () => stop("aborted")
    if (signal) {
      if (signal.aborted) abortListener()
      else signal.addEventListener("abort", abortListener, { once: true })
    }
  })
}