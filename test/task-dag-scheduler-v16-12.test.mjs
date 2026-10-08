// V16.12 Deterministic Task DAG Scheduler: behavior + hang regression tests.
//
// The scheduler's safety property is that a WRITE never overlaps anything, and
// its liveness property is that it ALWAYS terminates: every node ends in exactly
// one terminal state and the loop can never spin. The original implementation
// had a real bug - a STALE node was recorded but not settled, so the loop
// relaunched it forever. These tests pin the fix and the deadlock guard.

import test from "node:test"
import assert from "node:assert/strict"
import { getEventListeners } from "node:events"

import {
  TASK_DAG_POLICY,
  NODE_EFFECT,
  NODE_STATUS,
  RESOURCE_CLASS,
  planTaskDag,
  runTaskDag,
  isWriteEffect,
} from "../lib/task-dag-scheduler-v16-12.mjs"

const TERMINAL = new Set([
  NODE_STATUS.DONE,
  NODE_STATUS.FAILED,
  NODE_STATUS.CANCELLED,
  NODE_STATUS.STALE,
  NODE_STATUS.SKIPPED,
])

function assertAllTerminal(result) {
  for (const node of result.nodes) {
    assert.ok(TERMINAL.has(node.status), `node ${node.id} ended in non-terminal state ${node.status}`)
  }
  assert.equal(result.settledCount, result.totalCount, "every node must be settled exactly once")
}

test("task DAG policy id is byte-stable", () => {
  assert.equal(TASK_DAG_POLICY, "task-dag-scheduler-v16-12")
})

test("planTaskDag: deterministic topological order", () => {
  const plan = planTaskDag([
    { id: "c", effect: NODE_EFFECT.READ_ONLY, dependencies: ["a", "b"] },
    { id: "a", effect: NODE_EFFECT.READ_ONLY },
    { id: "b", effect: NODE_EFFECT.READ_ONLY },
  ])
  assert.deepEqual(plan.order, ["a", "b", "c"])
  assert.equal(plan.deterministic, true)
})

test("planTaskDag: a cycle is rejected fast (never hangs)", () => {
  assert.throws(() => planTaskDag([
    { id: "a", dependencies: ["b"] },
    { id: "b", dependencies: ["a"] },
  ]), /cycle/)
})

test("planTaskDag: an unknown dependency is rejected fast", () => {
  assert.throws(() => planTaskDag([{ id: "a", dependencies: ["ghost"] }]), /unknown/)
})

test("runTaskDag: dependencies run before dependents", async () => {
  const log = []
  const result = await runTaskDag([
    { id: "a", effect: NODE_EFFECT.READ_ONLY, run: async () => { log.push("a"); return 1 } },
    { id: "b", effect: NODE_EFFECT.READ_ONLY, dependencies: ["a"], run: async () => { log.push("b"); return 2 } },
    { id: "c", effect: NODE_EFFECT.READ_ONLY, dependencies: ["b"], run: async () => { log.push("c"); return 3 } },
  ])
  assert.deepEqual(log, ["a", "b", "c"])
  assert.equal(result.ok, true)
  assert.equal(result.counts.done, 3)
  assertAllTerminal(result)
})

test("runTaskDag: read-only nodes actually overlap", async () => {
  let active = 0
  let maxActive = 0
  const node = (id) => ({
    id,
    effect: NODE_EFFECT.READ_ONLY,
    run: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 25))
      active -= 1
      return id
    },
  })
  await runTaskDag([node("a"), node("b"), node("c")])
  assert.ok(maxActive >= 2, `expected overlap, saw maxActive=${maxActive}`)
})

test("runTaskDag: a SOURCE_WRITE never overlaps anything", async () => {
  let active = 0
  let writeActive = false
  let writeOverlapObserved = false
  const make = (id, effect) => ({
    id,
    effect,
    run: async () => {
      active += 1
      if (effect === NODE_EFFECT.SOURCE_WRITE) {
        writeActive = true
        if (active > 1) writeOverlapObserved = true
      } else if (writeActive) {
        writeOverlapObserved = true
      }
      await new Promise((r) => setTimeout(r, 20))
      if (effect === NODE_EFFECT.SOURCE_WRITE) writeActive = false
      active -= 1
      return id
    },
  })
  const result = await runTaskDag([
    make("r1", NODE_EFFECT.READ_ONLY),
    make("r2", NODE_EFFECT.READ_ONLY),
    make("w1", NODE_EFFECT.SOURCE_WRITE),
    make("r3", NODE_EFFECT.READ_ONLY),
  ])
  assert.equal(writeOverlapObserved, false, "a write must never overlap another node")
  assert.equal(isWriteEffect(NODE_EFFECT.SOURCE_WRITE), true)
  assert.equal(isWriteEffect(NODE_EFFECT.READ_ONLY), false)
  assertAllTerminal(result)
})

test("runTaskDag: a write waits for active reads, then runs alone", async () => {
  const events = []
  const result = await runTaskDag([
    { id: "r1", effect: NODE_EFFECT.READ_ONLY, run: async () => { events.push("r1:start"); await new Promise((r) => setTimeout(r, 30)); events.push("r1:end") } },
    { id: "w", effect: NODE_EFFECT.SOURCE_WRITE, dependencies: ["r1"], run: async () => { events.push("w:start"); events.push("w:end") } },
    { id: "r2", effect: NODE_EFFECT.READ_ONLY, run: async () => { events.push("r2:start"); await new Promise((r) => setTimeout(r, 5)); events.push("r2:end") } },
  ])
  const wStart = events.indexOf("w:start")
  // The write starts only after r1 ends, and no read starts while the write runs.
  assert.ok(events.indexOf("r1:end") < wStart, "write must wait for the active read")
  assert.equal(events[wStart + 1], "w:end", "nothing may run between write start and end")
  assertAllTerminal(result)
})

test("runTaskDag: reads cannot start while a write is active", async () => {
  let writeRunning = false
  let readStartedDuringWrite = false
  const result = await runTaskDag([
    { id: "w", effect: NODE_EFFECT.SOURCE_WRITE, run: async () => { writeRunning = true; await new Promise((r) => setTimeout(r, 30)); writeRunning = false } },
    { id: "r", effect: NODE_EFFECT.READ_ONLY, run: async () => { if (writeRunning) readStartedDuringWrite = true } },
  ])
  assert.equal(readStartedDuringWrite, false)
  assertAllTerminal(result)
})

test("runTaskDag: bounded concurrency is respected", async () => {
  let active = 0
  let maxActive = 0
  const nodes = Array.from({ length: 12 }, (_, i) => ({
    id: `n${i}`,
    effect: NODE_EFFECT.PROCESS_MUTATION,
    resource: RESOURCE_CLASS.SUBPROCESS,
    run: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 15))
      active -= 1
    },
  }))
  const result = await runTaskDag(nodes, { limits: { SUBPROCESS: 2 } })
  assert.ok(maxActive <= 2, `expected <=2 concurrent, saw ${maxActive}`)
  assertAllTerminal(result)
})

test("runTaskDag: a critical failure cancels its dependents", async () => {
  const ran = []
  const result = await runTaskDag([
    { id: "syntax", effect: NODE_EFFECT.PURE, run: async () => { throw new Error("boom") } },
    { id: "suite", effect: NODE_EFFECT.PROCESS_MUTATION, dependencies: ["syntax"], run: async () => { ran.push("suite") } },
    { id: "release", effect: NODE_EFFECT.PROCESS_MUTATION, dependencies: ["suite"], run: async () => { ran.push("release") } },
    { id: "indep", effect: NODE_EFFECT.READ_ONLY, run: async () => { ran.push("indep") } },
  ])
  assert.equal(result.ok, false)
  assert.deepEqual(ran, ["indep"], "a failed syntax gate must not still launch the suite")
  const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n.status]))
  assert.equal(byId.syntax, NODE_STATUS.FAILED)
  assert.ok([NODE_STATUS.CANCELLED, NODE_STATUS.SKIPPED].includes(byId.suite))
  assert.ok([NODE_STATUS.CANCELLED, NODE_STATUS.SKIPPED].includes(byId.release))
  assertAllTerminal(result)
})

test("runTaskDag: a failed dependency settles its dependent (no relaunch)", async () => {
  let dependents = 0
  const result = await runTaskDag([
    { id: "a", effect: NODE_EFFECT.READ_ONLY, run: async () => { throw new Error("nope") } },
    { id: "b", effect: NODE_EFFECT.READ_ONLY, dependencies: ["a"], run: async () => { dependents += 1 } },
  ])
  assert.equal(dependents, 0)
  assertAllTerminal(result)
  assert.ok([NODE_STATUS.SKIPPED, NODE_STATUS.CANCELLED].includes(result.nodes.find((n) => n.id === "b").status))
})

test("runTaskDag: a stale-generation result is discarded and settles (regression)", async () => {
  // This is the exact case that hung before: a STALE node was recorded but not
  // settled, so the loop relaunched it forever. It must terminate quickly now.
  const result = await runTaskDag([
    { id: "old", effect: NODE_EFFECT.READ_ONLY, generation: 1, run: async () => ({ fresh: false }) },
    { id: "new", effect: NODE_EFFECT.READ_ONLY, generation: 3, run: async () => ({ fresh: true }) },
  ], { workspaceGeneration: 2 })
  const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]))
  assert.equal(byId.old.status, NODE_STATUS.STALE)
  assert.equal(byId.old.value, null)
  assert.equal(byId.new.status, NODE_STATUS.DONE)
  assert.deepEqual(byId.new.value, { fresh: true })
  assertAllTerminal(result)
})

test("runTaskDag: abort settles all running and pending nodes", async () => {
  const controller = new AbortController()
  const started = []
  const promise = runTaskDag([
    { id: "slow", effect: NODE_EFFECT.READ_ONLY, run: async ({ signal }) => {
      started.push("slow")
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 500)
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")) }, { once: true })
      })
      return "done"
    } },
    { id: "pending", effect: NODE_EFFECT.READ_ONLY, dependencies: ["slow"], run: async () => { started.push("pending"); return 1 } },
  ], { signal: controller.signal, cancelAll: true })
  // Abort while "slow" is in flight.
  setTimeout(() => controller.abort("test-abort"), 15)
  const result = await promise
  assert.ok(started.includes("slow"), "the first node must have started")
  assert.ok(!started.includes("pending"), "a cancelled run must not start the dependent")
  assertAllTerminal(result)
})

test("runTaskDag: a rejected node leaves running.size at zero", async () => {
  const result = await runTaskDag([
    { id: "a", effect: NODE_EFFECT.READ_ONLY, run: async () => { throw new Error("x") } },
    { id: "b", effect: NODE_EFFECT.READ_ONLY, run: async () => 1 },
  ])
  assert.equal(result.counts.failed, 1)
  assert.equal(result.counts.done, 1)
  assertAllTerminal(result)
})

test("runTaskDag: a node timeout terminates deterministically", async () => {
  const result = await runTaskDag([
    { id: "hang", effect: NODE_EFFECT.READ_ONLY, timeoutMs: 25, run: async ({ signal }) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000)
        signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")) }, { once: true })
      })
    } },
  ])
  const row = result.nodes.find((n) => n.id === "hang")
  assert.equal(row.status, NODE_STATUS.FAILED)
  assert.equal(row.code, "DAG_NODE_TIMEOUT")
  assertAllTerminal(result)
})

test("runTaskDag: an unsatisfiable DAG fails fast, never hangs", async () => {
  // A node that can never start because its dependency is skipped.
  const result = await runTaskDag([
    { id: "a", effect: NODE_EFFECT.READ_ONLY, run: async () => { throw new Error("fail") } },
    { id: "b", effect: NODE_EFFECT.READ_ONLY, dependencies: ["a"], run: async () => 1 },
    { id: "c", effect: NODE_EFFECT.READ_ONLY, dependencies: ["b"], run: async () => 1 },
  ])
  assert.equal(result.counts.done, 0)
  assert.ok([NODE_STATUS.SKIPPED, NODE_STATUS.CANCELLED].includes(result.nodes.find((n) => n.id === "c").status))
  assertAllTerminal(result)
})

test("runTaskDag: 20 repeated runs leave no timer or listener leak", async () => {
  const before = getEventListeners(process, "uncaughtException").length
  for (let i = 0; i < 20; i += 1) {
    const result = await runTaskDag([
      { id: "r", effect: NODE_EFFECT.READ_ONLY, run: async () => { await new Promise((x) => setTimeout(x, 1)); return 1 } },
      { id: "t", effect: NODE_EFFECT.READ_ONLY, timeoutMs: 100, run: async () => 2 },
      { id: "w", effect: NODE_EFFECT.SOURCE_WRITE, dependencies: ["r"], run: async () => 3 },
    ])
    assertAllTerminal(result)
  }
  const after = getEventListeners(process, "uncaughtException").length
  assert.equal(after, before, "repeated runs must not leak process listeners")
})

test("runTaskDag: the deadlock guard reports DAG_DEADLOCK instead of spinning", async () => {
  // Force a no-progress state directly: a read node pinned to a resource whose
  // width is zero can never start, with nothing running.
  const result = await runTaskDag([
    { id: "blocked", effect: NODE_EFFECT.READ_ONLY, resource: RESOURCE_CLASS.FS_READ, run: async () => 1 },
  ], { limits: { FS_READ: 0 } })
  // FS_READ width 0 means the node can never start -> deterministic deadlock.
  assert.equal(result.ok, false)
  assert.ok(result.deadlock, "expected a DAG_DEADLOCK report")
  assert.equal(result.deadlock.code, "DAG_DEADLOCK")
  assertAllTerminal(result)
})

// ---------------------------------------------------------------------------
// V16.15: the ISOLATED-WRITE lane. A sandbox/worktree writer cannot be observed
// by a root read, so it may overlap reads and other isolated writers - but it is
// still fenced against a ROOT write in BOTH directions, and the lane is bounded.
// ---------------------------------------------------------------------------

test("runTaskDag: two ISOLATED_WRITE nodes overlap each other", async () => {
  let active = 0
  let maxActive = 0
  const node = (id) => ({
    id,
    effect: NODE_EFFECT.SOURCE_WRITE_ISOLATED,
    run: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 25))
      active -= 1
      return id
    },
  })
  const result = await runTaskDag([node("w1"), node("w2")])
  assert.ok(maxActive >= 2, `expected isolated writers to overlap, saw maxActive=${maxActive}`)
  assert.equal(result.maxIsolatedWriteActive, 2)
  assertAllTerminal(result)
})

test("runTaskDag: an ISOLATED_WRITE overlaps reads and stays inside its width", async () => {
  let readActive = 0
  let maxReadActive = 0
  let isolatedActive = 0
  let maxIsolatedActive = 0
  let readOverlappedIsolated = false
  // The read observes the lane WHILE it is running, not just at start: the
  // scheduler launches in plan order, so the reads begin first and the isolated
  // writers join them. Sampling at start alone would prove nothing.
  const sample = async () => {
    await new Promise((r) => setTimeout(r, 20))
    if (isolatedActive > 0) readOverlappedIsolated = true
  }
  const nodes = [
    { id: "r1", effect: NODE_EFFECT.READ_ONLY, run: async () => {
      readActive += 1
      maxReadActive = Math.max(maxReadActive, readActive)
      await sample()
      await new Promise((r) => setTimeout(r, 20))
      readActive -= 1
    } },
    { id: "r2", effect: NODE_EFFECT.READ_ONLY, run: async () => {
      readActive += 1
      maxReadActive = Math.max(maxReadActive, readActive)
      await sample()
      await new Promise((r) => setTimeout(r, 20))
      readActive -= 1
    } },
    ...["w1", "w2", "w3", "w4"].map((id) => ({
      id,
      effect: NODE_EFFECT.SOURCE_WRITE_ISOLATED,
      run: async () => {
        isolatedActive += 1
        maxIsolatedActive = Math.max(maxIsolatedActive, isolatedActive)
        await new Promise((r) => setTimeout(r, 25))
        isolatedActive -= 1
      },
    })),
  ]
  const result = await runTaskDag(nodes, { limits: { [RESOURCE_CLASS.ISOLATED_WRITE]: 2 } })
  assert.ok(readOverlappedIsolated, "an isolated writer must be allowed to overlap reads")
  assert.ok(maxReadActive >= 1)
  assert.ok(maxIsolatedActive <= 2, `isolated width must be honoured, saw ${maxIsolatedActive}`)
  assert.ok(result.maxIsolatedWriteActive <= 2)
  assertAllTerminal(result)
})

test("runTaskDag: an ISOLATED_WRITE never overlaps a ROOT write (both directions)", async () => {
  let rootWriteActive = false
  let isolatedActive = 0
  let violation = null
  const track = (id, effect) => ({
    id,
    effect,
    run: async () => {
      if (effect === NODE_EFFECT.SOURCE_WRITE) {
        if (isolatedActive > 0) violation = `${id} root write started while ${isolatedActive} isolated writer(s) ran`
        rootWriteActive = true
        await new Promise((r) => setTimeout(r, 30))
        rootWriteActive = false
      } else {
        if (rootWriteActive) violation = `${id} isolated writer started during a root write`
        isolatedActive += 1
        await new Promise((r) => setTimeout(r, 30))
        isolatedActive -= 1
      }
    },
  })
  const result = await runTaskDag([
    track("i1", NODE_EFFECT.SOURCE_WRITE_ISOLATED),
    track("i2", NODE_EFFECT.SOURCE_WRITE_ISOLATED),
    track("root", NODE_EFFECT.SOURCE_WRITE),
    track("r", NODE_EFFECT.READ_ONLY),
  ])
  assert.equal(violation, null, String(violation))
  assertAllTerminal(result)
})

test("planTaskDag: the isolated-write width cannot be raised past the hard cap", () => {
  const plan = planTaskDag([{ id: "a", effect: NODE_EFFECT.READ_ONLY }], {
    limits: { [RESOURCE_CLASS.ISOLATED_WRITE]: 99 },
  })
  assert.equal(plan.limits[RESOURCE_CLASS.ISOLATED_WRITE], 3)
  const lowered = planTaskDag([{ id: "a", effect: NODE_EFFECT.READ_ONLY }], {
    limits: { [RESOURCE_CLASS.ISOLATED_WRITE]: 1 },
  })
  assert.equal(lowered.limits[RESOURCE_CLASS.ISOLATED_WRITE], 1)
})

test("planTaskDag: isolated writers are reported separately from root writes", () => {
  const plan = planTaskDag([
    { id: "w", effect: NODE_EFFECT.SOURCE_WRITE },
    { id: "i", effect: NODE_EFFECT.SOURCE_WRITE_ISOLATED },
    { id: "r", effect: NODE_EFFECT.READ_ONLY },
  ])
  assert.deepEqual(plan.serialized, ["w"])
  assert.deepEqual(plan.isolatedWriters, ["i"])
  assert.deepEqual(plan.overlappable, ["i", "r"])
})

test("planTaskDag: isWriteEffect does not treat an isolated writer as a root write", async () => {
  const { isIsolatedWriteEffect, isAnyWriteEffect } = await import("../lib/task-dag-scheduler-v16-12.mjs")
  assert.equal(isWriteEffect(NODE_EFFECT.SOURCE_WRITE_ISOLATED), false)
  assert.equal(isIsolatedWriteEffect(NODE_EFFECT.SOURCE_WRITE_ISOLATED), true)
  assert.equal(isIsolatedWriteEffect(NODE_EFFECT.SOURCE_WRITE), false)
  assert.equal(isAnyWriteEffect(NODE_EFFECT.SOURCE_WRITE), true)
  assert.equal(isAnyWriteEffect(NODE_EFFECT.SOURCE_WRITE_ISOLATED), true)
  assert.equal(isAnyWriteEffect(NODE_EFFECT.READ_ONLY), false)
})
