import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { spawnSync } from "node:child_process"

function within(base, candidate) {
  const root = path.resolve(base)
  const full = path.resolve(candidate)
  return full === root || full.startsWith(root + path.sep)
}

function looksLikeNodeScript(file) {
  try {
    const head = readFileSync(file, "utf8").slice(0, 512)
    const firstLine = head.split(/\r?\n/, 1)[0]
    return /^#!.*(?:\/|\\|\b)node(?:\.exe)?(?:\s|$)/i.test(firstLine)
  } catch {
    return false
  }
}


function looksLikeWindowsExecutable(file) {
  try {
    const head = readFileSync(file)
    return head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a
  } catch {
    return false
  }
}

function executionForTarget(target) {
  const ext = path.extname(target).toLowerCase()
  if ([".exe", ".com"].includes(ext) && looksLikeWindowsExecutable(target)) {
    return {
      executable: target,
      argsPrefix: [],
      kind: "native",
      entry: target,
    }
  }
  if ([".js", ".mjs", ".cjs"].includes(ext) || (!ext && looksLikeNodeScript(target))) {
    return {
      executable: process.execPath,
      argsPrefix: [target],
      kind: "node-shim",
      entry: target,
    }
  }
  return null
}


function packageBinTarget(packageDir, commandName) {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"))
  } catch {
    return null
  }

  const bin = pkg?.bin
  let relative = null
  if (typeof bin === "string") {
    const packageCommand = String(pkg?.name || "").split("/").at(-1)
    if (packageCommand === commandName) relative = bin
  } else if (bin && typeof bin === "object" && typeof bin[commandName] === "string") {
    relative = bin[commandName]
  }
  if (!relative) return null

  const target = path.resolve(packageDir, relative)
  if (!within(packageDir, target) || !existsSync(target)) return null
  return executionForTarget(target) ? target : null
}

function adjacentPackageBin(cmdPath) {
  const fullCmd = path.resolve(String(cmdPath || ""))
  const commandName = path.basename(fullCmd).replace(/\.(?:cmd|bat)$/i, "")
  const nodeModulesRoot = path.join(path.dirname(fullCmd), "node_modules")
  let entries = []
  try {
    entries = readdirSync(nodeModulesRoot, { withFileTypes: true })
  } catch {
    return null
  }

  let inspected = 0
  for (const entry of entries) {
    if (inspected >= 2000) break
    if (!entry.isDirectory()) continue

    if (entry.name.startsWith("@")) {
      let scoped = []
      try {
        scoped = readdirSync(path.join(nodeModulesRoot, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of scoped) {
        if (inspected >= 2000) break
        if (!child.isDirectory()) continue
        inspected += 1
        const target = packageBinTarget(
          path.join(nodeModulesRoot, entry.name, child.name),
          commandName,
        )
        if (target) return target
      }
      continue
    }

    inspected += 1
    const target = packageBinTarget(path.join(nodeModulesRoot, entry.name), commandName)
    if (target) return target
  }
  return null
}

function resolveShimTarget(cmdPath) {
  const fullCmd = path.resolve(String(cmdPath || ""))
  const dir = path.dirname(fullCmd)

  if (/^npm(?:\.cmd|\.exe)?$/i.test(path.basename(fullCmd))) {
    const npmEntry = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js")
    if (existsSync(npmEntry)) return npmEntry
  }

  let shim = ""
  try {
    shim = readFileSync(fullCmd, "utf8")
  } catch {
    return null
  }

  const nodeModulesRoot = path.join(dir, "node_modules")
  const pattern = /node_modules[\\/](?:@[A-Za-z0-9._-]+[\\/])?[A-Za-z0-9._-]+(?:[\\/][A-Za-z0-9._+-]+)*/gi
  const matches = [...shim.matchAll(pattern)].map((match) => match[0]).reverse()

  for (const match of matches) {
    const portableMatch = match.split(/[\\/]+/).join(path.sep)
    const candidate = path.resolve(dir, portableMatch)
    if (!within(nodeModulesRoot, candidate) || !existsSync(candidate)) continue
    if (executionForTarget(candidate)) return candidate
  }

  // Some npm shims vary in formatting. Fall back to the adjacent global
  // node_modules metadata and only trust an explicit package.json bin mapping
  // for the command represented by this shim.
  return adjacentPackageBin(fullCmd)
}

export function resolveNodeShimEntry(cmdPath) {
  const target = resolveShimTarget(cmdPath)
  if (!target) return null
  const execution = executionForTarget(target)
  return execution?.kind === "node-shim" ? target : null
}

function resolveShimExecution(cmdPath) {
  const target = resolveShimTarget(cmdPath)
  if (!target) return null
  return executionForTarget(target)
}

export function resolveWindowsCommandCandidates(candidates = []) {
  const values = [...new Set(
    candidates.map((item) => String(item || "").trim()).filter(Boolean),
  )]

  // Respect PATH ordering, but only return a target that can be launched without
  // invoking cmd.exe. npm commonly emits both an extensionless POSIX shim and a
  // .cmd shim; either may point at a native .exe or a Node launcher.
  for (const candidate of values) {
    if (!existsSync(candidate)) continue
    const ext = path.extname(candidate).toLowerCase()

    if ([".exe", ".com"].includes(ext)) {
      const direct = executionForTarget(candidate)
      if (direct) return { ...direct, source: candidate }
      continue
    }

    if ([".cmd", ".bat"].includes(ext)) {
      const resolved = resolveShimExecution(candidate)
      if (resolved) return { ...resolved, source: candidate }
      continue
    }

    if (!ext) {
      if (looksLikeNodeScript(candidate)) {
        return {
          executable: process.execPath,
          argsPrefix: [candidate],
          kind: "node-script",
          source: candidate,
          entry: candidate,
        }
      }
      // npm's extensionless shim is normally a POSIX shell wrapper even on
      // Windows. Parse its package target instead of trying to execute the shell.
      const resolved = resolveShimExecution(candidate)
      if (resolved) return { ...resolved, source: candidate }
    }
  }
  return null
}

export function resolveWindowsCommand(name) {
  const value = String(name || "").trim()
  if (!value) return null

  if (path.isAbsolute(value)) {
    return resolveWindowsCommandCandidates([value])
  }

  const result = spawnWhere(value)
  if (result.status !== 0 || !result.stdout) return null
  const candidates = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return resolveWindowsCommandCandidates(candidates)
}

export function resolveManagedPiCommand(homeDir = os.homedir()) {
  const releasesDir = path.join(homeDir, ".pi", "agent", "install", "releases")
  let releases = []
  try {
    releases = readdirSync(releasesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }))
  } catch {
    return null
  }

  for (const release of releases) {
    const packageDir = path.join(
      releasesDir,
      release,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    )
    const target = packageBinTarget(packageDir, "pi")
    if (!target) continue
    const resolved = executionForTarget(target)
    if (resolved) {
      return {
        ...resolved,
        source: target,
        managedRelease: release,
      }
    }
  }
  return null
}

function spawnWhere(name) {
  // Lazy import avoidance is unnecessary here; child_process is builtin and this
  // module is Node-only. Kept as one helper so tests can cover candidate selection
  // without invoking the host PATH.
  return spawnSync("where", [name], { encoding: "utf8" })
}
