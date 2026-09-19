import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { analyzePlan, taskFiles, validatePlan } from "./task-graph.mjs"

const WORK_DIR = ".ues-work"
const STATE_SCHEMA = 1

function now() {
  return new Date().toISOString()
}

export function validWorkSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value || ""))
}

export function workPaths(root, slug) {
  root = path.resolve(root)
  if (!validWorkSlug(slug)) throw new Error("work slug must use lowercase letters, numbers and dashes")
  const dir = path.join(root, WORK_DIR, slug)
  return {
    root,
    dir,
    spec: path.join(dir, "SPEC.md"),
    plan: path.join(dir, "PLAN.json"),
    state: path.join(dir, "STATE.json"),
    evidence: path.join(dir, "EVIDENCE.json"),
    tasks: path.join(dir, "tasks"),
    reports: path.join(dir, "reports"),
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return fallback
    throw error
  }
}

async function writeJson(file, value) {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
}

export async function initWork(root, slug, goal) {
  const paths = workPaths(root, slug)
  if (existsSync(paths.state)) throw new Error(`work '${slug}' already exists`)

  await mkdir(paths.tasks, { recursive: true })
  await mkdir(paths.reports, { recursive: true })
  const createdAt = now()
  const cleanGoal = String(goal || "").trim() || "Define the requested engineering outcome."

  await writeFile(
    paths.spec,
    `# ${slug}\n\n## Goal\n\n${cleanGoal}\n\n## Acceptance criteria\n\n- Replace this line with observable acceptance criteria before execution.\n\n## Constraints\n\n- Preserve unrelated user changes.\n`,
    "utf8",
  )
  await writeJson(paths.state, {
    schemaVersion: STATE_SCHEMA,
    slug,
    goal: cleanGoal,
    status: "planning",
    createdAt,
    updatedAt: createdAt,
    planImportedAt: null,
    tasks: {},
    decisions: [],
    blockers: [],
    nextAction: "Complete SPEC.md, create PLAN.json, then run ocskill work plan.",
  })
  await writeJson(paths.evidence, {
    schemaVersion: STATE_SCHEMA,
    slug,
    updatedAt: createdAt,
    entries: [],
  })

  return { ...paths, slug, goal: cleanGoal }
}

export async function loadWork(root, slug) {
  const paths = workPaths(root, slug)
  const state = await readJson(paths.state)
  if (!state) throw new Error(`work '${slug}' does not exist`)
  const plan = await readJson(paths.plan)
  const evidence = await readJson(paths.evidence, { schemaVersion: 1, slug, entries: [] })
  return { paths, state, plan, evidence }
}

function taskBrief(task) {
  const files = taskFiles(task)
  return `# ${task.id}: ${task.title}\n\n## Summary\n\n${task.summary || "No summary provided."}\n\n## Dependencies\n\n${(task.dependsOn || []).map((id) => `- ${id}`).join("\n") || "- None"}\n\n## Files\n\n${files.map((file) => `- ${file}`).join("\n") || "- Scope must be established before editing."}\n\n## Acceptance criteria\n\n${(task.acceptance || []).map((item) => `- ${item}`).join("\n")}\n\n## Verification\n\n${(task.verification || []).map((item) => `- ${item}`).join("\n")}\n\n## Risk\n\n${task.risk || "medium"}\n`
}

export async function importPlan(root, slug, planInput) {
  const loaded = await loadWork(root, slug)
  const plan = typeof planInput === "string"
    ? JSON.parse(await readFile(path.resolve(planInput), "utf8"))
    : planInput

  const validation = validatePlan(plan)
  if (!validation.valid) {
    const error = new Error("plan validation failed")
    error.validation = validation
    throw error
  }

  const analysis = analyzePlan(plan)
  await writeJson(loaded.paths.plan, plan)

  const stateTasks = {}
  for (const task of plan.tasks) {
    stateTasks[task.id] = {
      status: "pending",
      attempts: 0,
      startedAt: null,
      completedAt: null,
      lastFailure: null,
      report: null,
    }
    await writeFile(path.join(loaded.paths.tasks, `${task.id}.md`), taskBrief(task), "utf8")
  }

  const updatedAt = now()
  const next = analysis.safeWaves[0] || []
  const state = {
    ...loaded.state,
    goal: plan.goal,
    status: "ready",
    updatedAt,
    planImportedAt: updatedAt,
    tasks: stateTasks,
    nextAction: next.length ? `Execute ready task(s): ${next.join(", ")}` : "No executable task.",
  }
  await writeJson(loaded.paths.state, state)
  return { plan, analysis, state, paths: loaded.paths }
}

function taskByID(plan, id) {
  const task = plan?.tasks?.find((item) => item.id === id)
  if (!task) throw new Error(`unknown task '${id}'`)
  return task
}

function completedSet(state) {
  return new Set(Object.entries(state.tasks || {}).filter(([, value]) => value.status === "completed").map(([id]) => id))
}

export function readyTasks(plan, state) {
  if (!plan) return []
  const completed = completedSet(state)
  const runningFiles = new Set()
  for (const task of plan.tasks) {
    if (state.tasks?.[task.id]?.status === "running") {
      for (const file of taskFiles(task)) runningFiles.add(file)
    }
  }

  const ready = []
  for (const task of plan.tasks) {
    const status = state.tasks?.[task.id]?.status
    if (!["pending", "failed"].includes(status)) continue
    if (!(task.dependsOn || []).every((dep) => completed.has(dep))) continue
    const files = taskFiles(task)
    if (files.length === 0 && runningFiles.size > 0) continue
    if (files.some((file) => runningFiles.has(file))) continue
    ready.push(task.id)
  }
  return ready
}

export async function workStatus(root, slug) {
  const loaded = await loadWork(root, slug)
  const counts = { pending: 0, running: 0, completed: 0, failed: 0 }
  for (const value of Object.values(loaded.state.tasks || {})) {
    if (Object.hasOwn(counts, value.status)) counts[value.status] += 1
  }
  return {
    slug,
    root: loaded.paths.root,
    dir: loaded.paths.dir,
    status: loaded.state.status,
    goal: loaded.state.goal,
    counts,
    ready: readyTasks(loaded.plan, loaded.state),
    blockers: loaded.state.blockers || [],
    nextAction: loaded.state.nextAction,
    updatedAt: loaded.state.updatedAt,
  }
}

export async function startTask(root, slug, taskID) {
  const loaded = await loadWork(root, slug)
  if (!loaded.plan) throw new Error("PLAN.json is missing; import a valid plan first")
  const task = taskByID(loaded.plan, taskID)
  const record = loaded.state.tasks?.[taskID]
  if (!record) throw new Error(`task '${taskID}' is not tracked in STATE.json`)
  if (record.status === "completed") throw new Error(`task '${taskID}' is already completed`)
  if (!readyTasks(loaded.plan, loaded.state).includes(taskID)) {
    throw new Error(`task '${taskID}' is not ready; dependencies or file-overlap constraints are unresolved`)
  }

  const timestamp = now()
  record.status = "running"
  record.attempts += 1
  record.startedAt = timestamp
  record.lastFailure = null
  loaded.state.status = "executing"
  loaded.state.updatedAt = timestamp
  loaded.state.nextAction = `Complete ${taskID}, write its report, then record fresh verification evidence.`
  await writeJson(loaded.paths.state, loaded.state)

  return { task, record, contextPack: await contextPack(root, slug, taskID) }
}

export async function completeTask(root, slug, taskID, options = {}) {
  const loaded = await loadWork(root, slug)
  if (!loaded.plan) throw new Error("PLAN.json is missing")
  const task = taskByID(loaded.plan, taskID)
  const record = loaded.state.tasks?.[taskID]
  if (!record) throw new Error(`task '${taskID}' is not tracked`)
  if (record.status !== "running") throw new Error(`task '${taskID}' must be running before it can complete`)

  const evidenceText = String(options.evidence || "").trim()
  if (!evidenceText) throw new Error("completion requires non-empty fresh evidence")

  const timestamp = now()
  const reportPath = path.join(loaded.paths.reports, `${taskID}.md`)
  if (options.report) await writeFile(reportPath, String(options.report).trimEnd() + "\n", "utf8")
  else if (!existsSync(reportPath)) {
    await writeFile(reportPath, `# ${taskID} report\n\nCompleted with evidence recorded in EVIDENCE.json.\n`, "utf8")
  }

  record.status = "completed"
  record.completedAt = timestamp
  record.report = path.relative(loaded.paths.root, reportPath).replaceAll("\\", "/")

  loaded.evidence.entries.push({
    task: taskID,
    at: timestamp,
    evidence: evidenceText,
    verification: task.verification,
  })
  loaded.evidence.updatedAt = timestamp

  const allComplete = loaded.plan.tasks.every((item) => loaded.state.tasks[item.id]?.status === "completed")
  const ready = allComplete ? [] : readyTasks(loaded.plan, loaded.state)
  loaded.state.status = allComplete ? "integration-verification" : "executing"
  loaded.state.updatedAt = timestamp
  loaded.state.nextAction = allComplete
    ? "Run integration verification and independent review before completion."
    : ready.length
      ? `Execute ready task(s): ${ready.join(", ")}`
      : "Resolve blockers or failed dependencies before continuing."

  await writeJson(loaded.paths.evidence, loaded.evidence)
  await writeJson(loaded.paths.state, loaded.state)
  return { task, state: loaded.state, ready }
}

export async function failTask(root, slug, taskID, reason) {
  const loaded = await loadWork(root, slug)
  if (!loaded.plan) throw new Error("PLAN.json is missing")
  taskByID(loaded.plan, taskID)
  const record = loaded.state.tasks?.[taskID]
  if (!record) throw new Error(`task '${taskID}' is not tracked`)

  const cleanReason = String(reason || "").trim()
  if (!cleanReason) throw new Error("failure reason is required")
  const timestamp = now()
  record.status = "failed"
  record.lastFailure = cleanReason
  loaded.state.updatedAt = timestamp
  loaded.state.status = "executing"
  loaded.state.nextAction = record.attempts >= 3
    ? `Re-plan or escalate ${taskID}; it has failed ${record.attempts} attempt(s).`
    : `Re-diagnose ${taskID} from fresh evidence before retrying.`
  await writeJson(loaded.paths.state, loaded.state)
  return { taskID, attempts: record.attempts, state: loaded.state }
}

export async function addDecision(root, slug, decision) {
  const loaded = await loadWork(root, slug)
  const text = String(decision || "").trim()
  if (!text) throw new Error("decision text is required")
  loaded.state.decisions ??= []
  loaded.state.decisions.push({ at: now(), text })
  loaded.state.updatedAt = now()
  await writeJson(loaded.paths.state, loaded.state)
  return loaded.state
}

export async function addBlocker(root, slug, blocker) {
  const loaded = await loadWork(root, slug)
  const text = String(blocker || "").trim()
  if (!text) throw new Error("blocker text is required")
  loaded.state.blockers ??= []
  if (!loaded.state.blockers.includes(text)) loaded.state.blockers.push(text)
  loaded.state.updatedAt = now()
  loaded.state.nextAction = "Resolve blocker: " + text
  await writeJson(loaded.paths.state, loaded.state)
  return loaded.state
}

export async function resolveBlocker(root, slug, blocker) {
  const loaded = await loadWork(root, slug)
  const text = String(blocker || "").trim()
  if (!text) throw new Error("blocker text is required")
  loaded.state.blockers = (loaded.state.blockers || []).filter((item) => item !== text)
  loaded.state.updatedAt = now()
  const ready = readyTasks(loaded.plan, loaded.state)
  loaded.state.nextAction = loaded.state.blockers.length
    ? "Resolve remaining blocker(s) before continuing."
    : ready.length
      ? `Execute ready task(s): ${ready.join(", ")}`
      : loaded.state.status === "integration-verification"
        ? "Run integration verification and independent review before completion."
        : loaded.state.nextAction
  await writeJson(loaded.paths.state, loaded.state)
  return loaded.state
}

export async function finalizeWork(root, slug, evidence) {
  const loaded = await loadWork(root, slug)
  if (!loaded.plan) throw new Error("PLAN.json is missing")
  if (loaded.state.blockers?.length) throw new Error("cannot finalize while blockers remain")
  const incomplete = loaded.plan.tasks
    .filter((task) => loaded.state.tasks?.[task.id]?.status !== "completed")
    .map((task) => task.id)
  if (incomplete.length) throw new Error("cannot finalize with incomplete tasks: " + incomplete.join(", "))

  const evidenceText = String(evidence || "").trim()
  if (!evidenceText) throw new Error("finalization requires fresh integration evidence")

  const timestamp = now()
  loaded.evidence.entries.push({
    task: "__integration__",
    at: timestamp,
    evidence: evidenceText,
    verification: ["cross-task integration and final acceptance verification"],
  })
  loaded.evidence.updatedAt = timestamp

  loaded.state.status = "completed"
  loaded.state.completedAt = timestamp
  loaded.state.updatedAt = timestamp
  loaded.state.nextAction = "Work item completed; preserve evidence and report any remaining limitations accurately."

  await writeJson(loaded.paths.evidence, loaded.evidence)
  await writeJson(loaded.paths.state, loaded.state)
  return { state: loaded.state, evidence: loaded.evidence.entries.at(-1) }
}

export async function contextPack(root, slug, taskID) {
  const loaded = await loadWork(root, slug)
  if (!loaded.plan) throw new Error("PLAN.json is missing")
  const task = taskByID(loaded.plan, taskID)
  const spec = await readFile(loaded.paths.spec, "utf8").catch(() => "")
  const dependencyReports = {}

  for (const dep of task.dependsOn || []) {
    const file = path.join(loaded.paths.reports, `${dep}.md`)
    if (!existsSync(file)) continue
    dependencyReports[dep] = (await readFile(file, "utf8")).slice(0, 12000)
  }

  return {
    schemaVersion: 1,
    slug,
    task,
    taskBrief: path.relative(loaded.paths.root, path.join(loaded.paths.tasks, `${taskID}.md`)).replaceAll("\\", "/"),
    spec: spec.slice(0, 24000),
    dependencyReports,
    decisions: loaded.state.decisions || [],
    blockers: loaded.state.blockers || [],
    workingState: {
      status: loaded.state.status,
      task: loaded.state.tasks?.[taskID],
    },
  }
}

export async function resumeWork(root, slug) {
  const loaded = await loadWork(root, slug)
  return {
    status: await workStatus(root, slug),
    planAnalysis: loaded.plan ? analyzePlan(loaded.plan) : null,
    completedEvidence: loaded.evidence.entries || [],
    decisions: loaded.state.decisions || [],
  }
}
