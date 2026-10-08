import { toolConcurrencyContract } from "./tool-concurrency.mjs"
// V16.15: the isolated-write lane helpers. `toolConcurrencyContract` stays on the
// first line because it is this file's declared source-integrity prefix.
import { isolatedWriteOverlapAllowed, resolveIsolatedWriteWidth } from "./tool-concurrency.mjs"

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

/**
 * V16.15: the TRUSTED isolation declaration.
 *
 * It is read from the scheduler's own `options` argument (which the runtime
 * owning the sandbox passes), never from the tool input (which the model
 * authors). A model that puts `isolated: true` in its own arguments therefore
 * gets an ordinary serial write, not a promotion into the overlap lane.
 */
function trustedIsolation(options = {}) {
  const sandboxId = options.sandboxId ?? options.worktreeId
  if (options.isolated !== true && sandboxId == null) return {}
  return { isolated: true, sandboxId: sandboxId == null ? "" : String(sandboxId) }
}

export class ToolScheduler {
  constructor(options = {}) {
    this.maxParallelReads = boundedInt(options.maxParallelReads, 4, 1, 16)
    this.maxQueueMs = boundedInt(options.maxQueueMs, 30_000, 100, 5 * 60_000)
    // V16.15: the bounded isolated-write lane. Default 2, hard-capped at 3 by
    // `resolveIsolatedWriteWidth`, so a caller can lower it but never raise it.
    this.maxParallelIsolatedWrites = resolveIsolatedWriteWidth(options.maxParallelIsolatedWrites)
    this.active = new Map()
    this.queue = []
    this.metrics = {
      acquisitions: 0,
      queued: 0,
      released: 0,
      queueTimeouts: 0,
      totalQueueMs: 0,
      maxQueueMs: 0,
      maxQueueDepth: 0,
      maxActive: 0,
      // V16.15: measured overlap of the isolated-write lane. A count, never a
      // speed claim.
      maxObservedIsolatedWrites: 0,
    }
  }

  canStart(contract) {
    if (this.active.size === 0) return true
    if (contract?.parallelSafe !== true) {
      // V16.15: an isolated writer may join other isolated writers only.
      if (contract?.class !== "ISOLATED_WRITE") return false
      const isolatedActive = [...this.active.values()]
        .filter((row) => row.contract?.class === "ISOLATED_WRITE")
      if (isolatedActive.length !== this.active.size) return false
      if (isolatedActive.length >= this.maxParallelIsolatedWrites) return false
      return isolatedActive.every((row) => isolatedWriteOverlapAllowed(row.contract, contract))
    }
    if (this.active.size >= this.maxParallelReads) return false
    for (const row of this.active.values()) {
      if (row.contract?.parallelSafe !== true) return false
    }
    return true
  }

  tryAcquire(owner, toolName, input = {}, options = {}) {
    const id = String(owner || "").trim()
    if (!id) throw new Error("ToolScheduler.tryAcquire requires a non-empty owner")
    if (this.active.has(id) || this.queue.some((row) => row.owner === id)) {
      throw new Error("ToolScheduler owner already active or queued: " + id)
    }
    const contract = toolConcurrencyContract(toolName, input, trustedIsolation(options))
    if (!this.canStart(contract)) return null
    const requestedAt = Date.now()
    let lease = null
    this._start({
      owner: id,
      toolName: String(toolName || ""),
      input,
      contract,
      requestedAt,
      resolve: (value) => { lease = value },
      reject: () => {},
      timer: null,
    })
    return lease
  }

  acquire(owner, toolName, input = {}, options = {}) {
    const id = String(owner || "").trim()
    if (!id) throw new Error("ToolScheduler.acquire requires a non-empty owner")
    if (this.active.has(id) || this.queue.some((row) => row.owner === id)) {
      throw new Error("ToolScheduler owner already active or queued: " + id)
    }
    const contract = toolConcurrencyContract(toolName, input, trustedIsolation(options))
    const requestedAt = Date.now()
    const timeoutMs = boundedInt(options.maxQueueMs, this.maxQueueMs, 100, 5 * 60_000)

    return new Promise((resolve, reject) => {
      const entry = {
        owner: id,
        toolName: String(toolName || ""),
        input,
        contract,
        requestedAt,
        resolve,
        reject,
        timer: null,
      }
      entry.timer = setTimeout(() => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1)
        this.metrics.queueTimeouts += 1
        const error = new Error("UES tool scheduler queue timeout for " + entry.toolName)
        error.code = "UES_TOOL_QUEUE_TIMEOUT"
        reject(error)
        this._drain()
      }, timeoutMs)
      entry.timer.unref?.()

      this.queue.push(entry)
      this.metrics.maxQueueDepth = Math.max(this.metrics.maxQueueDepth, this.queue.length)
      this._drain()
    })
  }

  _start(entry) {
    if (entry.timer) clearTimeout(entry.timer)
    const startedAt = Date.now()
    const queuedMs = Math.max(0, startedAt - entry.requestedAt)
    this.active.set(entry.owner, {
      owner: entry.owner,
      toolName: entry.toolName,
      contract: entry.contract,
      requestedAt: entry.requestedAt,
      startedAt,
      queuedMs,
    })
    this.metrics.acquisitions += 1
    if (queuedMs > 0) this.metrics.queued += 1
    this.metrics.totalQueueMs += queuedMs
    this.metrics.maxQueueMs = Math.max(this.metrics.maxQueueMs, queuedMs)
    this.metrics.maxActive = Math.max(this.metrics.maxActive, this.active.size)
    // V16.15: measured isolated-write overlap inside this process.
    this.metrics.maxObservedIsolatedWrites = Math.max(
      this.metrics.maxObservedIsolatedWrites,
      [...this.active.values()].filter((row) => row.contract?.class === "ISOLATED_WRITE").length,
    )

    let released = false
    entry.resolve({
      schemaVersion: 1,
      owner: entry.owner,
      toolName: entry.toolName,
      contract: entry.contract,
      queuedMs,
      release: () => {
        if (released) return false
        released = true
        return this.release(entry.owner)
      },
    })
  }

  _drain() {
    while (this.queue.length) {
      const head = this.queue[0]
      if (!this.canStart(head.contract)) break
      this.queue.shift()
      this._start(head)
      // A serialized (root write / process / unknown) entry ends the drain: the
      // loop re-checks `canStart` for the next head, and nothing may join it. An
      // isolated write does NOT end the drain, so a second isolated writer can
      // take the free lane slot immediately.
      const drainable = head.contract?.parallelSafe === true
        || head.contract?.class === "ISOLATED_WRITE"
      if (!drainable) break
    }
  }

  release(owner) {
    const id = String(owner || "")
    if (!this.active.has(id)) return false
    this.active.delete(id)
    this.metrics.released += 1
    this._drain()
    return true
  }

  reset(reason = "scheduler-reset") {
    for (const entry of this.queue.splice(0)) {
      if (entry.timer) clearTimeout(entry.timer)
      const error = new Error("UES tool scheduler reset: " + reason)
      error.code = "UES_TOOL_SCHEDULER_RESET"
      entry.reject(error)
    }
    const active = this.active.size
    this.active.clear()
    this._drain()
    return { schemaVersion: 1, activeReleased: active, reason: String(reason) }
  }

  snapshot() {
    return {
      schemaVersion: 1,
      maxParallelReads: this.maxParallelReads,
      // V16.15: the bounded isolated-write lane, reported so a caller can prove
      // the configured width is the one it asked for.
      maxParallelIsolatedWrites: this.maxParallelIsolatedWrites,
      maxQueueMs: this.maxQueueMs,
      active: [...this.active.values()].map((row) => ({
        owner: row.owner,
        toolName: row.toolName,
        class: row.contract?.class || null,
        parallelSafe: row.contract?.parallelSafe === true,
        isolated: row.contract?.isolated === true,
        sandboxId: row.contract?.sandboxId || null,
        queuedMs: row.queuedMs,
      })),
      queued: this.queue.map((row) => ({
        owner: row.owner,
        toolName: row.toolName,
        class: row.contract?.class || null,
        parallelSafe: row.contract?.parallelSafe === true,
        isolated: row.contract?.isolated === true,
        queuedMs: Math.max(0, Date.now() - row.requestedAt),
      })),
      metrics: {
        ...this.metrics,
        averageQueueMs: this.metrics.acquisitions
          ? this.metrics.totalQueueMs / this.metrics.acquisitions
          : 0,
      },
    }
  }

  async withTool(owner, toolName, input, fn, options = {}) {
    const lease = await this.acquire(owner, toolName, input, options)
    try {
      return await fn(lease)
    } finally {
      lease.release()
    }
  }
}
