import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const DEFAULT_ROUTER_CONFIG = Object.freeze({ enabled: true, maxSkills: 4 })

export async function readRouterConfig(configDir) {
  const file = path.join(configDir, ".ues", "router.json")
  if (!existsSync(file)) return { ...DEFAULT_ROUTER_CONFIG, file, exists: false }

  try {
    const parsed = JSON.parse(await readFile(file, "utf8"))
    return {
      enabled: parsed.enabled !== false,
      maxSkills: Number.isInteger(parsed.maxSkills)
        ? Math.max(1, Math.min(parsed.maxSkills, 6))
        : DEFAULT_ROUTER_CONFIG.maxSkills,
      file,
      exists: true,
    }
  } catch {
    return { ...DEFAULT_ROUTER_CONFIG, file, exists: true, invalid: true }
  }
}

export async function writeRouterConfig(configDir, next) {
  const current = await readRouterConfig(configDir)
  const value = {
    enabled: next.enabled ?? current.enabled,
    maxSkills: next.maxSkills ?? current.maxSkills,
  }
  if (!Number.isInteger(value.maxSkills) || value.maxSkills < 1 || value.maxSkills > 6) {
    throw new RangeError("router maxSkills must be an integer from 1 through 6")
  }

  const file = path.join(configDir, ".ues", "router.json")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8")
  return { ...value, file, exists: true }
}
