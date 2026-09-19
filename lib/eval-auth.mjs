import { existsSync } from "node:fs"
import { copyFile, mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export function currentOpenCodeAuthPath(home = os.homedir()) {
  return path.join(home, ".local", "share", "opencode", "auth.json")
}

export async function copyCurrentOpenCodeAuth(dataRoot, options = {}) {
  const source = options.source || currentOpenCodeAuthPath(options.home)
  const target = path.join(dataRoot, "opencode", "auth.json")

  if (!existsSync(source)) {
    return { copied: false, source, target, reason: "not-found" }
  }

  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(source, target)
  return { copied: true, source, target }
}
