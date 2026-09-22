import os from "node:os"
import { taskFiles, taskWriteFiles } from "./task-graph.mjs"

const EXCLUSIVE_FILE_PATTERNS = [
  /(^|\/)package(?:-lock)?\.json$/i,
  /(^|\/)pnpm-lock\.yaml$/i,
  /(^|\/)yarn\.lock$/i,
  /(^|\/)bun\.lockb?$/i,
  /(^|\/)composer\.lock$/i,
  /(^|\/)poetry\.lock$/i,
  /(^|\/)Cargo\.lock$/i,
  /(^|\/)schema\.prisma$/i,
  /(^|\/)migrations?(\/|$)/i,
  /(^|\/)(?:ts|js)config[^/]*\.json$/i,
  /(^|\/)\.github\/workflows(\/|$)/i,
]

function taskMap(plan) {
  return new Map((plan?.tasks || []).map((task) => [task.id, task]))
}

function completedSet(state) {
  return new Set(
    Object.entries(state?.tasks || {})
      .filter(([, record]) => record?.status === "completed")
      .map(([id]) => id),
  )
}

export function taskResources(task = {}) {
  const resources = new Set()
  const files = taskFiles(task)
  const writes = new Set(taskWriteFiles(task))

  for (const file of files) {
    resources.add("file:" + file)
    if (writes.has(file) && EXCLUSIVE_FILE_PATTERNS.some((pattern) => pattern.test(file))) {
      resources.add("exclusive:" + file)
    }
  }

  for (const value of task.resources || []) {
    const resource = String(value || "").trim()
    if (resource) resources.add("declared:" + resource)
  }

  if (files.length === 0) resources.add("unknown-file-scope")
  return [...resources].sort()
}

export function tasksConflict(taskA = {}, taskB = {}) {
  const filesA = taskFiles(taskA)
  const filesB = taskFiles(taskB)
  if (filesA.length === 0 || filesB.length === 0) return true

  const writesA = new Set(taskWriteFiles(taskA))
  const writesB = new Set(taskWriteFiles(taskB))
  const allB = new Set(filesB)
  const allA = new Set(filesA)

  if ([...writesA].some((file) => allB.has(file))) return true
  if ([...writesB].some((file) => allA.has(file))) return true

  const resourcesA = new Set(taskResources(taskA).filter((item) => item.startsWith("declared:") || item.startsWith("exclusive:")))
  const resourcesB = new Set(taskResources(taskB).filter((item) => item.startsWith("declared:") || item.startsWith("exclusive:")))
  return [...resourcesA].some((resource) => resourcesB.has(resource))
}

export function buildResourceLeases(plan, state) {
  const byID = taskMap(plan)
  const leases = []
  for (const [taskID, record] of Object.entries(state?.tasks || {})) {
    if (record?.status !== "running") continue
    const task = byID.get(taskID)
    if (!task) continue
    leases.push({
      taskID,
      runId: record.runId || null,
      sessionID: record.owner?.sessionID || null,
      resources: taskResources(task),
      leaseExpiresAt: record.leaseExpiresAt || null,
    })
  }
  return leases
}

function availableCPU() {
  if (typeof os.availableParallelism === "function") return Math.max(1, os.availableParallelism())
  return Math.max(1, os.cpus()?.length || 1)
}

export function adaptiveWorkerCount(input = {}) {
  const readyCount = Math.max(0, Number(input.readyCount || 0))
  if (readyCount === 0) return 0

  const maxConcurrent = Math.max(1, Math.min(16, Number(input.maxConcurrent || 4)))
  const cpuCount = Math.max(1, Number(input.cpuCount || availableCPU()))
  const conflictRatio = Math.max(0, Math.min(1, Number(input.conflictRatio || 0)))
  const weakModel = input.weakModel !== false

  if (input.rateLimited === true) return 1

  let cap = Math.min(maxConcurrent, readyCount)
  if (weakModel) cap = Math.min(cap, 4)

  // Agent work is often provider-bound, but local tools/tests still consume host resources.
  const hostCap = Math.max(1, Math.ceil(cpuCount / 2))
  cap = Math.min(cap, hostCap)

  if (conflictRatio >= 0.5) cap = Math.min(cap, 1)
  else if (conflictRatio >= 0.25) cap = Math.min(cap, 2)

  return Math.max(1, cap)
}

function dependencyReady(task, completed) {
  return (task.dependsOn || task.dependencies || []).every((dep) => completed.has(dep))
}

export function computeEventDrivenSchedule(plan, state, inputOptions = {}) {
  const byID = taskMap(plan)
  const completed = completedSet(state)
  const runningTasks = [...byID.values()].filter((task) => state?.tasks?.[task.id]?.status === "running")
  const candidates = [...byID.values()]
    .filter((task) => ["pending", "failed", "retryable"].includes(state?.tasks?.[task.id]?.status))
    .filter((task) => dependencyReady(task, completed))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))

  const selected = []
  const deferred = []

  for (const task of candidates) {
    const runningConflict = runningTasks.find((other) => tasksConflict(task, other))
    if (runningConflict) {
      deferred.push({ taskID: task.id, reason: "running-resource-conflict", conflictsWith: runningConflict.id })
      continue
    }
    const selectedConflict = selected.find((other) => tasksConflict(task, other))
    if (selectedConflict) {
      deferred.push({ taskID: task.id, reason: "selected-resource-conflict", conflictsWith: selectedConflict.id })
      continue
    }
    selected.push(task)
  }

  const conflictRatio = candidates.length ? deferred.length / candidates.length : 0
  const workerCount = adaptiveWorkerCount({
    readyCount: selected.length,
    maxConcurrent: inputOptions.maxConcurrent,
    cpuCount: inputOptions.cpuCount,
    weakModel: inputOptions.weakModel !== false,
    rateLimited: inputOptions.rateLimited === true,
    conflictRatio,
  })

  const dispatched = selected.slice(0, workerCount)
  for (const task of selected.slice(workerCount)) {
    deferred.push({ taskID: task.id, reason: "worker-capacity" })
  }

  return {
    schemaVersion: 1,
    mode: "event-driven",
    singleModel: inputOptions.singleModel !== false,
    maxConcurrent: Math.max(1, Math.min(16, Number(inputOptions.maxConcurrent || 4))),
    workerCount,
    ready: candidates.map((task) => task.id),
    selected: dispatched.map((task) => ({
      taskID: task.id,
      resources: taskResources(task),
      files: taskFiles(task),
      writes: taskWriteFiles(task),
    })),
    deferred: deferred.sort((a, b) => String(a.taskID).localeCompare(String(b.taskID))),
    leases: buildResourceLeases(plan, state),
    completed: [...completed].sort(),
  }
}

export function buildIntegrationQueue(results = []) {
  const accepted = []
  const failed = []
  for (const item of results || []) {
    if (item?.ok === true && item?.sandbox?.dir) {
      accepted.push({
        taskID: item.taskID,
        runId: item.runId || null,
        sandboxDir: item.sandbox.dir,
        base: item.sandbox.startPoint || null,
      })
    } else if (item?.ok === false) {
      failed.push({ taskID: item.taskID, error: item.error || "unknown parallel worker failure" })
    }
  }
  accepted.sort((a, b) => String(a.taskID).localeCompare(String(b.taskID)))
  failed.sort((a, b) => String(a.taskID).localeCompare(String(b.taskID)))
  return { accepted, failed }
}
