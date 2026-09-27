import { existsSync } from "node:fs"
import path from "node:path"
import { resolveManagedPiCommand, resolveWindowsCommand } from "./windows-shim.mjs"

export function looksLikePiCliEntrypoint(file) {
  const value = String(file || "").replaceAll("\\", "/").toLowerCase()
  if (!value) return false

  // Managed/npm Pi installs execute the package CLI script. ACP adapters may
  // also be Node scripts, so do not trust an arbitrary existing argv[1].
  if (value.includes("/@earendil-works/pi-coding-agent/")) return true

  const base = path.posix.basename(value)
  return /^(?:pi)(?:\.[cm]?js)?$/.test(base)
}

function fromResolvedPi(resolved, args, source) {
  if (!resolved?.executable) return null
  return {
    command: resolved.executable,
    args: [...(resolved.argsPrefix || []), ...args],
    source,
  }
}

export function resolvePiChildInvocation(args = [], options = {}) {
  const currentScript = options.currentScript ?? process.argv[1]
  const execPath = options.execPath ?? process.execPath
  const platform = options.platform ?? process.platform
  const exists = options.existsSync ?? existsSync

  if (
    currentScript &&
    !String(currentScript).startsWith("/$bunfs/root/") &&
    exists(currentScript) &&
    looksLikePiCliEntrypoint(currentScript)
  ) {
    return {
      command: execPath,
      args: [currentScript, ...args],
      source: "host-pi-cli",
    }
  }

  const execBase = path.basename(String(execPath || "")).toLowerCase()
  if (/^pi(?:\.exe)?$/.test(execBase)) {
    return { command: execPath, args, source: "host-pi-executable" }
  }

  if (platform === "win32") {
    const managed = options.managedPi === undefined
      ? resolveManagedPiCommand()
      : options.managedPi
    const managedInvocation = fromResolvedPi(managed, args, "managed-pi")
    if (managedInvocation) return managedInvocation

    const pathPi = options.pathPi === undefined
      ? resolveWindowsCommand("pi")
      : options.pathPi
    const pathInvocation = fromResolvedPi(pathPi, args, "path-pi")
    if (pathInvocation) return pathInvocation
  }

  return { command: "pi", args, source: "path-pi-fallback" }
}
