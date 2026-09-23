import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { removeResources } from "../lib/installer.mjs"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const normalizedRoot = packageRoot.replaceAll("\\", "/").toLowerCase()

function isPiPackageInstall() {
  return [
    "/.pi/agent/git/",
    "/.pi/agent/npm/",
    "/.pi/git/",
    "/.pi/npm/",
  ].some((marker) => normalizedRoot.includes(marker))
}

function npmGlobalPrefix() {
  if (process.platform === "win32") {
    const result = spawnSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "npm prefix -g"],
      { encoding: "utf8" },
    )
    return result.status === 0 ? result.stdout?.trim() : null
  }

  const result = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8" })
  return result.status === 0 ? result.stdout?.trim() : null
}

function isGlobalInstall() {
  if (process.env.npm_config_global === "true" || process.env.npm_config_global === "1") {
    return true
  }

  const prefix = npmGlobalPrefix()
  if (!prefix) return false
  return packageRoot.toLowerCase().startsWith(path.resolve(prefix).toLowerCase())
}

if (isPiPackageInstall() || !isGlobalInstall()) {
  console.log("[ocskill] Non-global/Pi package uninstall detected; leaving OpenCode resources untouched.")
  process.exit(0)
}

try {
  const result = await removeResources()
  for (const warning of result.warnings || []) {
    console.warn(`[ocskill] WARNING: ${warning}`)
  }

  if (result.stateError) {
    console.error(`[ocskill] ERROR: ${result.stateError}`)
    process.exit(1)
  }

  console.log(
    `[ocskill] Removed ${result.skills} managed skills, ${result.commands} managed commands and ${result.agents} managed subagents.`,
  )
} catch (error) {
  console.error("[ocskill] Cleanup failed.")
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
