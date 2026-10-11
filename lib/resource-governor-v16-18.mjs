// ---------------------------------------------------------------------------
// V16.18 GLOBAL RESOURCE GOVERNOR.
//
// WHY THIS EXISTS
//
// Before this release every concurrency-bearing subsystem resolved its own local
// maximum independently: the test runner, the RPC worker pool, the subagent
// fleet, the LSP pool, the semantic index, the writer lane, the browser lane and
// the service manager could all reach their own ceiling at the same moment. On a
// Windows host that is textbook oversubscription: each owner believes it is
// within budget while the machine is not.
//
// WHAT THIS IS NOT
//
// This is NOT a scheduler and it does NOT replace any subsystem owner. It does
// not run work, reorder queues, or decide what should happen. It is a LEASE
// COORDINATOR that answers one question for existing owners: "may I start ONE
// more unit of class X right now, given everything else that is running?".
//
// LAWS
//
//   1. A LEASE IS NEVER WRITTEN WITHOUT A CLASS. `withLease()` requires an
//      explicit class; an unknown class is refused rather than assumed cheap.
//   2. GLOBAL CAPS RESOLVE NESTING. A unit held by a parent never lets a child
//      exceed the class ceiling, because the ceiling is GLOBAL, not per-owner.
//      Nested oversubscription is therefore structurally impossible.
//   3. RE-ENTRANCY IS DEPTH, NOT WIDTH. The same logical task may nest leases of
//      the same class (a verifier inside a run) and consumes ONE unit, not two.
//      That is what keeps the governor deadlock-free: no task can deadlock
//      against itself, and unrelated tasks queue FIFO and are woken on release.
//   4. EVERY EXIT RELEASES. Success, throw, abort and timeout all release, and a
//      release is idempotent so a double release can never free someone else's
//      unit. A throw releases the unit BEFORE the error leaves the governor.
//   5. NOTHING IS RAISED BY THE GOVERNOR. It can only NARROW. Existing
//      per-subsystem limits stand; this module adds a shared ceiling, and each
//      owner keeps choosing its own local limit (respecting current Windows
//      evidence). Nobody may exceed these caps by asking.
//   6. METRICS ARE TRUTHFUL. `state()` reports counted live/waiting/peak/refused/
//      timeout/abort values, never a guess.
// ---------------------------------------------------------------------------

export const RESOURCE_CLASS = Object.freeze({
  CPU_HEAVY: "CPU_HEAVY",
  IO_HEAVY: "IO_HEAVY",
  MODEL_CHILD: "MODEL_CHILD",
  WRITER: "WRITER",
  LSP: "LSP",
  BROWSER: "BROWSER",
  SERVICE: "SERVICE",
})

export const RESOURCE_GOVERNOR_POLICY = "global-resource-governor-v16-18"
export const RESOURCE_GOVERNOR_SCHEMA_VERSION = 1

/**
 * Conservative global ceilings. They are CEILINGS: an owner may set a lower
 * local limit and the governor honours it, but no owner may exceed these. The
 * numbers deliberately match the current conservative Windows evidence (a small
 * child fleet, a single writer lane, a handful of heavy streams) and are never
 * raised by this module.
 */
export const RESOURCE_GOVERNOR_CAPS = Object.freeze({
  [RESOURCE_CLASS.CPU_HEAVY]: 3,
  [RESOURCE_CLASS.IO_HEAVY]: 6,
  [RESOURCE_CLASS.MODEL_CHILD]: 3,
  [RESOURCE_CLASS.WRITER]: 1,
  [RESOURCE_CLASS.LSP]: 2,
  [RESOURCE_CLASS.BROWSER]: 1,
  [RESOURCE_CLASS.SERVICE]: 2,
})

/** Classes the governor can govern. */
export const RESOURCE_GOVERNOR_CLASSES = Object.freeze(Object.keys(RESOURCE_GOVERNOR_CAPS))

function clock() {
  return Date.now()
}

/**
 * Create a governor. Pure in-process state, no timers kept alive, no process
 * handles: an abandoned governor is garbage-collected with its waiters.
 */
export function createResourceGovernor(options = {}) {
  const overrides = options.caps && typeof options.caps === "object" ? options.caps : {}
  const caps = { ...RESOURCE_GOVERNOR_CAPS, ...overrides }
  const defaultTimeoutMs = Math.max(1, Number(options.defaultTimeoutMs || 30_000))
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs || 5))

  const held = new Map()
  const heldByTask = new Map()
  const waiters = new Map()
  const peak = new Map()
  for (const cls of Object.keys(caps)) {
    held.set(cls, new Map())
    heldByTask.set(cls, new Map())
    waiters.set(cls, new Set())
    peak.set(cls, 0)
  }

  let leaseSeq = 0
  let admitted = 0
  let refused = 0
  let timedOut = 0
  let aborted = 0
  let waitMsTotal = 0
  let peakWaiters = 0

  function live(cls) {
    return held.get(cls)?.size || 0
  }

  function tryAcquire(cls, taskId, units, meta) {
    const owner = held.get(cls)
    const byTask = heldByTask.get(cls)
    if (!owner || !byTask) return { ok: false, reason: "unknown-class" }
    // LAW 3: re-entrancy is DEPTH, not WIDTH. The same logical task nesting the
    // same class consumes one unit, not two -- which is exactly why the governor
    // can never deadlock against itself.
    const existing = byTask.get(taskId)
    if (existing) {
      existing.depth += 1
      return { ok: true, lease: existing }
    }
    const want = Math.max(1, Math.trunc(Number(units || 1)))
    if (live(cls) + want > caps[cls]) return { ok: false, reason: "at-cap" }
    leaseSeq += 1
    const lease = {
      id: `lease-${cls}-${leaseSeq}`,
      cls,
      taskId,
      units: want,
      depth: 1,
      acquiredAt: clock(),
      meta: meta && typeof meta === "object" ? meta : {},
      released: false,
    }
    owner.set(lease.id, lease)
    byTask.set(taskId, lease)
    admitted += 1
    peak.set(cls, Math.max(peak.get(cls) || 0, live(cls)))
    return { ok: true, lease }
  }

  function release(lease) {
    if (!lease || lease.released === true) return false
    if (lease.depth > 1) {
      lease.depth -= 1
      return false
    }
    const owner = held.get(lease.cls)
    const byTask = heldByTask.get(lease.cls)
    if (!owner || !owner.has(lease.id)) return false
    owner.delete(lease.id)
    if (byTask?.get(lease.taskId) === lease) byTask.delete(lease.taskId)
    lease.released = true
    // Wake the FIFO head for this class. Progress is guaranteed because a release
    // always notifies, and every waiter re-tries on its own deadline.
    const queue = waiters.get(lease.cls)
    const head = queue?.values().next().value
    if (head) {
      queue.delete(head)
      head()
    }
    return true
  }

  function sleep(ms, signal) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener("abort", onAbort)
        resolve()
      }
      const onAbort = () => done()
      const timer = setTimeout(done, ms)
      if (signal) {
        if (signal.aborted) {
          done()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })
  }

  return {
    schemaVersion: RESOURCE_GOVERNOR_SCHEMA_VERSION,
    policy: RESOURCE_GOVERNOR_POLICY,
    caps: { ...caps },

    /** Current live unit count for a class. */
    live(cls) {
      return live(String(cls || "").toUpperCase())
    },

    /** Remaining headroom for a class. */
    headroom(cls) {
      const klass = String(cls || "").toUpperCase()
      const owner = held.get(klass)
      if (!owner) return 0
      return Math.max(0, caps[klass] - live(klass))
    },

    /** Whether a lease of this class/units could be granted without waiting. */
    canAdmit(cls, units = 1) {
      const klass = String(cls || "").toUpperCase()
      const owner = held.get(klass)
      if (!owner) return false
      return live(klass) + Math.max(1, Math.trunc(Number(units || 1))) <= caps[klass]
    },

    /** Acquire a lease and await it. Resolves null on timeout/abort/unknown class. */
    async acquire(cls, input = {}) {
      const klass = String(cls || "").toUpperCase()
      const units = Math.max(1, Math.trunc(Number(input.units || 1)))
      const taskId = String(input.taskId || "anonymous")
      const timeoutMs = Math.max(1, Number(input.timeoutMs || defaultTimeoutMs))
      const signal = input.signal instanceof AbortSignal ? input.signal : null
      if (signal?.aborted) {
        aborted += 1
        return null
      }
      const started = clock()
      let attempt = tryAcquire(klass, taskId, units, input.meta)
      while (!attempt.ok) {
        if (attempt.reason === "unknown-class") {
          refused += 1
          return null
        }
        if (clock() - started >= timeoutMs) {
          timedOut += 1
          return null
        }
        if (signal?.aborted) {
          aborted += 1
          return null
        }
        const queue = waiters.get(klass)
        let wake
        const waiting = new Promise((resolve) => { wake = resolve })
        queue?.add(wake)
        peakWaiters = Math.max(peakWaiters, queue?.size || 0)
        await Promise.race([waiting, sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (clock() - started))), signal)])
        queue?.delete(wake)
        attempt = tryAcquire(klass, taskId, units, input.meta)
      }
      waitMsTotal += clock() - started
      return attempt.lease
    },

    /** Release one lease. Idempotent. */
    release(lease) {
      return release(lease)
    },

    /**
     * Run `fn` under a lease of `cls`. Every exit path releases; a throw releases
     * BEFORE the error leaves the governor. When no lease can be granted the
     * work never runs and `{ ok:false }` is returned, so nothing executes out of
     * budget. What a refusal MEANS (fail open, queue, or stop) stays the caller's
     * decision, exactly as the rest of the runtime does with a missing provider.
     */
    async withLease(cls, fn, input = {}) {
      const lease = await this.acquire(cls, input)
      if (!lease) {
        const klass = String(cls || "").toUpperCase()
        return {
          ok: false,
          cls: klass,
          reason: held.has(klass) ? (input.signal?.aborted ? "aborted" : "timeout") : "unknown-class",
        }
      }
      const started = clock()
      try {
        const result = await fn(lease)
        return { ok: true, cls: lease.cls, lease: lease.id, waitedMs: lease.acquiredAt - started, result }
      } finally {
        release(lease)
      }
    },

    /** Truthful, counted metrics. Nothing here is estimated. */
    state() {
      const rows = {}
      for (const cls of Object.keys(caps)) {
        rows[cls] = {
          cap: caps[cls],
          live: live(cls),
          waiting: waiters.get(cls)?.size || 0,
          peak: peak.get(cls) || 0,
          headroom: Math.max(0, caps[cls] - live(cls)),
        }
      }
      return {
        schemaVersion: RESOURCE_GOVERNOR_SCHEMA_VERSION,
        policy: RESOURCE_GOVERNOR_POLICY,
        classes: rows,
        admitted,
        refused,
        timedOut,
        aborted,
        peakWaiters,
        waitMsTotal,
        leases: [...held.values()].reduce((sum, map) => sum + map.size, 0),
      }
    },
  }
}

export const RESOURCE_GOVERNOR_EXPORTS = Object.freeze([
  "RESOURCE_CLASS",
  "RESOURCE_GOVERNOR_POLICY",
  "RESOURCE_GOVERNOR_CAPS",
  "RESOURCE_GOVERNOR_CLASSES",
  "createResourceGovernor",
])
