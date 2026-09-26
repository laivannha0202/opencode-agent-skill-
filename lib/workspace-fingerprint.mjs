import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readlinkSync } from "node:fs"
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
  ".ues-services",
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

function porcelainEntries(statusOutput) {
  const records = String(statusOutput || "").split("\0").filter(Boolean)
  const entries = []
  let renameCode = null

  for (const record of records) {
    if (record.length >= 3 && record[2] === " ") {
      const code = record.slice(0, 2)
      const file = normalizePath(record.slice(3))
      if (file) entries.push({ code, file })
      renameCode = /[RC]/.test(code) ? code : null
      continue
    }
    if (renameCode) {
      const file = normalizePath(record)
      if (file) entries.push({ code: renameCode, file, renameSource: true })
      renameCode = null
    }
  }
  return entries
}

function porcelainChangedFiles(statusOutput) {
  return [...new Set(porcelainEntries(statusOutput).map((entry) => entry.file))].sort()
}

function untrackedContentDigest(root, statusOutput, options = {}) {
  const limit = Math.max(1024 * 1024, Number(options.maxUntrackedBytes || 32 * 1024 * 1024))
  const totalLimit = Math.max(limit, Number(options.maxUntrackedTotalBytes || 64 * 1024 * 1024))
  const files = porcelainEntries(statusOutput)
    .filter((entry) => entry.code === "??")
    .map((entry) => entry.file)
    .sort()
  const hash = createHash("sha256")
  let totalBytes = 0

  for (const relative of files) {
    const full = path.resolve(root, relative)
    if (full !== root && !full.startsWith(root + path.sep)) {
      return { cacheable: false, reason: "untracked-path-escape", files }
    }
    try {
      const info = lstatSync(full)
      hash.update(relative)
      hash.update("\0")
      if (info.isSymbolicLink()) {
        hash.update("symlink:")
        hash.update(readlinkSync(full))
        hash.update("\0")
        continue
      }
      if (!info.isFile()) {
        return { cacheable: false, reason: "untracked-non-file", files }
      }
      if (info.size > limit) {
        return {
          cacheable: false,
          reason: "untracked-file-too-large",
          files,
          file: relative,
          bytes: info.size,
        }
      }
      totalBytes += info.size
      if (totalBytes > totalLimit) {
        return {
          cacheable: false,
          reason: "untracked-total-too-large",
          files,
          bytes: totalBytes,
        }
      }
      hash.update(readFileSync(full))
      hash.update("\0")
    } catch {
      return { cacheable: false, reason: "untracked-read-failed", files, file: relative }
    }
  }
  return { cacheable: true, digest: hash.digest("hex"), files }
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
  const commandComplete = commands.every((result) => result.status === 0)
  const untracked = status.status === 0
    ? untrackedContentDigest(root, status.stdout)
    : { cacheable: false, reason: "status-unavailable", files: [] }
  const cacheable = commandComplete && untracked.cacheable === true
  if (!cacheable) {
    // A partial Git snapshot or unhashable untracked file must never be reused
    // as if it proved repository identity. Return a nonce fingerprint so
    // callers fail closed while still exposing changed-file hints.
    return {
      ...nonGitSnapshot(root),
      git: true,
      head: head.status === 0 ? String(head.stdout || "").trim() || null : null,
      changedFiles: status.status === 0 ? porcelainChangedFiles(status.stdout) : [],
      reason: commandComplete ? untracked.reason : "git-snapshot-incomplete",
    }
  }

  const parts = [
    String(head.stdout || ""),
    String(status.stdout || ""),
    String(diff.stdout || ""),
    String(cached.stdout || ""),
    "untracked:" + String(untracked.digest || ""),
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