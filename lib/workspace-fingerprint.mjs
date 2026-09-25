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

function normalizePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "")
}

function porcelainChangedFiles(statusOutput) {
  const records = String(statusOutput || "").split("\0").filter(Boolean)
  const files = new Set()
  let expectRenameSource = false

  for (const record of records) {
    if (record.length >= 3 && record[2] === " ") {
      const code = record.slice(0, 2)
      const file = normalizePath(record.slice(3))
      if (file) files.add(file)
      expectRenameSource = /[RC]/.test(code)
      continue
    }
    if (expectRenameSource) {
      const file = normalizePath(record)
      if (file) files.add(file)
      expectRenameSource = false
    }
  }
  return [...files].sort()
}

function nonGitSnapshot(root) {
  nonGitNonce += 1
  return {
    schemaVersion: 1,
    root,
    git: false,
    cacheable: false,
    fingerprint: createHash("sha256")
      .update(
        "non-git-no-reuse:" +
        root +
        ":" +
        process.pid +
        ":" +
        nonGitNonce,
      )
      .digest("hex"),
    changedFiles: [],
    head: null,
  }
}

export function runtimeWorkspaceSnapshot(root = process.cwd()) {
  root = path.resolve(root)
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"])
  if (inside.status !== 0 || String(inside.stdout || "").trim() !== "true") {
    return nonGitSnapshot(root)
  }

  const head = git(root, ["rev-parse", "HEAD"])
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...RUNTIME_PATHSPECS,
  ])
  const diff = git(root, ["diff", "--binary", "--no-ext-diff", "--", ...RUNTIME_PATHSPECS])
  const cached = git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--", ...RUNTIME_PATHSPECS])

  const commands = [head, status, diff, cached]
  const cacheable = commands.every((result) => result.status === 0)
  if (!cacheable) {
    // A partial Git snapshot must never be reused as if it proved repository
    // identity. Return a nonce fingerprint so callers fail closed.
    return {
      ...nonGitSnapshot(root),
      git: true,
      head: head.status === 0 ? String(head.stdout || "").trim() || null : null,
      changedFiles: status.status === 0 ? porcelainChangedFiles(status.stdout) : [],
      reason: "git-snapshot-incomplete",
    }
  }

  const parts = [
    String(head.stdout || ""),
    String(status.stdout || ""),
    String(diff.stdout || ""),
    String(cached.stdout || ""),
  ]
  return {
    schemaVersion: 1,
    root,
    git: true,
    cacheable: true,
    fingerprint: createHash("sha256")
      .update(parts.join("\n---UES-RUNTIME-FP---\n"))
      .digest("hex"),
    changedFiles: porcelainChangedFiles(status.stdout),
    head: String(head.stdout || "").trim() || null,
  }
}

export function runtimeWorkspaceFingerprint(root = process.cwd()) {
  return runtimeWorkspaceSnapshot(root).fingerprint
}
