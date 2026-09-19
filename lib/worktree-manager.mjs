import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"

function safeID(value, label) {
  const text = String(value || "")
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text)) throw new Error(label + " contains unsafe characters")
  return text
}

function git(root, args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  })
}

export function taskSandboxPath(root, slug, taskID) {
  root = path.resolve(root)
  const safeSlug = safeID(slug, "slug")
  const safeTask = safeID(taskID, "taskID")
  return path.join(path.dirname(root), ".ues-sandboxes", path.basename(root), safeSlug, safeTask)
}

export function taskSandboxStatus(root, slug, taskID) {
  const dir = taskSandboxPath(root, slug, taskID)
  if (!existsSync(dir)) return { exists: false, dir, clean: null, changes: [] }
  const status = git(dir, ["status", "--porcelain=v1"])
  const changes = status.status === 0 ? status.stdout.split(/\r?\n/).filter(Boolean) : []
  return { exists: true, dir, clean: status.status === 0 && changes.length === 0, changes }
}

export async function createTaskSandbox(root, slug, taskID) {
  root = path.resolve(root)
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0) throw new Error("task isolation requires a Git worktree")
  const dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", ":(exclude).ues-work"])
  if (dirty.status !== 0) throw new Error("could not inspect working tree")
  if (dirty.stdout.trim()) throw new Error("task isolation requires a clean main working tree")

  const dir = taskSandboxPath(root, slug, taskID)
  if (existsSync(dir)) return taskSandboxStatus(root, slug, taskID)
  await mkdir(path.dirname(dir), { recursive: true })
  const add = git(root, ["worktree", "add", "--detach", dir, "HEAD"])
  if (add.status !== 0) throw new Error((add.stderr || add.stdout || "git worktree add failed").trim())
  return taskSandboxStatus(root, slug, taskID)
}

export function diffTaskSandbox(root, slug, taskID) {
  const dir = taskSandboxPath(root, slug, taskID)
  if (!existsSync(dir)) throw new Error("task sandbox does not exist")
  const diff = git(dir, ["diff", "--binary", "HEAD"])
  if (diff.status !== 0) throw new Error((diff.stderr || diff.stdout || "git diff failed").trim())
  return { dir, patch: diff.stdout, changed: Boolean(diff.stdout.trim()) }
}

export function applyTaskSandbox(root, slug, taskID) {
  root = path.resolve(root)
  const { dir, patch, changed } = diffTaskSandbox(root, slug, taskID)
  if (!changed) return { dir, applied: false, reason: "no changes" }
  const apply = git(root, ["apply", "--3way", "--whitespace=nowarn", "-"], { input: patch })
  if (apply.status !== 0) throw new Error((apply.stderr || apply.stdout || "git apply failed").trim())
  return { dir, applied: true }
}

export async function removeTaskSandbox(root, slug, taskID, options = {}) {
  root = path.resolve(root)
  const dir = taskSandboxPath(root, slug, taskID)
  if (!existsSync(dir)) return { dir, removed: false }
  const status = taskSandboxStatus(root, slug, taskID)
  if (!status.clean && !options.force) throw new Error("task sandbox has uncommitted changes; apply them or use --force")
  const args = ["worktree", "remove"]
  if (options.force) args.push("--force")
  args.push(dir)
  const remove = git(root, args)
  if (remove.status !== 0) throw new Error((remove.stderr || remove.stdout || "git worktree remove failed").trim())
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return { dir, removed: true }
}
