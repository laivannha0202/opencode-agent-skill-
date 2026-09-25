import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import path from "node:path"

let nonGitNonce = 0

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
    // Runtime cache/receipt reuse must fail closed outside Git. A root-only
    // fingerprint would remain stable while files change and could incorrectly
    // reuse stale verification. Durable work has a stronger non-Git content
    // fingerprint; this lightweight path intentionally disables reuse instead.
    nonGitNonce += 1
    return createHash("sha256")
      .update(
        "non-git-no-reuse:" +
        root +
        ":" +
        process.pid +
        ":" +
        nonGitNonce,
      )
      .digest("hex")
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