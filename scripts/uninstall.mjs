import { removeResources } from "../lib/installer.mjs"

try {
  const result = await removeResources()
  console.log(
    `[ocskill] Removed ${result.skills} managed skills and ${result.commands} managed commands.`,
  )
} catch (error) {
  console.error("[ocskill] Cleanup failed.")
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}
