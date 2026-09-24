import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { evalModeOrder } from "../lib/eval-order.mjs"
import { runProcess } from "../lib/process-runner.mjs"
import { snapshotWorkspace, diffWorkspaceSnapshots } from "../lib/workspace-snapshot.mjs"
import { resolveManagedPiCommand, resolveWindowsCommand } from "../lib/windows-shim.mjs"
import { summarizeEvalResults } from "../lib/eval-report.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const abortController = new AbortController()
let interrupted = false

process.once("SIGINT", () => {
  interrupted = true
  console.warn("\n[pi-eval] interrupt requested; stopping the active Pi process tree...")
  abortController.abort()
})

function argValue(name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}

function hasArg(name) {
  return args.includes(name)
}

function argValues(name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) {
      values.push(args[index + 1])
      index += 1
    }
  }
  return values
}

function defaultProviderExtensions(modelRef) {
  const provider = String(modelRef || "").split("/", 1)[0].toLowerCase()
  if (provider !== "kilo") return []

  const installed = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "git",
    "github.com",
    "Kilo-Org",
    "kilo-pi-provider",
  )
  if (existsSync(installed)) return [installed]
  return ["git:github.com/Kilo-Org/kilo-pi-provider"]
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function excerpt(value, limit = 16000) {
  const text = String(value || "")
  return text.length <= limit ? text : text.slice(0, limit) + "\n...[truncated]"
}

function resolveCommand(executable) {
  if (process.platform !== "win32") return { executable, argsPrefix: [] }
  const resolved = resolveWindowsCommand(executable)
  if (resolved) return resolved
  if (String(executable).toLowerCase() === "pi") return resolveManagedPiCommand()
  return null
}

function runSync(executable, commandArgs, options = {}) {
  const resolved = resolveCommand(executable)
  if (!resolved) {
    return {
      status: 127,
      stdout: "",
      stderr: "No safely executable command found for: " + executable,
    }
  }
  return spawnSync(resolved.executable, [...resolved.argsPrefix, ...commandArgs], options)
}

function runAsync(executable, commandArgs, options = {}) {
  const resolved = resolveCommand(executable)
  if (!resolved) {
    return Promise.resolve({
      status: 127,
      signal: null,
      stdout: "",
      stderr: "No safely executable command found for: " + executable,
      durationMs: 0,
      timedOut: false,
      idleTimedOut: false,
      aborted: false,
    })
  }
  return runProcess(resolved.executable, [...resolved.argsPrefix, ...commandArgs], options)
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function addUsage(target, usage) {
  if (!usage || typeof usage !== "object") return target
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    target[key] += Number(usage[key] || 0)
  }
  const cost = usage.cost || {}
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) {
    target.cost[key] += Number(cost[key] || 0)
  }
  return target
}

function parsePiTelemetry(stdout) {
  const parentUsage = zeroUsage()
  const childUsage = zeroUsage()
  const toolNames = {}
  let parentUsageSamples = 0
  let childUsageSamples = 0
  let parentToolCalls = 0
  let childToolCalls = 0
  let controllerUsed = false
  let controllerPass = false
  let finalAssistant = ""
  let jsonLines = 0

  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    jsonLines += 1

    if (event.type === "tool_execution_start") {
      parentToolCalls += 1
      const name = String(event.toolName || "unknown")
      toolNames[name] = Number(toolNames[name] || 0) + 1
      if (name === "ues_execute") controllerUsed = true
    }

    if (event.type === "message_end" && event.message?.role === "assistant") {
      if (event.message.usage) {
        addUsage(parentUsage, event.message.usage)
        parentUsageSamples += 1
      }
      if (Array.isArray(event.message.content)) {
        const text = event.message.content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
        if (text) finalAssistant = text
      }
    }

    if (event.type === "tool_execution_end" && event.toolName === "ues_execute") {
      const details = event.result?.details
      const steps = Array.isArray(details?.steps) ? details.steps : []
      for (const step of steps) {
        if (step?.usage) {
          addUsage(childUsage, step.usage)
          childUsageSamples += 1
        }
        childToolCalls += Number(step?.toolCalls || 0)
        for (const name of step?.toolNames || []) {
          const key = "child:" + String(name)
          toolNames[key] = Number(toolNames[key] || 0) + 1
        }
      }
      if (event.isError !== true && details?.mode === "execute") controllerPass = true
    }
  }

  const totalUsage = zeroUsage()
  addUsage(totalUsage, parentUsage)
  addUsage(totalUsage, childUsage)

  return {
    schemaVersion: 1,
    runtime: "pi",
    jsonLines,
    toolCalls: parentToolCalls + childToolCalls,
    parentToolCalls,
    childToolCalls,
    toolNames,
    usageSamples: parentUsageSamples + childUsageSamples,
    parentUsageSamples,
    childUsageSamples,
    tokens: {
      input: totalUsage.input,
      output: totalUsage.output,
      cacheRead: totalUsage.cacheRead,
      cacheWrite: totalUsage.cacheWrite,
      total: totalUsage.totalTokens,
    },
    costSamples: parentUsageSamples + childUsageSamples,
    cost: totalUsage.cost.total,
    parentUsage,
    childUsage,
    controllerUsed,
    controllerPass,
    finalAssistant,
  }
}

function safeName(value) {
  return String(value || "model").replace(/[^a-z0-9._-]+/gi, "_").slice(0, 120)
}

const piCommand = argValue("--pi-command", process.env.UES_PI_COMMAND || "pi")
const model = argValue("--model", process.env.UES_EVAL_MODEL)
const thinking = argValue("--thinking", argValue("--variant", process.env.UES_EVAL_VARIANT))
const trials = Math.min(positiveInt(argValue("--trials"), 1), 20)
const taskFilter = argValue("--task")
const requestedMode = argValue("--mode", "both")
const suiteName = argValue("--suite", "live")
const keep = hasArg("--keep")
const timeoutMs = positiveInt(argValue("--timeout-ms"), 20 * 60_000)
const idleTimeoutMs = positiveInt(argValue("--idle-timeout-ms"), 7 * 60_000)
const heartbeatMs = positiveInt(argValue("--heartbeat-ms"), 30_000)
const explicitProviderExtensions = argValues("--provider-extension")
const providerExtensions = explicitProviderExtensions.length
  ? explicitProviderExtensions
  : defaultProviderExtensions(model)
const suiteRoot = path.join(root, "evals", suiteName)

if (!model) {
  console.error("Usage: node scripts/eval-pi.mjs --model provider/model [--pi-command path-or-command] [--provider-extension path|npm:spec|git:spec] [--thinking off|minimal|low|medium|high|xhigh] [--suite live] [--trials N] [--task id] [--mode baseline|ues|both] [--keep]")
  process.exit(2)
}
if (!["baseline", "ues", "both"].includes(requestedMode)) {
  console.error("--mode must be baseline, ues, or both")
  process.exit(2)
}
if (!existsSync(path.join(suiteRoot, "tasks.json"))) {
  console.error("Unknown eval suite or missing tasks.json: " + suiteName)
  process.exit(2)
}

const probe = runSync(piCommand, ["--version"], { encoding: "utf8" })
if (probe.status !== 0) {
  console.error("Pi CLI is required for Pi-native evals. Checked command: " + piCommand)
  console.error(excerpt(probe.stderr || probe.stdout))
  process.exit(2)
}
const piVersion = String(probe.stdout || probe.stderr || "").trim()

const suite = JSON.parse(await readFile(path.join(suiteRoot, "tasks.json"), "utf8"))
let tasks = suite.tasks || []
if (taskFilter) tasks = tasks.filter((task) => task.id === taskFilter)
if (tasks.length === 0) {
  console.error(taskFilter ? "Unknown task: " + taskFilter : "No eval tasks found.")
  process.exit(2)
}

const invocationDir = process.cwd()
const runRoot = await mkdtemp(path.join(os.tmpdir(), "ues-pi-eval-"))
const resultDir = path.resolve(argValue("--output-dir", path.join(invocationDir, ".ues-evals")))
await mkdir(resultDir, { recursive: true })

const results = []

try {
  for (const [taskIndex, task] of tasks.entries()) {
    if (interrupted) break
    for (let trial = 1; trial <= trials; trial += 1) {
      if (interrupted) break
      const trialModes = evalModeOrder(requestedMode, taskIndex, trial)

      for (const mode of trialModes) {
        if (interrupted) break

        const isolatedRoot = path.join(runRoot, task.id + "-" + mode + "-" + trial)
        const workspace = path.join(isolatedRoot, "workspace")
        const uesConfigDir = path.join(isolatedRoot, "ues-config")
        await mkdir(uesConfigDir, { recursive: true })
        await cp(path.join(suiteRoot, task.fixture), workspace, { recursive: true })

        const beforeSnapshot = await snapshotWorkspace(workspace)
        const childEnv = {
          ...process.env,
          UES_CONFIG_DIR: uesConfigDir,
          PI_SKIP_VERSION_CHECK: "true",
          NO_COLOR: "1",
        }

        const piArgs = [
          "--mode", "json",
          "-p",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--model", model,
        ]
        if (thinking) piArgs.push("--thinking", thinking)
        for (const extension of providerExtensions) {
          piArgs.push("--extension", extension)
        }

        let prompt = task.prompt
        if (mode === "ues") {
          piArgs.push("--extension", path.join(root, "pi", "extensions", "ues.ts"))
          prompt = [
            "Use the UES runtime controller for this benchmark task.",
            "You MUST call the ues_execute tool exactly once with the complete engineering task below and the current working directory.",
            "Do not edit project files directly before that tool call. After the tool returns, report its verified result concisely.",
            "",
            "Engineering task:",
            task.prompt,
          ].join("\n")
        }
        piArgs.push(prompt)

        console.log(
          "[" + mode + "] " + task.id + " trial " + trial + ": starting Pi " + piVersion +
          (providerExtensions.length ? " with provider extension isolation" : ""),
        )
        const agentRun = await runAsync(piCommand, piArgs, {
          cwd: workspace,
          env: childEnv,
          maxBuffer: 8 * 1024 * 1024,
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

        const graderPath = path.join(suiteRoot, task.grader)
        const graderRun = spawnSync(process.execPath, [graderPath], {
          cwd: workspace,
          env: { ...childEnv, UES_EVAL_WORKSPACE: workspace, UES_EVAL_TASK: task.id },
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        })

        const afterSnapshot = await snapshotWorkspace(workspace)
        const changedFiles = diffWorkspaceSnapshots(beforeSnapshot, afterSnapshot)
        const telemetry = parsePiTelemetry(agentRun.stdout)
        const baselineIsolated = mode !== "baseline" || telemetry.controllerUsed === false
        const controllerValid =
          mode === "baseline"
            ? baselineIsolated
            : (telemetry.controllerUsed && telemetry.controllerPass)
        const passed = agentRun.status === 0 && graderRun.status === 0 && controllerValid

        results.push({
          task: task.id,
          mode,
          runtime: "pi",
          model,
          variant: thinking || null,
          trial,
          passed,
          agentExit: agentRun.status,
          graderExit: graderRun.status,
          controllerValid,
          baselineIsolated,
          durationMs: agentRun.durationMs,
          timedOut: agentRun.timedOut,
          idleTimedOut: agentRun.idleTimedOut,
          aborted: agentRun.aborted,
          piVersion,
          telemetry,
          changedFiles,
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
          " (agent=" + agentRun.status + ", grader=" + graderRun.status +
          ", controller=" + controllerValid +
          (mode === "baseline" ? ", isolated=" + baselineIsolated : "") + ")",
        )
      }
    }
  }

  const summary = summarizeEvalResults(results)
  const payload = {
    schemaVersion: 1,
    runtime: "pi",
    suite: suiteName,
    model,
    variant: thinking || null,
    trials,
    requestedMode,
    piVersion,
    providerExtensionCount: providerExtensions.length,
    providerExtensionSource: explicitProviderExtensions.length ? "explicit" : (providerExtensions.length ? "auto" : "none"),
    interrupted,
    generatedAt: new Date().toISOString(),
    summary,
    results,
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outputFile = path.join(
    resultDir,
    "pi-" + safeName(suiteName) + "-" + safeName(model) + "-" + stamp + ".json",
  )
  await writeFile(outputFile, JSON.stringify(payload, null, 2) + "\n", "utf8")

  console.log("\nPi-native eval summary")
  console.log(JSON.stringify(summary, null, 2))
  console.log("Result file: " + outputFile)
} finally {
  if (!keep) await rm(runRoot, { recursive: true, force: true }).catch(() => {})
}