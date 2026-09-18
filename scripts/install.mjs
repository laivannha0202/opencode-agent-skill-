import { installResources } from "../lib/installer.mjs"

const isGlobalInstall =
  process.env.npm_config_global === "true" ||
  process.env.npm_config_global === "1"

if (!isGlobalInstall) {
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
