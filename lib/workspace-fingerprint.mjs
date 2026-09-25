import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import path from "node:path"

const RUNTIME_DIRS = [
  ".ues-cache",
  ".ues-traces",
  ".ues-work",
  ".ues-learning",
  ".ues-dashboard",
  ".ues-sandboxes",
  ".ues-memory",
  ".ues-evals",
]
const RUNTIME_PATHSPECS = [
  ".",
  ...RUNTIME_DIRS.map((dir) => `:(exclude)${dir}/**`),
]

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
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...RUNTIME_PATHSPECS],
    ["diff", "--binary", "--no-ext-diff", "--", ...RUNTIME_PATHSPECS],
    ["diff", "--cached", "--binary", "--no-ext-diff", "--", ...RUNTIME_PATHSPECS],
  ]) {
    const result = git(root, args)
    parts.push(result.status === 0 ? result.stdout : "ERROR:" + String(result.stderr || result.stdout || ""))
  }
  return createHash("sha256")
    .update(parts.join("\n---UES-RUNTIME-FP---\n"))
    .digest("hex")
}