import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import path from "node:path"

function git(root, args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
}

export function runtimeWorkspaceFingerprint(root = process.cwd()) {
  root = path.resolve(root)
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0) {
    // Non-git callers get a stable root-scoped fallback. Durable-work code has a
    // stronger non-git fingerprint; this lightweight helper is only for runtime
    // cache reuse and therefore fails closed by preventing cross-root reuse.
    return createHash("sha256").update("non-git:" + root).digest("hex")
  }

  const parts = []
  for (const args of [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=all", "--", "."],
    ["diff", "--binary", "--no-ext-diff", "--", "."],
    ["diff", "--cached", "--binary", "--no-ext-diff", "--", "."],
  ]) {
    const result = git(root, args)
    parts.push(result.status === 0 ? result.stdout : "ERROR:" + String(result.stderr || result.stdout || ""))
  }
  return createHash("sha256")
    .update(parts.join("\n---UES-RUNTIME-FP---\n"))
    .digest("hex")
}
