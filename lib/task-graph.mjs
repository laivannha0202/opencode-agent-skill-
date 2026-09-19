import path from "node:path"

const VALID_RISKS = new Set(["low", "medium", "high", "critical"])

function normalizeFile(value) {
  const normalized = path.posix
    .normalize(String(value || "").replaceAll("\\", "/"))
    .replace(/^\.\//, "")
  return normalized === "." ? "" : normalized
}

export function taskFiles(task) {
  const files = task?.files
  if (Array.isArray(files)) return [...new Set(files.map(normalizeFile).filter(Boolean))].sort()
  if (!files || typeof files !== "object") return []

  const values = []
  for (const key of ["create", "modify", "test", "delete", "read"]) {
    if (!Array.isArray(files[key])) continue
    values.push(...files[key])
  }
  return [...new Set(values.map(normalizeFile).filter(Boolean))].sort()
}

function taskMap(plan) {
  return new Map((plan?.tasks || []).map((task) => [task.id, task]))
}

export function validatePlan(plan) {
  const errors = []
  const warnings = []

  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return { valid: false, errors: ["plan must be a JSON object"], warnings }
  }
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1")
  if (!String(plan.goal || "").trim()) errors.push("goal must be a non-empty string")
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push("tasks must be a non-empty array")
    return { valid: false, errors, warnings }
  }

  const ids = new Set()
  for (const [index, task] of plan.tasks.entries()) {
    const prefix = `tasks[${index}]`
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`${prefix} must be an object`)
      continue
    }

    const id = String(task.id || "").trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      errors.push(`${prefix}.id must use letters, numbers, dot, underscore or dash`)
    } else if (ids.has(id)) {
      errors.push(`duplicate task id: ${id}`)
    } else {
      ids.add(id)
    }

    if (!String(task.title || "").trim()) errors.push(`${prefix}.title is required`)
    if (!String(task.summary || "").trim()) warnings.push(`${id || prefix}: summary is empty`)

    const deps = task.dependsOn ?? []
    if (!Array.isArray(deps)) errors.push(`${id || prefix}.dependsOn must be an array`)
    else if (deps.includes(id)) errors.push(`${id}: task cannot depend on itself`)

    if (!Array.isArray(task.acceptance) || task.acceptance.length === 0) {
      errors.push(`${id || prefix}: acceptance must contain at least one observable criterion`)
    }
    if (!Array.isArray(task.verification) || task.verification.length === 0) {
      errors.push(`${id || prefix}: verification must contain at least one concrete check`)
    }

    const risk = task.risk ?? "medium"
    if (!VALID_RISKS.has(risk)) errors.push(`${id || prefix}: invalid risk '${risk}'`)

    const files = taskFiles(task)
    if (files.length === 0) warnings.push(`${id || prefix}: no files declared; parallel scheduling will be conservative`)
  }

  const map = taskMap(plan)
  for (const task of plan.tasks) {
    if (!task?.id || !Array.isArray(task.dependsOn)) continue
    for (const dep of task.dependsOn) {
      if (!map.has(dep)) errors.push(`${task.id}: unknown dependency '${dep}'`)
    }
  }

  const cycle = findCycle(plan)
  if (cycle.length) errors.push(`dependency cycle: ${cycle.join(" -> ")}`)

  return { valid: errors.length === 0, errors, warnings }
}

function findCycle(plan) {
  const map = taskMap(plan)
  const visiting = new Set()
  const visited = new Set()
  const stack = []

  function visit(id) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    if (visited.has(id)) return []

    visiting.add(id)
    stack.push(id)
    for (const dep of map.get(id)?.dependsOn || []) {
      const cycle = visit(dep)
      if (cycle.length) return cycle
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return []
  }

  for (const id of map.keys()) {
    const cycle = visit(id)
    if (cycle.length) return cycle
  }
  return []
}

function overlaps(taskA, taskB) {
  const a = new Set(taskFiles(taskA))
  if (a.size === 0 || taskFiles(taskB).length === 0) return true
  return taskFiles(taskB).some((file) => a.has(file))
}

export function computeTopologicalWaves(plan) {
  const validation = validatePlan(plan)
  if (!validation.valid) {
    const error = new Error("invalid task plan")
    error.validation = validation
    throw error
  }

  const map = taskMap(plan)
  const complete = new Set()
  const remaining = new Set(map.keys())
  const waves = []

  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) => (map.get(id).dependsOn || []).every((dep) => complete.has(dep)))
      .sort()

    if (ready.length === 0) throw new Error("task graph cannot make progress")
    waves.push(ready)
    for (const id of ready) {
      remaining.delete(id)
      complete.add(id)
    }
  }
  return waves
}

export function computeSafeWaves(plan) {
  const validation = validatePlan(plan)
  if (!validation.valid) {
    const error = new Error("invalid task plan")
    error.validation = validation
    throw error
  }

  const map = taskMap(plan)
  const complete = new Set()
  const remaining = new Set(map.keys())
  const waves = []
  const serialized = []

  while (remaining.size) {
    const ready = [...remaining]
      .filter((id) => (map.get(id).dependsOn || []).every((dep) => complete.has(dep)))
      .sort()

    if (ready.length === 0) throw new Error("task graph cannot make progress")

    const selected = []
    for (const id of ready) {
      const task = map.get(id)
      const conflict = selected.find((otherID) => overlaps(task, map.get(otherID)))
      if (conflict) {
        serialized.push({ task: id, conflictsWith: conflict, reason: "declared-file overlap or unknown file scope" })
        continue
      }
      selected.push(id)
    }

    if (selected.length === 0) selected.push(ready[0])
    waves.push(selected)
    for (const id of selected) {
      remaining.delete(id)
      complete.add(id)
    }
  }

  return { waves, serialized }
}

export function analyzePlan(plan) {
  const validation = validatePlan(plan)
  if (!validation.valid) return { ...validation, topologicalWaves: [], safeWaves: [], serialized: [] }

  const topologicalWaves = computeTopologicalWaves(plan)
  const safe = computeSafeWaves(plan)
  return {
    ...validation,
    topologicalWaves,
    safeWaves: safe.waves,
    serialized: safe.serialized,
    taskCount: plan.tasks.length,
  }
}
