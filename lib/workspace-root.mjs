import { spawnSync } from "node:child_process"
import path from "node:path"

function runGit(cwd, args) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  })
}

export function resolveGitWorkspaceRoot(start = process.cwd()) {
  const requested = path.resolve(String(start || process.cwd()))
  const inside = runGit(requested, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0 || String(inside.stdout || "").trim() !== "true") {
    return {
      ok: false,
      requested,
      root: null,
      error: String(inside.stderr || inside.stdout || "not a git worktree").trim(),
    }
  }

  const top = runGit(requested, ["rev-parse", "--show-toplevel"])
  if (top.status !== 0) {
    return {
      ok: false,
      requested,
      root: null,
      error: String(top.stderr || top.stdout || "could not resolve git root").trim(),
    }
  }

  const root = path.resolve(String(top.stdout || "").trim())
  return { ok: true, requested, root, error: null }
}

export function requireGitWorkspaceRoot(start = process.cwd(), purpose = "UES") {
  const resolved = resolveGitWorkspaceRoot(start)
  if (resolved.ok) return resolved.root

  const detail = resolved.error ? ": " + resolved.error : ""
  throw new Error(
    purpose +
      " requires Pi to be opened inside a Git repository. Refusing to create UES runtime artifacts in " +
      resolved.requested +
      detail,
  )
}
