import path from "node:path"
import { fileURLToPath } from "node:url"
import { removeResources } from "../lib/installer.mjs"

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const normalizedRoot = packageRoot.replaceAll("\\", "/").toLowerCase()
const isPiPackageInstall = [
  "/.pi/agent/git/",
  "/.pi/agent/npm/",
  "/.pi/git/",
  "/.pi/npm/",
].some((marker) => normalizedRoot.includes(marker))

if (isPiPackageInstall) {
  console.log("[ocskill] Pi package uninstall detected; leaving OpenCode resources untouched.")
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
