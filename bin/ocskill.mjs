#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import {
  PACKAGE_NAME,
  getConfigDir,
  getPackageVersion,
  getStatus,
  installResources,
  removeResources,
} from "../lib/installer.mjs"

const args = process.argv.slice(2)
const command = args[0] || "help"
const lifecycle = args.includes("--lifecycle")
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function printHelp() {
  console.log(`
OpenCode Universal Engineering System

Usage:
  ocskill install    Install/sync bundled skills into OpenCode
  ocskill status     Show installed resource status
  ocskill doctor     Check Node, npm, OpenCode and install state
  ocskill update     Update the global npm package to latest
  ocskill remove     Uninstall the global npm package
  ocskill version    Show package version
  ocskill help       Show this help
`)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  })
  return result.status ?? 1
}

function hasCommand(name) {
  const checker = process.platform === "win32" ? "where" : "which"
  return spawnSync(checker, [name], { stdio: "ignore" }).status === 0
}

async function install() {
  if (lifecycle && process.env.npm_config_global !== "true") {
    console.log("[ocskill] Local npm install detected; skipping global OpenCode setup.")
    return
  }

  const result = await installResources()
  console.log(`[ocskill] Installed v${result.version}`)
  console.log(`[ocskill] OpenCode config: ${result.configDir}`)
  console.log(`[ocskill] Skills: ${result.skills.length}`)
  console.log(`[ocskill] Commands: ${result.commands.length}`)
  for (const warning of result.warnings) console.warn(`[ocskill] WARNING: ${warning}`)
  console.log("[ocskill] Restart OpenCode or start a new session.")
}

async function status() {
  const result = await getStatus()
  if (!result.installed) {
    console.log("[ocskill] Not installed in OpenCode.")
    console.log(`[ocskill] Expected config: ${result.configDir}`)
    process.exitCode = 1
    return
  }

  console.log(`[ocskill] Package version: ${result.version}`)
  console.log(`[ocskill] Config: ${result.configDir}`)
  console.log(`[ocskill] Skills: ${result.skillsPresent}/${result.skills.length}`)
  console.log(`[ocskill] Commands: ${result.commandsPresent}/${result.commands.length}`)
  console.log(`[ocskill] Workflow: ${result.workflowPresent ? "OK" : "MISSING"}`)
}

async function doctor() {
  console.log("OpenCode Universal Engineering System - doctor")
  console.log(`Package: ${PACKAGE_NAME}`)
  console.log(`Version: ${await getPackageVersion()}`)
  console.log(`Node:    ${process.version}`)
  console.log(`Config:  ${getConfigDir()}`)
  console.log(`npm:     ${hasCommand("npm") ? "OK" : "MISSING"}`)
  console.log(`OpenCode:${hasCommand("opencode") ? " OK" : " MISSING"}`)
  if (hasCommand("opencode")) run("opencode", ["--version"])
  await status()
}

async function update() {
  if (!hasCommand("npm")) {
    console.error("[ocskill] npm is required to update this global package.")
    process.exitCode = 1
    return
  }
  console.log(`[ocskill] Updating ${PACKAGE_NAME} to latest...`)
  const code = run("npm", ["install", "-g", `${PACKAGE_NAME}@latest`], { cwd: packageRoot })
  if (code !== 0) process.exitCode = code
}

async function remove() {
  if (lifecycle) {
    const result = await removeResources()
    console.log(`[ocskill] Removed ${result.skills} skills and ${result.commands} commands.`)
    return
  }

  if (!hasCommand("npm")) {
    console.error("[ocskill] npm is required to uninstall the global package.")
    process.exitCode = 1
    return
  }

  console.log(`[ocskill] Uninstalling ${PACKAGE_NAME}...`)
  const code = run("npm", ["uninstall", "-g", PACKAGE_NAME], { cwd: packageRoot })
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
