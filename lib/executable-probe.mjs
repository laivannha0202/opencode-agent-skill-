import { accessSync, constants as fsConstants } from "node:fs"
import path from "node:path"

const DEFAULT_TTL_MS = 60_000
const commandProbeCache = new Map()

function executableFile(target) {
  try {
    accessSync(target, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function probeKey(name) {
  return [
    name,
    String(process.env.PATH || ""),
    process.platform === "win32" ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD") : "",
  ].join("\u0000")
}

export function commandExists(command, options = {}) {
  if (!command) return false
  const name = String(command).trim()
  if (!name) return false

  const ttlMs = Math.max(0, Number(options.ttlMs ?? DEFAULT_TTL_MS))
  const key = probeKey(name)
  const now = Date.now()
  const cached = commandProbeCache.get(key)
  if (cached && now - cached.checkedAt < ttlMs) return cached.available

  const hasPath = path.isAbsolute(name) || name.includes("/") || name.includes("\\")
  let available = false
  if (hasPath) {
    available = executableFile(path.resolve(name))
  } else {
    const dirs = String(process.env.PATH || "")
      .split(path.delimiter)
      .map((item) => item.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
    const extension = path.extname(name)
    const suffixes = process.platform === "win32" && !extension
      ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((item) => item.trim())
          .filter(Boolean)
      : [""]

    outer:
    for (const dir of dirs) {
      for (const suffix of suffixes) {
        if (executableFile(path.join(dir, name + suffix))) {
          available = true
          break outer
        }
      }
    }
  }

  commandProbeCache.set(key, { available, checkedAt: now })
  return available
}

export function clearExecutableProbeCache() {
  commandProbeCache.clear()
}
