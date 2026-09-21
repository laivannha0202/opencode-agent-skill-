import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs"
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { analyzePlan, taskFiles, validatePlan } from "./task-graph.mjs"
import { buildContextManifest } from "./context-manifest.mjs"
import { relevantAcceptedLearnings } from "./learning-engine.mjs"
import { validateVerificationReceipt } from "./evidence-receipt.mjs"
import { appendRuntimeEvent, readRuntimeEvents } from "./runtime-events.mjs"
import { createGateReceipt, validateGateReceipt } from "./gate-receipt.mjs"
import { classifyEngineeringTask } from "./orchestrator-policy.mjs"

const WORK_DIR = ".ues-work"
const STATE_SCHEMA = 3
const LOCK_TIMEOUT_MS = 30_000
const LOCK_STALE_MS = 120_000
const DEFAULT_TASK_LEASE_MS = 10 * 60_000

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
    events: path.join(dir, "EVENTS.jsonl"),
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

async function journal(paths, type, data = {}) {
  return appendRuntimeEvent(paths.events, type, {
    slug: path.basename(paths.dir),
    ...data,
  })
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

const FINGERPRINT_SKIP_DIRS = new Set([
  ".git", ".ues-work", ".ues-learning", ".ues-dashboard", ".ues-sandboxes",
  "node_modules", ".next", "dist", "build", "coverage", ".venv", "venv",
  "Pods", "DerivedData", ".gradle", ".cache", ".turbo", "target", "bin", "obj",
])

function nonGitWorkspaceFingerprint(root, options = {}) {
  const maxFiles = Math.max(100, Number(options.maxFiles || 5000))
  const maxFileBytes = Math.max(64 * 1024, Number(options.maxFileBytes || 2 * 1024 * 1024))
  const files = []

  function visit(dir) {
    if (files.length >= maxFiles) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= maxFiles) break
      if (entry.isDirectory() && FINGERPRINT_SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
        continue
      }
      if (!entry.isFile()) continue
      const relative = path.relative(root, full).replaceAll("\\", "/")
      let info
      try { info = statSync(full) } catch { continue }
      files.push({ full, relative, size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  visit(root)
  const hash = createHash("sha256")
  hash.update("non-git-workspace-v2\n")
  hash.update("truncated=" + String(files.length >= maxFiles) + "\n")
  for (const file of files) {
    hash.update(file.relative + "\0" + file.size + "\0")
    if (file.size <= maxFileBytes) {
      try {
        hash.update(readFileSync(file.full))
      } catch {
        hash.update("READ_ERROR:" + file.mtimeMs)
      }
    } else {
      let fd = null
      try {
        fd = openSync(file.full, "r")
        const sampleBytes = Math.min(64 * 1024, file.size)
        const first = Buffer.allocUnsafe(sampleBytes)
        const last = Buffer.allocUnsafe(sampleBytes)
        readSync(fd, first, 0, sampleBytes, 0)
        readSync(fd, last, 0, sampleBytes, Math.max(0, file.size - sampleBytes))
        hash.update("LARGE_SAMPLE:")
        hash.update(first)
        hash.update(last)
      } catch {
        hash.update("READ_ERROR:" + file.mtimeMs)
      } finally {
        if (fd !== null) {
          try { closeSync(fd) } catch {}
        }
      }
    }
    hash.update("\n")
  }
  return hash.digest("hex")
}

export function workspaceFingerprint(root) {
  root = path.resolve(root)
  const inside = gitCapture(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0) {
    return nonGitWorkspaceFingerprint(root)
  }

  const parts = []
  const commands = [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).ues-work", ":(exclude).ues-learning", ":(exclude).ues-dashboard", ":(exclude).ues-sandboxes"],
    ["diff", "--binary", "--no-ext-diff", "--", ".", ":(exclude).ues-work", ":(exclude).ues-learning", ":(exclude).ues-dashboard", ":(exclude).ues-sandboxes"],
    ["diff", "--cached", "--binary", "--no-ext-diff", "--", ".", ":(exclude).ues-work", ":(exclude).ues-learning", ":(exclude).ues-dashboard", ":(exclude).ues-sandboxes"],
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
    receipts: [],
    gateReceipts: [],
  })
  await journal(paths, "work.init", { goal: cleanGoal })

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

function evidencePolicyForPlan(plan) {
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  const highRisk = tasks.some((task) => ["high", "critical"].includes(task?.risk))
  const longHorizon = tasks.length > 1 || plan?.mode === "long-horizon" || plan?.longHorizon === true
  return {
    schemaVersion: 1,
    strict: highRisk || longHorizon,
    receiptRequiredForTasks: highRisk || longHorizon,
    structuredPlanApproval: highRisk || longHorizon,
    structuredIntegrationApproval: highRisk || longHorizon,
    reason: highRisk ? "high-risk-plan" : longHorizon ? "long-horizon-plan" : "standard-plan",
  }
}

function currentEvidencePolicy(state, plan) {
  return state?.evidencePolicy || evidencePolicyForPlan(plan)
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
        runId: null,
        owner: null,
        heartbeatAt: null,
        leaseExpiresAt: null,
        evidenceStrength: null,
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
      evidencePolicy: evidencePolicyForPlan(plan),
      tasks: stateTasks,
      nextAction: "Run ues-plan-checker, then record PASS with 'ocskill work approve-plan'.",
    }
    await writeJson(loaded.paths.state, state)
    await journal(loaded.paths, "plan.imported", {
      planHash: hash,
      taskCount: plan.tasks.length,
    })
    return { plan, analysis, state, paths: loaded.paths }
  })
}

export async function approvePlan(root, slug, evidence, options = {}) {
  const evidenceText = String(evidence || options.receipt?.evidence || "").trim()

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    const hash = planHash(loaded.plan)
    if (loaded.state.planHash && loaded.state.planHash !== hash) {
      throw new Error("PLAN.json changed after import; re-import it before approval")
    }

    const policy = currentEvidencePolicy(loaded.state, loaded.plan)
    let receipt = options.receipt || null
    if (receipt) {
      const validation = validateGateReceipt(receipt)
      if (!validation.valid) {
        const error = new Error("invalid plan verification receipt")
        error.validation = validation
        throw error
      }
      if (receipt.kind !== "plan-verification") throw new Error("plan approval requires a plan-verification receipt")
      if (receipt.slug !== slug) throw new Error("plan verification receipt slug mismatch")
      if (receipt.verdict !== "PASS") throw new Error("plan verification receipt must record PASS")
      if (receipt.planHash !== hash) throw new Error("plan verification receipt planHash mismatch")
    } else if (policy.structuredPlanApproval) {
      throw new Error("strict plan approval requires a structured plan-verification receipt")
    }

    if (!evidenceText) throw new Error("plan approval requires non-empty plan-checker evidence")

    const timestamp = now()
    loaded.state.schemaVersion = STATE_SCHEMA
    loaded.state.planHash = hash
    loaded.state.evidencePolicy = policy
    loaded.state.planApproval = {
      status: "passed",
      planHash: hash,
      at: timestamp,
      evidence: evidenceText,
      receipt: receipt || null,
    }
    if (receipt) {
      loaded.evidence.gateReceipts ??= []
      if (!loaded.evidence.gateReceipts.some((item) => item.id === receipt.id)) {
        loaded.evidence.gateReceipts.push({ ...receipt, recordedAt: timestamp })
      }
      loaded.evidence.updatedAt = timestamp
      await writeJson(loaded.paths.evidence, loaded.evidence)
    }
    loaded.state.status = "ready"
    loaded.state.updatedAt = timestamp
    const next = readyTasks(loaded.plan, loaded.state)
    loaded.state.nextAction = next.length
      ? `Execute ready task(s): ${next.join(", ")}`
      : "No executable task; inspect dependencies and blockers."
    await writeJson(loaded.paths.state, loaded.state)
    await journal(loaded.paths, "plan.approved", {
      planHash: hash,
      ready: next,
      structured: Boolean(receipt),
      receiptId: receipt?.id || null,
    })
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
  const running = Object.entries(loaded.state.tasks || {})
    .filter(([, value]) => value.status === "running")
    .map(([taskID, value]) => ({
      taskID,
      runId: value.runId || null,
      attempts: value.attempts || 0,
      sessionID: value.owner?.sessionID || null,
      executionDir: value.owner?.executionDir || null,
      sandboxDir: value.owner?.sandboxDir || null,
      heartbeatAt: value.heartbeatAt || null,
      leaseExpiresAt: value.leaseExpiresAt || null,
    }))
  const taskEntries = Object.values(loaded.state.tasks || {})
  const receiptBacked = taskEntries.filter((value) => value.evidenceStrength === "receipt-backed").length
  const completed = taskEntries.filter((value) => value.status === "completed").length

  return {
    slug,
    root: loaded.paths.root,
    dir: loaded.paths.dir,
    status: loaded.state.status,
    goal: loaded.state.goal,
    counts,
    ready: readyTasks(loaded.plan, loaded.state),
    running,
    blockers: loaded.state.blockers || [],
    planApproval: loaded.state.planApproval || null,
    integrationVerification: loaded.state.integrationVerification || null,
    evidence: {
      receiptBacked,
      completed,
      coverage: completed ? receiptBacked / completed : 0,
      receipts: (loaded.evidence.receipts || []).length,
      gateReceipts: (loaded.evidence.gateReceipts || []).length,
    },
    nextAction: loaded.state.nextAction,
    updatedAt: loaded.state.updatedAt,
  }
}

export async function startTask(root, slug, taskID, options = {}) {
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
    const leaseMs = Math.max(30_000, Number(options.leaseMs || DEFAULT_TASK_LEASE_MS))
    record.status = "running"
    record.attempts += 1
    record.startedAt = timestamp
    record.lastFailure = null
    record.runId = randomUUID()
    record.owner = {
      pid: Number(options.pid || process.pid),
      sessionID: options.sessionID || null,
    }
    record.heartbeatAt = timestamp
    record.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
    record.evidenceStrength = null
    loaded.state.integrationVerification = null
    loaded.state.status = "executing"
    loaded.state.updatedAt = timestamp
    loaded.state.nextAction = `Complete ${taskID}, write its report, then record fresh verification evidence.`
    await writeJson(loaded.paths.state, loaded.state)
    await journal(loaded.paths, "task.started", {
      task: taskID,
      runId: record.runId,
      attempt: record.attempts,
      owner: record.owner,
      leaseExpiresAt: record.leaseExpiresAt,
    })
    return { task, record: { ...record } }
  })

  return { ...result, contextPack: await contextPack(root, slug, taskID) }
}


function assertRunFence(record, options = {}) {
  const runId = options.runId || null
  if (record.runId && !runId) {
    throw new Error("task run fence requires the active runId")
  }
  if (runId && record.runId !== runId) {
    throw new Error("task run fence mismatch; the executor lease is stale")
  }
}

export async function attachTaskSession(root, slug, taskID, runId, sessionID, options = {}) {
  const value = String(sessionID || "").trim()
  if (!value) throw new Error("sessionID is required")
  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)
    if (record.status !== "running") throw new Error(`task '${taskID}' is not running`)
    assertRunFence(record, { runId })
    record.owner ??= { pid: process.pid, sessionID: null }
    record.owner.sessionID = value
    record.owner.executionDir = options.executionDir ? path.resolve(options.executionDir) : null
    record.owner.sandboxDir = options.sandboxDir ? path.resolve(options.sandboxDir) : null
    loaded.state.updatedAt = now()
    await writeJson(loaded.paths.state, loaded.state)
    await journal(loaded.paths, "task.session-attached", {
      task: taskID,
      runId: record.runId,
      sessionID: value,
      executionDir: record.owner.executionDir,
      sandboxDir: record.owner.sandboxDir,
    })
    return {
      taskID,
      runId: record.runId,
      sessionID: value,
      executionDir: record.owner.executionDir,
      sandboxDir: record.owner.sandboxDir,
    }
  })
}

export async function heartbeatTask(root, slug, taskID, runId, options = {}) {
  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)
    if (record.status !== "running") throw new Error(`task '${taskID}' is not running`)
    assertRunFence(record, { runId })
    const leaseMs = Math.max(30_000, Number(options.leaseMs || DEFAULT_TASK_LEASE_MS))
    const timestamp = now()
    record.heartbeatAt = timestamp
    record.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString()
    loaded.state.updatedAt = timestamp
    await writeJson(loaded.paths.state, loaded.state)
    await journal(loaded.paths, "task.heartbeat", {
      task: taskID,
      runId: record.runId,
      heartbeatAt: record.heartbeatAt,
      leaseExpiresAt: record.leaseExpiresAt,
    })
    return { taskID, runId: record.runId, heartbeatAt: record.heartbeatAt, leaseExpiresAt: record.leaseExpiresAt }
  })
}

export async function recoverTask(root, slug, taskID, options = {}) {
  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)
    if (record.status !== "running") throw new Error(`task '${taskID}' is not running`)

    const expires = Date.parse(record.leaseExpiresAt || "")
    const stale = options.force || !Number.isFinite(expires) || expires <= Date.now()
    if (!stale) throw new Error(`task '${taskID}' lease is still active`)

    const timestamp = now()
    const previousOwner = record.owner ? { ...record.owner } : null
    const previousRunId = record.runId || null
    record.status = "failed"
    record.lastFailure = String(options.reason || "stale executor lease recovered after interruption")
    record.lastOwner = previousOwner
    record.lastRunId = previousRunId
    record.runId = null
    record.owner = null
    record.heartbeatAt = null
    record.leaseExpiresAt = null

    loaded.state.integrationVerification = null
    loaded.state.status = "executing"
    loaded.state.updatedAt = timestamp
    loaded.state.nextAction = `Recovered stale task ${taskID}. Re-diagnose and retry from fresh evidence.`
    await writeJson(loaded.paths.state, loaded.state)
    await journal(loaded.paths, "task.recovered", {
      tasks: [taskID],
      previousRunId,
      previousOwner,
      forced: Boolean(options.force),
    })
    return { recovered: [taskID], previousRunId, previousOwner, state: loaded.state }
  })
}

export async function recoverStaleTasks(root, slug, options = {}) {
  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    const timestamp = now()
    const recovered = []
    for (const [taskID, record] of Object.entries(loaded.state.tasks || {})) {
      if (record.status !== "running") continue
      const expires = Date.parse(record.leaseExpiresAt || "")
      const stale = options.force || !Number.isFinite(expires) || expires <= Date.now()
      if (!stale) continue
      const previousOwner = record.owner ? { ...record.owner } : null
      const previousRunId = record.runId || null
      record.status = "failed"
      record.lastFailure = "stale executor lease recovered after interruption"
      record.lastOwner = previousOwner
      record.lastRunId = previousRunId
      record.runId = null
      record.owner = null
      record.heartbeatAt = null
      record.leaseExpiresAt = null
      recovered.push(taskID)
    }
    if (recovered.length) {
      loaded.state.integrationVerification = null
      loaded.state.status = "executing"
      loaded.state.updatedAt = timestamp
      loaded.state.nextAction = `Recovered stale task(s): ${recovered.join(", ")}. Re-diagnose and retry from fresh evidence.`
      await writeJson(loaded.paths.state, loaded.state)
      await journal(loaded.paths, "task.recovered", { tasks: recovered })
    }
    return { recovered, state: loaded.state }
  })
}

export async function recordVerificationReceipt(root, slug, taskID, receipt) {
  const validation = validateVerificationReceipt(receipt)
  if (!validation.valid) {
    const error = new Error("invalid verification receipt")
    error.validation = validation
    throw error
  }

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)
    if (record.status !== "running") throw new Error(`task '${taskID}' must be running to record verification`)
    assertRunFence(record, { runId: receipt.runId })
    loaded.evidence.receipts ??= []
    const normalized = {
      ...receipt,
      task: taskID,
      runId: record.runId,
      recordedAt: now(),
    }
    loaded.evidence.receipts.push(normalized)
    loaded.evidence.schemaVersion = STATE_SCHEMA
    loaded.evidence.updatedAt = normalized.recordedAt
    await writeJson(loaded.paths.evidence, loaded.evidence)
    await journal(loaded.paths, "verification.receipt", {
      task: taskID,
      runId: record.runId,
      receiptId: normalized.id,
      passed: normalized.passed,
    })
    return normalized
  })
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
    assertRunFence(record, options)

    const timestamp = now()
    const receipts = (loaded.evidence.receipts || []).filter((item) => item.task === taskID && (!record.runId || item.runId === record.runId))
    const successfulReceipts = receipts.filter((item) => item.passed)
    const evidencePolicy = currentEvidencePolicy(loaded.state, loaded.plan)
    const currentFingerprint = workspaceFingerprint(loaded.paths.root)
    const freshSuccessfulReceipts = successfulReceipts.filter(
      (item) => item.workspaceAfter && item.workspaceAfter === currentFingerprint,
    )
    if (evidencePolicy.receiptRequiredForTasks && freshSuccessfulReceipts.length === 0) {
      throw new Error("strict task completion requires a successful verification receipt for the active run and current workspace fingerprint")
    }

    const acceptedReceipts = evidencePolicy.receiptRequiredForTasks
      ? freshSuccessfulReceipts
      : successfulReceipts

    const reportPath = path.join(loaded.paths.reports, `${taskID}.md`)
    if (options.report) await atomicWrite(reportPath, String(options.report).trimEnd() + "\n")
    else if (!existsSync(reportPath)) {
      await atomicWrite(reportPath, `# ${taskID} report\n\nCompleted with evidence recorded in EVIDENCE.json.\n`)
    }

    record.status = "completed"
    record.completedAt = timestamp
    record.report = path.relative(loaded.paths.root, reportPath).replaceAll("\\", "/")
    record.evidenceStrength = acceptedReceipts.length ? "receipt-backed" : "narrative"
    record.runId = null
    record.owner = null
    record.heartbeatAt = null
    record.leaseExpiresAt = null

    loaded.evidence.entries.push({
      task: taskID,
      at: timestamp,
      evidence: evidenceText,
      verification: task.verification,
      evidenceStrength: record.evidenceStrength,
      receiptIDs: acceptedReceipts.map((item) => item.id),
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
    await journal(loaded.paths, "task.completed", {
      task: taskID,
      evidenceStrength: record.evidenceStrength,
      receiptIDs: acceptedReceipts.map((item) => item.id),
    })
    return { task, state: loaded.state, ready }
  })
}

export async function failTask(root, slug, taskID, reason, options = {}) {
  const cleanReason = String(reason || "").trim()
  if (!cleanReason) throw new Error("failure reason is required")

  return withWorkLock(root, slug, async () => {
    const loaded = await loadWork(root, slug)
    if (!loaded.plan) throw new Error("PLAN.json is missing")
    taskByID(loaded.plan, taskID)
    const record = loaded.state.tasks?.[taskID]
    if (!record) throw new Error(`task '${taskID}' is not tracked`)
    if (record.status !== "running") throw new Error(`task '${taskID}' must be running before it can fail`)
    assertRunFence(record, options)

    const timestamp = now()
    record.status = "failed"
    record.lastFailure = cleanReason
    record.runId = null
    record.owner = null
    record.heartbeatAt = null
    record.leaseExpiresAt = null
    loaded.state.integrationVerification = null
    loaded.state.updatedAt = timestamp
    loaded.state.status = "executing"
    loaded.state.nextAction = record.attempts >= 3
      ? `Re-plan or escalate ${taskID}; it has failed ${record.attempts} attempt(s).`
      : `Re-diagnose ${taskID} from fresh evidence before retrying.`
    await writeJson(loaded.paths.state, loaded.state)
    await journal(loaded.paths, "task.failed", {
      task: taskID,
      attempts: record.attempts,
      reason: cleanReason,
    })
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

export async function recordIntegrationVerification(root, slug, verdict, evidence, report = null, options = {}) {
  const status = String(verdict || "").trim().toUpperCase()
  if (!["PASS", "FAIL", "PARTIAL"].includes(status)) {
    throw new Error("integration verdict must be PASS, FAIL, or PARTIAL")
  }
  const evidenceText = String(evidence || options.receipt?.evidence || "").trim()
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
    const policy = currentEvidencePolicy(loaded.state, loaded.plan)
    const receipt = options.receipt || null
    if (receipt) {
      const validation = validateGateReceipt(receipt)
      if (!validation.valid) {
        const error = new Error("invalid integration verification receipt")
        error.validation = validation
        throw error
      }
      if (receipt.kind !== "integration-verification") throw new Error("integration verification requires an integration-verification receipt")
      if (receipt.slug !== slug) throw new Error("integration verification receipt slug mismatch")
      if (receipt.verdict !== status) throw new Error("integration verification receipt verdict mismatch")
      if (receipt.workspaceFingerprint !== fingerprint) {
        throw new Error("integration verification receipt workspace fingerprint mismatch")
      }
    } else if (status === "PASS" && policy.structuredIntegrationApproval) {
      throw new Error("strict integration PASS requires a structured integration-verification receipt")
    }
    loaded.state.integrationVerification = {
      status,
      at: timestamp,
      evidence: evidenceText,
      report: report ? String(report) : null,
      fingerprint,
      receipt: receipt || null,
    }
    if (receipt) {
      loaded.evidence.gateReceipts ??= []
      if (!loaded.evidence.gateReceipts.some((item) => item.id === receipt.id)) {
        loaded.evidence.gateReceipts.push({ ...receipt, recordedAt: timestamp })
      }
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
    await journal(loaded.paths, "integration.verified", {
      verdict: status,
      fingerprint,
      receiptId: receipt?.id || null,
    })
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
    await journal(loaded.paths, "work.finalized", { fingerprint: currentFingerprint })
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

  const taskText = [
    task.title,
    task.summary,
    ...(task.acceptance || []),
    ...(task.verification || []),
  ].filter(Boolean).join(" ")
  const contextPolicy = classifyEngineeringTask(taskText, {
    changedFiles: taskFiles(task).length,
    risk: task.risk,
  })
  const contextManifest = await buildContextManifest(
    loaded.paths.root,
    task,
    {
      budget: contextPolicy.contextBudget,
      strategy: contextPolicy.profile?.contextStrategy || "semantic+graph+git",
    },
  ).catch(() => null)
  const learnings = await relevantAcceptedLearnings(
    loaded.paths.root,
    [task.title, task.summary, ...(task.acceptance || [])].join(" "),
  ).catch(() => [])

  return {
    schemaVersion: STATE_SCHEMA,
    contextPolicy,
    slug: loaded.state.slug,
    task,
    taskBrief: path.relative(loaded.paths.root, path.join(loaded.paths.tasks, `${taskID}.md`)).replaceAll("\\", "/"),
    spec: spec.slice(0, 24000),
    dependencyReports,
    decisions: loaded.state.decisions || [],
    blockers: loaded.state.blockers || [],
    planApproval: loaded.state.planApproval || null,
    contextManifest,
    acceptedLearnings: learnings,
    workingState: {
      status: loaded.state.status,
      task: loaded.state.tasks?.[taskID],
    },
  }
}

export async function createPlanVerificationReceipt(root, slug, input = {}) {
  const loaded = await loadWork(root, slug)
  if (!loaded.plan) throw new Error("PLAN.json is missing")
  const hash = planHash(loaded.plan)
  return createGateReceipt({
    kind: "plan-verification",
    slug,
    verdict: input.verdict || "PASS",
    verifier: input.verifier || "ues-plan-checker",
    sessionID: input.sessionID || null,
    runId: input.runId || null,
    planHash: hash,
    evidence: input.evidence,
    report: input.report,
  })
}

export async function createIntegrationVerificationReceipt(root, slug, input = {}) {
  await loadWork(root, slug)
  return createGateReceipt({
    kind: "integration-verification",
    slug,
    verdict: input.verdict || "PASS",
    verifier: input.verifier || "ues-integration-verifier",
    sessionID: input.sessionID || null,
    runId: input.runId || null,
    workspaceFingerprint: workspaceFingerprint(root),
    evidence: input.evidence,
    report: input.report,
  })
}

export async function contextPack(root, slug, taskID) {
  return buildContextPack(await loadWork(root, slug), taskID)
}

export async function runtimeEvents(root, slug, options = {}) {
  const paths = workPaths(root, slug)
  return readRuntimeEvents(paths.events, options)
}

export async function resumeWork(root, slug) {
  await recoverStaleTasks(root, slug).catch(() => ({ recovered: [] }))
  const loaded = await loadWork(root, slug)
  return {
    status: await workStatus(root, slug),
    planAnalysis: loaded.plan ? analyzePlan(loaded.plan) : null,
    completedEvidence: loaded.evidence.entries || [],
    decisions: loaded.state.decisions || [],
    recentEvents: await readRuntimeEvents(loaded.paths.events, { limit: 50 }),
  }
}
