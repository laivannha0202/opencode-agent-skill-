import { spawn } from "node:child_process"
import { terminateProcessTree } from "./process-supervisor.mjs"
import { createAdaptiveDeadline } from "./activity-deadline.mjs"

function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

const RPC_CONTROL_TIMEOUT_MS = clamp(
  process.env.UES_RPC_CONTROL_TIMEOUT_MS,
  3_000,
  500,
  30_000,
)

const RPC_DEFAULT_HARD_TIMEOUT_MS = 30 * 60_000
const RPC_MAX_HARD_TIMEOUT_MS = 2 * 60 * 60_000

/**
 * Resolve the timeout budget consumed by RpcWorker.run().
 *
 * V16.17.1: an explicitly supplied hard timeout is a CAP, not a hint that may
 * be raised by the old 30s floor. The ordinary no-option policy remains 30m,
 * while a caller that already bounded a child by the remaining run deadline
 * can safely pass 5s/1s/sub-second values without the transport inflating them.
 */
export function resolveRpcRunTimeouts(options = {}) {
  const hasExplicitHardTimeout = Number.isFinite(Number(options.hardTimeoutMs))
  const hardTimeoutMs = hasExplicitHardTimeout
    ? clamp(options.hardTimeoutMs, RPC_DEFAULT_HARD_TIMEOUT_MS, 1, RPC_MAX_HARD_TIMEOUT_MS)
    : RPC_DEFAULT_HARD_TIMEOUT_MS
  const hasExplicitAbsoluteTimeout = Number.isFinite(Number(options.absoluteHardTimeoutMs))
  const absoluteHardTimeoutMs = hasExplicitAbsoluteTimeout
    ? clamp(options.absoluteHardTimeoutMs, hardTimeoutMs, hardTimeoutMs, RPC_MAX_HARD_TIMEOUT_MS)
    : hardTimeoutMs
  return {
    hardTimeoutMs,
    absoluteHardTimeoutMs,
    hasExplicitHardTimeout,
    hasExplicitAbsoluteTimeout,
  }
}

/**
 * V16.16 canonical RPC worker identity (§11).
 *
 * This is the ONE place a Pi RPC worker key is constructed. Both the wave
 * prewarm path and the run path (`RPC_POOL.run`) MUST call this builder so a
 * prewarmed worker and its later run share the exact same key namespace and
 * field order. A differently-namespaced key (for example a wave-local
 * `ues-wave-…` alias) can never hit the pool's key-based reuse and only adds
 * process-start overhead.
 *
 * The key carries every correctness-sensitive dimension the run path fences
 * on: agent, cwd, invocation command/args, runtime options, policy snapshot
 * id, runtime epoch id, run id and journal root. Volatile prompt content is
 * never part of the key: the prompt travels as the run message, while fencing
 * travels in the key plus the worker env. Callers MUST build a compatible
 * spec (same command/args/cwd and fencing env) for the same inputs; when the
 * inputs genuinely differ the pool correctly reports no reuse and the caller
 * MUST discard the unconsumed prewarm instead of counting it.
 */
export const RPC_WORKER_KEY_VERSION = 1

export const PREPARED_EXECUTION_POLICY = "prepared-agent-execution-v16-17"
export const PREPARED_EXECUTION_SCHEMA_VERSION = 1

/**
 * V16.17 Prepared Agent Execution (§1): ONE canonical immutable descriptor.
 *
 * PREPARE ONCE → PREWARM + RUN consume the SAME descriptor. Callers must not
 * assemble `{ key, spec }` pairs by hand at multiple call sites: every field
 * the pool fences on is prepared here, once, from the same parts the run
 * will use. The descriptor is frozen; `sameExecution(a, b)` is the single
 * compatibility question.
 *
 * Compatibility law (all must hold):
 *   - identical pool key (agent, cwd, invocation, tool/timeout surface,
 *     policy snapshot id, runtime epoch id, run id, journal root);
 *   - identical model and thinking level (the key intentionally does NOT
 *     carry them: they travel in the invocation args, but a prewarm
 *     predicted for model X must never be consumed by a run on model Y);
 *   - identical system prompt identity (content hash, not content).
 *
 * Changing policy, system prompt, runtime epoch, cwd or model invalidates
 * compatibility. Changing only ordinary user task text does not: task text
 * travels as the run message, never in the descriptor.
 */
export function prepareAgentExecution(parts = {}) {
  const key = buildRpcWorkerKey(parts)
  const spec = buildRpcWorkerSpec({
    command: parts.command,
    args: parts.args,
    cwd: parts.cwd,
    env: parts.env,
  })
  return Object.freeze({
    schemaVersion: PREPARED_EXECUTION_SCHEMA_VERSION,
    policy: PREPARED_EXECUTION_POLICY,
    keyVersion: RPC_WORKER_KEY_VERSION,
    key,
    spec: Object.freeze({ ...spec, args: Object.freeze([...spec.args]) }),
    specFingerprint: rpcWorkerSpecFingerprint(spec),
    agent: parts.agent == null ? null : String(parts.agent),
    cwd: String(parts.cwd || ""),
    model: parts.model == null ? null : String(parts.model),
    thinking: parts.thinking == null ? null : String(parts.thinking),
    policySnapshotId: parts.policySnapshotId == null ? null : String(parts.policySnapshotId),
    systemPromptHash: parts.systemPromptHash == null ? null : String(parts.systemPromptHash),
    runtimeEpochId: parts.runtimeEpochId == null ? null : String(parts.runtimeEpochId),
    runId: parts.runId == null ? "" : String(parts.runId),
    journalRoot: parts.journalRoot == null ? String(parts.cwd || "") : String(parts.journalRoot),
    canProduceVerdict: false,
    deterministic: true,
  })
}

/**
 * The single compatibility question for a prewarmed worker and its run.
 * Same descriptor dimensions → consumable. Anything else → discard the
 * prewarm (never count it as a warm reuse).
 */
export function sameExecution(a = {}, b = {}) {
  if (!a || !b || typeof a.key !== "string" || typeof b.key !== "string") return false
  if (a.key !== b.key) return false
  const norm = (v) => (v == null ? null : String(v))
  return norm(a.model) === norm(b.model)
    && norm(a.thinking) === norm(b.thinking)
    && norm(a.systemPromptHash) === norm(b.systemPromptHash)
}

export function buildRpcWorkerKey(parts = {}) {
  return JSON.stringify([
    parts.agent,
    parts.cwd,
    parts.command,
    Array.isArray(parts.args) ? parts.args : [],
    Boolean(parts.compactToolOutput),
    Number(parts.toolOutputLimit || 0),
    Number(parts.verificationTimeoutSec || 0),
    Number(parts.toolTimeoutMs || 0),
    Boolean(parts.allowLocalEnvWrite),
    parts.policySnapshotId,
    parts.runtimeEpochId,
    parts.runId || "",
    parts.journalRoot || parts.cwd,
  ])
}

/**
 * Validate and freeze the worker spec shape a key was built for. The pool
 * reuses by key; a spec whose command/args/cwd or fencing env differs from
 * the run's is NOT compatible and must never be counted as a warm reuse.
 */
export function buildRpcWorkerSpec(parts = {}) {
  const command = String(parts.command || "")
  if (!command) throw new Error("Pi RPC worker spec requires a command")
  if (!Array.isArray(parts.args)) throw new Error("Pi RPC worker spec requires an args array")
  const cwd = String(parts.cwd || "")
  if (!cwd) throw new Error("Pi RPC worker spec requires a cwd")
  return {
    command,
    args: parts.args.map(String),
    cwd,
    env: parts.env && typeof parts.env === "object" ? { ...parts.env } : { ...process.env },
  }
}

/**
 * V16.17 (§5) CORRECTNESS-SENSITIVE SPAWN ENV.
 *
 * The pool key deliberately excludes the spawn env: ordinary env is noise and
 * keying on it would defeat reuse. But a small set of UES_CHILD_* variables
 * FENCES correctness (ownership token/scope, policy snapshot, runtime epoch,
 * run/journal binding, role/writer). Two workers with the same key but
 * different fencing env are NOT interchangeable: a prewarmed worker built for
 * one ownership scope must never silently serve a run with another. The pool
 * compares this fingerprint and fails closed (discard + cold start) on a
 * mismatch instead of returning an incompatible warm worker.
 */
export const RPC_WORKER_FENCE_ENV_KEYS = Object.freeze([
  "UES_CHILD_PROCESS",
  "UES_CHILD_AGENT",
  "UES_CHILD_POLICY_SNAPSHOT_ID",
  "UES_CHILD_RUNTIME_EPOCH_ID",
  "UES_CHILD_EXECUTION_OWNER_TOKEN",
  "UES_CHILD_EXECUTION_OWNER_SCOPE",
  "UES_CHILD_OWNERSHIP_ROOT",
  "UES_CHILD_RUN_ID",
  "UES_CHILD_JOURNAL_ROOT",
  "UES_CHILD_ROLE",
  "UES_CHILD_WRITER",
])

export function rpcWorkerSpecFingerprint(spec = {}) {
  const env = spec?.env && typeof spec.env === "object" ? spec.env : {}
  const fence = RPC_WORKER_FENCE_ENV_KEYS.map((key) => [key, env[key] == null ? null : String(env[key])])
  return JSON.stringify({
    command: String(spec?.command || ""),
    args: Array.isArray(spec?.args) ? spec.args.map(String) : [],
    cwd: String(spec?.cwd || ""),
    fence,
  })
}

async function waitForProcessClose(proc, timeoutMs = 2_000) {
  if (!proc) return
  const delayAfterExitMs = process.platform === "win32" ? 75 : 0

  if (proc.exitCode !== null || proc.signalCode !== null) {
    if (delayAfterExitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayAfterExitMs))
    }
    return
  }

  await new Promise((resolve) => {
    let settled = false
    let timer = null
    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      proc.removeListener("close", finish)
      resolve()
    }
    // "close" fires after the process has exited and its stdio handles have
    // closed. That distinction matters on Windows, where removing the worker's
    // temporary cwd immediately after only "exit" can still fail with EBUSY.
    proc.once("close", finish)
    timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
  })

  if (delayAfterExitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayAfterExitMs))
  }
}

class RpcWorker {
  constructor(spec) {
    this.spec = spec
    this.proc = null
    this.buffer = ""
    this.stderr = ""
    this.pending = new Map()
    this.listeners = new Set()
    this.requestId = 0
    this.runs = 0
    this.dead = false
    this.active = false
    this.activeAbort = null
    this.lastActivityAt = 0
    this.tail = Promise.resolve()
  }

  async start() {
    if (this.proc && !this.dead) return
    const proc = spawn(this.spec.command, this.spec.args, {
      cwd: this.spec.cwd,
      env: this.spec.env || process.env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc = proc
    this.dead = false
    this.stderr = ""

    proc.stdout.on("data", (data) => {
      this.buffer += data.toString()
      const lines = this.buffer.split("\n")
      this.buffer = lines.pop() || ""
      for (const line of lines) this.handleLine(line)
    })
    proc.stderr.on("data", (data) => {
      if (this.stderr.length < 128 * 1024) this.stderr += data.toString()
    })
    proc.stdin.on("error", (error) => this.fail(new Error("Pi RPC stdin error: " + error.message)))
    proc.on("error", (error) => this.fail(error))
    proc.on("exit", (code, signal) => {
      this.fail(new Error(`Pi RPC worker exited code=${code} signal=${signal || "none"}\n${this.stderr}`))
    })

    // Probe readiness through the protocol rather than relying on an arbitrary sleep.
    await this.send({ type: "get_state" }, { timeoutMs: 30_000 })
  }

  handleLine(line) {
    if (!line.trim()) return
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return
    }
    if (event?.type === "response" && event?.id && this.pending.has(event.id)) {
      const request = this.pending.get(event.id)
      this.pending.delete(event.id)
      clearTimeout(request.timer)
      if (event.success === false) request.reject(new Error(event.error || event.message || "Pi RPC command failed"))
      else request.resolve(event)
      return
    }
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch {}
    }
  }

  fail(error) {
    if (this.dead) return
    this.dead = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const listener of [...this.listeners]) {
      try { listener({ type: "ues_rpc_worker_error", error: String(error?.message || error) }) } catch {}
    }
  }

  async send(body, options = {}) {
    await this.startIfNeededForSend(body)
    if (!this.proc?.stdin || this.dead) throw new Error("Pi RPC worker is not available")
    const id = "ues-" + (++this.requestId)
    const timeoutMs = clamp(options.timeoutMs, 30_000, 1000, 30 * 60_000)
    const payload = JSON.stringify({ id, ...body }) + "\n"
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi RPC command timeout: ${body.type}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.proc.stdin.write(payload, (error) => {
        if (!error) return
        const request = this.pending.get(id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  async startIfNeededForSend(body) {
    // start() itself probes with get_state, so allow that first write through.
    if (this.proc && !this.dead) return
    if (body?.type === "get_state" && this.proc && !this.dead) return
    if (!this.proc || this.dead) await this.start()
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async steer(message) {
    if (!this.proc || this.dead || !this.active) {
      return { accepted: false, reason: "worker-not-active" }
    }
    await this.send(
      { type: "steer", message: String(message || "") },
      { timeoutMs: RPC_CONTROL_TIMEOUT_MS },
    )
    return { accepted: true }
  }

  async followUp(message) {
    if (!this.proc || this.dead || !this.active) {
      return { accepted: false, reason: "worker-not-active" }
    }
    await this.send(
      { type: "follow_up", message: String(message || "") },
      { timeoutMs: RPC_CONTROL_TIMEOUT_MS },
    )
    return { accepted: true }
  }

  async getState() {
    if (!this.proc || this.dead) return null
    const response = await this.send(
      { type: "get_state" },
      { timeoutMs: RPC_CONTROL_TIMEOUT_MS },
    )
    return response?.data || null
  }

  async clearQueue() {
    if (!this.proc || this.dead) return { steering: [], followUp: [] }
    const response = await this.send(
      { type: "clear_queue" },
      { timeoutMs: RPC_CONTROL_TIMEOUT_MS },
    )
    return response?.data || { steering: [], followUp: [] }
  }

  async setModel(provider, modelId) {
    if (!this.proc || this.dead) throw new Error("Pi RPC worker is not available")
    const response = await this.send(
      { type: "set_model", provider: String(provider || ""), modelId: String(modelId || "") },
      { timeoutMs: RPC_CONTROL_TIMEOUT_MS },
    )
    return response?.data || null
  }

  async setThinkingLevel(level) {
    if (!this.proc || this.dead) throw new Error("Pi RPC worker is not available")
    await this.send(
      { type: "set_thinking_level", level: String(level || "") },
      { timeoutMs: RPC_CONTROL_TIMEOUT_MS },
    )
    return { level: String(level || "") }
  }

  async compact(customInstructions = "") {
    if (!this.proc || this.dead) throw new Error("Pi RPC worker is not available")
    const response = await this.send(
      {
        type: "compact",
        ...(String(customInstructions || "").trim()
          ? { customInstructions: String(customInstructions).trim() }
          : {}),
      },
      { timeoutMs: Math.max(RPC_CONTROL_TIMEOUT_MS, 5 * 60_000) },
    )
    return response?.data || null
  }

  async waitForIdle(timeoutMs = 30_000) {
    if (!this.proc || this.dead) {
      return { idle: true, state: null, reason: "worker-unavailable" }
    }
    const timeout = clamp(timeoutMs, 30_000, 500, 30 * 60_000)
    const deadline = Date.now() + timeout
    let state = await this.getState()
    let pollMs = 100

    while (
      state &&
      (
        state.isStreaming === true ||
        state.isCompacting === true ||
        Number(state.pendingMessageCount || 0) > 0
      )
    ) {
      if (Date.now() >= deadline) {
        return { idle: false, state, reason: "timeout" }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
      pollMs = Math.min(500, Math.max(100, Math.trunc(pollMs * 1.6)))
      state = await this.getState()
    }

    return { idle: true, state, reason: null }
  }

  async abortTransport() {
    if (!this.proc || this.dead) return false
    try {
      await this.send({ type: "abort" }, { timeoutMs: RPC_CONTROL_TIMEOUT_MS })
      return true
    } catch {
      const proc = this.proc
      terminateProcessTree(proc, { graceMs: 1000 })
      this.dead = true
      await waitForProcessClose(proc)
      return true
    }
  }

  async abort() {
    if (!this.proc || this.dead) return false
    if (typeof this.activeAbort === "function") {
      await this.activeAbort("aborted")
      return true
    }
    return this.abortTransport()
  }

  async stop() {
    const proc = this.proc
    if (!proc) return
    terminateProcessTree(proc, { graceMs: 500 })
    this.dead = true
    await waitForProcessClose(proc)
    if (this.proc === proc) this.proc = null
  }

  run(message, options = {}) {
    // Bind the timeout budget when the run is requested, not after queue/startup.
    // This prevents queue wait or RPC startup from silently granting a fresh
    // deadline after the caller already bounded the child to remaining run time.
    const requestedAt = Date.now()
    const timeoutPolicy = resolveRpcRunTimeouts(options)
    const requestedHardDeadlineAt = requestedAt + timeoutPolicy.hardTimeoutMs
    const requestedAbsoluteDeadlineAt = requestedAt + timeoutPolicy.absoluteHardTimeoutMs

    const execute = async () => {
      const startupRemainingMs = requestedHardDeadlineAt - Date.now()
      if (startupRemainingMs <= 0) {
        const error = new Error("UES RPC hard-timeout")
        error.code = "UES_RPC_TIMEOUT"
        error.uesRpcPhase = "startup"
        throw error
      }

      let startupTimer = null
      const startupTimeout = new Promise((_, reject) => {
        startupTimer = setTimeout(() => {
          const error = new Error("UES RPC hard-timeout")
          error.code = "UES_RPC_TIMEOUT"
          error.uesRpcPhase = "startup"
          reject(error)
        }, Math.max(1, startupRemainingMs))
        startupTimer.unref?.()
      })
      const startupWork = (async () => {
        await this.start()
        if (this.runs > 0 && options.reuseSession !== true) {
          await this.send({ type: "new_session" }, { timeoutMs: 30_000 })
        }
      })()
      startupWork.catch(() => {})
      try {
        await Promise.race([startupWork, startupTimeout])
      } catch (error) {
        if (error && typeof error === "object" && !error.uesRpcPhase) error.uesRpcPhase = "startup"
        if (error?.code === "UES_RPC_TIMEOUT") await this.stop().catch(() => {})
        throw error
      } finally {
        if (startupTimer) clearTimeout(startupTimer)
      }

      this.runs += 1
      this.stderr = ""

      const runStartedAt = Date.now()
      const hardTimeoutMs = Math.max(1, requestedHardDeadlineAt - runStartedAt)
      const absoluteHardTimeoutMs = Math.max(
        hardTimeoutMs,
        requestedAbsoluteDeadlineAt - runStartedAt,
      )
      const activityExtensionMs = clamp(
        options.activityExtensionMs,
        0,
        0,
        Math.max(hardTimeoutMs, absoluteHardTimeoutMs),
      )
      const deadlineBudgetMs = Math.max(1, hardTimeoutMs, absoluteHardTimeoutMs)
      const activityWindowMinMs = Math.min(1_000, deadlineBudgetMs)
      const activityWindowFallback = Math.min(
        deadlineBudgetMs,
        Math.max(activityWindowMinMs, Math.min(activityExtensionMs || hardTimeoutMs, 30_000)),
      )
      const activityWindowMs = clamp(
        options.activityWindowMs,
        activityWindowFallback,
        activityWindowMinMs,
        deadlineBudgetMs,
      )
      const idleTimeoutMs = clamp(options.idleTimeoutMs, 5 * 60_000, 10_000, 30 * 60_000)
      let lastActivityAt = runStartedAt
      const adaptiveDeadline = createAdaptiveDeadline({
        hardTimeoutMs,
        absoluteHardTimeoutMs,
        activityExtensionMs,
        activityWindowMs,
      }, runStartedAt)
      this.lastActivityAt = lastActivityAt
      this.active = true
      let finalMessage = null
      let partialAssistantMessage = null
      let toolCalls = 0
      let lastToolErrorAt = 0
      const toolNames = new Set()
      let settledResolve
      let settledReject
      const settled = new Promise((resolve, reject) => {
        settledResolve = resolve
        settledReject = reject
      })
      // The active run can be aborted while the prompt transport is still
      // completing, before execution reaches "await settled". Attach a handler
      // immediately so Node never reports a transient unhandled rejection;
      // awaiting the original promise below still preserves the rejection.
      settled.catch(() => {})

      let aborting = false
      const abortFor = async (reason) => {
        if (aborting) return
        aborting = true
        const error = new Error("UES RPC " + reason)
        error.partialMessage = partialAssistantMessage || finalMessage
        error.stderr = this.stderr
        error.toolCalls = toolCalls
        error.toolNames = [...toolNames]
        error.deadlineExtensions = adaptiveDeadline.extensions
        error.deadlineAt = adaptiveDeadline.deadlineAt
        error.absoluteDeadlineAt = adaptiveDeadline.absoluteAt
        error.code = String(reason || "").includes("timeout") ? "UES_RPC_TIMEOUT" : undefined
        // Settle with the rich timeout error before transport teardown can emit a
        // generic worker-exit error and win the race.
        settledReject(error)
        try { await this.abortTransport() } catch {}
      }
      this.activeAbort = abortFor

      let deadlineTimer = null
      const armDeadlineTimer = () => {
        if (deadlineTimer) clearTimeout(deadlineTimer)
        const delayMs = Math.max(1, adaptiveDeadline.deadlineAt - Date.now())
        deadlineTimer = setTimeout(() => {
          const decision = adaptiveDeadline.shouldAbort(Date.now(), lastActivityAt)
          if (decision.abort) {
            void abortFor(decision.reason || "hard-timeout")
          } else {
            armDeadlineTimer()
          }
        }, delayMs)
        deadlineTimer.unref?.()
      }
      armDeadlineTimer()

      const unsubscribe = this.onEvent((event) => {
        lastActivityAt = Date.now()
        this.lastActivityAt = lastActivityAt
        if (event?.message?.role === "assistant") {
          partialAssistantMessage = event.message
        }
        if (event.type === "tool_execution_start") {
          toolCalls += 1
          lastToolErrorAt = 0
          if (event.toolName) toolNames.add(String(event.toolName))
        }
        if (event.type === "tool_execution_end") {
          lastToolErrorAt = event.isError === true ? Date.now() : 0
        }
        if (event.type === "message_end" && event.message?.role === "assistant") {
          finalMessage = event.message
        }
        try {
          const decision = options.onEvent?.(event)
          if (decision?.abort === true) void abortFor(decision.reason || "event-abort")
        } catch {}
        if (event.type === "agent_settled" && !aborting) settledResolve()
        if (event.type === "ues_rpc_worker_error") settledReject(new Error(event.error || "RPC worker failed"))
      })

      const postToolErrorIdleTimeoutMs = clamp(
        options.postToolErrorIdleTimeoutMs,
        60_000,
        5_000,
        idleTimeoutMs,
      )
      const watchdogTimer = setInterval(() => {
        const now = Date.now()
        const threshold = lastToolErrorAt > 0
          ? Math.min(idleTimeoutMs, postToolErrorIdleTimeoutMs)
          : idleTimeoutMs
        if (now - lastActivityAt >= threshold) {
          void abortFor(lastToolErrorAt > 0 ? "post-tool-error-stall" : "idle-timeout")
          return
        }
        const deadline = adaptiveDeadline.shouldAbort(now, lastActivityAt)
        if (deadline.abort) {
          void abortFor(deadline.reason || "hard-timeout")
        }
      }, Math.max(10, Math.min(1000, hardTimeoutMs)))
      watchdogTimer.unref?.()

      const signal = options.signal
      const onAbort = () => void abortFor("aborted")
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }

      try {
        const promptSend = this.send(
          { type: "prompt", message },
          { timeoutMs: Math.max(1, Math.min(30_000, hardTimeoutMs)) },
        )
        promptSend.catch(() => {})
        await Promise.race([promptSend, settled])
        await promptSend
        await settled
        return {
          message: finalMessage,
          stderr: this.stderr,
          toolCalls,
          toolNames: [...toolNames],
          deadlineExtensions: adaptiveDeadline.extensions,
          deadlineAt: adaptiveDeadline.deadlineAt,
          absoluteDeadlineAt: adaptiveDeadline.absoluteAt,
        }
      } catch (error) {
        if (error && typeof error === "object") error.uesRpcPhase = "runtime"
        throw error
      } finally {
        this.active = false
        this.activeAbort = null
        clearInterval(watchdogTimer)
        if (deadlineTimer) clearTimeout(deadlineTimer)
        unsubscribe()
        if (signal) signal.removeEventListener("abort", onAbort)
      }
    }

    const promise = this.tail.then(execute, execute)
    this.tail = promise.catch(() => {})
    return promise
  }
}

export class PiRpcWorkerPool {
  constructor(options = {}) {
    this.maxWorkers = Math.max(1, Math.min(16, Number(options.maxWorkers || 8)))
    this.workers = new Map()
    this.reservations = new Map()
    // V16.17 (§5): the spec fingerprint each live worker was started for. The
    // pool reuses by KEY, but must FAIL CLOSED when a same-key run carries an
    // incompatible fencing spec: discard the warm worker and cold-start rather
    // than hand a run a worker built for a different ownership scope.
    this.workerSpecs = new Map()
    // V16.16 test boundary: production spawns real Pi workers; behavioral
    // tests inject a fake worker factory that counts starts without spawning.
    // The pool's key-based reuse logic itself is always the real one.
    this.createWorker = typeof options.createWorker === "function"
      ? options.createWorker
      : ((spec) => new RpcWorker(spec))
  }

  reserve(key) {
    this.reservations.set(key, (this.reservations.get(key) || 0) + 1)
  }

  release(key) {
    const next = Math.max(0, (this.reservations.get(key) || 0) - 1)
    if (next > 0) this.reservations.set(key, next)
    else this.reservations.delete(key)
  }

  /** Remove a tracked worker and its correctness metadata as one operation. */
  forgetWorker(key, expectedWorker = undefined) {
    const name = String(key || "")
    const current = this.workers.get(name)
    if (expectedWorker !== undefined && current !== expectedWorker) return null
    this.workers.delete(name)
    this.workerSpecs.delete(name)
    return current || null
  }

  async pruneIdleWorkers(protectedKey = null) {
    while (this.workers.size > this.maxWorkers) {
      let candidateKey = null
      let candidate = null
      for (const [key, worker] of this.workers.entries()) {
        if (key === protectedKey || this.reservations.has(key)) continue
        if (!worker || worker.dead) {
          candidateKey = key
          candidate = worker
          break
        }
        if (worker.active) continue
        candidateKey = key
        candidate = worker
        break
      }
      if (!candidateKey) break
      const removed = this.forgetWorker(candidateKey, candidate)
      await (removed || candidate)?.stop().catch(() => {})
    }
  }

  async run(key, spec, message, options = {}) {
    this.reserve(key)
    let worker = null
    let workerReused = false
    let staleStop = null

    try {
      worker = this.workers.get(key)
      // V16.17 (§5) FAIL-CLOSED ON SPEC MISMATCH: a worker is only reusable
      // when the fencing spec it was started for matches this run's spec. A
      // same-key/incompatible spec discards the warm worker (never a warm
      // reuse) so a run can never inherit another scope's env.
      if (worker && !worker.dead) {
        const liveFingerprint = this.workerSpecs.get(key) || null
        const wantedFingerprint = rpcWorkerSpecFingerprint(spec)
        if (liveFingerprint !== null && liveFingerprint !== wantedFingerprint) {
          this.forgetWorker(key, worker)
          await worker.stop().catch(() => {})
          worker = null
        }
      }
      // V16.16 honest warm reuse: a worker started by prewarm (process alive,
      // no runs yet) and reused by its run saves a full process start, so it
      // counts as warm exactly like a multi-run reuse. Only a real reuse of
      // the SAME key counts; anything else gets workerReused false.
      workerReused = Boolean(worker && !worker.dead && (worker.runs > 0 || worker.proc))
      if (options.reuseSession === true && !workerReused) {
        const error = new Error("Pi RPC same-session resume unavailable")
        error.code = "UES_RPC_SESSION_UNAVAILABLE"
        throw error
      }

      if (!worker || worker.dead) {
        const staleWorker = worker
        if (staleWorker) this.forgetWorker(key, staleWorker)

        // Publish the replacement synchronously before any await. Concurrent
        // callers for the same key must see this worker rather than allocate a
        // second untracked process while the stale worker is being reaped.
        worker = this.createWorker(spec)
        workerReused = false
        this.workers.set(key, worker)
        this.workerSpecs.set(key, rpcWorkerSpecFingerprint(spec))
        if (staleWorker) staleStop = staleWorker.stop().catch(() => {})
      } else {
        // Refresh insertion order so the bounded worker map behaves as an LRU.
        this.workers.delete(key)
        this.workers.set(key, worker)
      }

      // Queue the run before pruning. The reservation prevents another
      // concurrent key from treating this not-yet-active worker as idle during
      // the small window before RpcWorker.execute sets active=true.
      const runPromise = worker.run(message, options)
      await this.pruneIdleWorkers(key)
      if (staleStop) await staleStop

      const result = await runPromise
      return { ...result, workerReused }
    } catch (error) {
      if (worker && this.workers.get(key) === worker) {
        this.forgetWorker(key, worker)
        await worker.stop().catch(() => {})
      }
      await this.pruneIdleWorkers().catch(() => {})
      throw error
    } finally {
      this.release(key)
      await this.pruneIdleWorkers(key).catch(() => {})
    }
  }

  activeEntries() {
    return [...this.workers.entries()]
      .filter(([, worker]) => worker && !worker.dead && worker.active)
      .map(([key, worker]) => ({
        key,
        lastActivityAt: worker.lastActivityAt || 0,
      }))
  }

  /**
   * V16.16 RPC prewarm: start (or reuse) the worker for `key` through this
   * SAME pool, without running a prompt. The wave caller overlaps this with
   * sandbox creation / context build / test discovery, then `run()` reuses
   * the warm worker for the same key. A failed prewarm worker is stopped and
   * forgotten so no abandoned process survives.
   *
   * Retry reuses a worker only when the caller passes the same key for a
   * still-valid sandbox and runtime epoch; anything else gets a fresh worker
   * through `run()`. No stale prompt or context is ever reused: prewarm runs
   * no prompt at all.
   */
  async prewarm(key, spec) {
    const name = String(key || "")
    if (!name) throw new Error("Pi RPC prewarm requires a key")
    this.reserve(name)
    try {
      let worker = this.workers.get(name)
      if (worker && !worker.dead) {
        // V16.17 (§5) FAIL-CLOSED: a prewarm whose fencing spec differs from
        // the worker already warm under this key must NOT be treated as a
        // no-op reuse. Discard the incompatible worker and start a fresh one.
        const liveFingerprint = this.workerSpecs.get(name) || null
        const wantedFingerprint = rpcWorkerSpecFingerprint(spec)
        if (liveFingerprint !== null && liveFingerprint !== wantedFingerprint) {
          this.forgetWorker(name, worker)
          await worker.stop().catch(() => {})
          worker = null
        }
      }
      if (worker && !worker.dead) {
        // Refresh LRU order; an already-warm worker costs nothing.
        this.workers.delete(name)
        this.workers.set(name, worker)
        await this.pruneIdleWorkers(name)
        return { key: name, reused: true, prewarmed: true }
      }
      if (worker) {
        this.forgetWorker(name, worker)
        await worker.stop().catch(() => {})
      }
      worker = this.createWorker(spec)
      this.workers.set(name, worker)
      this.workerSpecs.set(name, rpcWorkerSpecFingerprint(spec))
      try {
        await worker.start()
      } catch (error) {
        if (this.workers.get(name) === worker) this.forgetWorker(name, worker)
        await worker.stop().catch(() => {})
        throw error
      }
      await this.pruneIdleWorkers(name)
      return { key: name, reused: false, prewarmed: true }
    } finally {
      this.release(name)
      await this.pruneIdleWorkers(name).catch(() => {})
    }
  }

  /** Stop and forget one worker (abandoned/failed prewarm cleanup). */
  async discard(key) {
    const name = String(key || "")
    const worker = this.forgetWorker(name)
    if (!worker) return { key: name, discarded: false, reason: "no-such-worker" }
    await worker.stop().catch(() => {})
    return { key: name, discarded: true }
  }

  selectSingleActive() {
    const active = [...this.workers.entries()]
      .filter(([, worker]) => worker && !worker.dead && worker.active)
    if (active.length !== 1) {
      return {
        ok: false,
        reason: active.length === 0 ? "no-active-worker" : "multiple-active-workers",
        active: active.length,
      }
    }
    const [key, worker] = active[0]
    return { ok: true, key, worker, active: 1 }
  }

  async controlActive(action, input = {}) {
    const name = String(action || "").trim().toLowerCase()
    if (name === "status") return { ok: true, action: name, ...this.status() }

    const selected = this.selectSingleActive()
    if (!selected.ok) return { ...selected, action: name }
    const { key, worker } = selected
    let data

    if (name === "get-state") {
      data = await worker.getState()
    } else if (name === "steer") {
      data = await worker.steer(input.message)
    } else if (name === "follow-up") {
      data = await worker.followUp(input.message)
    } else if (name === "abort") {
      data = { aborted: await worker.abort() }
    } else if (name === "clear-queue") {
      data = await worker.clearQueue()
    } else if (name === "set-model") {
      if (!String(input.provider || "").trim() || !String(input.modelId || "").trim()) {
        return { ok: false, action: name, reason: "provider-and-model-required", active: 1, key }
      }
      data = await worker.setModel(input.provider, input.modelId)
    } else if (name === "set-thinking") {
      if (!String(input.level || "").trim()) {
        return { ok: false, action: name, reason: "thinking-level-required", active: 1, key }
      }
      data = await worker.setThinkingLevel(input.level)
    } else if (name === "compact") {
      data = await worker.compact(input.customInstructions)
    } else if (name === "wait") {
      data = await worker.waitForIdle(input.timeoutMs)
    } else {
      return { ok: false, action: name, reason: "unknown-control-action", active: 1, key }
    }

    return { ok: true, action: name, key, active: 1, data }
  }

  async steerActive(message) {
    const result = await this.controlActive("steer", { message })
    if (!result.ok) {
      return {
        accepted: false,
        reason: result.reason,
        active: result.active || 0,
      }
    }
    return {
      accepted: result.data?.accepted !== false,
      key: result.key,
      active: 1,
    }
  }

  async followUpActive(message) {
    const result = await this.controlActive("follow-up", { message })
    if (!result.ok) {
      return {
        accepted: false,
        reason: result.reason,
        active: result.active || 0,
      }
    }
    return {
      accepted: result.data?.accepted !== false,
      key: result.key,
      active: 1,
    }
  }

  async abortActive() {
    const active = [...this.workers.values()]
      .filter((worker) => worker && !worker.dead && worker.active)
    const outcomes = await Promise.all(
      active.map((worker) => worker.abort().catch(() => false)),
    )
    return { aborted: outcomes.filter(Boolean).length }
  }

  async stopAll() {
    const workers = [...this.workers.values()]
    this.workers.clear()
    this.workerSpecs.clear()
    this.reservations.clear()
    await Promise.all(workers.map((worker) => worker.stop().catch(() => {})))
  }

  status() {
    const active = this.activeEntries()
    return {
      workers: this.workers.size,
      workerSpecs: this.workerSpecs.size,
      activeWorkers: active.length,
      reservedWorkers: this.reservations.size,
      keys: [...this.workers.keys()],
      active,
    }
  }
}
