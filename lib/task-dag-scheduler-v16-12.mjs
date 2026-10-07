// V16.12 Deterministic Task DAG Scheduler.
//
// WHY THIS MODULE EXISTS
//
// Independent deterministic work is executed serially today: repo intelligence,
// affected-test discovery, static diagnostics, read-only search and receipt
// lookup each wait for the previous one even though they touch no shared state.
// On a large task that serialization is pure wasted wall time.
//
// This module is the SINGLE V16.12 owner of safe overlap for deterministic work.
// It is deliberately small and conservative because the cost of a wrong overlap
// (a read racing a write and being treated as fresh) is far higher than the cost
// of a serialized read.
//
// EFFECT CLASSES
//
//   PURE               no I/O at all; trivially overlappable
//   READ_ONLY          reads the workspace; overlappable with other reads
//   CACHE_WRITE_SAFE   writes ONLY into an isolated cache namespace (never
//                      source); may overlap reads and other cache writes
//   SOURCE_WRITE       mutates source; NEVER overlaps anything but itself
//   PROCESS_MUTATION   spawns/mutates external processes (tests, compilers);
//                      runs in its own bounded lane and never overlaps a write
//
// LAWS
//
//   1. WRITES ARE SERIALIZED. At most ONE SOURCE_WRITE node runs at a time, and
//      no other node of ANY class overlaps it. This preserves the workspace
//      generation / Pre-write Fence invariant: a read can never observe a
//      half-written tree and be treated as fresh.
//   2. BOUNDED CONCURRENCY. Never an unbounded `Promise.all`. Each resource
//      class has an explicit width, and the scheduler never exceeds it.
//   3. DEPENDENCIES ARE ORDERED. A node runs only after every dependency has
//      completed successfully.
//   4. FAILURE CANCELS DEPENDENTS. A critical node failure aborts dependent work
//      via AbortController, so a failed syntax check does not still launch the
//      full suite and the release verifier.
//   5. LATE RESULTS ARE DISCARDED. A node tagged with a workspace generation
//      that is stale by the time it resolves is marked `stale` and its output is
//      not propagated.
//   6. NO LEAKS. Every node settles; timers and listeners are cleared.

import { measured, NOT_MEASURED } from "./measurement-provenance.mjs"

export const TASK_DAG_SCHEMA_VERSION = 1
export const TASK_DAG_POLICY = "task-dag-scheduler-v16-12"

export const NODE_EFFECT = Object.freeze({
  PURE: "PURE",
  READ_ONLY: "READ_ONLY",
  CACHE_WRITE_SAFE: "CACHE_WRITE_SAFE",
  SOURCE_WRITE: "SOURCE_WRITE",
  PROCESS_MUTATION: "PROCESS_MUTATION",
})

export const RESOURCE_CLASS = Object.freeze({
  CPU: "CPU",
  FS_READ: "FS_READ",
  CACHE: "CACHE",
  SUBPROCESS: "SUBPROCESS",
  WRITE: "WRITE",
})

export const NODE_STATUS = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  DONE: "done",
  FAILED: "failed",
  SKIPPED: "skipped",
  CANCELLED: "cancelled",
  STALE: "stale",
})

const EFFECT_RESOURCE = Object.freeze({
  [NODE_EFFECT.PURE]: RESOURCE_CLASS.CPU,
  [NODE_EFFECT.READ_ONLY]: RESOURCE_CLASS.FS_READ,
  [NODE_EFFECT.CACHE_WRITE_SAFE]: RESOURCE_CLASS.CACHE,
  [NODE_EFFECT.SOURCE_WRITE]: RESOURCE_CLASS.WRITE,
  [NODE_EFFECT.PROCESS_MUTATION]: RESOURCE_CLASS.SUBPROCESS,
})

const DEFAULT_LIMITS = Object.freeze({
  [RESOURCE_CLASS.CPU]: 4,
  [RESOURCE_CLASS.FS_READ]: 6,
  [RESOURCE_CLASS.CACHE]: 3,
  [RESOURCE_CLASS.SUBPROCESS]: 2,
  [RESOURCE_CLASS.WRITE]: 1,
})

/** A node is a write when its effect mutates source. */
export function isWriteEffect(effect) {
  return String(effect) === NODE_EFFECT.SOURCE_WRITE
}

/**
 * Validate a node declaration. Returns a normalized node or throws. Validation
 * is strict because a malformed node is a safety bug, not a style issue.
 */
export function normalizeNode(node = {}) {
  const id = String(node.id || "").trim()
  if (!id) throw new Error("task-dag: node id is required")
  const effect = String(node.effect || NODE_EFFECT.READ_ONLY)
  if (!Object.values(NODE_EFFECT).includes(/** @type {any} */ (effect))) throw new Error(`task-dag: unknown effect ${effect}`)
  const dependencies = Array.isArray(node.dependencies) ? node.dependencies.map(String) : []
  return {
    id,
    effect,
    resource: String(node.resource || EFFECT_RESOURCE[effect]),
    dependencies,
    critical: node.critical !== false,
    timeoutMs: Math.max(0, Number(node.timeoutMs || 0)),
    generation: node.generation == null ? null : Number(node.generation),
    run: typeof node.run === "function" ? node.run : null,
  }
}

/**
 * Plan an execution order from a node set. Pure: it computes a topological
 * order and the per-resource concurrency width, without running anything.
 * Throws on an unknown dependency or a cycle.
 */
export function planTaskDag(nodes = [], options = {}) {
  const normalized = nodes.map(normalizeNode)
  const byId = new Map(normalized.map((node) => [node.id, node]))
  if (byId.size !== normalized.length) throw new Error("task-dag: duplicate node id")

  for (const node of normalized) {
    for (const dep of node.dependencies) {
      if (!byId.has(dep)) throw new Error(`task-dag: node ${node.id} depends on unknown ${dep}`)
    }
  }

  // Deterministic topological order (stable by input order among ready nodes).
  const indegree = new Map(normalized.map((node) => [node.id, node.dependencies.length]))
  const order = []
  const ready = normalized.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const dependents = new Map(normalized.map((node) => [node.id, []]))
  for (const node of normalized) for (const dep of node.dependencies) dependents.get(dep).push(node.id)

  while (ready.length) {
    const id = ready.shift()
    order.push(id)
    for (const next of dependents.get(id)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
  }
  if (order.length !== normalized.length) throw new Error("task-dag: cycle detected")

  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
  return {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    policy: TASK_DAG_POLICY,
    order,
    nodes: normalized,
    limits,
    // A node that can overlap is any non-write node; writes always serialize.
    overlappable: normalized.filter((node) => !isWriteEffect(node.effect)).map((node) => node.id),
    serialized: normalized.filter((node) => isWriteEffect(node.effect)).map((node) => node.id),
    deterministic: true,
  }
}

/**
 * Execute a DAG with bounded, effect-aware concurrency.
 *
 * @param {object[]} nodes
 * @param {object} [options]
 * @param {object} [options.limits]           per-resource concurrency overrides
 * @param {AbortSignal} [options.signal]       external cancellation
 * @param {number} [options.workspaceGeneration] current generation; a node whose
 *   `generation` is lower at resolution time is marked stale
 * @param {(event: object) => void} [options.onEvent]
 */
export async function runTaskDag(nodes = [], options = {}) {
  const plan = planTaskDag(nodes, options)
  const byId = new Map(plan.nodes.map((node) => [node.id, node]))
  const limits = plan.limits
  const externalSignal = options.signal || null
  const controller = new AbortController()
  const onAbort = () => controller.abort(externalSignal?.reason || "external-abort")
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason || "external-abort")
    else externalSignal.addEventListener("abort", onAbort, { once: true })
  }

  const results = new Map()
  const running = new Map() // id -> Promise (self-deletes in .finally)
  const activeByResource = new Map()
  // TERMINAL-STATE MODEL. Every node ends in EXACTLY ONE of these. A node is
  // "settled" the moment it reaches one, and the scheduler NEVER relaunches a
  // settled node. (The original bug: a STALE node was recorded but not settled,
  // so the loop relaunched it forever.)
  const TERMINAL = new Set([NODE_STATUS.DONE, NODE_STATUS.FAILED, NODE_STATUS.CANCELLED, NODE_STATUS.STALE, NODE_STATUS.SKIPPED])
  const settled = new Set()
  const statusOf = new Map()
  const startedAt = Date.now()
  const emit = typeof options.onEvent === "function" ? options.onEvent : () => {}

  // One and only one terminal transition per node. Returns false if the node was
  // already settled (so a late timeout/abort can never double-settle).
  function settle(node, status, patch = {}) {
    if (settled.has(node.id)) return false
    settled.add(node.id)
    statusOf.set(node.id, status)
    results.set(node.id, { id: node.id, status, value: null, effect: node.effect, ...patch })
    emit({ type: `node.${status}`, id: node.id, ...(patch.reason ? { reason: patch.reason } : {}) })
    return true
  }

  function resourceActive(resource) {
    return activeByResource.get(resource) || 0
  }
  function acquire(resource) {
    activeByResource.set(resource, resourceActive(resource) + 1)
  }
  function release(resource) {
    activeByResource.set(resource, Math.max(0, resourceActive(resource) - 1))
  }

  function dependenciesSatisfied(node) {
    return node.dependencies.every((dep) => statusOf.get(dep) === NODE_STATUS.DONE)
  }
  // A dependency that did NOT produce a usable result (failed / cancelled /
  // stale / skipped) permanently blocks the dependent node.
  function dependencyUnsatisfiable(node) {
    return node.dependencies.some((dep) => {
      const status = statusOf.get(dep)
      return status != null && status !== NODE_STATUS.DONE
    })
  }

  // A write node can only start when NOTHING else is running. Any other node can
  // only start when NO write is running. This is the serialization law.
  function canStart(node) {
    const writeActive = resourceActive(RESOURCE_CLASS.WRITE) > 0
    if (isWriteEffect(node.effect)) {
      return [...activeByResource.values()].every((count) => count === 0)
    }
    if (writeActive) return false
    const resource = node.resource
    return resourceActive(resource) < (limits[resource] ?? 1)
  }

  function runNode(node) {
    const resource = node.resource
    acquire(resource)
    const nodeController = new AbortController()
    const onParentAbort = () => nodeController.abort(controller.signal.reason)
    if (controller.signal.aborted) nodeController.abort(controller.signal.reason)
    else controller.signal.addEventListener("abort", onParentAbort, { once: true })

    let timer = null
    let timedOut = false
    const timeout = node.timeoutMs > 0
      ? new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true
            nodeController.abort("timeout")
            reject(Object.assign(new Error(`task-dag: node ${node.id} timed out`), { code: "DAG_NODE_TIMEOUT" }))
          }, node.timeoutMs)
        })
      : null

    emit({ type: "node.start", id: node.id, effect: node.effect, resource })
    const execution = (async () => {
      if (!node.run) return null
      const work = node.run({ signal: nodeController.signal, node, id: node.id })
      return timeout ? await Promise.race([work, timeout]) : await work
    })()

    return execution
      .then((value) => {
        // Late-result guard: a node that declared a generation and resolves
        // after the workspace advanced is STALE; its output is NOT propagated.
        // STALE is a terminal state, so it can never be relaunched.
        const stale = node.generation != null && options.workspaceGeneration != null && node.generation < options.workspaceGeneration
        if (stale) {
          settle(node, NODE_STATUS.STALE, { value: null, provenance: NOT_MEASURED, reason: "workspace-generation-advanced" })
        } else {
          settle(node, NODE_STATUS.DONE, { value, provenance: measured(1) })
        }
        return results.get(node.id)
      })
      .catch((error) => {
        // A node that already reached a terminal state (e.g. it was settled as
        // CANCELLED by an abort sweep) must not be re-settled here.
        if (settled.has(node.id)) return results.get(node.id)
        const aborted = !timedOut && (nodeController.signal.aborted || controller.signal.aborted)
        if (timedOut) {
          settle(node, NODE_STATUS.FAILED, { error: String(error?.message || error), code: "DAG_NODE_TIMEOUT", critical: node.critical })
        } else if (aborted) {
          settle(node, NODE_STATUS.CANCELLED, { error: String(error?.message || error), reason: "aborted" })
        } else {
          settle(node, NODE_STATUS.FAILED, { error: String(error?.message || error), critical: node.critical })
        }
        // A critical failure cancels every remaining (dependent and, when
        // `cancelAll` is set, all) node. A failed syntax gate must not still
        // launch the full suite.
        if (node.critical && !aborted && !timedOut) {
          cancelRemaining(node.id, /** @type {any} */ (options).cancelAll === true)
        }
        return results.get(node.id)
      })
      .finally(() => {
        if (timer) clearTimeout(timer)
        controller.signal.removeEventListener("abort", onParentAbort)
        release(resource)
        running.delete(node.id)
      })
  }

  // Cancel every node that is not yet settled: dependents of `id` (and, when
  // cancelAll is set, everything still pending). Running nodes are cancelled via
  // the shared abort controller.
  function cancelRemaining(id, cancelAll) {
    for (const node of plan.nodes) {
      if (settled.has(node.id)) continue
      const dependent = node.dependencies.includes(id) || node.dependencies.some((dep) => statusOf.has(dep) && statusOf.get(dep) !== NODE_STATUS.DONE)
      if (dependent || cancelAll) {
        settle(node, NODE_STATUS.CANCELLED, { reason: "dependency-failed" })
      }
    }
    controller.abort("dependency-failed")
  }

  let deadlocked = false

  // Scheduling loop. Each iteration: propagate cancellation, launch everything
  // runnable, then await the next completion. The loop can ONLY exit by settling
  // every node; a no-progress state is a deterministic DAG_DEADLOCK, never a spin.
  while (true) {
    // 1. External/dependency abort sweep: settle anything not already running.
    if (controller.signal.aborted) {
      for (const node of plan.nodes) {
        if (!settled.has(node.id) && !running.has(node.id)) settle(node, NODE_STATUS.CANCELLED, { reason: "aborted" })
      }
    }
    // 2. Dependency-unsatisfiable sweep: a node whose dependency did not succeed
    //    can never run, so settle it SKIPPED now (terminal, no relaunch).
    for (const node of plan.nodes) {
      if (settled.has(node.id) || running.has(node.id)) continue
      if (dependencyUnsatisfiable(node)) settle(node, NODE_STATUS.SKIPPED, { reason: "dependency-not-satisfied" })
    }

    // 3. Launch every node that is ready and permitted.
    let launched = false
    for (const node of plan.nodes) {
      if (settled.has(node.id) || running.has(node.id)) continue
      if (!dependenciesSatisfied(node)) continue
      if (!canStart(node)) continue
      running.set(node.id, runNode(node))
      launched = true
    }

    // 4. Progress decision.
    if (running.size === 0) {
      const pending = plan.nodes.filter((node) => !settled.has(node.id))
      if (pending.length === 0) break
      if (!launched) {
        // DEADLOCK GUARD. Pending nodes remain, nothing is running and nothing
        // can start. This is deterministic (never a hang): every remaining node
        // is settled SKIPPED and the run is reported as a DAG_DEADLOCK failure.
        for (const node of pending) settle(node, NODE_STATUS.SKIPPED, { reason: "dag-deadlock" })
        deadlocked = true
        break
      }
      continue
    }

    // 5. Await the next completion. A node deletes itself from `running` in its
    //    `.finally`, which has run by the time this race resolves, so the next
    //    iteration sees an accurate active set. `Promise.race` resolves as soon
    //    as ANY node settles, guaranteeing forward progress while running > 0.
    await Promise.race([...running.values()])
  }

  if (externalSignal) externalSignal.removeEventListener("abort", onAbort)

  // Post-condition: EVERY node is in exactly one terminal state. Any node that
  // somehow did not settle is reported SKIPPED, never left PENDING.
  const rows = plan.nodes.map((node) => {
    const row = results.get(node.id)
    if (row && TERMINAL.has(row.status)) return row
    return { id: node.id, status: NODE_STATUS.SKIPPED, value: null, effect: node.effect, reason: "unsettled" }
  })
  const anyFailed = rows.some((row) => row.status === NODE_STATUS.FAILED)
  const counts = {
    done: rows.filter((row) => row.status === NODE_STATUS.DONE).length,
    failed: rows.filter((row) => row.status === NODE_STATUS.FAILED).length,
    cancelled: rows.filter((row) => row.status === NODE_STATUS.CANCELLED).length,
    stale: rows.filter((row) => row.status === NODE_STATUS.STALE).length,
    skipped: rows.filter((row) => row.status === NODE_STATUS.SKIPPED).length,
  }
  return {
    schemaVersion: TASK_DAG_SCHEMA_VERSION,
    policy: TASK_DAG_POLICY,
    ok: !anyFailed && !deadlocked,
    deadlock: deadlocked
      ? { code: "DAG_DEADLOCK", message: "pending nodes remain but none can start", nodes: rows.filter((row) => row.reason === "dag-deadlock").map((row) => row.id) }
      : null,
    nodes: rows,
    order: plan.order,
    limits,
    durationMs: Date.now() - startedAt,
    counts,
    // Invariant proof: the number of terminal nodes equals the node count.
    settledCount: settled.size,
    totalCount: plan.nodes.length,
  }
}

export const taskDagSchedulerExports = Object.freeze({
  planTaskDag,
  runTaskDag,
  normalizeNode,
  isWriteEffect,
  NODE_EFFECT,
  RESOURCE_CLASS,
  NODE_STATUS,
  DEFAULT_LIMITS,
})
