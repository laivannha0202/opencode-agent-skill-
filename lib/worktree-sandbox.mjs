import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

export async function createTaskSandbox(root, slug, taskID, options = {}) {
  root = path.resolve(root)
  const base = options.baseDir ? path.resolve(options.baseDir) : path.join(root, ".ues-sandboxes")
  const name = safeName(slug + "-" + taskID)
  if (!name) throw new Error("sandbox name is empty")
  const dir = path.join(base, name)
  if (existsSync(dir)) throw new Error("sandbox already exists: " + dir)

  await mkdir(base, { recursive: true })
  const branch = options.branch || "ues/" + name
  const startPoint = options.startPoint || "HEAD"
  const result = git(root, ["worktree", "add", "-b", branch, dir, startPoint])
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git worktree add failed").trim())

  return { schemaVersion: 1, root, dir, branch, slug, taskID, startPoint }
}

export async function removeTaskSandbox(root, dir, options = {}) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  const result = git(root, ["worktree", "remove", ...(options.force ? ["--force"] : []), dir])
  if (result.status !== 0 && existsSync(dir)) {
    if (options.force) await rm(dir, { recursive: true, force: true })
    else throw new Error((result.stderr || result.stdout || "git worktree remove failed").trim())
  }
  git(root, ["worktree", "prune"])
  return { removed: !existsSync(dir), dir }
}

export function listTaskSandboxes(root) {
  const result = git(path.resolve(root), ["worktree", "list", "--porcelain"])
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git worktree list failed").trim())
  const items = []
  let current = null
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) items.push(current)
      current = { path: line.slice(9) }
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5)
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7)
  }
  if (current) items.push(current)
  return items
}
