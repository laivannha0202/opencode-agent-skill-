#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
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
import { getUesConfigDir } from "../lib/runtime-config.mjs"
import { resolveWindowsCommand } from "../lib/windows-shim.mjs"
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
  checkpointWork,
  markCheckpointResumed,
} from "../lib/task-engine.mjs"
import { reviewScope } from "../lib/review-scope.mjs"
import { buildVerificationPlan } from "../lib/verification-plan.mjs"
import { resolveAdaptiveModel, resolveCapabilityModel, resolveModel } from "../lib/model-policy.mjs"
import { createVerificationReceipt } from "../lib/evidence-receipt.mjs"
import { classifyEngineeringTask } from "../lib/orchestrator-policy.mjs"
import { createTaskSandbox, integrateTaskSandbox, listTaskSandboxes, removeTaskSandbox, rollbackTaskSandbox } from "../lib/worktree-sandbox.mjs"
import { analyzeEvalTraces, saveLearningAnalysis, readLearningState, acceptLearning, promoteLearning } from "../lib/learning-engine.mjs"
import { hermesStatus, buildHermesDelegationPrompt, buildHermesWorkflowPrompt, hermesOneShotArgs, hermesSidecarPlan } from "../lib/hermes-bridge.mjs"
import { readModelPolicy, recordModelPerformance, validateModelID, writeModelPolicy } from "../lib/model-config.mjs"
import { evidenceStoreStatus, gcEvidenceStore, getEvidence, putEvidence } from "../lib/evidence-store.mjs"
import { inferTaskCapabilities } from "../lib/capability-registry.mjs"
import { MODEL_TASK_CLASSES } from "../lib/model-performance.mjs"
import { browserCapability, buildBrowserVerificationPlan } from "../lib/browser-adapter.mjs"
import { inspectBrowserPage, summarizeBrowserInspection } from "../lib/browser-runtime.mjs"
import { comparePngFiles, cropPngFile } from "../lib/png-diff.mjs"
import { createGeometryReceipt, responsiveViewportMatrix, validateVisualSpec } from "../lib/visual-spec.mjs"
import { planDynamicWorkflow } from "../lib/dynamic-workflow.mjs"
import { lintSkillCatalog } from "../lib/skill-quality.mjs"
import { designTokenEvidence, extractDesignTokens, inspectResponsiveLayout } from "../lib/ui-inspector.mjs"
import {
  cliErrorPayload,
  clipOutput,
  errorMessage,
  optionInt,
  optionIntOrUndefined,
  optionValue,
  positionalArg,
  readJsonFile,
  readTextFile,
  usageError,
} from "../lib/cli-utils.mjs"

const rawArgs = process.argv.slice(2)
const rawSeparator = rawArgs.indexOf("--")
const jsonOutput = rawArgs.some((value, index) =>
  value === "--json" && (rawSeparator < 0 || index < rawSeparator),
)
const args = rawArgs.filter((value, index) =>
  !(value === "--json" && (rawSeparator < 0 || index < rawSeparator)),
)
const command = args[0] || "help"
const argsSeparator = args.indexOf("--")
const helpRequested = args.some((value, index) =>
  (value === "--help" || value === "-h") && (argsSeparator < 0 || index < argsSeparator),
)
const force = args.includes("--force")
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function printHelp() {
  console.log(`
Universal Engineering System for Pi Agent\n\nUsage (preferred CLI: ues; ocskill remains a compatibility alias):\n  ocskill install [--force]    Legacy: install/re-sync OpenCode compatibility resources
  ocskill status               Show package/resource synchronization status
  ocskill doctor               Legacy migration doctor for OpenCode compatibility resources
  ocskill eval                 Validate the bundled static skill-routing suite
  ocskill eval-live [options]  Run legacy OpenCode baseline-vs-UES behavioral evals
  ocskill eval-pi [options]    Run Pi-native baseline-vs-UES weak-model benchmark
  ocskill eval-report [paths]  Aggregate live eval pass-rate/cost/tool telemetry
  ocskill inspect [dir]        Deterministic repository/stack/test-command map
  ocskill impact <query> [dir] Search likely impact paths and matching lines
  ocskill evidence [dir]       Collect stack, verification and Git evidence
  ocskill working-tree [dir]   Report Git branch/HEAD/dirty state
  ocskill diff [dir] [--out file] Emit Git diff safely as UTF-8 (Windows-safe)
  ocskill text-read <file> [--start N] [--max N]  Read UTF-8/UTF-16 text safely with bounded output
  ocskill normalize-text <file>  Convert UTF-8/UTF-16 text files to UTF-8
  ocskill repo-graph [dir] [--compact] [--max-files N]
                              Build a bounded source import/dependency graph; compact omits full node/edge payloads
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
  ocskill sandbox <action> ...  Create, integrate, rollback and clean isolated Git worktree sandboxes
                              Also supports capability/exec for fail-closed container verification
  ocskill learn <action> ...    Analyze eval traces and promote benchmark-validated lessons
  ocskill hermes <action> ...   Optional Hermes sidecar/status/task/workflow planning
  ocskill store <status|put|get|gc> ... Content-addressed evidence storage and bounded retrieval
  ocskill capabilities <text>     Infer required execution/model capabilities
  ocskill visual <action> ...     Geometry receipts, PNG diff/crop and viewport matrix
  ocskill browser <action> ...    Browser capability, plan and bounded Playwright inspection
  ocskill ui <tokens|layout> ...  Extract design tokens or verify responsive geometry
  ocskill workflow-plan <plan>    Cost-aware deterministic/LLM/vision wave schedule
  ocskill skills lint [dir]       Lint skill size, metadata and routing-description collisions
  ocskill dashboard [dir] [--serve] [--port N]
                              Generate/serve the local UES Control Center
  ues models <status|on|off|set|role> ...\n                              Configure Pi runtime role/tier model routing immediately\n  ocskill router [status|on|off] [--max N]\n                              Legacy: configure the OpenCode v2 compatibility router\n  ocskill update               Update the global npm package and re-sync resources
  ocskill remove [--force]     Remove managed resources and uninstall the npm package
  ocskill version              Show package version
  ocskill help                 Show this help

  Long-task actions:
    ocskill work init <slug> [dir] --goal <text>
    ocskill work plan <slug> <plan.json> [dir]
    ocskill work status|resume <slug> [dir]
    ocskill work gate-receipt <slug> <plan|integration> [dir] --evidence <text> [--verdict PASS|FAIL|PARTIAL] [--verifier <role>] [--session-id <id>] [--report-file <file>] [--out <file>]
    ocskill work agent-receipt <slug> <task-id> [dir] --run-id <id> --verdict PASS|FAIL --evidence <text>
    ocskill work approve-plan <slug> [dir] --evidence <plan-checker-evidence> [--receipt-file <file>]
    ocskill work start <slug> <task-id> [dir] [--lease-ms N]
    ocskill work attach-session <slug> <task-id> [dir] --run-id <id> --session-id <id> [--execution-dir <dir>] [--sandbox-dir <dir>]
    ocskill work heartbeat <slug> <task-id> [dir] --run-id <id>
    ocskill work recover <slug> [dir] [--force]
    ocskill work recover-task <slug> <task-id> [dir] [--force] [--reason <text>]
    ocskill work checkpoint <slug> <task-id> [dir] --run-id <id> [--reason <text>]
    ocskill work checkpoint-resumed <slug> <task-id> [dir] --run-id <id> [--reason <text>]
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
    ocskill models capability <provider/model> [--vision on|off] [--browser on|off] [--reasoning on|off] [--long-context on|off] [--cost low|medium|high] [--latency fast|medium|slow] [--quality 0..1]
    ocskill models observe <provider/model> --task-class <class> --passed on|off [--retries N] [--tokens N] [--latency-ms N]

  --force backs up and replaces/removes state owned by another package.
`)
}

function printCommandHelp(commandName, subcommand) {
  const workUsage = {
    init: "ocskill work init <slug> [dir] --goal <text>",
    plan: "ocskill work plan <slug> <plan.json> [dir]",
    status: "ocskill work status [slug|dir]",
    resume: "ocskill work resume <slug> [dir]",
    "gate-receipt": "ocskill work gate-receipt <slug> <plan|integration> [dir] --evidence <text>",
    "agent-receipt": "ocskill work agent-receipt <slug> <task-id> [dir] --run-id <id> --verdict PASS|FAIL --evidence <text>",
    "approve-plan": "ocskill work approve-plan <slug> [dir] --evidence <text>",
    start: "ocskill work start <slug> <task-id> [dir]",
    "attach-session": "ocskill work attach-session <slug> <task-id> [dir] --run-id <id> --session-id <id>",
    heartbeat: "ocskill work heartbeat <slug> <task-id> [dir] --run-id <id>",
    recover: "ocskill work recover <slug> [dir]",
    "recover-task": "ocskill work recover-task <slug> <task-id> [dir]",
    checkpoint: "ocskill work checkpoint <slug> <task-id> [dir] --run-id <id> [--reason <text>]",
    "checkpoint-resumed": "ocskill work checkpoint-resumed <slug> <task-id> [dir] --run-id <id> [--reason <text>]",
    events: "ocskill work events <slug> [dir]",
    "verify-command": "ocskill work verify-command <slug> <task-id> [dir] --run-id <id> -- <command> [args...]",
    complete: "ocskill work complete <slug> <task-id> [dir] --run-id <id> --evidence <text>",
    fail: "ocskill work fail <slug> <task-id> [dir] --run-id <id> --reason <text>",
    decision: "ocskill work decision <slug> [dir] --text <decision>",
    block: "ocskill work block <slug> [dir] --text <blocker>",
    unblock: "ocskill work unblock <slug> [dir] --text <blocker>",
    "verify-integration": "ocskill work verify-integration <slug> [dir] --verdict PASS|FAIL|PARTIAL --evidence <text>",
    finalize: "ocskill work finalize <slug> [dir] --evidence <text>",
  }
  if (commandName === "work") {
    if (subcommand && workUsage[subcommand]) console.log("Usage: " + workUsage[subcommand] + "\n")
    else console.log("Usage: ocskill work <action> ...\n\nActions:\n  " + Object.keys(workUsage).join("\n  "))
    return
  }
  if (commandName === "sandbox") {
    console.log("Usage: ocskill sandbox <capability|exec|list|create|integrate|rollback|remove> ...\n")
    return
  }
  if (commandName === "diff") {
    console.log("Usage: ocskill diff [dir] [--base <ref>] [--out <utf8-file>]\n")
    return
  }
  if (commandName === "text-read") {
    console.log("Usage: ocskill text-read <file> [--start N] [--max N] [--json]\n")
    return
  }
  if (commandName === "normalize-text") {
    console.log("Usage: ocskill normalize-text <file> [--out <utf8-file>]\n")
    return
  }
  printHelp()
}

function printCliError(error, options = {}) {
  const payload = cliErrorPayload(error, {
    command: options.command || args.filter((value) => value !== "--help" && value !== "-h").join(" "),
    usage: options.usage,
    hint: options.hint,
    recoverable: options.recoverable,
  })
  if (jsonOutput) console.error(JSON.stringify(payload))
  else {
    console.error("[ocskill] " + payload.error.code + ": " + payload.error.message)
    if (payload.error.hint) console.error("[ocskill] Hint: " + payload.error.hint)
  }
  process.exitCode = payload.exitCode
}

function pathLikeWorkRoot(value) {
  return !value || value === "." || value === ".." || value.includes("/") || value.includes("\\")
}

function listWorkspaces(root) {
  root = path.resolve(root)
  const base = path.join(root, ".ues-work")
  if (!existsSync(base)) return []
  const result = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const state = JSON.parse(readTextFile(path.join(base, entry.name, "STATE.json")))
      result.push({
        slug: entry.name,
        status: state.status || null,
        goal: state.goal || null,
        updatedAt: state.updatedAt || null,
        nextAction: state.nextAction || null,
      })
    } catch {}
  }
  return result.sort((a, b) => a.slug.localeCompare(b.slug))
}

function run(executable, commandArgs, options = {}) {
  const common = { stdio: "inherit", ...options }

  if (process.platform !== "win32") {
    const result = spawnSync(executable, commandArgs, common)
    return result.status ?? 1
  }

  const resolved = resolveWindowsCommand(executable)
  if (!resolved) {
    console.error("[ocskill] No safely executable Windows command found for: " + executable)
    return 127
  }

  const result = spawnSync(
    resolved.executable,
    [...resolved.argsPrefix, ...commandArgs],
    common,
  )
  return result.status ?? 1
}

function hasCommand(name) {
  if (process.platform === "win32") return resolveWindowsCommand(name) !== null
  return spawnSync("which", [name], { stdio: "ignore" }).status === 0
}

function runCapture(executable, commandArgs, options = {}) {
  const common = { encoding: "utf8", ...options }

  if (process.platform !== "win32") {
    return spawnSync(executable, commandArgs, common)
  }

  const resolved = resolveWindowsCommand(executable)
  if (!resolved) {
    return {
      status: 127,
      stdout: "",
      stderr: `No safely executable Windows command found for: ${executable}`,
    }
  }

  return spawnSync(
    resolved.executable,
    [...resolved.argsPrefix, ...commandArgs],
    common,
  )
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
  if (Number(result.openCodeMajor) >= 2) {
    console.log(`[ocskill] Prompt aliases: ${(result.promptAliases || []).length} (session.prompt compatibility path)`)
  } else {
    console.log(`[ocskill] Commands: ${result.commands.length}`)
  }
  console.log(`[ocskill] Subagents: ${result.agents.length}`)
  console.log(`[ocskill] OpenCode major: ${result.openCodeMajor}`)
  console.log(
    Number(result.openCodeMajor) >= 2
      ? "[ocskill] V13 parallel: runtime capability-gated; open a new OpenCode session and check ues.capabilities."
      : "[ocskill] V13 parallel: unavailable on OpenCode 1.x; CLI/durable workflow remains available.",
  )
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
  if (Number(result.openCodeMajor) >= 2) {
    console.log(`[ocskill] Prompt aliases: ${result.promptAliasesPresent || 0}/${(result.promptAliases || []).length}`)
  } else {
    console.log(`[ocskill] Commands: ${result.commandsPresent}/${result.commands.length}`)
  }
  console.log(`[ocskill] Subagents: ${result.agentsPresent}/${(result.agents || []).length}`)
  console.log(`[ocskill] OpenCode major: ${result.openCodeMajor ?? "legacy/unknown"}`)
  console.log(
    Number(result.openCodeMajor) >= 2
      ? "[ocskill] V13 parallel: runtime capability-gated; verify freshDispatch with ues.capabilities in a new session."
      : "[ocskill] V13 parallel: unavailable on OpenCode 1.x; use serial durable execution or upgrade the runtime.",
  )
  if ((result.plugins || []).length) console.log(`[ocskill] Router plugins: ${result.pluginsPresent}/${result.plugins.length}`)
  console.log(`[ocskill] Workflow: ${result.workflowPresent ? "OK" : "MISSING"}`)

  if (!synced ||
      result.skillsPresent !== result.skills.length ||
      result.commandsPresent !== result.commands.length ||
      (result.promptAliasesPresent || 0) !== (result.promptAliases || []).length ||
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
  const openCodeAvailable = hasCommand("opencode")
  console.log(`OpenCode: ${openCodeAvailable ? "OK" : "MISSING"}`)
  if (openCodeAvailable) {
    const code = run("opencode", ["--version"])
    if (code !== 0) process.exitCode = code
  }
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

async function evaluatePi() {
  const code = run(
    process.execPath,
    [path.join(packageRoot, "scripts", "eval-pi.mjs"), ...args.slice(1)],
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
  printJson(await repoMap(positionalArg(args, 1) || process.cwd()))
}

async function inspectImpact() {
  const query = args[1]
  if (!query) {
    printCliError(Object.assign(new Error("Usage: ocskill impact <query> [dir]"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  printJson(await impactMap(positionalArg(args, 2) || process.cwd(), query))
}

async function inspectEvidence() {
  printJson(await collectEvidence(positionalArg(args, 1) || process.cwd()))
}

async function inspectWorkingTree() {
  printJson(await checkWorkingTree(positionalArg(args, 1) || process.cwd()))
}

async function inspectStack() {
  printJson(await detectStack(positionalArg(args, 1) || process.cwd()))
}

async function inspectTests() {
  printJson(await detectTestCommands(positionalArg(args, 1) || process.cwd()))
}

async function inspectRepoGraph() {
  const root = positionalArg(args, 1) || process.cwd()
  const parsedMaxFiles = optionInt(args, "--max-files", 2500)
  const maxFiles = Number.isFinite(parsedMaxFiles)
    ? Math.max(100, Math.min(parsedMaxFiles, 10000))
    : 2500
  const graph = await buildRepoGraph(root, { maxFiles })
  if (args.includes("--compact")) {
    printJson({
      schemaVersion: graph.schemaVersion,
      root: graph.root,
      scannedFiles: graph.scannedFiles,
      truncated: graph.truncated,
      nodeCount: graph.nodes.length,
      edgeCount: graph.edges.length,
      hotspots: graph.hotspots,
      externalImports: graph.externalImports,
    })
    return
  }
  printJson(graph)
}

async function semanticIndexControl() {
  const action = args[1] || "status"
  const root = positionalArg(args, 2) || process.cwd()
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
    printCliError(error)
  }
}

async function aciControl() {
  const action = args[1]
  try {
    if (action === "search") {
      const query = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!query) throw new Error("Usage: ocskill aci search <query> [dir] [--limit N]")
      printJson(await aciSearch(root, query, { limit: optionInt(args, "--limit", 20) }))
      return
    }
    if (action === "refs") {
      const symbol = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!symbol) throw new Error("Usage: ocskill aci refs <symbol> [dir] [--limit N]")
      printJson(await aciReferences(root, symbol, { limit: optionInt(args, "--limit", 40) }))
      return
    }
    if (action === "view") {
      const file = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!file) throw new Error("Usage: ocskill aci view <file> [dir] [--line N] [--lines N]")
      printJson(await aciView(root, file, {
        line: optionInt(args, "--line", 1),
        startLine: optionInt(args, "--start-line", 0),
        lines: optionInt(args, "--lines", 120),
      }))
      return
    }
    if (action === "text") {
      const query = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!query) throw new Error("Usage: ocskill aci text <query> [dir] [--limit N]")
      printJson(await aciTextSearch(root, query, { limit: optionInt(args, "--limit", 80) }))
      return
    }
    throw new Error("Usage: ocskill aci <search|refs|view|text> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function traceControl() {
  const action = args[1] || "show"
  try {
    if (action === "show") {
      const traceID = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!traceID) throw new Error("Usage: ocskill trace show <trace-id> [dir] [--limit N]")
      printJson(await readTrajectory(root, traceID, { limit: optionInt(args, "--limit", 200) }))
      return
    }
    if (action === "append") {
      const traceID = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      const type = optionValue(args, "--type")
      const payload64 = optionValue(args, "--payload-b64")
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
    printCliError(error)
  }
}

async function inspectReviewScope() {
  const base = positionalArg(args, 1)
  const root = positionalArg(args, 2) || process.cwd()
  printJson(reviewScope(root, base))
}

async function inspectVerificationPlan() {
  printJson(await buildVerificationPlan(positionalArg(args, 1) || process.cwd(), optionValue(args, "--base")))
}

async function inspectTaskGraph() {
  const file = args[1]
  if (!file) {
    printCliError(Object.assign(new Error("Usage: ocskill task-graph <plan.json>"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  try {
    const plan = readJsonFile(file)
    const analysis = analyzePlan(plan)
    printJson(analysis)
    if (!analysis.valid) process.exitCode = 1
  } catch (error) {
    printCliError(error)
  }
}

async function inspectContextPack() {
  const slug = args[1]
  const taskID = args[2]
  if (!slug || !taskID) {
    printCliError(Object.assign(new Error("Usage: ocskill context-pack <slug> <task-id> [dir]"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  printJson(await contextPack(positionalArg(args, 3) || process.cwd(), slug, taskID))
}

async function workControl() {
  const action = args[1]
  const slug = args[2]
  if (!action) {
    const error = new Error("Usage: ocskill work <action> ...")
    error.code = "UES_USAGE"
    error.exitCode = 2
    printCliError(error)
    return
  }

  if (action === "status" && pathLikeWorkRoot(slug)) {
    const root = path.resolve(slug || process.cwd())
    const workspaces = listWorkspaces(root)
    const active = workspaces.filter((item) => item.status !== "completed")
    const candidate = active.length === 1
      ? active[0]
      : active.length === 0 && workspaces.length === 1
        ? workspaces[0]
        : null
    if (candidate) {
      const status = await workStatus(root, candidate.slug)
      printJson({
        ...status,
        autoResolved: true,
        autoResolvedSlug: candidate.slug,
        requestedRoot: root,
      })
    } else {
      printJson({
        schemaVersion: 1,
        root,
        autoResolved: false,
        workspaces,
        hint: workspaces.length > 1 ? "Pass an explicit work slug because multiple workspaces exist." : null,
      })
    }
    return
  }

  if (!slug) {
    const error = usageError("Usage: ocskill work " + action + " <slug> ...")
    printCliError(error)
    return
  }

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug))) {
    printCliError(usageError(
      "Invalid work slug '" + String(slug) + "'. Use lowercase letters, numbers and dashes only.",
    ), {
      usage: "Usage: ocskill work " + action + " <slug> ...",
      hint: "Example slug: recovery-2-foundation",
    })
    return
  }

  try {
    if (action === "init") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await initWork(root, slug, optionValue(args, "--goal")))
      return
    }
    if (action === "plan") {
      const planFile = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!planFile) throw new Error("Usage: ocskill work plan <slug> <plan.json> [dir]")
      const result = await importPlan(root, slug, planFile)
      printJson({ state: result.state, analysis: result.analysis, dir: result.paths.dir })
      return
    }
    if (action === "status") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await workStatus(root, slug))
      return
    }
    if (action === "resume") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await resumeWork(root, slug))
      return
    }
    if (action === "gate-receipt") {
      const kind = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!["plan", "integration"].includes(kind)) {
        throw new Error("Usage: ocskill work gate-receipt <slug> <plan|integration> [dir] --evidence <text>")
      }
      const reportFile = optionValue(args, "--report-file")
      const report = reportFile ? readTextFile(reportFile) : null
      const input = {
        verdict: optionValue(args, "--verdict") || "PASS",
        verifier: optionValue(args, "--verifier") || undefined,
        sessionID: optionValue(args, "--session-id"),
        runId: optionValue(args, "--run-id"),
        evidence: optionValue(args, "--evidence"),
        report,
      }
      const receipt = kind === "plan"
        ? await createPlanVerificationReceipt(root, slug, input)
        : await createIntegrationVerificationReceipt(root, slug, input)
      const outputFile = optionValue(args, "--out")
      if (outputFile) {
        const resolved = path.resolve(outputFile)
        writeFileSync(resolved, JSON.stringify(receipt, null, 2) + "\n", "utf8")
        printJson({ file: resolved, receipt })
      } else {
        printJson(receipt)
      }
      return
    }
    if (action === "agent-receipt") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      const runId = optionValue(args, "--run-id")
      const verdict = String(optionValue(args, "--verdict") || "").toUpperCase()
      const evidence = String(optionValue(args, "--evidence") || "").trim()
      const verifier = String(optionValue(args, "--verifier") || "ues-verifier")
      const sessionID = optionValue(args, "--session-id")
      if (!taskID || !runId || !["PASS", "FAIL"].includes(verdict) || !evidence) {
        const error = new Error("Usage: ocskill work agent-receipt <slug> <task-id> [dir] --run-id <id> --verdict PASS|FAIL --evidence <text> [--verifier <role>] [--session-id <id>]")
        error.code = "UES_USAGE"
        error.exitCode = 2
        throw error
      }
      const fingerprint = workspaceFingerprint(root)
      const timestamp = new Date().toISOString()
      const receipt = createVerificationReceipt({
        task: taskID,
        runId,
        command: "ues-agent-verifier",
        args: [verifier, ...(sessionID ? [sessionID] : [])],
        cwd: path.resolve(root),
        exitCode: verdict === "PASS" ? 0 : 1,
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
        stdout: evidence,
        stderr: verdict === "PASS" ? "" : evidence,
        workspaceBefore: fingerprint,
        workspaceAfter: fingerprint,
      })
      receipt.kind = "agent-verifier"
      receipt.verifier = verifier
      receipt.sessionID = sessionID || null
      receipt.evidence = evidence
      printJson(await recordVerificationReceipt(root, slug, taskID, receipt))
      return
    }
    if (action === "approve-plan") {
      const root = positionalArg(args, 3) || process.cwd()
      const receiptFile = optionValue(args, "--receipt-file")
      const receipt = receiptFile ? readJsonFile(receiptFile) : null
      printJson(await approvePlan(root, slug, optionValue(args, "--evidence"), { receipt }))
      return
    }
    if (action === "start") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work start <slug> <task-id> [dir]")
      printJson(await startTask(root, slug, taskID, {
        leaseMs: optionIntOrUndefined(args, "--lease-ms"),
      }))
      return
    }
    if (action === "attach-session") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work attach-session <slug> <task-id> [dir] --run-id <id> --session-id <id>")
      printJson(await attachTaskSession(
        root,
        slug,
        taskID,
        optionValue(args, "--run-id"),
        optionValue(args, "--session-id"),
        {
          executionDir: optionValue(args, "--execution-dir"),
          sandboxDir: optionValue(args, "--sandbox-dir"),
        },
      ))
      return
    }
    if (action === "heartbeat") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      const runId = optionValue(args, "--run-id")
      if (!taskID || !runId) throw new Error("Usage: ocskill work heartbeat <slug> <task-id> [dir] --run-id <id>")
      printJson(await heartbeatTask(root, slug, taskID, runId, {
        leaseMs: optionIntOrUndefined(args, "--lease-ms"),
      }))
      return
    }
    if (action === "recover") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await recoverStaleTasks(root, slug, { force: args.includes("--force") }))
      return
    }
    if (action === "recover-task") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work recover-task <slug> <task-id> [dir] [--force] [--reason <text>]")
      printJson(await recoverTask(root, slug, taskID, {
        force: args.includes("--force"),
        reason: optionValue(args, "--reason"),
      }))
      return
    }
    if (action === "checkpoint") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work checkpoint <slug> <task-id> [dir] --run-id <id> [--reason <text>]")
      printJson(await checkpointWork(root, slug, {
        taskID,
        runId: optionValue(args, "--run-id"),
        reason: optionValue(args, "--reason") || "pre-compaction",
      }))
      return
    }
    if (action === "checkpoint-resumed") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!taskID) throw new Error("Usage: ocskill work checkpoint-resumed <slug> <task-id> [dir] --run-id <id> [--reason <text>]")
      printJson(await markCheckpointResumed(root, slug, {
        taskID,
        runId: optionValue(args, "--run-id"),
        reason: optionValue(args, "--reason"),
      }))
      return
    }
    if (action === "events") {
      const root = positionalArg(args, 3) || process.cwd()
      const limit = optionInt(args, "--limit", 200)
      printJson(await runtimeEvents(root, slug, { limit }))
      return
    }
    if (action === "verify-command") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      const separator = args.indexOf("--")
      const executable = separator >= 0 ? args[separator + 1] : null
      const commandArgs = separator >= 0 ? args.slice(separator + 2) : []
      const runId = optionValue(args, "--run-id")
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
      printJson({
        receipt: recorded,
        output: {
          stdout: clipOutput(result.stdout),
          stderr: clipOutput(result.stderr),
        },
      })
      if ((result.status ?? 1) !== 0) process.exitCode = result.status ?? 1
      return
    }
    if (action === "complete") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      const runId = optionValue(args, "--run-id")
      if (!taskID || !runId) throw new Error("Usage: ocskill work complete <slug> <task-id> [dir] --run-id <id> --evidence <text>")
      const reportFile = optionValue(args, "--report-file")
      const report = reportFile ? readTextFile(reportFile) : null
      printJson(await completeTask(root, slug, taskID, {
        evidence: optionValue(args, "--evidence"),
        report,
        runId,
      }))
      return
    }
    if (action === "fail") {
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      const runId = optionValue(args, "--run-id")
      if (!taskID || !runId) throw new Error("Usage: ocskill work fail <slug> <task-id> [dir] --run-id <id> --reason <text>")
      printJson(await failTask(root, slug, taskID, optionValue(args, "--reason"), { runId }))
      return
    }
    if (action === "decision") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await addDecision(root, slug, optionValue(args, "--text")))
      return
    }
    if (action === "block") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await addBlocker(root, slug, optionValue(args, "--text")))
      return
    }
    if (action === "unblock") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await resolveBlocker(root, slug, optionValue(args, "--text")))
      return
    }
    if (action === "verify-integration") {
      const root = positionalArg(args, 3) || process.cwd()
      const reportFile = optionValue(args, "--report-file")
      const report = reportFile ? readTextFile(reportFile) : null
      const receiptFile = optionValue(args, "--receipt-file")
      const receipt = receiptFile ? readJsonFile(receiptFile) : null
      printJson(await recordIntegrationVerification(
        root,
        slug,
        optionValue(args, "--verdict"),
        optionValue(args, "--evidence"),
        report,
        { receipt },
      ))
      return
    }
    if (action === "finalize") {
      const root = positionalArg(args, 3) || process.cwd()
      printJson(await finalizeWork(root, slug, optionValue(args, "--evidence")))
      return
    }

    throw usageError("Unknown work action: " + action)
  } catch (error) {
    if (error?.validation && !jsonOutput) printJson(error.validation)
    printCliError(error, {
      command: "work " + String(action || ""),
      recoverable: error?.code === "UES_USAGE",
    })
  }
}

async function modelPolicy() {
  const role = args[1]
  if (!role) {
    printCliError(Object.assign(new Error("Usage: ocskill model-policy <role> [--attempt N]"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  const attempt = optionInt(args, "--attempt", 1)
  const policy = await readModelPolicy(getUesConfigDir())
  const normalizedAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1
  const taskText = optionValue(args, "--text")
  if (taskText) {
    const taskPolicy = classifyEngineeringTask(taskText)
    printJson(resolveCapabilityModel(role, normalizedAttempt, taskText, taskPolicy, policy))
    return
  }
  printJson(resolveModel(role, normalizedAttempt, policy))
}


async function modelsControl() {
  const action = args[1] || "status"
  let policy = await readModelPolicy(getUesConfigDir())

  if (action === "status") {
    printJson(policy)
    return
  }
  if (action === "on" || action === "off") {
    policy = await writeModelPolicy(getUesConfigDir(), { enabled: action === "on" })
    printJson(policy)
    console.log("[ocskill] Model routing is active immediately for Pi child-agent dispatch.")
    return
  }
  if (action === "set") {
    const tier = args[2]
    const model = args[3]
    if (!["light", "standard", "heavy"].includes(tier) || !validateModelID(model)) {
      printCliError(Object.assign(new Error("Usage: ocskill models set <light|standard|heavy> <provider/model[#variant]>"), { code: "UES_USAGE", exitCode: 2 }))
      return
    }
    policy = await writeModelPolicy(getUesConfigDir(), {
      enabled: true,
      tiers: { [tier]: model },
    })
    printJson(policy)
    console.log("[ocskill] Model routing is active immediately for Pi child-agent dispatch.")
    return
  }
  if (action === "role") {
    const role = args[2]
    const tier = args[3]
    if (!role || !["light", "standard", "heavy"].includes(tier)) {
      printCliError(Object.assign(new Error("Usage: ocskill models role <role> <light|standard|heavy>"), { code: "UES_USAGE", exitCode: 2 }))
      return
    }
    policy = await writeModelPolicy(getUesConfigDir(), {
      roleTiers: { [role]: tier },
    })
    printJson(policy)
    console.log("[ocskill] Role-tier routing is active immediately for Pi child-agent dispatch.")
    return
  }

  if (action === "observe") {
    const model = args[2]
    if (!validateModelID(model)) {
      printCliError(Object.assign(new Error("Usage: ocskill models observe <provider/model> --task-class <class> --passed on|off"), { code: "UES_USAGE", exitCode: 2 }))
      return
    }
    const taskClass = optionValue(args, "--task-class") || "general"
    if (!MODEL_TASK_CLASSES.includes(taskClass)) throw new Error("--task-class must be one of: " + MODEL_TASK_CLASSES.join(", "))
    const passedRaw = String(optionValue(args, "--passed") || "").toLowerCase()
    if (!["on","off","true","false","pass","fail"].includes(passedRaw)) throw new Error("--passed must be on/off, true/false, or pass/fail")
    policy = await recordModelPerformance(getUesConfigDir(), {
      model, taskClass, passed: ["on","true","pass"].includes(passedRaw),
      retries: optionInt(args, "--retries", 0) || 0,
      tokens: optionInt(args, "--tokens", 0) || 0,
      latencyMs: optionInt(args, "--latency-ms", 0) || 0,
    })
    printJson({ model, taskClass, recorded: true, performance: policy.performance?.[model]?.[taskClass] || null })
    return
  }

  if (action === "capability") {
    const model = args[2]
    if (!validateModelID(model)) {
      printCliError(Object.assign(new Error("Usage: ocskill models capability <provider/model> [capability flags]"), { code: "UES_USAGE", exitCode: 2 }))
      return
    }
    const current = policy.capabilities?.[model] || {}
    const boolFlag = (name, prior) => {
      const value = optionValue(args, name)
      if (value == null) return prior
      if (!["on", "off", "true", "false"].includes(String(value).toLowerCase())) throw new Error(name + " must be on/off")
      return ["on", "true"].includes(String(value).toLowerCase())
    }
    const qualityRaw = optionValue(args, "--quality")
    const quality = qualityRaw == null ? current.quality : Number(qualityRaw)
    if (qualityRaw != null && (!Number.isFinite(quality) || quality < 0 || quality > 1)) throw new Error("--quality must be from 0 to 1")
    const cost = optionValue(args, "--cost") || current.costClass
    const latency = optionValue(args, "--latency") || current.latencyClass
    if (cost && !["low", "medium", "high"].includes(cost)) throw new Error("--cost must be low|medium|high")
    if (latency && !["fast", "medium", "slow"].includes(latency)) throw new Error("--latency must be fast|medium|slow")
    policy = await writeModelPolicy(getUesConfigDir(), {
      capabilities: {
        [model]: {
          ...current,
          coding: boolFlag("--coding", current.coding),
          reasoning: boolFlag("--reasoning", current.reasoning),
          toolCalling: boolFlag("--tool-calling", current.toolCalling),
          vision: boolFlag("--vision", current.vision),
          browser: boolFlag("--browser", current.browser),
          filesystem: boolFlag("--filesystem", current.filesystem),
          longContext: boolFlag("--long-context", current.longContext),
          ...(cost ? { costClass: cost } : {}),
          ...(latency ? { latencyClass: latency } : {}),
          ...(quality != null ? { quality } : {}),
        },
      },
    })
    printJson(policy)
    return
  }

  printCliError(Object.assign(new Error("Usage: ocskill models <status|on|off|set|role> ..."), { code: "UES_USAGE", exitCode: 2 }))
}

async function routerControl() {
  const action = args[1] || "status"
  const maxIndex = args.indexOf("--max")
  const maxValue = maxIndex >= 0 ? Number.parseInt(optionValue(args, "--max") ?? "", 10) : null

  if (!["status", "on", "off"].includes(action)) {
    printCliError(Object.assign(new Error("Usage: ocskill router [status|on|off] [--max 1..6]"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  if (maxIndex >= 0 && (!Number.isInteger(maxValue) || maxValue < 1 || maxValue > 6)) {
    printCliError(Object.assign(new Error("--max must be an integer from 1 through 6"), {
      code: "UES_USAGE",
      exitCode: 2,
    }))
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
    printCliError(Object.assign(new Error("Usage: ocskill task-policy <text>"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  printJson(classifyEngineeringTask(text))
}

async function sandboxControl() {
  const action = args[1] || "list"
  try {
    if (action === "capability") {
      printJson(containerSandboxCapability(optionValue(args, "--engine")))
      return
    }
    if (action === "exec") {
      const separator = args.indexOf("--")
      const root = positionalArg(args, 2) || process.cwd()
      const executable = separator >= 0 ? args[separator + 1] : null
      const commandArgs = separator >= 0 ? args.slice(separator + 2) : []
      const image = optionValue(args, "--image")
      if (!image || !executable) {
        throw new Error("Usage: ocskill sandbox exec [dir] --image <image> [--engine docker|podman] -- <command> [args...]")
      }
      const result = runContainerSandbox(root, {
        engine: optionValue(args, "--engine"),
        image,
        command: executable,
        args: commandArgs,
        timeoutMs: optionInt(args, "--timeout-ms", 10 * 60_000),
      })
      printJson({ ...result, stdout: clipOutput(result.stdout), stderr: clipOutput(result.stderr) })
      if (result.status !== 0) process.exitCode = result.status
      return
    }
    if (action === "list") {
      printJson(listTaskSandboxes(positionalArg(args, 2) || process.cwd()))
      return
    }
    if (action === "create") {
      const slug = args[2]
      const taskID = args[3]
      const root = positionalArg(args, 4) || process.cwd()
      if (!slug || !taskID) throw new Error("Usage: ocskill sandbox create <slug> <task-id> [dir]")
      printJson(await createTaskSandbox(root, slug, taskID, {
        inheritDirtyRoot: args.includes("--inherit-dirty-root"),
        allowDirtyRoot: args.includes("--allow-dirty-root"),
        startPoint: optionValue(args, "--start-point") || undefined,
      }))
      return
    }
    if (action === "integrate") {
      const dir = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!dir) throw new Error("Usage: ocskill sandbox integrate <worktree-path> [dir] [--keep]")
      printJson(await integrateTaskSandbox(root, dir, { keep: args.includes("--keep") }))
      return
    }
    if (action === "rollback") {
      const dir = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!dir) throw new Error("Usage: ocskill sandbox rollback <worktree-path> [dir] [--keep]")
      printJson(await rollbackTaskSandbox(root, dir, { keep: args.includes("--keep") }))
      return
    }
    if (action === "remove") {
      const dir = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!dir) throw new Error("Usage: ocskill sandbox remove <worktree-path> [dir] [--force] [--delete-branch]")
      printJson(await removeTaskSandbox(root, dir, {
        force: args.includes("--force"),
        deleteBranch: args.includes("--delete-branch"),
      }))
      return
    }
    throw new Error("Usage: ocskill sandbox <capability|exec|list|create|integrate|rollback|remove> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function learningControl() {
  const action = args[1] || "status"
  const root = positionalArg(args, 2) || process.cwd()
  try {
    if (action === "status") {
      printJson(await readLearningState(root))
      return
    }
    if (action === "analyze") {
      const evalDir = optionValue(args, "--eval-dir") || path.join(path.resolve(root), ".ues-evals")
      const analysis = await analyzeEvalTraces(evalDir)
      const state = await saveLearningAnalysis(root, analysis)
      printJson({ analysis, state })
      return
    }
    if (action === "accept") {
      const id = args[2]
      const acceptRoot = positionalArg(args, 3) || process.cwd()
      if (!id) throw new Error("Usage: ocskill learn accept <proposal-id> [dir]")
      printJson(await acceptLearning(acceptRoot, id))
      return
    }
    if (action === "promote") {
      const id = args[2]
      const promoteRoot = positionalArg(args, 3) || process.cwd()
      if (!id) throw new Error("Usage: ocskill learn promote <proposal-id> [dir] --report <matrix-summary.json>")
      printJson(await promoteLearning(promoteRoot, id, {
        report: optionValue(args, "--report"),
      }))
      return
    }
    throw new Error("Usage: ocskill learn <status|analyze|accept|promote> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function hermesControl() {
  const action = args[1] || "status"
  if (action === "status") {
    printJson(hermesStatus())
    return
  }
  if (action === "workflow" || action === "exec-workflow") {
    const slug = args[2]
    const root = positionalArg(args, 3) || process.cwd()
    if (!slug) {
      printCliError(Object.assign(new Error("Usage: ocskill hermes <workflow|exec-workflow> <slug> [dir] [--max-concurrent N]"), { code: "UES_USAGE", exitCode: 2 }))
      return
    }
    const planFile = path.join(path.resolve(root), ".ues-work", slug, "PLAN.json")
    const plan = readJsonFile(planFile)
    const schedule = planDynamicWorkflow(plan.tasks || [], {
      maxConcurrent: optionInt(args, "--max-concurrent", 4),
    })
    const sidecar = hermesSidecarPlan({ mode: "dynamic-workflow", maxConcurrent: schedule.maxConcurrent })
    const prompt = buildHermesWorkflowPrompt({ slug, goal: plan.goal || null, plan }, schedule)
    if (action === "workflow") {
      printJson({ sidecar, schedule, prompt })
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
  if (action === "prompt" || action === "exec") {
    const slug = args[2]
    const taskID = args[3]
    const root = positionalArg(args, 4) || process.cwd()
    if (!slug || !taskID) {
      printCliError(Object.assign(new Error("Usage: ocskill hermes <prompt|exec> <slug> <task-id> [dir]"), { code: "UES_USAGE", exitCode: 2 }))
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
  printCliError(Object.assign(new Error("Usage: ocskill hermes <status|prompt|exec|workflow|exec-workflow> ..."), { code: "UES_USAGE", exitCode: 2 }))
}

async function evidenceStoreControl() {
  const action = args[1] || "status"
  try {
    if (action === "status") {
      printJson(await evidenceStoreStatus(positionalArg(args, 2) || process.cwd()))
      return
    }
    if (action === "put") {
      const file = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!file) throw new Error("Usage: ocskill store put <file> [dir] [--kind <kind>] [--summary <text>]")
      const content = readTextFile(file)
      printJson(await putEvidence(root, content, {
        kind: optionValue(args, "--kind") || "file",
        source: path.resolve(file),
        summary: optionValue(args, "--summary"),
      }))
      return
    }
    if (action === "get") {
      const ref = args[2]
      const root = positionalArg(args, 3) || process.cwd()
      if (!ref) throw new Error("Usage: ocskill store get <evidence-ref> [dir] [--max N] [--start N]")
      printJson(await getEvidence(root, ref, {
        maxChars: optionInt(args, "--max", 24_000),
        start: optionInt(args, "--start", 0),
      }))
      return
    }
    if (action === "gc") {
      const root = positionalArg(args, 2) || process.cwd()
      printJson(await gcEvidenceStore(root, {
        maxEntries: optionInt(args, "--max-entries", 2000),
        maxAgeDays: optionInt(args, "--max-age-days", 30),
      }))
      return
    }
    throw new Error("Usage: ocskill store <status|put|get|gc> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function capabilityControl() {
  const text = args.slice(1).join(" ").trim()
  if (!text) {
    printCliError(Object.assign(new Error("Usage: ocskill capabilities <task text>"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  printJson(inferTaskCapabilities(text))
}

async function visualControl() {
  const action = args[1]
  try {
    if (action === "spec") {
      const file = args[2]
      if (!file) throw new Error("Usage: ocskill visual spec <VISUAL_SPEC.json>")
      printJson(validateVisualSpec(readJsonFile(file)))
      return
    }
    if (action === "geometry") {
      const specFile = args[2]
      const actualFile = args[3]
      if (!specFile || !actualFile) throw new Error("Usage: ocskill visual geometry <VISUAL_SPEC.json> <actual-boxes.json>")
      printJson(createGeometryReceipt(readJsonFile(specFile), readJsonFile(actualFile)))
      return
    }
    if (action === "compare") {
      const expected = args[2]
      const actual = args[3]
      if (!expected || !actual) throw new Error("Usage: ocskill visual compare <expected.png> <actual.png> [--threshold N] [--max-diff-ratio N]")
      const threshold = Number(optionValue(args, "--threshold") ?? 16)
      const maxDiffRatio = Number(optionValue(args, "--max-diff-ratio") ?? 0)
      printJson(await comparePngFiles(expected, actual, { threshold, maxDiffRatio }))
      return
    }
    if (action === "crop") {
      const input = args[2]
      const output = args[3]
      if (!input || !output) throw new Error("Usage: ocskill visual crop <input.png> <output.png> --x N --y N --width N --height N")
      printJson(await cropPngFile(input, output, {
        x: optionInt(args, "--x", 0),
        y: optionInt(args, "--y", 0),
        width: optionInt(args, "--width", 1),
        height: optionInt(args, "--height", 1),
      }))
      return
    }
    if (action === "viewports") {
      printJson(responsiveViewportMatrix())
      return
    }
    throw new Error("Usage: ocskill visual <spec|geometry|compare|crop|viewports> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function browserControl() {
  const action = args[1] || "capability"
  try {
    if (action === "capability") {
      printJson(await browserCapability(positionalArg(args, 2) || process.cwd()))
      return
    }
    if (action === "plan") {
      const url = args[2] || null
      printJson(buildBrowserVerificationPlan({
        url,
        target: optionValue(args, "--target"),
      }))
      return
    }
    if (action === "inspect") {
      const url = args[2]
      if (!url) throw new Error("Usage: ocskill browser inspect <url> [dir] [--selector <css>] [--screenshot <path>] [--width N] [--height N] [--max-elements N]")
      const root = positionalArg(args, 3) || process.cwd()
      const report = await inspectBrowserPage(root, url, {
        selector: optionValue(args, "--selector"),
        screenshot: optionValue(args, "--screenshot"),
        width: optionInt(args, "--width", 1440),
        height: optionInt(args, "--height", 900),
        maxElements: optionInt(args, "--max-elements", 80),
        timeoutMs: optionInt(args, "--timeout-ms", 30000),
        waitMs: optionInt(args, "--wait-ms", 0),
        fullPage: !args.includes("--viewport-only"),
      })
      printJson(args.includes("--full") ? report : summarizeBrowserInspection(report, { limit: optionInt(args, "--limit", 20) }))
      return
    }
    throw new Error("Usage: ocskill browser <capability|plan|inspect> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function uiControl() {
  const action = args[1]
  try {
    if (action === "tokens") {
      const file = args[2]
      if (!file) throw new Error("Usage: ocskill ui tokens <styles.css>")
      const tokens = extractDesignTokens(readTextFile(file))
      printJson({ tokens, evidence: designTokenEvidence(tokens) })
      return
    }
    if (action === "layout") {
      const file = args[2]
      if (!file) throw new Error("Usage: ocskill ui layout <boxes.json> --width N --height N [--min-touch N] [--overlap-ratio N]")
      const payload = readJsonFile(file)
      const items = Array.isArray(payload) ? payload : payload.elements || payload.boxes || []
      printJson(inspectResponsiveLayout(items, {
        width: optionInt(args, "--width", Number(payload.viewport?.width || 0)),
        height: optionInt(args, "--height", Number(payload.viewport?.height || 0)),
      }, {
        minTouchTarget: optionInt(args, "--min-touch", 44),
        overlapRatio: Number(optionValue(args, "--overlap-ratio") ?? 0.15),
      }))
      return
    }
    throw new Error("Usage: ocskill ui <tokens|layout> ...")
  } catch (error) {
    printCliError(error)
  }
}

async function diffControl() {
  const root = path.resolve(positionalArg(args, 1) || process.cwd())
  const base = optionValue(args, "--base")
  const outputFile = optionValue(args, "--out")
  const commandArgs = ["diff", "--binary", "--no-ext-diff", ...(base ? [base] : []), "--"]
  const result = runCapture("git", commandArgs, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  if ((result.status ?? 1) !== 0) {
    const error = new Error((result.stderr || result.stdout || "git diff failed").trim())
    error.code = "UES_GIT_DIFF"
    throw error
  }
  if (outputFile) {
    const resolved = path.resolve(outputFile)
    writeFileSync(resolved, result.stdout || "", "utf8")
    printJson({ schemaVersion: 1, root, base: base || null, file: resolved, encoding: "utf8", bytes: Buffer.byteLength(result.stdout || "") })
    return
  }
  if (jsonOutput) {
    printJson({ schemaVersion: 1, root, base: base || null, encoding: "utf8", diff: result.stdout || "" })
    return
  }
  process.stdout.write(result.stdout || "")
}

async function textReadControl() {
  const file = positionalArg(args, 1)
  if (!file) {
    const error = new Error("Usage: ocskill text-read <file> [--start N] [--max N] [--json]")
    error.code = "UES_USAGE"
    error.exitCode = 2
    throw error
  }
  const text = readTextFile(file)
  const parsedStart = optionInt(args, "--start", 0)
  const parsedMax = optionInt(args, "--max", 12000)
  const start = Number.isFinite(parsedStart) ? Math.max(0, parsedStart) : 0
  const maxChars = Number.isFinite(parsedMax) ? Math.max(256, Math.min(parsedMax, 100000)) : 12000
  const slice = text.slice(start, start + maxChars)
  const truncated = start + slice.length < text.length
  if (jsonOutput) {
    printJson({
      schemaVersion: 1,
      file: path.resolve(file),
      chars: text.length,
      start,
      returnedChars: slice.length,
      truncated,
      text: slice,
    })
    return
  }
  process.stdout.write(slice)
  if (truncated) process.stdout.write("\n...[UES text-read truncated]...\n")
}

async function normalizeTextControl() {
  const file = args[1]
  if (!file) {
    const error = new Error("Usage: ocskill normalize-text <file> [--out <utf8-file>]")
    error.code = "UES_USAGE"
    error.exitCode = 2
    throw error
  }
  const text = readTextFile(file)
  const output = path.resolve(optionValue(args, "--out") || file)
  writeFileSync(output, text, "utf8")
  printJson({ schemaVersion: 1, input: path.resolve(file), output, encoding: "utf8", bytes: Buffer.byteLength(text) })
}

async function workflowPlanControl() {
  const file = args[1]
  if (!file) {
    printCliError(Object.assign(new Error("Usage: ocskill workflow-plan <PLAN.json> [--max-concurrent N]"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  try {
    const plan = readJsonFile(file)
    printJson(planDynamicWorkflow(plan.tasks || [], {
      maxConcurrent: optionInt(args, "--max-concurrent", 4),
      maxLLMConcurrent: optionInt(args, "--max-llm-concurrent", optionInt(args, "--max-concurrent", 4)),
      maxVisionConcurrent: optionInt(args, "--max-vision-concurrent", 2),
      maxWaveCost: optionInt(args, "--max-wave-cost", 24),
      minAgentCost: optionInt(args, "--min-agent-cost", 5),
      minVisionAgentCost: optionInt(args, "--min-vision-agent-cost", 4),
    }))
  } catch (error) {
    printCliError(error)
  }
}

async function skillsControl() {
  const action = args[1] || "lint"
  if (action !== "lint") {
    printCliError(Object.assign(new Error("Usage: ocskill skills lint [dir]"), { code: "UES_USAGE", exitCode: 2 }))
    return
  }
  try {
    printJson(await lintSkillCatalog(positionalArg(args, 2) || packageRoot))
  } catch (error) {
    printCliError(error)
  }
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
    console.error(errorMessage(error))
    process.exitCode = error?.exitCode || 1
    return
  }

  const latestVersion = resolved.version

  let compared
  try {
    compared = compareVersions(latestVersion, currentVersion)
  } catch (error) {
    console.error("[ocskill] npm returned a version that could not be compared safely; refusing update.")
    printCliError(error)
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

async function main() {
  if (helpRequested) {
    printCommandHelp(command, args[1])
    return
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
  case "eval-pi":
    await evaluatePi()
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
  case "store":
    await evidenceStoreControl()
    break
  case "capabilities":
    await capabilityControl()
    break
  case "visual":
    await visualControl()
    break
  case "browser":
    await browserControl()
    break
  case "workflow-plan":
    await workflowPlanControl()
    break
  case "diff":
    await diffControl().catch((error) => printCliError(error))
    break
  case "text-read":
    await textReadControl().catch((error) => printCliError(error))
    break
  case "normalize-text":
    await normalizeTextControl().catch((error) => printCliError(error))
    break
  case "ui":
    await uiControl()
    break
  case "skills":
    await skillsControl()
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
  default: {
    const error = new Error("Unknown command: " + command)
    error.code = "UES_USAGE"
    error.exitCode = 2
    throw error
  }
  }
}

try {
  await main()
} catch (error) {
  printCliError(error)
}
