import { spawn } from "node:child_process"
import { terminateProcessTree } from "./process-supervisor.mjs"

function clamp(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
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
      { timeoutMs: 15_000 },
    )
    return { accepted: true }
  }

  async abortTransport() {
    if (!this.proc || this.dead) return false
    try {
      await this.send({ type: "abort" }, { timeoutMs: 15_000 })
      return true
    } catch {
      terminateProcessTree(this.proc, { graceMs: 1000 })
      this.dead = true
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
    if (!this.proc) return
    terminateProcessTree(this.proc, { graceMs: 500 })
    this.dead = true
    this.proc = null
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
      const idleTimeoutMs = clamp(options.idleTimeoutMs, 5 * 60_000, 10_000, 30 * 60_000)
      let lastActivityAt = Date.now()
      this.lastActivityAt = lastActivityAt
      this.active = true
      let finalMessage = null
      let toolCalls = 0
      let lastToolErrorAt = 0
      const toolNames = new Set()
      let settledResolve
      let settledReject
      const settled = new Promise((resolve, reject) => {
        settledResolve = resolve
        settledReject = reject
      })

      let aborting = false
      const abortFor = async (reason) => {
        if (aborting) return
        aborting = true
        try { await this.abortTransport() } catch {}
        settledReject(new Error("UES RPC " + reason))
      }
      this.activeAbort = abortFor

      const unsubscribe = this.onEvent((event) => {
        lastActivityAt = Date.now()
        this.lastActivityAt = lastActivityAt
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

      const hardTimer = setTimeout(() => void abortFor("hard-timeout"), hardTimeoutMs)
      hardTimer.unref?.()
      const postToolErrorIdleTimeoutMs = clamp(
        options.postToolErrorIdleTimeoutMs,
        60_000,
        5_000,
        idleTimeoutMs,
      )
      const idleTimer = setInterval(() => {
        const now = Date.now()
        const threshold = lastToolErrorAt > 0 ? Math.min(idleTimeoutMs, postToolErrorIdleTimeoutMs) : idleTimeoutMs
        if (now - lastActivityAt >= threshold) {
          void abortFor(lastToolErrorAt > 0 ? "post-tool-error-stall" : "idle-timeout")
        }
      }, 1000)
      idleTimer.unref?.()

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
        }
      } catch (error) {
        if (error && typeof error === "object") error.uesRpcPhase = "runtime"
        throw error
      } finally {
        this.active = false
        this.activeAbort = null
        clearTimeout(hardTimer)
        clearInterval(idleTimer)
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

  async run(key, spec, message, options = {}) {
    let worker = this.workers.get(key)
    let workerReused = Boolean(worker && !worker.dead && worker.runs > 0)
    if (!worker || worker.dead) {
      if (worker) await worker.stop().catch(() => {})
      worker = new RpcWorker(spec)
      workerReused = false
      this.workers.set(key, worker)
      while (this.workers.size > this.maxWorkers) {
        const oldestKey = this.workers.keys().next().value
        if (!oldestKey || oldestKey === key) break
        const oldest = this.workers.get(oldestKey)
        this.workers.delete(oldestKey)
        await oldest?.stop().catch(() => {})
      }
    } else {
      // Refresh insertion order so the bounded worker map behaves as an LRU.
      this.workers.delete(key)
      this.workers.set(key, worker)
    }

    try {
      const result = await worker.run(message, options)
      return { ...result, workerReused }
    } catch (error) {
      this.workers.delete(key)
      await worker.stop().catch(() => {})
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

  async steerActive(message) {
    const active = [...this.workers.entries()]
      .filter(([, worker]) => worker && !worker.dead && worker.active)
    if (active.length !== 1) {
      return {
        accepted: false,
        reason: active.length === 0 ? "no-active-worker" : "multiple-active-workers",
        active: active.length,
      }
    }
    const [key, worker] = active[0]
    const result = await worker.steer(message)
    return { ...result, key, active: 1 }
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