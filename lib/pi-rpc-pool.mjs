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
      await new Promise((resolve) => setTimeout(resolve, 100))
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
    const execute = async () => {
      try {
        await this.start()
        if (this.runs > 0) {
          await this.send({ type: "new_session" }, { timeoutMs: 30_000 })
        }
      } catch (error) {
        if (error && typeof error === "object") error.uesRpcPhase = "startup"
        throw error
      }
      this.runs += 1
      this.stderr = ""

      const hardTimeoutMs = clamp(options.hardTimeoutMs, 30 * 60_000, 30_000, 2 * 60 * 60_000)
      const absoluteHardTimeoutMs = clamp(
        options.absoluteHardTimeoutMs,
        hardTimeoutMs,
        hardTimeoutMs,
        2 * 60 * 60_000,
      )
      const activityExtensionMs = clamp(
        options.activityExtensionMs,
        0,
        0,
        Math.max(hardTimeoutMs, absoluteHardTimeoutMs),
      )
      const activityWindowMs = clamp(
        options.activityWindowMs,
        Math.max(5_000, Math.min(activityExtensionMs || hardTimeoutMs, 30_000)),
        1_000,
        Math.max(hardTimeoutMs, absoluteHardTimeoutMs),
      )
      const idleTimeoutMs = clamp(options.idleTimeoutMs, 5 * 60_000, 10_000, 30 * 60_000)
      const runStartedAt = Date.now()
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
        // Settle with the rich timeout error before transport teardown can emit a
        // generic worker-exit error and win the race.
        settledReject(error)
        try { await this.abortTransport() } catch {}
      }
      this.activeAbort = abortFor

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
      }, 1000)
      watchdogTimer.unref?.()

      const signal = options.signal
      const onAbort = () => void abortFor("aborted")
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }

      try {
        await this.send({ type: "prompt", message }, { timeoutMs: 30_000 })
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
  }

  async pruneIdleWorkers(protectedKey = null) {
    while (this.workers.size > this.maxWorkers) {
      let candidateKey = null
      let candidate = null
      for (const [key, worker] of this.workers.entries()) {
        if (key === protectedKey) continue
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
      this.workers.delete(candidateKey)
      await candidate?.stop().catch(() => {})
    }
  }

  async run(key, spec, message, options = {}) {
    let worker = this.workers.get(key)
    let workerReused = Boolean(worker && !worker.dead && worker.runs > 0)
    if (!worker || worker.dead) {
      if (worker) {
        await worker.stop().catch(() => {})
        this.workers.delete(key)
      }
      worker = new RpcWorker(spec)
      workerReused = false
      this.workers.set(key, worker)
      await this.pruneIdleWorkers(key)
    } else {
      // Refresh insertion order so the bounded worker map behaves as an LRU.
      this.workers.delete(key)
      this.workers.set(key, worker)
    }

    try {
      const result = await worker.run(message, options)
      await this.pruneIdleWorkers(key)
      return { ...result, workerReused }
    } catch (error) {
      this.workers.delete(key)
      await worker.stop().catch(() => {})
      await this.pruneIdleWorkers().catch(() => {})
      throw error
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
    await Promise.all(workers.map((worker) => worker.stop().catch(() => {})))
  }

  status() {
    const active = this.activeEntries()
    return {
      workers: this.workers.size,
      activeWorkers: active.length,
      keys: [...this.workers.keys()],
      active,
    }
  }
}