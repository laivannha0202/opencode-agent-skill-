import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

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
    const candidate = path.resolve(dir, match)
    if (!within(nodeModulesRoot, candidate) || !existsSync(candidate)) continue

    const ext = path.extname(candidate).toLowerCase()
    if ([".js", ".mjs", ".cjs"].includes(ext)) return candidate

    // npm/cmd-shim also supports extensionless Node bin entries such as
    // node_modules/opencode-ai/bin/opencode. Accept them only when they are
    // concrete files inside node_modules and have a Node shebang.
    if (!ext && looksLikeNodeScript(candidate)) return candidate
  }

  return null
}
