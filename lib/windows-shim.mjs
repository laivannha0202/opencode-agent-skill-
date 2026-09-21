import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
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
  const ext = path.extname(target).toLowerCase()
  if ([".js", ".mjs", ".cjs"].includes(ext)) return target
  if (!ext && looksLikeNodeScript(target)) return target
  return null
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

export function resolveNodeShimEntry(cmdPath) {
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

    const ext = path.extname(candidate).toLowerCase()
    if ([".js", ".mjs", ".cjs"].includes(ext)) return candidate

    // npm/cmd-shim also supports extensionless Node bin entries such as
    // node_modules/opencode-ai/bin/opencode. Accept them only when they are
    // concrete files inside node_modules and have a Node shebang.
    if (!ext && looksLikeNodeScript(candidate)) return candidate
  }

  // Some npm shims vary in formatting enough that parsing the .cmd text is
  // brittle. Fall back to the adjacent global node_modules metadata and resolve
  // only a package.json bin entry that explicitly owns this command name.
  return adjacentPackageBin(fullCmd)
}


export function resolveWindowsCommandCandidates(candidates = []) {
  const values = [...new Set(
    candidates.map((item) => String(item || "").trim()).filter(Boolean),
  )]

  // Respect PATH ordering when a candidate is directly executable by CreateProcess
  // or is a recognized Node-backed shim. Unsupported batch shims are skipped so a
  // later native executable can still be used safely.
  for (const candidate of values) {
    const ext = path.extname(candidate).toLowerCase()
    if ([".exe", ".com"].includes(ext) && existsSync(candidate)) {
      return { executable: candidate, argsPrefix: [], kind: "native", source: candidate }
    }
    if ([".cmd", ".bat"].includes(ext)) {
      const entry = resolveNodeShimEntry(candidate)
      if (entry) {
        return {
          executable: process.execPath,
          argsPrefix: [entry],
          kind: "node-shim",
          source: candidate,
          entry,
        }
      }
      continue
    }
    if (!ext && existsSync(candidate) && looksLikeNodeScript(candidate)) {
      return {
        executable: process.execPath,
        argsPrefix: [candidate],
        kind: "node-script",
        source: candidate,
        entry: candidate,
      }
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

function spawnWhere(name) {
  // Lazy import avoidance is unnecessary here; child_process is builtin and this
  // module is Node-only. Kept as one helper so tests can cover candidate selection
  // without invoking the host PATH.
  return spawnSync("where", [name], { encoding: "utf8" })
}
