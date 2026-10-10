// V16.16 Async / Cancellable Git Hot-Path Runner.
//
// WHY THIS MODULE EXISTS
//
// `lib/worktree-sandbox.mjs` runs every Git operation with `spawnSync`. A
// synchronous spawn BLOCKS the Node event loop for the whole child lifetime:
// `git status` on a large tree, a `worktree add` under Defender, or a hung
// child freezes every watchdog, deadline and abort handler in the process.
// V16.16 overlaps independent work, so a blocked event loop is a correctness
// risk, not just a latency cost.
//
// This module is the single owner of the BOUNDED async Git primitive:
//
//   runGitAsync(root, args, options) -> structured result
//
// LAWS
//
//   1. NEVER shell:true, NEVER string interpolation. argv only, explicit cwd.
//   2. BOUNDED always: timeout, max stdout/stderr bytes, AbortSignal.
//   3. Windows-safe teardown: the whole process tree is terminated on
//      abort/timeout (via the existing process-supervisor owner).
//   4. ROOT MUTATION STAYS SERIAL. This module runs ONE git process per call;
//      the transaction authority (`lib/integration-transaction-v16-15.mjs`)
//      remains the only owner that decides apply order and concurrency. This
//      module never parallelizes callers by itself.
//   5. STRUCTURED result only: { exitCode, stdout, stderr, durationMs,
//      cancelled, timedOut }. No exceptions for a non-zero exit (a failing
//      `git apply --check` is a VERDICT, not a crash); throws only when the
//      process could not be spawned at all.

import { spawn } from "node:child_process"
import path from "node:path"
import { createTailByteBuffer, terminateProcessTreeAsync } from "./process-supervisor.mjs"

export const GIT_ASYNC_RUNTIME_POLICY = "git-async-runtime-v16-16"
export const GIT_ASYNC_RUNTIME_SCHEMA_VERSION = 1

export const GIT_ASYNC_LIMITS = Object.freeze({
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 10 * 60_000,
  defaultMaxBytes: 16 * 1024 * 1024,
  maxMaxBytes: 64 * 1024 * 1024,
})

function clampInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * Validate argv. A Git argument that is not a finite string, or that contains
 * a NUL byte, is rejected BEFORE spawn. There is no shell, so metacharacters
 * are data, never code - but NUL would truncate the argument at the OS level.
 */
export function assertSafeGitArgs(args) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("git-async-runtime: git argv must be a non-empty array")
  }
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error("git-async-runtime: every git argument must be a string")
    }
    if (arg.includes("\0")) {
      throw new Error("git-async-runtime: git argument contains NUL")
    }
  }
  return true
}

/**
 * Run one bounded async Git process.
 *
 * @param {string} root            explicit cwd (required, must exist semantically)
 * @param {string[]} args          git argv (no shell, no interpolation)
 * @param {object} [options]
 * @param {string} [options.input]       stdin payload
 * @param {number} [options.timeoutMs]   bounded timeout (default 60s)
 * @param {number} [options.maxBytes]    per-stream cap (default 16MiB)
 * @param {AbortSignal} [options.signal] cancellation
 */
export function runGitAsync(root, args, options = {}) {
  assertSafeGitArgs(args)
  const cwd = path.resolve(String(root || ""))
  if (!cwd) throw new Error("git-async-runtime: root is required")
  const timeoutMs = clampInt(
    options.timeoutMs ?? GIT_ASYNC_LIMITS.defaultTimeoutMs,
    GIT_ASYNC_LIMITS.defaultTimeoutMs,
    100,
    GIT_ASYNC_LIMITS.maxTimeoutMs,
  )
  const maxBytes = clampInt(
    options.maxBytes ?? GIT_ASYNC_LIMITS.defaultMaxBytes,
    GIT_ASYNC_LIMITS.defaultMaxBytes,
    1024,
    GIT_ASYNC_LIMITS.maxMaxBytes,
  )
  const signal = options.signal || null
  const input = options.input == null ? null : String(options.input)

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    let proc = null
    try {
      proc = spawn("git", [...args], {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    // V16.17.1: tail-only byte buffers owned by lib/process-supervisor.mjs.
    // The old `stdout += text` tail-slice copied up to `maxBytes` chars on
    // EVERY data event and accounted CHARS against the documented per-stream
    // BYTE cap. Buffers queue chunk Buffers (O(limit) memory, head dropped)
    // and render once at settlement. ASCII behavior is unchanged.
    const stdoutCapture = createTailByteBuffer(maxBytes)
    const stderrCapture = createTailByteBuffer(maxBytes)
    let settled = false
    let timedOut = false
    let cancelled = false

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      resolve({
        schemaVersion: GIT_ASYNC_RUNTIME_SCHEMA_VERSION,
        policy: GIT_ASYNC_RUNTIME_POLICY,
        exitCode: outcome.exitCode,
        stdout: stdoutCapture.text(),
        stderr: stderrCapture.text(),
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        stdoutOmittedBytes: stdoutCapture.omittedBytes,
        stderrOmittedBytes: stderrCapture.omittedBytes,
        durationMs: Date.now() - startedAt,
        cancelled,
        timedOut,
        deterministic: true,
      })
    }

    const killTree = () => {
      // Fire-and-forget: the timeout/abort fallback below bounds settlement
      // independently of how long the kill helper takes.
      try {
        void terminateProcessTreeAsync(proc, { graceMs: 1000 }).catch(() => {})
      } catch {}
    }

    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      killTree()
      // Give the tree a bounded grace window, then report even if the OS lies.
      setTimeout(() => finish({ exitCode: null }), 2_000).unref?.()
    }, timeoutMs)
    timer.unref?.()

    const onAbort = () => {
      if (settled) return
      cancelled = true
      killTree()
      setTimeout(() => finish({ exitCode: null }), 2_000).unref?.()
    }
    if (signal) {
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    const append = (chunk, which) => {
      if (which === "stdout") stdoutCapture.append(chunk)
      else stderrCapture.append(chunk)
    }

    proc.stdout.on("data", (chunk) => append(chunk, "stdout"))
    proc.stderr.on("data", (chunk) => append(chunk, "stderr"))
    proc.on("error", (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener("abort", onAbort)
      reject(error instanceof Error ? error : new Error(String(error)))
    })
    proc.on("close", (code) => {
      finish({ exitCode: typeof code === "number" ? code : null })
    })

    if (input != null) {
      proc.stdin.write(input, (error) => {
        try { proc.stdin.end() } catch {}
        if (error && !settled) {
          // An EPIPE here means the child already exited; the close handler
          // below still reports the real outcome. Anything else surfaces.
          if (error?.code !== "EPIPE") {
            settled = true
            clearTimeout(timer)
            if (signal) signal.removeEventListener("abort", onAbort)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        }
      })
    } else {
      try { proc.stdin.end() } catch {}
    }
  })
}

/**
 * Run bounded Git processes with a concurrency ceiling.
 *
 * The ceiling exists so a caller cannot turn "async" into "forty concurrent
 * git processes". Root mutation must still go through the transaction owner
 * one patch at a time; this helper is for read-only fan-out (status,
 * rev-parse, diff, ls-files) and rejects mutation-looking argv unless the
 * caller explicitly opts in.
 */
const MUTATION_RE = /\b(apply|commit|checkout|reset|clean|push|worktree\s+(add|remove|move)|branch\s+-[dD]|update-ref)\b/i

export async function runGitBatch(root, calls = [], options = {}) {
  const maxConcurrency = clampInt(options.maxConcurrency ?? 4, 4, 1, 8)
  const allowMutation = options.allowMutation === true
  if (!Array.isArray(calls) || calls.length === 0) return []
  if (!allowMutation) {
    for (const call of calls) {
      const argv = Array.isArray(call) ? call : call?.args
      if (MUTATION_RE.test((argv || []).join(" "))) {
        throw new Error("git-async-runtime: batch refuses root-mutating argv without allowMutation:true")
      }
    }
  }
  const results = new Array(calls.length)
  let next = 0
  const workers = Array.from({ length: Math.min(maxConcurrency, calls.length) }, async () => {
    while (next < calls.length) {
      const index = next
      next += 1
      const call = calls[index]
      const argv = Array.isArray(call) ? call : call?.args
      const callOptions = Array.isArray(call) ? {} : { ...(options.callOptions || {}), ...(call?.options || {}) }
      if (options.signal?.aborted) {
        results[index] = {
          exitCode: null, stdout: "", stderr: "batch aborted",
          durationMs: 0, cancelled: true, timedOut: false,
          policy: GIT_ASYNC_RUNTIME_POLICY,
        }
        continue
      }
      results[index] = await runGitAsync(root, argv, { ...options, ...callOptions, signal: options.signal })
    }
  })
  await Promise.all(workers)
  return results
}

export const gitAsyncRuntimeExports = Object.freeze({
  runGitAsync,
  runGitBatch,
  assertSafeGitArgs,
  GIT_ASYNC_RUNTIME_POLICY,
  GIT_ASYNC_LIMITS,
})
