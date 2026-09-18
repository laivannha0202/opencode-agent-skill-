#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
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
  ocskill update               Update the global npm package and re-sync resources
  ocskill remove [--force]     Remove managed resources and uninstall the npm package
  ocskill version              Show package version
  ocskill help                 Show this help

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

function quoteCmd(value) {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

function findNodeShimEntry(cmdPath) {
  const dir = path.dirname(cmdPath)

  if (/^npm(?:\.cmd|\.exe)?$/i.test(path.basename(cmdPath))) {
    const entry = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
    if (existsSync(entry)) return entry
  }

  let shim = ""
  try {
    shim = readFileSync(cmdPath, "utf8")
  } catch {}
  const match = shim.match(/node_modules[\\/][^\s"]+?\.(?:js|mjs)/gi)?.at(-1)
  if (!match) return null
  const entry = path.resolve(dir, match)
  return existsSync(entry) ? entry : null
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
    const entry = findNodeShimEntry(resolved)
    if (entry) {
      const result = spawnSync(process.execPath, [entry, ...commandArgs], common)
      return result.status ?? 1
    }
    const line = [resolved, ...commandArgs].map(quoteCmd).join(" ")
    const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], common)
    return result.status ?? 1
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
    const entry = findNodeShimEntry(resolved)
    if (entry) return spawnSync(process.execPath, [entry, ...commandArgs], common)

    const line = [resolved, ...commandArgs].map(quoteCmd).join(" ")
    return spawnSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", line],
      common,
    )
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
  console.log(`[ocskill] Workflow: ${result.workflowPresent ? "OK" : "MISSING"}`)

  if (!synced ||
      result.skillsPresent !== result.skills.length ||
      result.commandsPresent !== result.commands.length ||
      result.agentsPresent !== (result.agents || []).length ||
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

async function update() {
  if (!hasCommand("npm")) {
    console.error("[ocskill] npm is required to update this global package.")
    process.exitCode = 1
    return
  }

  const currentVersion = await getPackageVersion()
  const lookup = runCapture(
    "npm",
    ["view", PACKAGE_NAME, "version", "--json"],
    { cwd: os.homedir() },
  )

  if (lookup.status !== 0) {
    console.error("[ocskill] Could not determine the latest published npm version; refusing an unsafe self-update.")
    if (lookup.stderr?.trim()) console.error(lookup.stderr.trim())
    process.exitCode = lookup.status ?? 1
    return
  }

  let latestVersion
  try {
    latestVersion = JSON.parse(lookup.stdout.trim())
  } catch {
    latestVersion = null
  }

  if (typeof latestVersion !== "string") {
    console.error("[ocskill] npm returned an invalid latest version; refusing an unsafe self-update.")
    process.exitCode = 1
    return
  }

  const compared = compareVersions(latestVersion, currentVersion)
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
    `[ocskill] Removed ${removed.skills} skills, ${removed.commands} commands and ${removed.agents} subagents.`,
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
