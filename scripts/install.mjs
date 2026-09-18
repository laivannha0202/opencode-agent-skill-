import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { installResources } from "../lib/installer.mjs"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function isGlobalInstall() {
  if (process.env.npm_config_global === "true" || process.env.npm_config_global === "1") {
    return true
  }

  const result = spawnSync("npm", ["prefix", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  })

  if (result.status !== 0 || !result.stdout) return false

  const globalPrefix = path.resolve(result.stdout.trim())
  const normalizedRoot = packageRoot.toLowerCase()
  const normalizedPrefix = globalPrefix.toLowerCase()

  return normalizedRoot.startsWith(normalizedPrefix)
}

if (!isGlobalInstall()) {
  console.log("[ocskill] Local npm install detected; skipping OpenCode global setup.")
  console.log("[ocskill] Use 'node bin/ocskill.mjs install' to test installation manually.")
  process.exit(0)
}

try {
  const result = await installResources()
  console.log(`[ocskill] Installed v${result.version}`)
  console.log(`[ocskill] OpenCode config: ${result.configDir}`)
  console.log(`[ocskill] Skills: ${result.skills.length}`)
  console.log(`[ocskill] Commands: ${result.commands.length}`)
  for (const warning of result.warnings) {
    console.warn(`[ocskill] WARNING: ${warning}`)
  }
  console.log("[ocskill] Restart OpenCode or start a new session.")
} catch (error) {
  console.error("[ocskill] Installation failed.")
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
