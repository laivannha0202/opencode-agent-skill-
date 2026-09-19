import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import path from "node:path"

const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"])

async function walk(root) {
  const files = []
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else if (entry.isFile()) files.push(full)
    }
  }
  await visit(root)
  return files
}

export async function snapshotWorkspace(root) {
  const snapshot = {}
  for (const file of await walk(root)) {
    const info = await stat(file).catch(() => null)
    if (!info || info.size > 2 * 1024 * 1024) continue
    const bytes = await readFile(file)
    snapshot[path.relative(root, file)] = {
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }
  }
  return snapshot
}

export function diffWorkspaceSnapshots(before, after) {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)])
  const changed = []
  for (const file of [...paths].sort()) {
    if (!before[file]) changed.push({ path: file, change: "added" })
    else if (!after[file]) changed.push({ path: file, change: "removed" })
    else if (before[file].sha256 !== after[file].sha256) changed.push({ path: file, change: "modified" })
  }
  return changed
}
