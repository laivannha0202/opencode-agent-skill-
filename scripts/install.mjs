import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { installResources } from "../lib/installer.mjs"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

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

if (!isGlobalInstall()) {
  console.log("[ocskill] Local npm install detected; skipping OpenCode global setup.")
  console.log("[ocskill] Use 'node bin/ocskill.mjs install' to test installation manually.")
  process.exit(0)
}

try {
  const result = await installResources()
  console.log(`[ocskill] Installed resources for v${result.version}`)
  console.log(`[ocskill] OpenCode config: ${result.configDir}`)
  console.log(`[ocskill] Skills: ${result.skills.length}`)
  console.log(`[ocskill] Commands: ${result.commands.length}`)
  console.log(`[ocskill] Subagents: ${result.agents.length}`)
  for (const warning of result.warnings) {
    console.warn(`[ocskill] WARNING: ${warning}`)
  }
  console.log("[ocskill] Start a new OpenCode session to pick up workflow changes.")
} catch (error) {
  console.error("[ocskill] Installation failed.")
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
