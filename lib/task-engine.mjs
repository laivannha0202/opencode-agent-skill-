import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { analyzePlan, taskFiles, validatePlan } from "./task-graph.mjs"

const WORK_DIR = ".ues-work"
const STATE_SCHEMA = 2
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 120_000

function now() {
  return new Date().toISOString()
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    lock: path.join(dir, ".state-lock"),
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

async function atomicWrite(file, content) {
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp"
  await writeFile(temp, content, "utf8")
  try {
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

async function writeJson(file, value) {
  await atomicWrite(file, JSON.stringify(value, null, 2) + "\n")
}

async function acquireWorkLock(paths) {
  const started = Date.now()
  while (true) {
    try {
      await mkdir(paths.lock)
      await writeFile(
        path.join(paths.lock, "owner.json"),
        JSON.stringify({ pid: process.pid, at: now() }) + "\n",
        "utf8",
      ).catch(() => {})
      return
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const info = await stat(paths.lock).catch(() => null)
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
        await rm(paths.lock, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) {
        throw new Error(`timed out waiting for UES state lock: ${paths.lock}`)
      }
      await sleep(25)
    }
  }
}

async function withWorkLock(root, slug, fn) {
  const paths = workPaths(root, slug)
  await acquireWorkLock(paths)
  try {
    return await fn(paths)
  } finally {
    await rm(paths.lock, { recursive: true, force: true }).catch(() => {})
  }
}

export function planHash(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex")
}

function gitCapture(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
}

export function workspaceFingerprint(root) {
  root = path.resolve(root)
  const inside = gitCapture(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0) {
    return createHash("sha256").update("non-git:" + root).digest("hex")
  }

  const parts = []
  const commands = [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).ues-work"],
    ["diff", "--binary", "--no-ext-diff", "--", ".", ":(exclude).ues-work"],
    ["diff", "--cached", "--binary", "--no-ext-diff", "--", ".", ":(exclude).ues-work"],
  ]
  for (const args of commands) {
    const result = gitCapture(root, args)
    parts.push(result.status === 0 ? result.stdout : "ERROR:" + (result.stderr || result.stdout || ""))
  }
  return createHash("sha256").update(parts.join("\n---UES-FP---\n")).digest("hex")
}

export async function initWork(root, slug, goal) {
  const paths = workPaths(root, slug)
  if (existsSync(paths.state)) throw new Error(`work '${slug}' already exists`)

  await mkdir(paths.tasks, { recursive: true })
  await mkdir(paths.reports, { recursive: true })
  const createdAt = now()
  const cleanGoal = String(goal || "").trim() || "Define the requested engineering outcome."

  await atomicWrite(
    paths.spec,
    `# ${slug}\n\n## Goal\n\n${cleanGoal}\n\n## Acceptance criteria\n\n- Replace this line with observable acceptance criteria before execution.\n\n## Constraints\n\n- Preserve unrelated user changes.\n`,
  )
  await writeJson(paths.state, {
    schemaVersion: STATE_SCHEMA,
    slug,
    goal: cleanGoal,
    status: "planning",
    createdAt,
    updatedAt: createdAt,
    planImportedAt: null,
    planHash: null,
    planApproval: null,
    integrationVerification: null,
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
  const evidence = await readJson(paths.evidence, { schemaVersion: STATE_SCHEMA, slug, entries: [] })
  return { paths, state, plan, evidence }
}

function taskBrief(task) {
  const files = taskFiles(task)
  return `# ${task.id}: ${task.title}\n\n## Summary\n\n${task.summary || "No summary provided."}\n\n## Dependencies\n\n${(task.dependsOn || []).map((id) => `- ${id}`).join("\n") || "- None"}\n\n## Files\n\n${files.map((file) => `- ${file}`).join("\n") || "- Scope must be established before editing."}\n\n## Acceptance criteria\n\n${(task.acceptance || []).map((item) => `- ${item}`).join("\n")}\n\n## Verification\n\n${(task.verification || []).map((item) => `- ${item}`).join("\n")}\n\n## Risk\n\n${task.risk || "medium"}\n`
}

function planIsApproved(state, plan) {
  if (!plan) return false
  const hash = state.planHash || planHash(plan)
  return state.planApproval?.status === "passed" && state.planApproval?.planHash === hash
}

export async function importPlan(root, slug, planInput) {
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
  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (Object.values(loaded.state.tasks || {}).some((record) => record.status === "running")) {
      throw new Error("cannot replace PLAN.json while a task is running")
    }

    await writeJson(loaded.paths.plan, plan)
    const hash = planHash(plan)
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
      await atomicWrite(path.join(loaded.paths.tasks, `${task.id}.md`), taskBrief(task))
    }

    const updatedAt = now()
    const state = {
      ...loaded.state,
      schemaVersion: STATE_SCHEMA,
      goal: plan.goal,
      status: "awaiting-plan-approval",
      updatedAt,
      planImportedAt: updatedAt,
      planHash: hash,
      planApproval: { status: "pending", planHash: hash, at: updatedAt, evidence: null },
      integrationVerification: null,
      tasks: stateTasks,
      nextAction: "Run ues-plan-checker, then record PASS with 'ocskill work approve-plan'.",
    }
    await writeJson(loaded.paths.state, state)
    return { plan, analysis, state, paths: loaded.paths }
  })
}

export async function approvePlan(root, slug, evidence) {
  const evidenceText = String(evidence || "").trim()
  if (!evidenceText) throw new Error("plan approval requires non-empty plan-checker evidence")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    const hash = planHash(loaded.plan)
    if (loaded.state.planHash && loaded.state.planHash !== hash) {
      throw new Error("PLAN.json changed after import; re-import it before approval")
    }

    const timestamp = now()
    loaded.state.schemaVersion = STATE_SCHEMA
    loaded.state.planHash = hash
    loaded.state.planApproval = {
      status: "passed",
      planHash: hash,
      at: timestamp,
      evidence: evidenceText,
    }
    loaded.state.status = "ready"
    loaded.state.updatedAt = timestamp
    const next = readyTasks(loaded.plan, loaded.state)
    loaded.state.nextAction = next.length
      ? `Execute ready task(s): ${next.join(", ")}`
      : "No executable task; inspect dependencies and blockers."
    await writeJson(loaded.paths.state, loaded.state)
    return { planHash: hash, approval: loaded.state.planApproval, ready: next }
  })
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
  if (!plan || !planIsApproved(state, plan)) return []
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
    planApproval: loaded.state.planApproval || null,
    integrationVerification: loaded.state.integrationVerification || null,
    nextAction: loaded.state.nextAction,
    updatedAt: loaded.state.updatedAt,
  }
}

export async function startTask(root, slug, taskID) {
  const result = await withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing; import a valid plan first")
    if (!planIsApproved(loaded.state, loaded.plan)) {
      throw new Error("plan is not approved; run ues-plan-checker and 'ocskill work approve-plan' first")
    }

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
    loaded.state.integrationVerification = null
    loaded.state.status = "executing"
    loaded.state.updatedAt = timestamp
    loaded.state.nextAction = `Complete ${taskID}, write its report, then record fresh verification evidence.`
    await writeJson(loaded.paths.state, loaded.state)
    return { task, record: { ...record } }
  })

  return { ...result, contextPack: await contextPack(root, slug, taskID) }
}

export async function completeTask(root, slug, taskID, options = {}) {
  const evidenceText = String(options.evidence || "").trim()
  if (!evidenceText) throw new Error("completion requires non-empty fresh evidence")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    const task = taskByID(loaded.plan, taskID)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)
    if (record.status !== "running") throw new Error(`task '${taskID}' must be running before it can complete`)

    const timestamp = now()
    const reportPath = path.join(loaded.paths.reports, `${taskID}.md`)
    if (options.report) await atomicWrite(reportPath, String(options.report).trimEnd() + "\n")
    else if (!existsSync(reportPath)) {
      await atomicWrite(reportPath, `# ${taskID} report\n\nCompleted with evidence recorded in EVIDENCE.json.\n`)
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
    loaded.evidence.schemaVersion = STATE_SCHEMA
    loaded.evidence.updatedAt = timestamp

    const allComplete = loaded.plan.tasks.every((item) => loaded.state.tasks[item.id]?.status === "completed")
    const ready = allComplete ? [] : readyTasks(loaded.plan, loaded.state)
    loaded.state.integrationVerification = null
    loaded.state.status = allComplete ? "integration-verification" : "executing"
    loaded.state.updatedAt = timestamp
    loaded.state.nextAction = allComplete
      ? "Run ues-integration-verifier, then record its verdict with 'ocskill work verify-integration'."
      : ready.length
        ? `Execute ready task(s): ${ready.join(", ")}`
        : "Resolve blockers or failed dependencies before continuing."

    await writeJson(loaded.paths.evidence, loaded.evidence)
    await writeJson(loaded.paths.state, loaded.state)
    return { task, state: loaded.state, ready }
  })
}

export async function failTask(root, slug, taskID, reason) {
  const cleanReason = String(reason || "").trim()
  if (!cleanReason) throw new Error("failure reason is required")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    taskByID(loaded.plan, taskID)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)

    const timestamp = now()
    record.status = "failed"
    record.lastFailure = cleanReason
    loaded.state.integrationVerification = null
    loaded.state.updatedAt = timestamp
    loaded.state.status = "executing"
    loaded.state.nextAction = record.attempts >= 3
      ? `Re-plan or escalate ${taskID}; it has failed ${record.attempts} attempt(s).`
      : `Re-diagnose ${taskID} from fresh evidence before retrying.`
    await writeJson(loaded.paths.state, loaded.state)
    return { taskID, attempts: record.attempts, state: loaded.state }
  })
}

export async function addDecision(root, slug, decision) {
  const text = String(decision || "").trim()
  if (!text) throw new Error("decision text is required")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    loaded.state.decisions ??= []
    const timestamp = now()
    loaded.state.decisions.push({ at: timestamp, text })
    loaded.state.updatedAt = timestamp
    await writeJson(loaded.paths.state, loaded.state)
    return loaded.state
  })
}

export async function addBlocker(root, slug, blocker) {
  const text = String(blocker || "").trim()
  if (!text) throw new Error("blocker text is required")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    loaded.state.blockers ??= []
    if (!loaded.state.blockers.includes(text)) loaded.state.blockers.push(text)
    loaded.state.integrationVerification = null
    loaded.state.updatedAt = now()
    loaded.state.nextAction = "Resolve blocker: " + text
    await writeJson(loaded.paths.state, loaded.state)
    return loaded.state
  })
}

export async function resolveBlocker(root, slug, blocker) {
  const text = String(blocker || "").trim()
  if (!text) throw new Error("blocker text is required")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    loaded.state.blockers = (loaded.state.blockers || []).filter((item) => item !== text)
    loaded.state.integrationVerification = null
    loaded.state.updatedAt = now()
    const ready = readyTasks(loaded.plan, loaded.state)
    loaded.state.nextAction = loaded.state.blockers.length
      ? "Resolve remaining blocker(s) before continuing."
      : ready.length
        ? `Execute ready task(s): ${ready.join(", ")}`
        : loaded.state.status === "integration-verification"
          ? "Run integration verification and record a fresh verdict."
          : loaded.state.nextAction
    await writeJson(loaded.paths.state, loaded.state)
    return loaded.state
  })
}

export async function recordIntegrationVerification(root, slug, verdict, evidence, report = null) {
  const status = String(verdict || "").trim().toUpperCase()
  if (!["PASS", "FAIL", "PARTIAL"].includes(status)) {
    throw new Error("integration verdict must be PASS, FAIL, or PARTIAL")
  }
  const evidenceText = String(evidence || "").trim()
  if (!evidenceText) throw new Error("integration verification requires non-empty evidence")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    const incomplete = loaded.plan.tasks
      .filter((task) => loaded.state.tasks?.[task.id]?.status !== "completed")
      .map((task) => task.id)
    if (incomplete.length) {
      throw new Error("cannot record integration verification with incomplete tasks: " + incomplete.join(", "))
    }
    if (status === "PASS" && loaded.state.blockers?.length) {
      throw new Error("cannot record integration PASS while blockers remain")
    }

    const timestamp = now()
    const fingerprint = workspaceFingerprint(loaded.paths.root)
    loaded.state.integrationVerification = {
      status,
      at: timestamp,
      evidence: evidenceText,
      report: report ? String(report) : null,
      fingerprint,
    }
    loaded.state.updatedAt = timestamp
    loaded.state.status = status === "PASS" ? "ready-to-finalize" : "integration-verification"
    loaded.state.nextAction = status === "PASS"
      ? "Integration PASS recorded. Finalize only if the workspace fingerprint is unchanged."
      : "Resolve integration findings, re-run affected tasks/checks, then verify integration again."

    loaded.evidence.entries.push({
      task: "__integration_verification__",
      at: timestamp,
      evidence: evidenceText,
      verdict: status,
      fingerprint,
      verification: ["fresh cross-task integration and acceptance verification"],
    })
    loaded.evidence.schemaVersion = STATE_SCHEMA
    loaded.evidence.updatedAt = timestamp

    await writeJson(loaded.paths.evidence, loaded.evidence)
    await writeJson(loaded.paths.state, loaded.state)
    return loaded.state.integrationVerification
  })
}

export async function finalizeWork(root, slug, evidence) {
  const evidenceText = String(evidence || "").trim()
  if (!evidenceText) throw new Error("finalization requires fresh integration evidence")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    if (loaded.state.blockers?.length) throw new Error("cannot finalize while blockers remain")
    const incomplete = loaded.plan.tasks
      .filter((task) => loaded.state.tasks?.[task.id]?.status !== "completed")
      .map((task) => task.id)
    if (incomplete.length) throw new Error("cannot finalize with incomplete tasks: " + incomplete.join(", "))

    const verification = loaded.state.integrationVerification
    if (verification?.status !== "PASS") {
      throw new Error("cannot finalize without a recorded integration PASS")
    }
    const currentFingerprint = workspaceFingerprint(loaded.paths.root)
    if (verification.fingerprint !== currentFingerprint) {
      throw new Error("workspace changed after integration PASS; re-run integration verification before finalizing")
    }

    const timestamp = now()
    loaded.evidence.entries.push({
      task: "__integration__",
      at: timestamp,
      evidence: evidenceText,
      fingerprint: currentFingerprint,
      verification: ["cross-task integration and final acceptance verification"],
    })
    loaded.evidence.schemaVersion = STATE_SCHEMA
    loaded.evidence.updatedAt = timestamp

    loaded.state.status = "completed"
    loaded.state.completedAt = timestamp
    loaded.state.updatedAt = timestamp
    loaded.state.nextAction = "Work item completed; preserve evidence and report any remaining limitations accurately."

    await writeJson(loaded.paths.evidence, loaded.evidence)
    await writeJson(loaded.paths.state, loaded.state)
    return { state: loaded.state, evidence: loaded.evidence.entries.at(-1) }
  })
}

async function buildContextPack(loaded, taskID) {
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
    schemaVersion: STATE_SCHEMA,
    slug: loaded.state.slug,
    task,
    taskBrief: path.relative(loaded.paths.root, path.join(loaded.paths.tasks, `${taskID}.md`)).replaceAll("\\", "/"),
    spec: spec.slice(0, 24000),
    dependencyReports,
    decisions: loaded.state.decisions || [],
    blockers: loaded.state.blockers || [],
    planApproval: loaded.state.planApproval || null,
    workingState: {
      status: loaded.state.status,
      task: loaded.state.tasks?.[taskID],
    },
  }
}

export async function contextPack(root, slug, taskID) {
  return buildContextPack(await loadWork(root, slug), taskID)
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
