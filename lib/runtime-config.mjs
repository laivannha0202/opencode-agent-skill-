import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

function xdgConfigRoot() {
  return process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), ".config")
}

export function getUesConfigDir() {
  if (process.env.UES_CONFIG_DIR) return path.resolve(process.env.UES_CONFIG_DIR)

  const nativeDir = path.join(xdgConfigRoot(), "ues")
  const legacyDir = process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(xdgConfigRoot(), "opencode")

  const nativePolicy = path.join(nativeDir, ".ues", "model-policy.json")
  const legacyPolicy = path.join(legacyDir, ".ues", "model-policy.json")

  if (existsSync(nativePolicy)) return nativeDir
  if (existsSync(legacyPolicy)) return legacyDir
  return nativeDir
}

export function getLegacyOpenCodeConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(xdgConfigRoot(), "opencode")
}
