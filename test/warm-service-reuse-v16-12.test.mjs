// V16.12 Warm Runtime Service Reuse: behavior tests.
//
// The registry must be LAZY (never always-on), BOUNDED (capacity + idle TTL),
// HEALTH-CHECKED (a bad handle is evicted, never silently reused), and
// SINGLE-FLIGHT (concurrent cold starts join one startup). These tests pin all
// four laws plus the honest metrics.

import test from "node:test"
import assert from "node:assert/strict"

import {
  WARM_SERVICE_POLICY,
  WARM_SERVICE_KIND,
  createWarmServiceRegistry,
} from "../lib/warm-service-reuse-v16-12.mjs"
import { PROVENANCE } from "../lib/measurement-provenance.mjs"

function makeClock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test("warm service policy id is byte-stable", () => {
  assert.equal(WARM_SERVICE_POLICY, "warm-service-reuse-v16-12")
})

test("a registry with no use starts NO service (never always-on)", async () => {
  let starts = 0
  const registry = createWarmServiceRegistry()
  const status = registry.status()
  assert.equal(status.active, 0)
  assert.equal(status.alwaysOn, false)
  assert.equal(starts, 0)
})

test("the first acquire cold-starts, the second reuses warm", async () => {
  let starts = 0
  const registry = createWarmServiceRegistry()
  try {
    const start = async () => { starts += 1; return { stop: async () => {} } }
    const a = await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "w1", start })
    const b = await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "w1", start })
    assert.equal(a.warm, false)
    assert.equal(b.warm, true)
    assert.equal(starts, 1, "the second acquire must reuse the warm instance")
    assert.equal(registry.status().metrics.coldStarts, 1)
    assert.equal(registry.status().metrics.warmHits, 1)
  } finally {
    await registry.shutdown()
  }
})

test("a warm handle that fails its health check is evicted, never reused", async () => {
  let starts = 0
  let healthy = true
  const registry = createWarmServiceRegistry()
  try {
    const start = async () => { starts += 1; return { stop: async () => {} } }
    const health = () => healthy
    await registry.acquire({ kind: WARM_SERVICE_KIND.BROWSER, key: "b1", start, health })
    healthy = false
    const second = await registry.acquire({ kind: WARM_SERVICE_KIND.BROWSER, key: "b1", start, health })
    assert.equal(second.warm, false, "a failed health check must force a fresh start")
    assert.equal(starts, 2)
    assert.equal(registry.status().metrics.healthFailures, 1)
  } finally {
    await registry.shutdown()
  }
})

test("noReuse forces a fresh instance", async () => {
  let starts = 0
  const registry = createWarmServiceRegistry()
  try {
    const start = async () => { starts += 1; return { stop: async () => {} } }
    await registry.acquire({ kind: WARM_SERVICE_KIND.RPC, key: "r1", start })
    const second = await registry.acquire({ kind: WARM_SERVICE_KIND.RPC, key: "r1", start, noReuse: true })
    assert.equal(second.warm, false)
    assert.equal(starts, 2)
  } finally {
    await registry.shutdown()
  }
})

test("concurrent cold starts for the same key are single-flight", async () => {
  let starts = 0
  const registry = createWarmServiceRegistry()
  try {
    const start = async () => { starts += 1; await new Promise((r) => setTimeout(r, 20)); return { stop: async () => {} } }
    const [a, b, c] = await Promise.all([
      registry.acquire({ kind: WARM_SERVICE_KIND.ADVISOR, key: "a1", start }),
      registry.acquire({ kind: WARM_SERVICE_KIND.ADVISOR, key: "a1", start }),
      registry.acquire({ kind: WARM_SERVICE_KIND.ADVISOR, key: "a1", start }),
    ])
    assert.equal(starts, 1, "concurrent first uses must join ONE startup")
    assert.ok(a.instance === b.instance && b.instance === c.instance)
    assert.ok(registry.status().metrics.startupsJoined >= 2)
  } finally {
    await registry.shutdown()
  }
})

test("capacity is bounded and evicts the least-recently-used service", async () => {
  const clock = makeClock()
  const stopped = []
  const registry = createWarmServiceRegistry({ now: clock.now, limits: { maxServices: 2, maxPerKey: 8 } })
  const start = (id) => async () => ({ stop: async () => { stopped.push(id) } })
  await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "s1", start: start("s1") })
  clock.advance(10)
  await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "s2", start: start("s2") })
  clock.advance(10)
  await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "s3", start: start("s3") })
  const status = registry.status()
  assert.ok(status.active <= 2, `expected <=2 active, saw ${status.active}`)
  assert.ok(stopped.includes("s1"), "the LRU service must be stopped")
  await registry.shutdown()
})

test("the per-kind cap bounds services of one kind", async () => {
  const registry = createWarmServiceRegistry({ limits: { maxServices: 8, maxPerKey: 1 } })
  try {
    const start = async () => ({ stop: async () => {} })
    await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "a", start })
    await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "b", start })
    const lspCount = registry.status().services.filter((s) => s.kind === WARM_SERVICE_KIND.LSP).length
    assert.ok(lspCount <= 1, `expected <=1 LSP service, saw ${lspCount}`)
  } finally {
    await registry.shutdown()
  }
})

test("idle services are evicted deterministically after the TTL", async () => {
  const clock = makeClock()
  const stopped = []
  const registry = createWarmServiceRegistry({ now: clock.now, limits: { idleTtlMs: 1000 } })
  await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "idle", start: async () => ({ stop: async () => { stopped.push("idle") } }) })
  assert.equal(registry.status().active, 1)
  clock.advance(1500)
  const evicted = registry.evictIdle()
  assert.equal(evicted, 1)
  assert.equal(registry.status().active, 0)
  assert.equal(registry.status().metrics.idleEvictions, 1)
  await registry.shutdown()
})

test("a healthy warm service is reused without restarting", async () => {
  let starts = 0
  const registry = createWarmServiceRegistry()
  try {
    const start = async () => { starts += 1; return { stop: async () => {} } }
    const health = async () => true
    await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "h1", start, health })
    const again = await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "h1", start, health })
    assert.equal(again.warm, true)
    assert.equal(again.healthChecked, true)
    assert.equal(starts, 1)
  } finally {
    await registry.shutdown()
  }
})

test("status reports honest provenance; saved latency is ESTIMATED, never MEASURED", async () => {
  const clock = makeClock()
  const registry = createWarmServiceRegistry({ now: clock.now })
  try {
    // Cold start takes 50ms; warm reuse takes ~0ms.
    await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "p", start: async () => { clock.advance(50); return { stop: async () => {} } } })
    await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "p", start: async () => { throw new Error("must not start") } })
    const status = registry.status()
    assert.equal(status.metrics.averageColdStartMs.provenance, PROVENANCE.MEASURED)
    assert.equal(status.metrics.estimatedSavedPerReuseMs.provenance, PROVENANCE.ESTIMATED)
    assert.equal(status.alwaysOn, false)
  } finally {
    await registry.shutdown()
  }
})

test("a startup that times out is bounded, never an infinite hang", async () => {
  const registry = createWarmServiceRegistry({ limits: { startupTimeoutMs: 50 } })
  try {
    await assert.rejects(
      () => registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "hang", start: async () => new Promise(() => {}) }),
      /timeout/,
    )
  } finally {
    await registry.shutdown()
  }
})

test("shutdown closes every warm service and reports zero remaining", async () => {
  const stopped = []
  const registry = createWarmServiceRegistry()
  const start = (id) => async () => ({ stop: async () => { stopped.push(id) } })
  await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "x", start: start("x") })
  await registry.acquire({ kind: WARM_SERVICE_KIND.CUSTOM, key: "y", start: start("y") })
  const result = await registry.shutdown()
  assert.equal(result.remaining, 0)
  assert.ok(stopped.includes("x") && stopped.includes("y"))
})

test("drop closes a specific service", async () => {
  let stopped = 0
  const registry = createWarmServiceRegistry()
  await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "d", start: async () => ({ stop: async () => { stopped += 1 } }) })
  assert.equal(await registry.drop(WARM_SERVICE_KIND.LSP, "d"), true)
  assert.equal(stopped, 1)
  assert.equal(registry.status().active, 0)
})

test("different kinds with the same key are distinct services", async () => {
  let starts = 0
  const registry = createWarmServiceRegistry()
  try {
    const start = async () => { starts += 1; return { stop: async () => {} } }
    await registry.acquire({ kind: WARM_SERVICE_KIND.LSP, key: "shared", start })
    await registry.acquire({ kind: WARM_SERVICE_KIND.BROWSER, key: "shared", start })
    assert.equal(starts, 2)
    assert.equal(registry.status().active, 2)
  } finally {
    await registry.shutdown()
  }
})
