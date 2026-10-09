import path from "node:path"
// V16.17 (§4): task-graph owns DEPENDENCY topology and declared task resources.
// Execution CONFLICTS are owned by the canonical conflict graph, so this module
// no longer keeps a second write/write + read/write implementation that can drift
// from it. `overlaps` / `computeSafeWaves` delegate to the one authority.
import {
  PAIR_VERDICT,
  classifyPair,
  normalizeScope,
} from "./execution-conflict-graph-v16-15.mjs"

const VALID_RISKS = new Set(["low", "medium", "high", "critical"])

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null)
}

function normalizeStringList(value, aliases = []) {
  const sources = [value, ...aliases].filter((source) => source !== undefined && source !== null)
  if (!sources.length) return undefined

  for (const source of sources) {
    const items = Array.isArray(source) ? source : [source]
    const normalized = items
      .map((item) => {
        if (typeof item === "string") return item.trim()
        if (!item || typeof item !== "object" || Array.isArray(item)) return ""
        return String(
          firstDefined(
            item.criterion,
            item.criteria,
            item.check,
            item.description,
            item.expected,
            item.outcome,
            item.text,
            item.command,
          ) || "",
        ).trim()
      })
      .filter(Boolean)
    if (normalized.length) return normalized
  }

  return []
}

function normalizeRisk(value, fallback = "medium") {
  const raw = String(value ?? "").trim()
  if (!raw) return { risk: fallback, riskNotes: "" }
  const lower = raw.toLowerCase()
  if (VALID_RISKS.has(lower)) return { risk: lower, riskNotes: "" }

  const token = lower.match(/\b(low|medium|high|critical)\b/)?.[1]
  if (token && VALID_RISKS.has(token)) {
    return { risk: token, riskNotes: raw }
  }

  // Unknown prose in a risk field is never downgraded. Preserve it as notes
  // and choose a conservative level so weak-model formatting errors cannot
  // silently weaken verification requirements.
  return { risk: "high", riskNotes: raw }
}

export function normalizePlanForValidation(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return plan
  const tasks = Array.isArray(plan.tasks)
    ? plan.tasks.map((task) => {
        if (!task || typeof task !== "object" || Array.isArray(task)) return task

        const acceptance = normalizeStringList(
          task.acceptance,
          [task.acceptanceCriteria, task.criteria, task.successCriteria],
        )
        const verification = normalizeStringList(
          task.verification,
          [task.verificationChecks, task.checks, task.verify, task.validation],
        )
        const riskSource = firstDefined(task.risk, task.riskLevel, task.severity)
        const normalizedRisk = normalizeRisk(riskSource, "medium")
        const dependencies = firstDefined(task.dependsOn, task.dependencies)
        const requirementIdsSource = firstDefined(task.requirementIds, task.requirements, task.requirementIDs)
        const requirementIds = requirementIdsSource === undefined
          ? undefined
          : [...new Set(
              (Array.isArray(requirementIdsSource) ? requirementIdsSource : [requirementIdsSource])
                .map((item) => String(item || "").trim().toUpperCase())
                .filter(Boolean),
            )]

        return {
          ...task,
          ...(dependencies !== undefined ? { dependsOn: Array.isArray(dependencies) ? dependencies : [dependencies].filter(Boolean) } : {}),
          ...(acceptance !== undefined ? { acceptance } : {}),
          ...(verification !== undefined ? { verification } : {}),
          ...(requirementIds !== undefined ? { requirementIds } : {}),
          risk: normalizedRisk.risk,
          ...(normalizedRisk.riskNotes && !task.riskNotes ? { riskNotes: normalizedRisk.riskNotes } : {}),
        }
      })
    : plan.tasks

  return {
    ...plan,
    schemaVersion: Number(plan.schemaVersion || 1),
    tasks,
  }
}

function unsafeRepoPath(value) {
  const raw = String(value || "").replaceAll("\\", "/")
  if (!raw) return false
  if (path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return true
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "")
  return normalized === ".." || normalized.startsWith("../")
}

function normalizeFile(value) {
  if (unsafeRepoPath(value)) return ""
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

export function taskWriteFiles(task) {
  const files = task?.files
  if (Array.isArray(files)) return taskFiles(task)
  if (!files || typeof files !== "object") return []
  const values = []
  for (const key of ["create", "modify", "test", "delete"]) {
    if (Array.isArray(files[key])) values.push(...files[key])
  }
  return [...new Set(values.map(normalizeFile).filter(Boolean))].sort()
}

export function taskReadFiles(task) {
  const files = task?.files
  if (!files || Array.isArray(files) || typeof files !== "object") return []
  return [...new Set((files.read || []).map(normalizeFile).filter(Boolean))].sort()
}


export function taskVerificationCommands(task) {
  if (!Array.isArray(task?.verificationCommands)) return []
  return task.verificationCommands
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null
      const command = String(item.command || "").trim()
      if (!command) return null
      const args = Array.isArray(item.args) ? item.args.map((value) => String(value)) : []
      return { command, args }
    })
    .filter(Boolean)
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

    if (task.requirementIds !== undefined) {
      if (!Array.isArray(task.requirementIds)) {
        errors.push(`${id || prefix}.requirementIds must be an array when provided`)
      } else {
        for (const requirementId of task.requirementIds) {
          if (!/^R\d+$/.test(String(requirementId || "").trim().toUpperCase())) {
            errors.push(`${id || prefix}: invalid requirement id '${requirementId}'`)
          }
        }
      }
    }

    if (task.verificationCommands !== undefined) {
      if (!Array.isArray(task.verificationCommands)) {
        errors.push(`${id || prefix}.verificationCommands must be an array when provided`)
      } else {
        for (const [commandIndex, commandSpec] of task.verificationCommands.entries()) {
          const commandPrefix = `${id || prefix}.verificationCommands[${commandIndex}]`
          if (!commandSpec || typeof commandSpec !== "object" || Array.isArray(commandSpec)) {
            errors.push(`${commandPrefix} must be an object`)
            continue
          }
          if (!String(commandSpec.command || "").trim()) errors.push(`${commandPrefix}.command is required`)
          if (commandSpec.args !== undefined && !Array.isArray(commandSpec.args)) {
            errors.push(`${commandPrefix}.args must be an array when provided`)
          }
        }
      }
    }

    const risk = task.risk ?? "medium"
    if (!VALID_RISKS.has(risk)) errors.push(`${id || prefix}: invalid risk '${risk}'`)

    const rawFiles = task.files
    const rawValues = Array.isArray(rawFiles)
      ? rawFiles
      : rawFiles && typeof rawFiles === "object"
        ? ["create", "modify", "test", "delete", "read"].flatMap((key) => Array.isArray(rawFiles[key]) ? rawFiles[key] : [])
        : []
    for (const file of rawValues) {
      if (unsafeRepoPath(file)) errors.push(`${id || prefix}: file scope must stay inside the repository: ${file}`)
    }

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

/**
 * V16.17 (§4): translate one validated task into the canonical conflict scope
 * shape. A task that declares only reads is a READER; a task that declares no
 * files at all stays a WRITER whose scope is UNKNOWN (silence is never safety),
 * exactly as the conflict graph's own fail-closed rule requires.
 */
export function taskConflictScope(task, index = 0) {
  const writeFiles = taskWriteFiles(task)
  const readFiles = taskReadFiles(task)
  const readOnly = writeFiles.length === 0 && readFiles.length > 0
  return normalizeScope({
    id: String(task?.id ?? `task-${index}`),
    readOnly,
    writeFiles,
    readFiles,
    generatedOutputs: Array.isArray(task?.generatedOutputs) ? task.generatedOutputs : [],
    services: Array.isArray(task?.services)
      ? task.services
      : Array.isArray(task?.mutableServices) ? task.mutableServices : [],
    externalEffects: Array.isArray(task?.externalEffects)
      ? task.externalEffects
      : Array.isArray(task?.sideEffects) ? task.sideEffects : [],
    commands: Array.isArray(task?.commands)
      ? task.commands
      : Array.isArray(task?.plannedCommands) ? task.plannedCommands : [],
  }, index)
}

/**
 * Canonical conflict verdict for one pair of tasks. Delegates to the execution
 * conflict graph so there is exactly ONE write/write, read/write, config-family,
 * lockfile, generated-output, module-edge, service and external-effect rule set.
 */
export function tasksConflict(taskA, taskB, options = {}) {
  const pair = classifyPair(
    taskConflictScope(taskA, 0),
    taskConflictScope(taskB, 1),
    options,
  )
  return {
    conflict: pair.verdict === PAIR_VERDICT.CONFLICT,
    kinds: [...new Set(pair.relations.map((relation) => relation.kind))],
    relations: pair.relations,
  }
}

function overlaps(taskA, taskB) {
  return tasksConflict(taskA, taskB).conflict
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
        serialized.push({ task: id, conflictsWith: conflict, reason: "declared write/read conflict or unknown file scope" })
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
