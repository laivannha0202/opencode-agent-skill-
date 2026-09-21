#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"
import {
  PACKAGE_NAME,
  getConfigDir,
  getPackageVersion,
  getStatus,
  installResources,
  removeResources,
} from "../lib/installer.mjs"
import { compareVersions } from "../lib/version.mjs"
import { resolveLatestPublishedVersion } from "../lib/update-resolver.mjs"
import { readRouterConfig, writeRouterConfig } from "../lib/router-config.mjs"
import { resolveNodeShimEntry } from "../lib/windows-shim.mjs"
import {
  detectStack,
  detectTestCommands,
  repoMap,
  impactMap,
  collectEvidence,
  checkWorkingTree,
} from "../lib/repo-inspect.mjs"
import { buildRepoGraph } from "../lib/repo-graph.mjs"
import { buildSemanticIndex, semanticIndexStatus } from "../lib/semantic-index.mjs"
import { aciReferences, aciSearch, aciTextSearch, aciView } from "../lib/aci.mjs"
import { appendTrajectoryEvent, readTrajectory } from "../lib/trajectory.mjs"
import { containerSandboxCapability, runContainerSandbox } from "../lib/container-sandbox.mjs"
import { analyzePlan } from "../lib/task-graph.mjs"
import {
  addBlocker,
  addDecision,
  attachTaskSession,
  approvePlan,
  completeTask,
  contextPack,
  failTask,
  finalizeWork,
  importPlan,
  initWork,
  recordIntegrationVerification,
  resolveBlocker,
  resumeWork,
  startTask,
  workStatus,
  heartbeatTask,
  recoverStaleTasks,
  recoverTask,
  recordVerificationReceipt,
  workspaceFingerprint,
  createPlanVerificationReceipt,
  createIntegrationVerificationReceipt,
  runtimeEvents,
} from "../lib/task-engine.mjs"
import { reviewScope } from "../lib/review-scope.mjs"
import { buildVerificationPlan } from "../lib/verification-plan.mjs"
import { resolveAdaptiveModel, resolveModel } from "../lib/model-policy.mjs"
import { createVerificationReceipt } from "../lib/evidence-receipt.mjs"
import { classifyEngineeringTask } from "../lib/orchestrator-policy.mjs"
import { createTaskSandbox, integrateTaskSandbox, listTaskSandboxes, removeTaskSandbox } from "../lib/worktree-sandbox.mjs"
import { analyzeEvalTraces, saveLearningAnalysis, readLearningState, acceptLearning, promoteLearning } from "../lib/learning-engine.mjs"
import { hermesStatus, buildHermesDelegationPrompt, hermesOneShotArgs } from "../lib/hermes-bridge.mjs"
import { readModelPolicy, validateModelID, writeModelPolicy } from "../lib/model-config.mjs"

const args = process.argv.slice(2)
const command = args[0] || "help"
const force = args.includes("--force")
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function printHelp() {
  console.log(`
OpenCode Universal Engineering System

Usage:
  ocskill install [--force]    Install or re-sync bundled OpenCode resources
  ocskill status               Show package/resource synchronization status
  ocskill doctor               Check Node, npm, OpenCode and installed resources
  ocskill eval                 Validate the bundled static skill-routing suite
  ocskill eval-live [options]  Run baseline-vs-UES live behavioral evals
  ocskill eval-report [paths]  Aggregate live eval pass-rate/cost/tool telemetry
  ocskill inspect [dir]        Deterministic repository/stack/test-command map
  ocskill impact <query> [dir] Search likely impact paths and matching lines
  ocskill evidence [dir]       Collect stack, verification and Git evidence
  ocskill working-tree [dir]   Report Git branch/HEAD/dirty state
  ocskill repo-graph [dir]      Build a bounded source import/dependency graph
  ocskill index <status|build|rebuild> [dir]
                              Build/reuse the persistent incremental semantic index
  ocskill aci <search|refs|view|text> ...
                              Bounded evidence-first code search/view interface
  ocskill trace <show|append> ... Inspect or append redacted operational trajectory events
  ocskill review-scope [base] [dir]
                              Enumerate changed files, review coverage and risk
  ocskill verification-plan [dir]
                              Build project-native verification recommendations
  ocskill task-graph <plan>     Validate PLAN.json and compute dependency-safe waves
  ocskill context-pack <slug> <task> [dir]
                              Emit bounded task context for a fresh executor
  ocskill work <action> ...     Manage persistent .ues-work long-task state
  ocskill model-policy <role> [--attempt N]
                              Resolve light/standard/heavy escalation tier
  ocskill task-policy <text>    Classify task mode/risk/context/model tier
  ocskill sandbox <action> ...  Create, integrate and clean isolated Git worktree sandboxes
                              Also supports capability/exec for fail-closed container verification
  ocskill learn <action> ...    Analyze eval traces and promote benchmark-validated lessons
  ocskill hermes <action> ...   Optional Hermes adapter/status
  ocskill dashboard [dir] [--serve] [--port N]
                              Generate/serve the local UES Control Center
  ocskill models <status|on|off|set|role> ...
                              Configure role/tier model routing, then re-sync
  ocskill router [status|on|off] [--max N]
                              Configure the OpenCode v2 automatic skill router
  ocskill update               Update the global npm package and re-sync resources
  ocskill remove [--force]     Remove managed resources and uninstall the npm package
  ocskill version              Show package version
  ocskill help                 Show this help

  Long-task actions:
    ocskill work init <slug> [dir] --goal <text>
    ocskill work plan <slug> <plan.json> [dir]
    ocskill work status|resume <slug> [dir]
    ocskill work gate-receipt <slug> <plan|integration> [dir] --evidence <text> [--verdict PASS|FAIL|PARTIAL] [--verifier <role>] [--session-id <id>] [--report-file <file>] [--out <file>]
    ocskill work approve-plan <slug> [dir] --evidence <plan-checker-evidence> [--receipt-file <file>]
    ocskill work start <slug> <task-id> [dir] [--lease-ms N]
    ocskill work attach-session <slug> <task-id> [dir] --run-id <id> --session-id <id> [--execution-dir <dir>] [--sandbox-dir <dir>]
    ocskill work heartbeat <slug> <task-id> [dir] --run-id <id>
    ocskill work recover <slug> [dir] [--force]
    ocskill work recover-task <slug> <task-id> [dir] [--force] [--reason <text>]
    ocskill work events <slug> [dir] [--limit N]
    ocskill work verify-command <slug> <task-id> [dir] --run-id <id> -- <command> [args...]
    ocskill work complete <slug> <task-id> [dir] --run-id <id> --evidence <text> [--report-file <file>]
    ocskill work fail <slug> <task-id> [dir] --run-id <id> --reason <text>
    ocskill work decision <slug> [dir] --text <decision>
    ocskill work block|unblock <slug> [dir] --text <blocker>
    ocskill work verify-integration <slug> [dir] --verdict PASS|FAIL|PARTIAL --evidence <text> [--report-file <file>] [--receipt-file <file>]
    ocskill work finalize <slug> [dir] --evidence <integration-evidence>

  Model routing:
    ocskill models status
    ocskill models on|off
    ocskill models set <light|standard|heavy> <provider/model[#variant]>
    ocskill models role <role> <light|standard|heavy>

  --force backs up and replaces/removes state owned by another package.
`)
}

function findWindowsCommand(name) {
  if (path.isAbsolute(name) && existsSync(name)) return name

  const result = spawnSync("where", [name], { encoding: "utf8" })
  if (result.status !== 0 || !result.stdout) return null

  const matches = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return matches.find((item) => /\.(cmd|bat)$/i.test(item)) || matches[0] || null
}



function run(executable, commandArgs, options = {}) {
  const common = { stdio: "inherit", ...options }

  if (process.platform !== "win32") {
    const result = spawnSync(executable, commandArgs, common)
    return result.status ?? 1
  }

  const resolved = findWindowsCommand(executable)
  if (!resolved) return 127

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const entry = resolveNodeShimEntry(resolved)
    if (entry) {
      const result = spawnSync(process.execPath, [entry, ...commandArgs], common)
      return result.status ?? 1
    }
    console.error("[ocskill] Refusing to execute an unrecognized Windows batch shim through cmd.exe.")
    return 126
  }

  const result = spawnSync(resolved, commandArgs, common)
  return result.status ?? 1
}

function hasCommand(name) {
  if (process.platform === "win32") return findWindowsCommand(name) !== null
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0
}

function runCapture(executable, commandArgs, options = {}) {
  const common = { encoding: "utf8", ...options }

  if (process.platform !== "win32") {
    return spawnSync(executable, commandArgs, common)
  }

  const resolved = findWindowsCommand(executable)
  if (!resolved) return { status: 127, stdout: "", stderr: `Command not found: ${executable}` }

  if (/\.(cmd|bat)$/i.test(resolved)) {
    const entry = resolveNodeShimEntry(resolved)
    if (entry) return spawnSync(process.execPath, [entry, ...commandArgs], common)
    return {
      status: 126,
      stdout: "",
      stderr: "Refusing to execute an unrecognized Windows batch shim through cmd.exe.",
    }
  }

  return spawnSync(resolved, commandArgs, common)
}


async function install() {
  const result = await installResources({ force })
  if (result.stateError) {
    for (const warning of result.warnings) console.warn(`[ocskill] WARNING: ${warning}`)
    console.error(`[ocskill] ERROR: ${result.stateError}`)
    process.exitCode = 1
    return
  }
  console.log(`[ocskill] Installed resources for v${result.version}`)
  console.log(`[ocskill] OpenCode config: ${result.configDir}`)
  console.log(`[ocskill] Skills: ${result.skills.length}`)
  console.log(`[ocskill] Commands: ${result.commands.length}`)
  console.log(`[ocskill] Subagents: ${result.agents.length}`)
  console.log(`[ocskill] OpenCode major: ${result.openCodeMajor}`)
  if ((result.plugins || []).length) console.log(`[ocskill] Router plugins: ${result.plugins.length}`)
  for (const warning of result.warnings) console.warn(`[ocskill] WARNING: ${warning}`)
  console.log("[ocskill] Start a new OpenCode session to pick up workflow changes.")
}

async function status() {
  const currentVersion = await getPackageVersion()
  const result = await getStatus()

  if (!result.installed) {
    console.log(`[ocskill] Package version: ${currentVersion}`)
    console.log("[ocskill] OpenCode resources are not installed or state is invalid.")
    console.log(`[ocskill] Expected config: ${result.configDir}`)
    if (result.stateError) console.log(`[ocskill] State: ${result.stateError}`)
    process.exitCode = 1
    return
  }

  const synced = result.version === currentVersion
  console.log(`[ocskill] Package version: ${currentVersion}`)
  console.log(`[ocskill] Resource version: ${result.version}`)
  console.log(`[ocskill] Sync: ${synced ? "OK" : "OUTDATED - run ocskill install"}`)
  console.log(`[ocskill] Config: ${result.configDir}`)
  console.log(`[ocskill] Skills: ${result.skillsPresent}/${result.skills.length}`)
  console.log(`[ocskill] Commands: ${result.commandsPresent}/${result.commands.length}`)
  console.log(`[ocskill] Subagents: ${result.agentsPresent}/${(result.agents || []).length}`)
  console.log(`[ocskill] OpenCode major: ${result.openCodeMajor ?? "legacy/unknown"}`)
  if ((result.plugins || []).length) console.log(`[ocskill] Router plugins: ${result.pluginsPresent}/${result.plugins.length}`)
  console.log(`[ocskill] Workflow: ${result.workflowPresent ? "OK" : "MISSING"}`)

  if (!synced ||
      result.skillsPresent !== result.skills.length ||
      result.commandsPresent !== result.commands.length ||
      result.agentsPresent !== (result.agents || []).length ||
      result.pluginsPresent !== (result.plugins || []).length ||
      !result.workflowPresent) {
    process.exitCode = 1
  }
}

async function doctor() {
  console.log("OpenCode Universal Engineering System - doctor")
  console.log(`Package:  ${PACKAGE_NAME}`)
  console.log(`Version:  ${await getPackageVersion()}`)
  console.log(`Node:     ${process.version}`)
  console.log(`Config:   ${getConfigDir()}`)
  console.log(`npm:      ${hasCommand("npm") ? "OK" : "MISSING"}`)
  console.log(`OpenCode: ${hasCommand("opencode") ? "OK" : "MISSING"}`)
  if (hasCommand("opencode")) run("opencode", ["--version"])
  await status()
}

async function evaluate() {
  const code = run(process.execPath, [path.join(packageRoot, "scripts", "eval-skills.mjs")])
  if (code !== 0) process.exitCode = code
}

async function evaluateLive() {
  const code = run(
    process.execPath,
    [path.join(packageRoot, "scripts", "eval-live.mjs"), ...args.slice(1)],
  )
  if (code !== 0) process.exitCode = code
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2))
}

async function evaluateReport() {
  const code = run(
    process.execPath,
    [path.join(packageRoot, "scripts", "eval-report.mjs"), ...args.slice(1)],
  )
  if (code !== 0) process.exitCode = code
}

async function inspectRepository() {
  printJson(await repoMap(args[1] || process.cwd()))
}

async function inspectImpact() {
  const query = args[1]
  if (!query) {
    console.error("Usage: ocskill impact <query> [dir]")
    process.exitCode = 2
    return
  }
  printJson(await impactMap(args[2] || process.cwd(), query))
}

async function inspectEvidence() {
  printJson(await collectEvidence(args[1] || process.cwd()))
}

async function inspectWorkingTree() {
  printJson(await checkWorkingTree(args[1] || process.cwd()))
}

async function inspectStack() {
  printJson(await detectStack(args[1] || process.cwd()))
}

async function inspectTests() {
  printJson(await detectTestCommands(args[1] || process.cwd()))
}

function optionValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

async function inspectRepoGraph() {
  printJson(await buildRepoGraph(args[1] || process.cwd()))
}

async function semanticIndexControl() {
  const action = args[1] || "status"
  const root = args[2] && !args[2].startsWith("--") ? args[2] : process.cwd()
  try {
    if (action === "status") {
      printJson(await semanticIndexStatus(root))
      return
    }
    if (action === "build" || action === "rebuild") {
      const built = await buildSemanticIndex(root, { rebuild: action === "rebuild" })
      printJson({ action, stats: built.stats })
      return
    }
    throw new Error("Usage: ocskill index <status|build|rebuild> [dir]")
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

async function aciControl() {
  const action = args[1]
  try {
    if (action === "search") {
      const query = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!query) throw new Error("Usage: ocskill aci search <query> [dir] [--limit N]")
      printJson(await aciSearch(root, query, { limit: Number(optionValue("--limit") || 20) }))
      return
    }
    if (action === "refs") {
      const symbol = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!symbol) throw new Error("Usage: ocskill aci refs <symbol> [dir] [--limit N]")
      printJson(await aciReferences(root, symbol, { limit: Number(optionValue("--limit") || 40) }))
      return
    }
    if (action === "view") {
      const file = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!file) throw new Error("Usage: ocskill aci view <file> [dir] [--line N] [--lines N]")
      printJson(await aciView(root, file, {
        line: Number(optionValue("--line") || 1),
        startLine: Number(optionValue("--start-line") || 0),
        lines: Number(optionValue("--lines") || 120),
      }))
      return
    }
    if (action === "text") {
      const query = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!query) throw new Error("Usage: ocskill aci text <query> [dir] [--limit N]")
      printJson(await aciTextSearch(root, query, { limit: Number(optionValue("--limit") || 80) }))
      return
    }
    throw new Error("Usage: ocskill aci <search|refs|view|text> ...")
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

async function traceControl() {
  const action = args[1] || "show"
  try {
    if (action === "show") {
      const traceID = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!traceID) throw new Error("Usage: ocskill trace show <trace-id> [dir] [--limit N]")
      printJson(await readTrajectory(root, traceID, { limit: Number(optionValue("--limit") || 200) }))
      return
    }
    if (action === "append") {
      const traceID = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      const type = optionValue("--type")
      const payload64 = optionValue("--payload-b64")
      if (!traceID || !type) throw new Error("Usage: ocskill trace append <trace-id> [dir] --type <type> [--payload-b64 <base64-json>]")
      let payload = {}
      if (payload64) {
        payload = JSON.parse(Buffer.from(payload64, "base64").toString("utf8"))
      }
      printJson(await appendTrajectoryEvent(root, traceID, type, payload))
      return
    }
    throw new Error("Usage: ocskill trace <show|append> ...")
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

async function inspectReviewScope() {
  const base = args[1] && !args[1].startsWith("--") ? args[1] : null
  const root = args[2] && !args[2].startsWith("--") ? args[2] : process.cwd()
  printJson(reviewScope(root, base))
}

async function inspectVerificationPlan() {
  printJson(await buildVerificationPlan(args[1] || process.cwd(), optionValue("--base")))
}

async function inspectTaskGraph() {
  const file = args[1]
  if (!file) {
    console.error("Usage: ocskill task-graph <plan.json>")
    process.exitCode = 2
    return
  }
  try {
    const plan = JSON.parse(readFileSync(path.resolve(file), "utf8"))
    const analysis = analyzePlan(plan)
    printJson(analysis)
    if (!analysis.valid) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

async function inspectContextPack() {
  const slug = args[1]
  const taskID = args[2]
  if (!slug || !taskID) {
    console.error("Usage: ocskill context-pack <slug> <task-id> [dir]")
    process.exitCode = 2
    return
  }
  printJson(await contextPack(args[3] || process.cwd(), slug, taskID))
}

async function workControl() {
  const action = args[1]
  const slug = args[2]
  if (!action || !slug) {
    console.error("Usage: ocskill work <init|plan|status|resume|gate-receipt|approve-plan|start|attach-session|heartbeat|recover|recover-task|events|verify-command|complete|fail|decision|block|unblock|verify-integration|finalize> <slug> ...")
    process.exitCode = 2
    return
  }

  try {
    if (action === "init") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await initWork(root, slug, optionValue("--goal")))
      return
    }
    if (action === "plan") {
      const planFile = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      if (!planFile) throw new Error("Usage: ocskill work plan <slug> <plan.json> [dir]")
      const result = await importPlan(root, slug, planFile)
      printJson({ state: result.state, analysis: result.analysis, dir: result.paths.dir })
      return
    }
    if (action === "status") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await workStatus(root, slug))
      return
    }
    if (action === "resume") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await resumeWork(root, slug))
      return
    }
    if (action === "gate-receipt") {
      const kind = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      if (!["plan", "integration"].includes(kind)) {
        throw new Error("Usage: ocskill work gate-receipt <slug> <plan|integration> [dir] --evidence <text>")
      }
      const reportFile = optionValue("--report-file")
      const report = reportFile ? readFileSync(path.resolve(reportFile), "utf8") : null
      const input = {
        verdict: optionValue("--verdict") || "PASS",
        verifier: optionValue("--verifier") || undefined,
        sessionID: optionValue("--session-id"),
        runId: optionValue("--run-id"),
        evidence: optionValue("--evidence"),
        report,
      }
      const receipt = kind === "plan"
        ? await createPlanVerificationReceipt(root, slug, input)
        : await createIntegrationVerificationReceipt(root, slug, input)
      const outputFile = optionValue("--out")
      if (outputFile) {
        const resolved = path.resolve(outputFile)
        writeFileSync(resolved, JSON.stringify(receipt, null, 2) + "\n", "utf8")
        printJson({ file: resolved, receipt })
      } else {
        printJson(receipt)
      }
      return
    }
    if (action === "approve-plan") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      const receiptFile = optionValue("--receipt-file")
      const receipt = receiptFile ? JSON.parse(readFileSync(path.resolve(receiptFile), "utf8")) : null
      printJson(await approvePlan(root, slug, optionValue("--evidence"), { receipt }))
      return
    }
    if (action === "start") {
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work start <slug> <task-id> [dir]")
      printJson(await startTask(root, slug, taskID, {
        leaseMs: Number.parseInt(optionValue("--lease-ms") || "0", 10) || undefined,
      }))
      return
    }
    if (action === "attach-session") {
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work attach-session <slug> <task-id> [dir] --run-id <id> --session-id <id>")
      printJson(await attachTaskSession(
        root,
        slug,
        taskID,
        optionValue("--run-id"),
        optionValue("--session-id"),
        {
          executionDir: optionValue("--execution-dir"),
          sandboxDir: optionValue("--sandbox-dir"),
        },
      ))
      return
    }
    if (action === "heartbeat") {
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      const runId = optionValue("--run-id")
      if (!taskID || !runId) throw new Error("Usage: ocskill work heartbeat <slug> <task-id> [dir] --run-id <id>")
      printJson(await heartbeatTask(root, slug, taskID, runId, {
        leaseMs: Number.parseInt(optionValue("--lease-ms") || "0", 10) || undefined,
      }))
      return
    }
    if (action === "recover") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await recoverStaleTasks(root, slug, { force: args.includes("--force") }))
      return
    }
    if (action === "recover-task") {
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work recover-task <slug> <task-id> [dir] [--force] [--reason <text>]")
      printJson(await recoverTask(root, slug, taskID, {
        force: args.includes("--force"),
        reason: optionValue("--reason"),
      }))
      return
    }
    if (action === "events") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      const limit = Number.parseInt(optionValue("--limit") || "200", 10)
      printJson(await runtimeEvents(root, slug, { limit }))
      return
    }
    if (action === "verify-command") {
      const taskID = args[3]
      const root = args[4] && args[4] !== "--" && !args[4].startsWith("--") ? args[4] : process.cwd()
      const separator = args.indexOf("--")
      const executable = separator >= 0 ? args[separator + 1] : null
      const commandArgs = separator >= 0 ? args.slice(separator + 2) : []
      const runId = optionValue("--run-id")
      if (!taskID || !runId || !executable) {
        throw new Error("Usage: ocskill work verify-command <slug> <task-id> [dir] --run-id <id> -- <command> [args...]")
      }
      const startedAt = new Date().toISOString()
      const before = workspaceFingerprint(root)
      const startedMs = Date.now()
      const result = runCapture(executable, commandArgs, {
        cwd: path.resolve(root),
        maxBuffer: 8 * 1024 * 1024,
      })
      const receipt = createVerificationReceipt({
        task: taskID,
        runId,
        command: executable,
        args: commandArgs,
        cwd: path.resolve(root),
        exitCode: result.status ?? 1,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        stdout: result.stdout,
        stderr: result.stderr,
        workspaceBefore: before,
        workspaceAfter: workspaceFingerprint(root),
      })
      const recorded = await recordVerificationReceipt(root, slug, taskID, receipt)
      const clip = (value) => {
        const text = String(value || "")
        return text.length <= 8000 ? text : "...[truncated]\n" + text.slice(-8000)
      }
      printJson({
        receipt: recorded,
        output: {
          stdout: clip(result.stdout),
          stderr: clip(result.stderr),
        },
      })
      if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1
      return
    }
    if (action === "complete") {
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      const runId = optionValue("--run-id")
      if (!taskID || !runId) throw new Error("Usage: ocskill work complete <slug> <task-id> [dir] --run-id <id> --evidence <text>")
      const reportFile = optionValue("--report-file")
      const report = reportFile ? readFileSync(path.resolve(reportFile), "utf8") : null
      printJson(await completeTask(root, slug, taskID, {
        evidence: optionValue("--evidence"),
        report,
        runId,
      }))
      return
    }
    if (action === "fail") {
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      const runId = optionValue("--run-id")
      if (!taskID || !runId) throw new Error("Usage: ocskill work fail <slug> <task-id> [dir] --run-id <id> --reason <text>")
      printJson(await failTask(root, slug, taskID, optionValue("--reason"), { runId }))
      return
    }
    if (action === "decision") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await addDecision(root, slug, optionValue("--text")))
      return
    }
    if (action === "block") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await addBlocker(root, slug, optionValue("--text")))
      return
    }
    if (action === "unblock") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await resolveBlocker(root, slug, optionValue("--text")))
      return
    }
    if (action === "verify-integration") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      const reportFile = optionValue("--report-file")
      const report = reportFile ? readFileSync(path.resolve(reportFile), "utf8") : null
      const receiptFile = optionValue("--receipt-file")
      const receipt = receiptFile ? JSON.parse(readFileSync(path.resolve(receiptFile), "utf8")) : null
      printJson(await recordIntegrationVerification(
        root,
        slug,
        optionValue("--verdict"),
        optionValue("--evidence"),
        report,
        { receipt },
      ))
      return
    }
    if (action === "finalize") {
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      printJson(await finalizeWork(root, slug, optionValue("--evidence")))
      return
    }

    throw new Error("Unknown work action: " + action)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    if (error?.validation) printJson(error.validation)
    process.exitCode = 1
  }
}

async function modelPolicy() {
  const role = args[1]
  if (!role) {
    console.error("Usage: ocskill model-policy <role> [--attempt N]")
    process.exitCode = 2
    return
  }
  const attempt = Number.parseInt(optionValue("--attempt") || "1", 10)
  const policy = await readModelPolicy(getConfigDir())
  const normalizedAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1
  const taskText = optionValue("--text")
  if (taskText) {
    printJson(resolveAdaptiveModel(role, normalizedAttempt, classifyEngineeringTask(taskText), policy))
    return
  }
  printJson(resolveModel(role, normalizedAttempt, policy))
}


async function modelsControl() {
  const action = args[1] || "status"
  let policy = await readModelPolicy(getConfigDir())

  if (action === "status") {
    printJson(policy)
    return
  }
  if (action === "on" || action === "off") {
    policy = await writeModelPolicy(getConfigDir(), { enabled: action === "on" })
    printJson(policy)
    console.log("[ocskill] Run 'ocskill install' to rewrite managed agent frontmatter.")
    return
  }
  if (action === "set") {
    const tier = args[2]
    const model = args[3]
    if (!["light", "standard", "heavy"].includes(tier) || !validateModelID(model)) {
      console.error("Usage: ocskill models set <light|standard|heavy> <provider/model[#variant]>")
      process.exitCode = 2
      return
    }
    policy = await writeModelPolicy(getConfigDir(), {
      enabled: true,
      tiers: { [tier]: model },
    })
    printJson(policy)
    console.log("[ocskill] Run 'ocskill install' to apply model mappings to managed agents.")
    return
  }
  if (action === "role") {
    const role = args[2]
    const tier = args[3]
    if (!role || !["light", "standard", "heavy"].includes(tier)) {
      console.error("Usage: ocskill models role <role> <light|standard|heavy>")
      process.exitCode = 2
      return
    }
    policy = await writeModelPolicy(getConfigDir(), {
      roleTiers: { [role]: tier },
    })
    printJson(policy)
    console.log("[ocskill] Run 'ocskill install' to apply role-tier changes.")
    return
  }

  console.error("Usage: ocskill models <status|on|off|set|role> ...")
  process.exitCode = 2
}

async function routerControl() {
  const action = args[1] || "status"
  const maxIndex = args.indexOf("--max")
  const maxValue = maxIndex >= 0 ? Number.parseInt(args[maxIndex + 1] || "", 10) : null

  if (!["status", "on", "off"].includes(action)) {
    console.error("Usage: ocskill router [status|on|off] [--max 1..6]")
    process.exitCode = 2
    return
  }
  if (maxIndex >= 0 && (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 6)) {
    console.error("--max must be an integer from 1 through 6")
    process.exitCode = 2
    return
  }

  let config = await readRouterConfig(getConfigDir())
  if (action !== "status" || maxValue !== null) {
    config = await writeRouterConfig(getConfigDir(), {
      enabled: action === "on" ? true : action === "off" ? false : config.enabled,
      ...(maxValue !== null ? { maxSkills: maxValue } : {}),
    })
  }

  const installed = await getStatus()
  const runtimeAvailable =
    installed.installed &&
    Number(installed.openCodeMajor) >= 2 &&
    (installed.plugins || []).includes("ues-router/index.js") &&
    installed.pluginsPresent === installed.plugins.length

  console.log(`[ocskill] Router preference: ${config.enabled ? "ON" : "OFF"}`)
  console.log(`[ocskill] Router runtime: ${runtimeAvailable ? "AVAILABLE" : "UNAVAILABLE"}`)
  if (!runtimeAvailable) {
    console.log("[ocskill] Runtime routing requires OpenCode 2.x followed by 'ocskill install'.")
  }
  console.log(`[ocskill] Max automatic skills: ${config.maxSkills}`)
  console.log(`[ocskill] Config: ${config.file}`)
}


async function taskPolicyControl() {
  const text = args.slice(1).join(" ").trim()
  if (!text) {
    console.error("Usage: ocskill task-policy <text>")
    process.exitCode = 2
    return
  }
  printJson(classifyEngineeringTask(text))
}

async function sandboxControl() {
  const action = args[1] || "list"
  try {
    if (action === "capability") {
      printJson(containerSandboxCapability(optionValue("--engine")))
      return
    }
    if (action === "exec") {
      const separator = args.indexOf("--")
      const root = args[2] && args[2] !== "--" && !args[2].startsWith("--") ? args[2] : process.cwd()
      const executable = separator >= 0 ? args[separator + 1] : null
      const commandArgs = separator >= 0 ? args.slice(separator + 2) : []
      const image = optionValue("--image")
      if (!image || !executable) {
        throw new Error("Usage: ocskill sandbox exec [dir] --image <image> [--engine docker|podman] -- <command> [args...]")
      }
      const result = runContainerSandbox(root, {
        engine: optionValue("--engine"),
        image,
        command: executable,
        args: commandArgs,
        timeoutMs: Number(optionValue("--timeout-ms") || 10 * 60_000),
      })
      const clip = (value) => {
        const text = String(value || "")
        return text.length <= 16000 ? text : text.slice(0, 8000) + "\n...[truncated]\n" + text.slice(-8000)
      }
      printJson({ ...result, stdout: clip(result.stdout), stderr: clip(result.stderr) })
      if (result.status !== 0) process.exitCode = result.status
      return
    }
    if (action === "list") {
      printJson(listTaskSandboxes(args[2] || process.cwd()))
      return
    }
    if (action === "create") {
      const slug = args[2]
      const taskID = args[3]
      const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
      if (!slug || !taskID) throw new Error("Usage: ocskill sandbox create <slug> <task-id> [dir]")
      printJson(await createTaskSandbox(root, slug, taskID))
      return
    }
    if (action === "integrate") {
      const dir = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!dir) throw new Error("Usage: ocskill sandbox integrate <worktree-path> [dir] [--keep]")
      printJson(await integrateTaskSandbox(root, dir, { keep: args.includes("--keep") }))
      return
    }
    if (action === "remove") {
      const dir = args[2]
      const root = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!dir) throw new Error("Usage: ocskill sandbox remove <worktree-path> [dir] [--force] [--delete-branch]")
      printJson(await removeTaskSandbox(root, dir, {
        force: args.includes("--force"),
        deleteBranch: args.includes("--delete-branch"),
      }))
      return
    }
    throw new Error("Usage: ocskill sandbox <capability|exec|list|create|integrate|remove> ...")
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

async function learningControl() {
  const action = args[1] || "status"
  const root = args[2] && !args[2].startsWith("--") ? args[2] : process.cwd()
  try {
    if (action === "status") {
      printJson(await readLearningState(root))
      return
    }
    if (action === "analyze") {
      const evalDir = optionValue("--eval-dir") || path.join(path.resolve(root), ".ues-evals")
      const analysis = await analyzeEvalTraces(evalDir)
      const state = await saveLearningAnalysis(root, analysis)
      printJson({ analysis, state })
      return
    }
    if (action === "accept") {
      const id = args[2]
      const acceptRoot = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!id) throw new Error("Usage: ocskill learn accept <proposal-id> [dir]")
      printJson(await acceptLearning(acceptRoot, id))
      return
    }
    if (action === "promote") {
      const id = args[2]
      const promoteRoot = args[3] && !args[3].startsWith("--") ? args[3] : process.cwd()
      if (!id) throw new Error("Usage: ocskill learn promote <proposal-id> [dir] --report <matrix-summary.json>")
      printJson(await promoteLearning(promoteRoot, id, {
        report: optionValue("--report"),
      }))
      return
    }
    throw new Error("Usage: ocskill learn <status|analyze|accept|promote> ...")
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

async function hermesControl() {
  const action = args[1] || "status"
  if (action === "status") {
    printJson(hermesStatus())
    return
  }
  if (action === "prompt" || action === "exec") {
    const slug = args[2]
    const taskID = args[3]
    const root = args[4] && !args[4].startsWith("--") ? args[4] : process.cwd()
    if (!slug || !taskID) {
      console.error("Usage: ocskill hermes <prompt|exec> <slug> <task-id> [dir]")
      process.exitCode = 2
      return
    }
    const prompt = buildHermesDelegationPrompt(await contextPack(root, slug, taskID))
    if (action === "prompt") {
      console.log(prompt)
      return
    }

    const status = hermesStatus()
    if (!status.available) {
      console.error(status.error || "Hermes CLI is unavailable")
      process.exitCode = 1
      return
    }
    const result = runCapture("hermes", hermesOneShotArgs(prompt), {
      cwd: path.resolve(root),
      maxBuffer: 8 * 1024 * 1024,
    })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1
    return
  }
  console.error("Usage: ocskill hermes <status|prompt|exec> ...")
  process.exitCode = 2
}

async function dashboardControl() {
  const forwarded = args.slice(1)
  const code = run(process.execPath, [path.join(packageRoot, "scripts", "control-center.mjs"), ...forwarded])
  if (code !== 0) process.exitCode = code
}

async function update() {
  if (!hasCommand("npm")) {
    console.error("[ocskill] npm is required to update this global package.")
    process.exitCode = 1
    return
  }

  const currentVersion = await getPackageVersion()
  let resolved
  try {
    resolved = resolveLatestPublishedVersion({
      runCapture,
      packageName: PACKAGE_NAME,
      cwd: os.homedir(),
    })
  } catch (error) {
    console.error("[ocskill] Could not determine the latest published npm version; refusing an unsafe self-update.")
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = error?.exitCode || 1
    return
  }

  const latestVersion = resolved.version

  let compared
  try {
    compared = compareVersions(latestVersion, currentVersion)
  } catch (error) {
    console.error("[ocskill] npm returned a version that could not be compared safely; refusing update.")
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
    return
  }

  if (compared < 0) {
    console.error(
      `[ocskill] Registry latest is v${latestVersion}, older than installed v${currentVersion}; refusing downgrade.`,
    )
    process.exitCode = 1
    return
  }

  if (compared === 0) {
    console.log(`[ocskill] Already on latest npm version v${currentVersion}; re-syncing current resources.`)
    await install()
    return
  }

  console.log(`[ocskill] Updating ${PACKAGE_NAME} from v${currentVersion} to v${latestVersion}...`)
  const code = run(
    "npm",
    ["install", "-g", `${PACKAGE_NAME}@${latestVersion}`, "--ignore-scripts"],
    { cwd: os.homedir() },
  )
  if (code !== 0) {
    process.exitCode = code
    return
  }

  console.log("[ocskill] Re-syncing resources after update...")
  const syncCode = run("ocskill", ["install"])
  if (syncCode !== 0) process.exitCode = syncCode
}

async function remove() {
  const removed = await removeResources({ force })
  if (removed.stateError) {
    for (const warning of removed.warnings || []) {
      console.warn(`[ocskill] WARNING: ${warning}`)
    }
    console.error(`[ocskill] ERROR: ${removed.stateError}`)
    process.exitCode = 1
    return
  }
  console.log(
    `[ocskill] Removed ${removed.skills} skills, ${removed.commands} commands, ${removed.agents} subagents and ${removed.plugins || 0} plugins.`,
  )
  for (const warning of removed.warnings || []) {
    console.warn(`[ocskill] WARNING: ${warning}`)
  }

  if (!hasCommand("npm")) return

  const code = run(
    "npm",
    ["uninstall", "-g", PACKAGE_NAME, "--ignore-scripts"],
    { cwd: os.homedir() },
  )
  if (code !== 0) process.exitCode = code
}

switch (command) {
  case "install":
  case "sync":
    await install()
    break
  case "status":
    await status()
    break
  case "doctor":
    await doctor()
    break
  case "eval":
  case "evals":
    await evaluate()
    break
  case "eval-live":
    await evaluateLive()
    break
  case "eval-report":
    await evaluateReport()
    break
  case "inspect":
    await inspectRepository()
    break
  case "impact":
    await inspectImpact()
    break
  case "evidence":
    await inspectEvidence()
    break
  case "working-tree":
    await inspectWorkingTree()
    break
  case "repo-graph":
    await inspectRepoGraph()
    break
  case "index":
    await semanticIndexControl()
    break
  case "aci":
    await aciControl()
    break
  case "trace":
    await traceControl()
    break
  case "review-scope":
    await inspectReviewScope()
    break
  case "verification-plan":
    await inspectVerificationPlan()
    break
  case "task-graph":
    await inspectTaskGraph()
    break
  case "context-pack":
    await inspectContextPack()
    break
  case "work":
    await workControl()
    break
  case "model-policy":
    await modelPolicy()
    break
  case "task-policy":
    await taskPolicyControl()
    break
  case "sandbox":
    await sandboxControl()
    break
  case "learn":
    await learningControl()
    break
  case "hermes":
    await hermesControl()
    break
  case "dashboard":
    await dashboardControl()
    break
  case "models":
    await modelsControl()
    break
  case "detect-stack":
    await inspectStack()
    break
  case "detect-tests":
    await inspectTests()
    break
  case "router":
    await routerControl()
    break
  case "update":
    await update()
    break
  case "remove":
  case "uninstall":
    await remove()
    break
  case "version":
  case "--version":
  case "-v":
    console.log(await getPackageVersion())
    break
  case "help":
  case "--help":
  case "-h":
    printHelp()
    break
  default:
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exitCode = 1
}
