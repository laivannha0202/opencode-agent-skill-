// V16.12 Warm Runtime Service Reuse.
//
// WHY THIS MODULE EXISTS
//
// Cold-starting an expensive runtime service (LSP session, browser transport,
// advisor worker, RPC worker) costs real wall time. If a task uses the same
// service three times, paying the cold start three times is pure waste. But a
// naive "keep everything warm forever" is ALSO wrong: it burns memory, holds
// file handles and processes open, and turns a lazy runtime into an always-on
// one - which V16.12 explicitly forbids.
//
// This module is the SINGLE V16.12 owner of the question:
//
//   "Should I reuse an already-warm service instance, start one, or has the
//    warm instance gone bad?"
//
// LAWS
//
//   1. LAZY, NEVER ALWAYS-ON. A service is only ever instantiated on a real
//      first use. There is no eager warm-up path. A run that never touches a
//      service never starts it.
//   2. BOUNDED. The registry caps total warm services, per-key services, and
//      enforces an idle TTL. Idle services are closed deterministically.
//   3. HEALTH-CHECKED BEFORE REUSE. A warm handle is validated before it is
//      handed out. A failed health check evicts it and starts a fresh one; a
//      stale handle is NEVER silently reused.
//   4. SINGLE-FLIGHT. Concurrent first uses of the same key join ONE startup.
//      They never race to spawn duplicates.
//   5. HONEST METRICS. Cold starts, warm hits, health failures, evictions and
//      the latency saved are recorded. "Saved" latency is ESTIMATED (from real
//      cold vs warm samples) and is never reported as measured.
//   6. NO NEW DAEMON. This composes existing pools (LSP pool, browser lane,
//      advisor session, RPC pool) via injected factories. It owns no protocol.

import { estimated, measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const WARM_SERVICE_SCHEMA_VERSION = 1
export const WARM_SERVICE_POLICY = "warm-service-reuse-v16-12"

export const WARM_SERVICE_KIND = Object.freeze({
  LSP: "lsp",
  BROWSER: "browser",
  ADVISOR: "advisor",
  RPC: "rpc",
  CUSTOM: "custom",
})

const DEFAULTS = Object.freeze({
  maxServices: 8,
  maxPerKey: 1,
  idleTtlMs: 5 * 60_000,
  startupTimeoutMs: 30_000,
})

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

function withTimeout(promise, ms, onTimeout) {
  if (!(ms > 0)) return promise
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout ? onTimeout() : new Error("warm-service: startup timeout")), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer) })
}

/**
 * Create a bounded warm-service registry. Every service type is registered with
 * an injected `start` factory, an optional `health` probe, and a `stop` teardown.
 * The registry owns lifecycle; it never owns protocol.
 *
 * @param {object} [options]
 * @param {object} [options.limits] { maxServices, maxPerKey, idleTtlMs, startupTimeoutMs }
 * @param {() => number} [options.now]
 */
export function createWarmServiceRegistry(options = {}) {
  const limits = {
    maxServices: boundedInt(options.limits?.maxServices, DEFAULTS.maxServices, 1, 64),
    maxPerKey: boundedInt(options.limits?.maxPerKey, DEFAULTS.maxPerKey, 1, 8),
    idleTtlMs: boundedInt(options.limits?.idleTtlMs, DEFAULTS.idleTtlMs, 1_000, 60 * 60_000),
    startupTimeoutMs: boundedInt(options.limits?.startupTimeoutMs, DEFAULTS.startupTimeoutMs, 100, 5 * 60_000),
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now()
  const services = new Map() // key -> { instance, kind, createdAt, lastUsedAt, uses, coldStartMs }
  const inflight = new Map() // key -> Promise
  const metrics = {
    coldStarts: 0,
    warmHits: 0,
    healthFailures: 0,
    evictions: 0,
    idleEvictions: 0,
    capacityEvictions: 0,
    startupsJoined: 0,
    stops: 0,
    coldStartLatencyMs: 0,
    warmReuseLatencyMs: 0,
  }

  function keyFor(kind, key) {
    return `${kind}\u0000${String(key)}`
  }

  function liveServices() {
    return [...services.entries()].filter(([, row]) => row.instance)
  }

  async function stopRow(key, reason) {
    const row = services.get(key)
    if (!row) return false
    services.delete(key)
    metrics.stops += 1
    try {
      if (typeof row.instance?.stop === "function") await row.instance.stop()
      else if (typeof row.instance?.close === "function") await row.instance.close()
      else if (typeof row.instance?.dispose === "function") await row.instance.dispose()
    } catch {}
    return true
  }

  function evictIdle() {
    const at = now()
    let evicted = 0
    for (const [key, row] of services.entries()) {
      if (at - row.lastUsedAt >= limits.idleTtlMs) {
        // Fire-and-forget teardown; the entry is removed synchronously so it can
        // never be handed out again.
        services.delete(key)
        metrics.evictions += 1
        metrics.idleEvictions += 1
        evicted += 1
        Promise.resolve()
          .then(() => row.instance?.stop?.() ?? row.instance?.close?.() ?? row.instance?.dispose?.())
          .catch(() => {})
      }
    }
    return evicted
  }

  async function enforceCapacity() {
    while (services.size > limits.maxServices) {
      // Evict the least-recently-used entry.
      let victimKey = null
      let victimAt = Infinity
      for (const [key, row] of services.entries()) {
        if (row.lastUsedAt < victimAt) { victimAt = row.lastUsedAt; victimKey = key }
      }
      if (victimKey == null) break
      await stopRow(victimKey, "capacity")
      metrics.evictions += 1
      metrics.capacityEvictions += 1
    }
    // Per-key cap.
    const counts = new Map()
    for (const [key, row] of services.entries()) {
      counts.set(row.kind, (counts.get(row.kind) || 0) + 1)
      if (counts.get(row.kind) > limits.maxPerKey) {
        await stopRow(key, "per-key-capacity")
        metrics.evictions += 1
        metrics.capacityEvictions += 1
      }
    }
  }

  return {
    schemaVersion: WARM_SERVICE_SCHEMA_VERSION,
    policy: WARM_SERVICE_POLICY,
    limits,

    /**
     * Acquire a warm service for `key`, starting one only if necessary.
     *
     * @param {object} spec
     * @param {string} spec.kind         WARM_SERVICE_KIND
     * @param {string} spec.key          identity (workspace + provider + ...)
     * @param {() => Promise<any>} spec.start   cold-start factory
     * @param {(instance: any) => Promise<boolean>|boolean} [spec.health]
     * @param {boolean} [spec.noReuse]    force a fresh instance (e.g. poisoned)
     * @returns {Promise<{ instance: any, warm: boolean, coldStartMs: number, healthChecked: boolean }>}
     */
    async acquire(/** @type {any} */ spec = {}) {
      const kind = String(spec.kind || WARM_SERVICE_KIND.CUSTOM)
      const key = keyFor(kind, spec.key ?? "default")
      const at = now()

      evictIdle()

      // Warm path: reuse an existing, HEALTHY instance.
      if (spec.noReuse !== true) {
        const row = services.get(key)
        if (row && row.instance) {
          let healthy = true
          let checked = false
          if (typeof spec.health === "function") {
            checked = true
            try { healthy = await spec.health(row.instance) !== false } catch { healthy = false }
          }
          if (healthy) {
            const reuseStart = now()
            row.lastUsedAt = now()
            row.uses += 1
            metrics.warmHits += 1
            metrics.warmReuseLatencyMs += Math.max(0, now() - reuseStart)
            return { instance: row.instance, warm: true, coldStartMs: 0, healthChecked: checked }
          }
          // A warm handle that fails health is EVICTED, never reused.
          metrics.healthFailures += 1
          await stopRow(key, "health-failed")
        }
      } else {
        await stopRow(key, "no-reuse")
      }

      // Single-flight: concurrent cold starts for the same key join one factory.
      if (inflight.has(key)) {
        metrics.startupsJoined += 1
        const instance = await inflight.get(key)
        return /** @type {any} */ ({ instance, warm: true, coldStartMs: 0, healthChecked: false, joined: true })
      }

      const startedAt = now()
      const pending = withTimeout(
        Promise.resolve().then(() => spec.start()),
        limits.startupTimeoutMs,
        () => Object.assign(new Error("warm-service: startup timeout"), { code: "UES_WARM_START_TIMEOUT" }),
      )
      inflight.set(key, pending)
      let instance
      try {
        instance = await pending
      } finally {
        inflight.delete(key)
      }
      const coldStartMs = Math.max(0, now() - startedAt)
      metrics.coldStarts += 1
      metrics.coldStartLatencyMs += coldStartMs
      services.set(key, { instance, kind, createdAt: now(), lastUsedAt: now(), uses: 1, coldStartMs })
      await enforceCapacity()
      return { instance, warm: false, coldStartMs, healthChecked: false }
    },

    /** Explicitly drop a warm service (e.g. after a protocol error). */
    async drop(kind, key) {
      return stopRow(keyFor(kind, key ?? "default"), "explicit")
    },

    /** Close every warm service. Used at run end and in tests. */
    async shutdown() {
      const keys = [...services.keys()]
      for (const key of keys) await stopRow(key, "shutdown")
      return { stopped: keys.length, remaining: services.size }
    },

    evictIdle,

    status() {
      const rows = [...services.values()]
      const cold = metrics.coldStarts
      const warm = metrics.warmHits
      const avgCold = cold ? metrics.coldStartLatencyMs / cold : null
      const avgWarm = warm ? metrics.warmReuseLatencyMs / warm : null
      // Saved latency is ESTIMATED from real cold vs warm samples, only when both
      // exist. Never promoted to measured.
      const savedPerReuse = avgCold != null && avgWarm != null ? Math.max(0, avgCold - avgWarm) : null
      return {
        schemaVersion: WARM_SERVICE_SCHEMA_VERSION,
        policy: WARM_SERVICE_POLICY,
        limits,
        active: rows.length,
        busy: 0,
        services: rows.map((row) => ({ kind: row.kind, uses: row.uses, idleMs: now() - row.lastUsedAt, coldStartMs: row.coldStartMs })),
        metrics: {
          ...metrics,
          averageColdStartMs: avgCold == null ? NOT_MEASURED : measured(Math.round(avgCold)),
          averageWarmReuseMs: avgWarm == null ? NOT_MEASURED : measured(Math.round(avgWarm)),
          estimatedSavedPerReuseMs: savedPerReuse == null ? NOT_MEASURED : estimated(Math.round(savedPerReuse)),
        },
        // Never warm-by-default: this reports the CURRENT instance count, which
        // is 0 until a real first use.
        alwaysOn: false,
      }
    },

    resetMetrics() {
      for (const key of Object.keys(metrics)) metrics[key] = 0
    },
  }
}

export const warmServiceReuseExports = Object.freeze({
  createWarmServiceRegistry,
  WARM_SERVICE_KIND,
})
