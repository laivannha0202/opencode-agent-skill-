function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\/+/, "")
}

function taskFiles(task, keys) {
  const files = task?.files
  if (Array.isArray(files)) return [...new Set(files.map(normalizePath).filter(Boolean))]
  if (!files || typeof files !== "object") return []
  return [...new Set(keys.flatMap((key) => Array.isArray(files[key]) ? files[key] : []).map(normalizePath).filter(Boolean))]
}

function claimMap(task) {
  const writes = taskFiles(task, ["create", "modify", "test", "delete"])
  const reads = taskFiles(task, ["read"])
  const claims = new Map()
  const add = (resource, mode) => {
    const current = claims.get(resource)
    if (!current || mode === "write") claims.set(resource, mode)
  }

  for (const file of reads) add("file:" + file, "read")
  for (const file of writes) add("file:" + file, "write")

  const explicit = Array.isArray(task?.resources) ? task.resources : []
  for (const resource of explicit) add("resource:" + String(resource), "write")

  if (writes.length) add("@writers", "read")
  const sharedSurface = writes.some((file) =>
    /(^|\/)(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^/]+)?\.json|schema\.prisma|.*\.csproj|pom\.xml|gradle\.properties)$/i.test(file) ||
    /(^|\/)(migrations?|generated|config)\//i.test(file)
  )
  if (sharedSurface) add("@writers", "write")

  if (!writes.length && !reads.length && explicit.length === 0) {
    add("@unknown-scope", "write")
    add("@writers", "write")
  }

  return [...claims].map(([resource, mode]) => ({ resource, mode }))
}

export function taskResourceClaims(task) {
  return claimMap(task)
}

export class ResourceLeaseTable {
  constructor() {
    this.resources = new Map()
    this.byOwner = new Map()
  }

  canAcquire(owner, claims) {
    for (const claim of claims) {
      const holders = this.resources.get(claim.resource) || []
      for (const holder of holders) {
        if (holder.owner === owner) continue
        if (claim.mode === "write" || holder.mode === "write") return false
      }
    }
    return true
  }

  acquire(owner, claims) {
    if (!this.canAcquire(owner, claims)) return false
    this.byOwner.set(owner, claims)
    for (const claim of claims) {
      const holders = this.resources.get(claim.resource) || []
      holders.push({ owner, mode: claim.mode })
      this.resources.set(claim.resource, holders)
    }
    return true
  }

  release(owner) {
    const claims = this.byOwner.get(owner) || []
    this.byOwner.delete(owner)
    for (const claim of claims) {
      const remaining = (this.resources.get(claim.resource) || []).filter((holder) => holder.owner !== owner)
      if (remaining.length) this.resources.set(claim.resource, remaining)
      else this.resources.delete(claim.resource)
    }
  }

  snapshot() {
    return [...this.resources.entries()].map(([resource, holders]) => ({ resource, holders }))
  }
}

export function adaptiveWorkerCount(input = {}) {
  const requested = Math.max(1, Math.min(16, Number(input.requested || 4)))
  const readyCount = Math.max(0, Number(input.readyCount || 0))
  let limit = Math.min(requested, Math.max(1, readyCount || 1))
  const recentFailures = Math.max(0, Number(input.recentFailures || 0))
  const conflictRate = Math.max(0, Math.min(1, Number(input.conflictRate || 0)))
  if (recentFailures >= 2) limit = Math.max(1, Math.ceil(limit / 2))
  if (conflictRate >= 0.35) limit = Math.max(1, Math.ceil(limit / 2))
  return limit
}

function validateGraph(tasks, completed) {
  const byID = new Map()
  for (const task of tasks) {
    const id = String(task?.id || "")
    if (!id || byID.has(id)) throw new Error("parallel DAG requires unique non-empty task ids")
    byID.set(id, task)
  }
  for (const task of tasks) {
    for (const dep of task.dependsOn || task.dependencies || []) {
      if (!byID.has(dep) && !completed.has(dep)) {
        throw new Error("parallel DAG task " + task.id + " has missing dependency " + dep)
      }
    }
  }
  return byID
}

function errorRecord(error) {
  return {
    message: String(error?.message || error),
    code: error?.code || null,
  }
}

export async function runEventDrivenDAG(tasks = [], options = {}) {
  if (typeof options.worker !== "function") throw new Error("parallel DAG requires a worker function")
  const completed = new Set(options.completedTaskIds || [])
  const byID = validateGraph(tasks, completed)
  const pending = new Set(tasks.map((task) => task.id))
  const running = new Map()
  const failed = new Map()
  const blocked = new Map()
  const results = new Map()
  const leases = options.leases || new ResourceLeaseTable()
  const events = []
  let integrationTail = Promise.resolve()
  let conflictDeferrals = 0
  let schedulingChecks = 0

  const emit = (type, payload = {}) => {
    const event = { type, at: new Date().toISOString(), ...payload }
    events.push(event)
    options.onEvent?.(event)
  }

  const enqueueIntegration = (task, result, context) => {
    if (typeof options.integrate !== "function") return Promise.resolve(null)
    const job = integrationTail.then(() => options.integrate(task, result, context))
    integrationTail = job.catch(() => {})
    return job
  }

  const launch = (task) => {
    const claims = taskResourceClaims(task)
    if (!leases.acquire(task.id, claims)) return false
    pending.delete(task.id)
    const context = {
      model: options.singleModel === false ? null : (options.model || null),
      singleModel: options.singleModel !== false,
      claims,
    }
    emit("task.started", { task: task.id, model: context.model, claims })
    const promise = (async () => {
      try {
        const result = await options.worker(task, context)
        const integration = await enqueueIntegration(task, result, context)
        return { ok: true, result, integration }
      } catch (error) {
        return { ok: false, error }
      } finally {
        leases.release(task.id)
      }
    })()
    running.set(task.id, promise)
    return true
  }

  while (pending.size || running.size) {
    for (const id of [...pending]) {
      const task = byID.get(id)
      const badDep = (task.dependsOn || task.dependencies || []).find((dep) => failed.has(dep) || blocked.has(dep))
      if (badDep) {
        pending.delete(id)
        blocked.set(id, { dependency: badDep })
        emit("task.blocked", { task: id, dependency: badDep })
      }
    }

    const ready = [...pending]
      .map((id) => byID.get(id))
      .filter((task) => (task.dependsOn || task.dependencies || []).every((dep) => completed.has(dep)))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))

    schedulingChecks += Math.max(1, ready.length)
    const conflictRate = schedulingChecks ? conflictDeferrals / schedulingChecks : 0
    const limit = adaptiveWorkerCount({
      requested: options.maxConcurrent || 4,
      readyCount: ready.length + running.size,
      recentFailures: failed.size,
      conflictRate,
    })

    for (const task of ready) {
      if (running.size >= limit) break
      const claims = taskResourceClaims(task)
      if (!leases.canAcquire(task.id, claims)) {
        conflictDeferrals += 1
        continue
      }
      launch(task)
    }

    if (!running.size) {
      if (pending.size) {
        for (const id of pending) {
          blocked.set(id, { dependency: null, reason: "no-runnable-task" })
          emit("task.blocked", { task: id, reason: "no-runnable-task" })
        }
        pending.clear()
      }
      break
    }

    const settled = await Promise.race(
      [...running.entries()].map(([id, promise]) => promise.then((value) => ({ id, ...value }))),
    )
    running.delete(settled.id)
    if (settled.ok) {
      completed.add(settled.id)
      results.set(settled.id, { result: settled.result, integration: settled.integration })
      emit("task.completed", { task: settled.id })
    } else {
      failed.set(settled.id, errorRecord(settled.error))
      emit("task.failed", { task: settled.id, error: errorRecord(settled.error) })
      if (options.failFast === true) {
        for (const id of pending) {
          blocked.set(id, { dependency: settled.id, reason: "fail-fast" })
          emit("task.blocked", { task: id, dependency: settled.id, reason: "fail-fast" })
        }
        pending.clear()
      }
    }
  }

  await integrationTail
  return {
    schemaVersion: 1,
    model: options.singleModel === false ? null : (options.model || null),
    singleModel: options.singleModel !== false,
    requestedConcurrency: Math.max(1, Number(options.maxConcurrent || 4)),
    completed: [...completed].filter((id) => byID.has(id)),
    failed: Object.fromEntries(failed),
    blocked: Object.fromEntries(blocked),
    results: Object.fromEntries(results),
    conflictDeferrals,
    events,
    leaseSnapshot: leases.snapshot(),
  }
}
