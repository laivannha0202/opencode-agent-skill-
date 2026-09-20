import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { installResources } from "../lib/installer.mjs"
import { copyCurrentOpenCodeAuth } from "../lib/eval-auth.mjs"
import { parseOpenCodeTelemetry } from "../lib/eval-telemetry.mjs"
import { buildOpenCodeRunArgs, parseOpenCodeMajor } from "../lib/opencode-compat.mjs"
import { snapshotWorkspace, diffWorkspaceSnapshots } from "../lib/workspace-snapshot.mjs"
import { runProcess } from "../lib/process-runner.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const abortController = new AbortController()
let interrupted = false
process.once("SIGINT", () => {
  interrupted = true
  console.warn("\n[eval] interrupt requested; stopping the active OpenCode process tree...")
  abortController.abort()
})

function argValue(name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}

function hasArg(name) {
  return args.includes(name)
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function findWindowsCommand(name) {
  if (path.isAbsolute(name) && existsSync(name)) return name
  const result = spawnSync("where", [name], { encoding: "utf8" })
  if (result.status !== 0 || !result.stdout) return null
  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return matches.find((item) => /\.(exe|cmd|bat)$/i.test(item)) || matches[0] || null
}

function quoteCmd(value) {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value
  return '"' + value.replaceAll('"', '""') + '"'
}

function findNodeShimEntry(cmdPath) {
  const dir = path.dirname(cmdPath)
  let shim = ""
  try {
    shim = readFileSync(cmdPath, "utf8")
  } catch {
    return null
  }
  const match = shim.match(/node_modules[\\/][^\s"]+?\.(?:js|mjs)/gi)?.at(-1)
  if (!match) return null
  const entry = path.resolve(dir, match)
  return existsSync(entry) ? entry : null
}

function runCommand(executable, commandArgs, options = {}) {
  if (process.platform !== "win32") {
    return spawnSync(executable, commandArgs, options)
  }

  const resolved = findWindowsCommand(executable)
  if (!resolved) {
    return { status: 127, stdout: "", stderr: "Command not found: " + executable }
  }

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const entry = findNodeShimEntry(resolved)
    if (entry) return spawnSync(process.execPath, [entry, ...commandArgs], options)

    const line = [resolved, ...commandArgs].map(quoteCmd).join(" ")
    return spawnSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", line],
      options,
    )
  }

  return spawnSync(resolved, commandArgs, options)
}


function runAsyncCommand(executable, commandArgs, options = {}) {
  if (process.platform !== "win32") return runProcess(executable, commandArgs, options)

  const resolved = findWindowsCommand(executable)
  if (!resolved) {
    return Promise.resolve({
      status: 127,
      signal: null,
      stdout: "",
      stderr: "Command not found: " + executable,
      durationMs: 0,
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    })
  }

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const entry = findNodeShimEntry(resolved)
    if (entry) return runProcess(process.execPath, [entry, ...commandArgs], options)
    const line = [resolved, ...commandArgs].map(quoteCmd).join(" ")
    return runProcess(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], options)
  }

  return runProcess(resolved, commandArgs, options)
}

function excerpt(value, limit = 12000) {
  if (!value) return ""
  const text = String(value)
  return text.length <= limit ? text : text.slice(0, limit) + "\n...[truncated]"
}

async function inspectLongOrchestration(workspace) {
  const workRoot = path.join(workspace, ".ues-work")
  const dirs = await readdir(workRoot, { withFileTypes: true }).catch(() => [])
  const items = []

  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const dir = path.join(workRoot, entry.name)
    try {
      const [state, plan, evidence] = await Promise.all([
        readFile(path.join(dir, "STATE.json"), "utf8").then(JSON.parse),
        readFile(path.join(dir, "PLAN.json"), "utf8").then(JSON.parse),
        readFile(path.join(dir, "EVIDENCE.json"), "utf8").then(JSON.parse),
      ])
      const tasks = Object.values(state.tasks || {})
      const evidenceTasks = new Set((evidence.entries || []).map((item) => item.task))
      const receiptBackedTasks = new Set(
        (evidence.receipts || []).filter((item) => item.passed).map((item) => item.task),
      )
      const plannedIDs = (plan.tasks || []).map((item) => item.id)
      const item = {
        slug: entry.name,
        taskCount: Array.isArray(plan.tasks) ? plan.tasks.length : 0,
        planApproved: state.planApproval?.status === "passed",
        structuredPlanReceipt:
          state.planApproval?.receipt?.kind === "plan-verification" &&
          state.planApproval?.receipt?.verdict === "PASS" &&
          state.planApproval?.receipt?.planHash === state.planHash,
        attemptedTasks: tasks.filter((task) => Number(task.attempts || 0) > 0).length,
        completedTasks: tasks.filter((task) => task.status === "completed").length,
        receiptBackedTasks: plannedIDs.filter((id) => receiptBackedTasks.has(id)).length,
        receiptCoverage: plannedIDs.length
          ? plannedIDs.filter((id) => receiptBackedTasks.has(id)).length / plannedIDs.length
          : 0,
        integrationPassed: state.integrationVerification?.status === "PASS",
        structuredIntegrationReceipt:
          state.integrationVerification?.receipt?.kind === "integration-verification" &&
          state.integrationVerification?.receipt?.verdict === "PASS" &&
          state.integrationVerification?.receipt?.workspaceFingerprint === state.integrationVerification?.fingerprint,
        integrationEvidence: evidenceTasks.has("__integration_verification__"),
        finalizedEvidence: evidenceTasks.has("__integration__"),
        completed: state.status === "completed",
      }
      item.valid =
        item.taskCount >= 2 &&
        item.planApproved &&
        item.structuredPlanReceipt &&
        item.attemptedTasks === item.taskCount &&
        item.completedTasks === item.taskCount &&
        item.receiptBackedTasks === item.taskCount &&
        item.integrationPassed &&
        item.structuredIntegrationReceipt &&
        item.integrationEvidence &&
        item.finalizedEvidence &&
        item.completed
      items.push(item)
    } catch (error) {
      items.push({ slug: entry.name, valid: false, error: String(error?.message || error) })
    }
  }

  return {
    required: true,
    valid: items.some((item) => item.valid),
    items,
  }
}

const model = argValue("--model", process.env.UES_EVAL_MODEL)
const variant = argValue("--variant", process.env.UES_EVAL_VARIANT)
const trials = Math.min(positiveInt(argValue("--trials"), 1), 20)
const taskFilter = argValue("--task")
const requestedMode = argValue("--mode", "both")
const keep = hasArg("--keep")
const authMode = argValue("--auth", "env-only")
const suiteName = argValue("--suite", "live")
const timeoutMs = positiveInt(argValue("--timeout-ms"), 15 * 60_000)
const idleTimeoutMs = positiveInt(argValue("--idle-timeout-ms"), 5 * 60_000)
const heartbeatMs = positiveInt(argValue("--heartbeat-ms"), 30_000)
const suiteRoot = path.join(root, "evals", suiteName)

if (!model) {
  console.error("Usage: node scripts/eval-live.mjs --model provider/model [--suite live|long|polyglot] [--variant high] [--trials N] [--task id] [--mode baseline|ues|both] [--auth env-only|current] [--output-dir path] [--keep] [--timeout-ms N] [--idle-timeout-ms N] [--heartbeat-ms N]")
  console.error("You can also set UES_EVAL_MODEL and UES_EVAL_VARIANT.")
  process.exit(2)
}

if (!["baseline", "ues", "both"].includes(requestedMode)) {
  console.error("--mode must be baseline, ues, or both")
  process.exit(2)
}

if (!["env-only", "current"].includes(authMode)) {
  console.error("--auth must be env-only or current")
  process.exit(2)
}

const probe = runCommand("opencode", ["--version"], { encoding: "utf8" })
if (probe.status !== 0) {
  console.error("OpenCode CLI is required for live evals.")
  console.error(excerpt(probe.stderr || probe.stdout))
  process.exit(2)
}
const opencodeVersion = String(probe.stdout || probe.stderr || "").trim()
const parsedOpenCodeMajor = parseOpenCodeMajor(opencodeVersion)
const opencodeMajor = parsedOpenCodeMajor ?? 1
if (parsedOpenCodeMajor === null) {
  console.warn("[eval] could not parse OpenCode version; using the conservative OpenCode 1.x invocation.")
}

if (!["live", "long", "polyglot"].includes(suiteName)) {
  console.error("--suite must be live, long, or polyglot")
  process.exit(2)
}

const suite = JSON.parse(await readFile(path.join(suiteRoot, "tasks.json"), "utf8"))
let tasks = suite.tasks || []
if (taskFilter) tasks = tasks.filter((task) => task.id === taskFilter)
if (tasks.length === 0) {
  console.error(taskFilter ? "Unknown task: " + taskFilter : "No live eval tasks found.")
  process.exit(2)
}

const modes = requestedMode === "both" ? ["baseline", "ues"] : [requestedMode]
const invocationDir = process.cwd()
const runRoot = await mkdtemp(path.join(os.tmpdir(), "ues-live-eval-"))
const resultDir = path.resolve(
  argValue("--output-dir", path.join(invocationDir, ".ues-evals")),
)
await mkdir(resultDir, { recursive: true })

const results = []
const oldConfigDir = process.env.OPENCODE_CONFIG_DIR

try {
  for (const task of tasks) {
    if (interrupted) break
    for (const mode of modes) {
      if (interrupted) break
      for (let trial = 1; trial <= trials; trial += 1) {
        if (interrupted) break
        const isolatedRoot = path.join(runRoot, task.id + "-" + mode + "-" + trial)
        const workspace = path.join(isolatedRoot, "workspace")
        const isolatedHome = path.join(isolatedRoot, "home")
        const xdgRoot = path.join(isolatedHome, ".config")
        const configDir = path.join(xdgRoot, "opencode")
        const dataRoot = path.join(isolatedRoot, "data")
        const cacheRoot = path.join(isolatedRoot, "cache")
        const stateRoot = path.join(isolatedRoot, "state")

        await mkdir(configDir, { recursive: true })
        await mkdir(dataRoot, { recursive: true })
        await mkdir(cacheRoot, { recursive: true })
        await mkdir(stateRoot, { recursive: true })
        await cp(path.join(suiteRoot, task.fixture), workspace, { recursive: true })
        const beforeSnapshot = await snapshotWorkspace(workspace)

        if (authMode === "current") {
          const auth = await copyCurrentOpenCodeAuth(dataRoot)
          if (!auth.copied) {
            console.warn("[eval] current auth requested but auth.json was not found; continuing with environment credentials only.")
          }
        }

        if (mode === "ues") {
          process.env.OPENCODE_CONFIG_DIR = configDir
          const installed = await installResources({ sourceRoot: root })
          if (installed.stateError) {
            throw new Error("UES install failed for live eval: " + installed.stateError)
          }
        }

        const childEnv = {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          OPENCODE_CONFIG_DIR: configDir,
          XDG_CONFIG_HOME: xdgRoot,
          XDG_DATA_HOME: dataRoot,
          XDG_CACHE_HOME: cacheRoot,
          XDG_STATE_HOME: stateRoot,
          OPENCODE_DISABLE_AUTOUPDATE: "true",
        }

        const opencodeArgs = buildOpenCodeRunArgs({
          major: opencodeMajor,
          model,
          workspace,
          variant,
          prompt: task.prompt,
        })

        console.log("[" + mode + "] " + task.id + " trial " + trial + ": starting agent")
        const agentRun = await runAsyncCommand("opencode", opencodeArgs, {
          cwd: workspace,
          env: childEnv,
          maxBuffer: 4 * 1024 * 1024,
          heartbeatMs,
          timeoutMs,
          idleTimeoutMs,
          signal: abortController.signal,
          onHeartbeat: ({ elapsedMs, idleMs }) => {
            console.log(
              "[" + mode + "] " + task.id + " trial " + trial +
              ": still running (" + Math.round(elapsedMs / 1000) + "s elapsed, " +
              Math.round(idleMs / 1000) + "s since output)",
            )
          },
        })
        const durationMs = agentRun.durationMs

        const graderPath = path.join(suiteRoot, task.grader)
        const graderRun = spawnSync(process.execPath, [graderPath], {
          cwd: workspace,
          env: { ...childEnv, UES_EVAL_WORKSPACE: workspace, UES_EVAL_TASK: task.id },
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        })

        const afterSnapshot = await snapshotWorkspace(workspace)
        const telemetry = parseOpenCodeTelemetry(agentRun.stdout)
        const changedFiles = diffWorkspaceSnapshots(beforeSnapshot, afterSnapshot)
        const orchestration =
          suiteName === "long" && mode === "ues"
            ? await inspectLongOrchestration(workspace)
            : { required: false, valid: true, items: [] }
        const passed =
          agentRun.status === 0 &&
          graderRun.status === 0 &&
          (!orchestration.required || orchestration.valid)
        results.push({
          task: task.id,
          mode,
          model,
          variant: variant || null,
          trial,
          passed,
          agentExit: agentRun.status,
          graderExit: graderRun.status,
          durationMs,
          timedOut: agentRun.timedOut,
          idleTimedOut: agentRun.idleTimedOut,
          aborted: agentRun.aborted,
          authMode,
          opencodeVersion,
          opencodeMajor,
          telemetry,
          changedFiles,
          orchestration,
          agentStdout: excerpt(agentRun.stdout),
          agentStderr: excerpt(agentRun.stderr),
          graderStdout: excerpt(graderRun.stdout),
          graderStderr: excerpt(graderRun.stderr),
          workspace: keep ? workspace : null,
          timestamp: new Date().toISOString(),
        })

        if (agentRun.aborted) interrupted = true
        console.log(
          "[" + mode + "] " + task.id + " trial " + trial + ": " +
          (passed ? "PASS" : "FAIL") +
          " (agent=" + agentRun.status + ", grader=" + graderRun.status +
          (orchestration.required ? ", orchestration=" + (orchestration.valid ? "PASS" : "FAIL") : "") +
          (agentRun.timedOut ? ", timeout=hard" : agentRun.idleTimedOut ? ", timeout=idle" : "") +
          ", " + durationMs + "ms)",
        )
      }
    }
  }
} finally {
  if (oldConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = oldConfigDir

  if (!keep) await rm(runRoot, { recursive: true, force: true })
}

const summary = {}
for (const mode of modes) {
  const subset = results.filter((item) => item.mode === mode)
  const passed = subset.filter((item) => item.passed).length
  summary[mode] = {
    passed,
    total: subset.length,
    passRate: subset.length ? passed / subset.length : 0,
  }
}

const safeModel = model.replace(/[^a-zA-Z0-9._-]+/g, "-")
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const resultFile = path.join(resultDir, stamp + "-" + suiteName + "-" + safeModel + ".json")
await writeFile(
  resultFile,
  JSON.stringify(
    {
      schemaVersion: 1,
      suite: suiteName,
      suiteVersion: suite.version,
      model,
      variant: variant || null,
      trials,
      taskFilter: taskFilter || null,
      authMode,
      timeoutMs,
      idleTimeoutMs,
      heartbeatMs,
      opencodeVersion,
      opencodeMajor,
      modes,
      summary,
      results,
    },
    null,
    2,
  ) + "\n",
  "utf8",
)

console.log("\nSummary")
for (const [mode, item] of Object.entries(summary)) {
  console.log("- " + mode + ": " + item.passed + "/" + item.total + " (" + (item.passRate * 100).toFixed(1) + "%)")
}
console.log("Result: " + resultFile)
if (keep) console.log("Temporary workspaces kept under: " + runRoot)
if (interrupted) process.exitCode = 130
