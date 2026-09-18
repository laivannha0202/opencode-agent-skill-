import { existsSync, readFileSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { installResources } from "../lib/installer.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const liveRoot = path.join(root, "evals", "live")
const args = process.argv.slice(2)

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
  }

  return spawnSync(resolved, commandArgs, options)
}

function excerpt(value, limit = 12000) {
  if (!value) return ""
  const text = String(value)
  return text.length <= limit ? text : text.slice(0, limit) + "\n...[truncated]"
}

const model = argValue("--model", process.env.UES_EVAL_MODEL)
const variant = argValue("--variant", process.env.UES_EVAL_VARIANT)
const trials = Math.min(positiveInt(argValue("--trials"), 1), 20)
const taskFilter = argValue("--task")
const requestedMode = argValue("--mode", "both")
const keep = hasArg("--keep")

if (!model) {
  console.error("Usage: node scripts/eval-live.mjs --model provider/model [--variant high] [--trials N] [--task id] [--mode baseline|ues|both] [--keep]")
  console.error("You can also set UES_EVAL_MODEL and UES_EVAL_VARIANT.")
  process.exit(2)
}

if (!["baseline", "ues", "both"].includes(requestedMode)) {
  console.error("--mode must be baseline, ues, or both")
  process.exit(2)
}

const probe = runCommand("opencode", ["--version"], { encoding: "utf8" })
if (probe.status !== 0) {
  console.error("OpenCode CLI is required for live evals.")
  console.error(excerpt(probe.stderr || probe.stdout))
  process.exit(2)
}

const suite = JSON.parse(await readFile(path.join(liveRoot, "tasks.json"), "utf8"))
let tasks = suite.tasks || []
if (taskFilter) tasks = tasks.filter((task) => task.id === taskFilter)
if (tasks.length === 0) {
  console.error(taskFilter ? "Unknown task: " + taskFilter : "No live eval tasks found.")
  process.exit(2)
}

const modes = requestedMode === "both" ? ["baseline", "ues"] : [requestedMode]
const runRoot = await mkdtemp(path.join(os.tmpdir(), "ues-live-eval-"))
const resultDir = path.join(root, ".ues-evals")
await mkdir(resultDir, { recursive: true })

const results = []
const oldConfigDir = process.env.OPENCODE_CONFIG_DIR

try {
  for (const task of tasks) {
    for (const mode of modes) {
      for (let trial = 1; trial <= trials; trial += 1) {
        const isolatedRoot = path.join(runRoot, task.id + "-" + mode + "-" + trial)
        const workspace = path.join(isolatedRoot, "workspace")
        const xdgRoot = path.join(isolatedRoot, "xdg")
        const configDir = path.join(xdgRoot, "opencode")

        await mkdir(configDir, { recursive: true })
        await cp(path.join(liveRoot, task.fixture), workspace, { recursive: true })

        if (mode === "ues") {
          process.env.OPENCODE_CONFIG_DIR = configDir
          const installed = await installResources({ sourceRoot: root })
          if (installed.stateError) {
            throw new Error("UES install failed for live eval: " + installed.stateError)
          }
        }

        const childEnv = {
          ...process.env,
          OPENCODE_CONFIG_DIR: configDir,
          XDG_CONFIG_HOME: xdgRoot,
        }

        const opencodeArgs = [
          "run",
          "--standalone",
          "--format",
          "json",
          "--auto",
          "--agent",
          "build",
          "--model",
          model,
          "--dir",
          workspace,
        ]
        if (variant) opencodeArgs.push("--variant", variant)
        opencodeArgs.push(task.prompt)

        const started = Date.now()
        const agentRun = runCommand("opencode", opencodeArgs, {
          cwd: workspace,
          env: childEnv,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
        })
        const durationMs = Date.now() - started

        const graderPath = path.join(liveRoot, task.grader)
        const graderRun = spawnSync(process.execPath, [graderPath], {
          cwd: workspace,
          env: { ...childEnv, UES_EVAL_WORKSPACE: workspace },
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        })

        const passed = agentRun.status === 0 && graderRun.status === 0
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
          agentStdout: excerpt(agentRun.stdout),
          agentStderr: excerpt(agentRun.stderr),
          graderStdout: excerpt(graderRun.stdout),
          graderStderr: excerpt(graderRun.stderr),
          workspace: keep ? workspace : null,
          timestamp: new Date().toISOString(),
        })

        console.log(
          "[" + mode + "] " + task.id + " trial " + trial + ": " +
          (passed ? "PASS" : "FAIL") +
          " (agent=" + agentRun.status + ", grader=" + graderRun.status + ", " + durationMs + "ms)",
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
const resultFile = path.join(resultDir, stamp + "-" + safeModel + ".json")
await writeFile(
  resultFile,
  JSON.stringify(
    {
      schemaVersion: 1,
      suiteVersion: suite.version,
      model,
      variant: variant || null,
      trials,
      taskFilter: taskFilter || null,
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
