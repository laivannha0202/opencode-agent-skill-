import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"

function git(root, args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input: options.input,
  })
}

function statusFiles(root) {
  const result = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git status failed").trim())
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((value) => value.includes(" -> ") ? value.split(" -> ").at(-1) : value)
    .map((value) => value.replaceAll("\\", "/"))
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

export async function createTaskSandbox(root, slug, taskID, options = {}) {
  root = path.resolve(root)
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status.status !== 0) throw new Error((status.stderr || status.stdout || "git status failed").trim())
  if (status.stdout.trim() && options.allowDirtyRoot !== true) {
    throw new Error("sandbox creation requires a clean root working tree so the isolated executor cannot miss existing uncommitted changes")
  }
  const base = options.baseDir
    ? path.resolve(options.baseDir)
    : path.join(path.dirname(root), "." + path.basename(root) + ".ues-sandboxes")
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

export async function integrateTaskSandbox(root, dir, options = {}) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  if (!existsSync(dir)) throw new Error("sandbox does not exist: " + dir)

  const rootTop = git(root, ["rev-parse", "--show-toplevel"])
  const sandboxTop = git(dir, ["rev-parse", "--show-toplevel"])
  if (rootTop.status !== 0 || sandboxTop.status !== 0) throw new Error("root and sandbox must be Git worktrees")
  if (path.resolve(sandboxTop.stdout.trim()) !== dir) throw new Error("sandbox path is not the worktree root")

  // Resolve the merge base against the canonical root HEAD explicitly.
  const rootHead = git(root, ["rev-parse", "HEAD"])
  const sandboxHead = git(dir, ["rev-parse", "HEAD"])
  if (rootHead.status !== 0 || sandboxHead.status !== 0) throw new Error("could not resolve worktree HEADs")
  const base = git(dir, ["merge-base", rootHead.stdout.trim(), sandboxHead.stdout.trim()])
  if (base.status !== 0) throw new Error((base.stderr || base.stdout || "git merge-base failed").trim())
  const baseSha = base.stdout.trim()

  // Intent-to-add exposes untracked files in a binary diff without committing them.
  const addIntent = git(dir, ["add", "-N", "."])
  if (addIntent.status !== 0) throw new Error((addIntent.stderr || addIntent.stdout || "git add -N failed").trim())

  const changedRun = git(dir, ["diff", "--name-only", baseSha, "--"])
  if (changedRun.status !== 0) throw new Error((changedRun.stderr || changedRun.stdout || "git diff --name-only failed").trim())
  const changed = changedRun.stdout.split(/\r?\n/).filter(Boolean).map((value) => value.replaceAll("\\", "/"))
  if (changed.length === 0) {
    if (!options.keep) await removeTaskSandbox(root, dir, { force: true, deleteBranch: true })
    return { integrated: true, changed: [], base: baseSha, empty: true }
  }

  const rootDirty = new Set(statusFiles(root))
  const overlap = changed.filter((file) => rootDirty.has(file))
  if (overlap.length) {
    throw new Error("sandbox integration conflicts with existing root changes: " + overlap.join(", "))
  }

  const patch = git(dir, ["diff", "--binary", "--no-ext-diff", baseSha, "--"])
  if (patch.status !== 0) throw new Error((patch.stderr || patch.stdout || "git diff failed").trim())
  const applied = git(root, ["apply", "--whitespace=nowarn", "-"], { input: patch.stdout })
  if (applied.status !== 0) {
    throw new Error((applied.stderr || applied.stdout || "git apply failed").trim())
  }

  if (!options.keep) await removeTaskSandbox(root, dir, { force: true, deleteBranch: true })
  return { integrated: true, changed, base: baseSha, empty: false }
}

export async function removeTaskSandbox(root, dir, options = {}) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  let branch = options.branch || null
  if (!branch && options.deleteBranch && existsSync(dir)) {
    const currentBranch = git(dir, ["branch", "--show-current"])
    if (currentBranch.status === 0) branch = currentBranch.stdout.trim() || null
  }
  const result = git(root, ["worktree", "remove", ...(options.force ? ["--force"] : []), dir])
  if (result.status !== 0 && existsSync(dir)) {
    if (options.force) await rm(dir, { recursive: true, force: true })
    else throw new Error((result.stderr || result.stdout || "git worktree remove failed").trim())
  }
  git(root, ["worktree", "prune"])
  if (options.deleteBranch && branch) {
    if (!branch.startsWith("ues/")) {
      throw new Error("refusing to delete non-UES sandbox branch: " + branch)
    }
    const deleted = git(root, ["branch", "-D", branch])
    if (deleted.status !== 0) {
      throw new Error((deleted.stderr || deleted.stdout || "git branch delete failed").trim())
    }
  }
  return { removed: !existsSync(dir), dir, branch: branch || null }
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
