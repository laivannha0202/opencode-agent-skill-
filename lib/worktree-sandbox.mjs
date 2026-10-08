import { existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { isUesRuntimeArtifactPath, sourceFacingPaths, sourceGitPathspecs, UES_RUNTIME_DIRS } from "./runtime-artifacts.mjs"
import { workspaceStatusEntries } from "./workspace-fingerprint.mjs"
import { safeRemovePath } from "./fs-cleanup.mjs"

function git(root, args, options = {}) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    input: options.input,
  })
}

function statusFiles(root) {
  const result = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...sourceGitPathspecs(),
  ])
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || "git status failed").trim())
  return sourceFacingPaths(
    workspaceStatusEntries(result.stdout)
      .filter((entry) => entry.renameSource !== true)
      .map((entry) => entry.file),
  )
}

function sourceIntentBatches(values, options = {}) {
  const maxItems = Math.max(1, Math.min(256, Number(options.maxItems || 64)))
  const maxChars = Math.max(1024, Math.min(24_000, Number(options.maxChars || 12_000)))
  const batches = []
  let batch = []
  let chars = 0

  for (const value of sourceFacingPaths(values)) {
    const cost = value.length + 3
    if (batch.length && (batch.length >= maxItems || chars + cost > maxChars)) {
      batches.push(batch)
      batch = []
      chars = 0
    }
    batch.push(value)
    chars += cost
  }
  if (batch.length) batches.push(batch)
  return batches
}

function intentToAddSourceFiles(root) {
  const untracked = git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...sourceGitPathspecs(),
  ])
  if (untracked.status !== 0) {
    throw new Error((untracked.stderr || untracked.stdout || "git ls-files for intent-to-add failed").trim())
  }

  const candidates = sourceFacingPaths(untracked.stdout.split("\0").filter(Boolean))
  for (const batch of sourceIntentBatches(candidates)) {
    const addIntent = git(root, ["add", "-N", "--", ...batch])
    if (addIntent.status !== 0) {
      throw new Error((addIntent.stderr || addIntent.stdout || "git add -N failed").trim())
    }
  }
  return candidates
}

function safeName(value) {
  return String(value || "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function metadataFile(dir) {
  return path.resolve(dir) + ".ues-meta.json"
}

async function readSandboxMetadata(dir) {
  try {
    return JSON.parse(await readFile(metadataFile(dir), "utf8"))
  } catch {
    return null
  }
}

export async function taskSandboxOwnerRoot(dir) {
  const metadata = await readSandboxMetadata(path.resolve(dir)).catch(() => null)
  const root = metadata?.root ? path.resolve(String(metadata.root)) : null
  return root || null
}

/**
 * V16.15: read the sandbox metadata sidecar. Exported so the integration
 * transaction owner (`lib/integration-transaction-v16-15.mjs`) can PREFLIGHT a
 * sandbox without mutating anything, instead of re-implementing this convention.
 * Returns null when the sidecar is missing or unreadable.
 */
export async function readTaskSandboxMetadata(dir) {
  return readSandboxMetadata(path.resolve(dir)).catch(() => null)
}

async function writeSandboxMetadata(dir, value) {
  await writeFile(metadataFile(dir), JSON.stringify(value, null, 2) + "\n", "utf8")
}

async function inheritDirtySnapshot(root, dir) {
  const inheritedUntrackedHashes = {}
  const diff = git(root, ["diff", "--binary", "--no-ext-diff", "HEAD", "--", ...sourceGitPathspecs()])
  if (diff.status !== 0) throw new Error((diff.stderr || diff.stdout || "git diff HEAD failed").trim())
  if (diff.stdout) {
    const applied = git(dir, ["apply", "--whitespace=nowarn", "-"], { input: diff.stdout })
    if (applied.status !== 0) throw new Error((applied.stderr || applied.stdout || "git apply inherited root diff failed").trim())
  }

  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  if (untracked.status !== 0) throw new Error((untracked.stderr || untracked.stdout || "git ls-files failed").trim())
  for (const relative of untracked.stdout.split("\0").filter(Boolean)) {
    const normalizedRelative = relative.replaceAll("\\", "/")
    if (isUesRuntimeArtifactPath(normalizedRelative)) continue
    const source = path.join(root, relative)
    const target = path.join(dir, relative)
    const bytes = await readFile(source)
    inheritedUntrackedHashes[normalizedRelative] = createHash("sha256").update(bytes).digest("hex")
    await mkdir(path.dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  const add = git(dir, ["add", "-A"])
  if (add.status !== 0) throw new Error((add.stderr || add.stdout || "git add inherited snapshot failed").trim())
  const commit = git(dir, [
    "-c", "user.name=UES Parallel Runtime",
    "-c", "user.email=ues-parallel@example.invalid",
    "commit", "-m", "chore(ues): inherited parallel integration snapshot",
  ])
  if (commit.status !== 0) {
    const status = git(dir, ["status", "--porcelain=v1", "--untracked-files=all"])
    if (status.status !== 0 || status.stdout.trim()) {
      throw new Error((commit.stderr || commit.stdout || "git commit inherited snapshot failed").trim())
    }
  }
  const head = git(dir, ["rev-parse", "HEAD"])
  if (head.status !== 0) throw new Error((head.stderr || head.stdout || "git rev-parse inherited snapshot failed").trim())
  return {
    head: head.stdout.trim(),
    inheritedUntrackedHashes,
  }
}

export async function createTaskSandbox(root, slug, taskID, options = {}) {
  root = path.resolve(root)
  const rootDirty = statusFiles(root).length > 0
  if (rootDirty && options.allowDirtyRoot !== true && options.inheritDirtyRoot !== true) {
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

  let integrationBase = git(dir, ["rev-parse", "HEAD"]).stdout.trim()
  let inheritedDirtyRoot = false
  let inheritedUntrackedHashes = {}
  if (rootDirty && options.inheritDirtyRoot === true) {
    const inherited = await inheritDirtySnapshot(root, dir)
    integrationBase = inherited.head
    inheritedUntrackedHashes = inherited.inheritedUntrackedHashes
    inheritedDirtyRoot = true
  }

  const metadata = {
    schemaVersion: 2,
    root,
    dir,
    branch,
    slug,
    taskID,
    startPoint,
    integrationBase,
    inheritedDirtyRoot,
    inheritedUntrackedHashes,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
  }
  await writeSandboxMetadata(dir, metadata)
  return metadata
}

export async function integrateTaskSandbox(root, dir, options = {}) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  if (!existsSync(dir)) throw new Error("sandbox does not exist: " + dir)

  const rootTop = git(root, ["rev-parse", "--show-toplevel"])
  const sandboxTop = git(dir, ["rev-parse", "--show-toplevel"])
  if (rootTop.status !== 0 || sandboxTop.status !== 0) throw new Error("root and sandbox must be Git worktrees")
  if (path.resolve(sandboxTop.stdout.trim()) !== dir) throw new Error("sandbox path is not the worktree root")

  const metadata = await readSandboxMetadata(dir)
  let baseSha = metadata?.integrationBase || null
  if (!baseSha) {
    const rootHead = git(root, ["rev-parse", "HEAD"])
    const sandboxHead = git(dir, ["rev-parse", "HEAD"])
    if (rootHead.status !== 0 || sandboxHead.status !== 0) throw new Error("could not resolve worktree HEADs")
    const base = git(dir, ["merge-base", rootHead.stdout.trim(), sandboxHead.stdout.trim()])
    if (base.status !== 0) throw new Error((base.stderr || base.stdout || "git merge-base failed").trim())
    baseSha = base.stdout.trim()
  }

  // Intent-to-add only the non-ignored untracked source files. A root-wide
  // `git add -N -- .` fails when an ignored UES runtime directory such as
  // .ues-cache exists, even when an exclude pathspec is also present.
  intentToAddSourceFiles(dir)

  const changedRun = git(dir, ["diff", "--name-only", baseSha, "--", ...sourceGitPathspecs()])
  if (changedRun.status !== 0) throw new Error((changedRun.stderr || changedRun.stdout || "git diff --name-only failed").trim())
  const changed = changedRun.stdout.split(/\r?\n/).filter(Boolean).map((value) => value.replaceAll("\\", "/"))
  if (changed.length === 0) {
    if (!options.keep) await removeTaskSandbox(root, dir, { force: true, deleteBranch: true })
    return { integrated: true, changed: [], base: baseSha, empty: true }
  }

  const rootDirty = new Set(statusFiles(root))
  const overlap = changed.filter((file) => rootDirty.has(file))
  const unsafeOverlap = []
  for (const file of overlap) {
    if (!metadata?.inheritedDirtyRoot) {
      unsafeOverlap.push(file)
      continue
    }

    const inheritedUntrackedHash = metadata?.inheritedUntrackedHashes?.[file]
    if (inheritedUntrackedHash) {
      try {
        const current = await readFile(path.join(root, file))
        const currentHash = createHash("sha256").update(current).digest("hex")
        if (currentHash !== inheritedUntrackedHash) unsafeOverlap.push(file)
      } catch {
        unsafeOverlap.push(file)
      }
      continue
    }

    const check = git(root, ["diff", "--quiet", baseSha, "--", file])
    if (check.status !== 0) unsafeOverlap.push(file)
  }
  if (unsafeOverlap.length) {
    throw new Error("sandbox integration conflicts with existing root changes: " + unsafeOverlap.join(", "))
  }

  const patch = git(dir, ["diff", "--binary", "--no-ext-diff", baseSha, "--", ...sourceGitPathspecs()])
  if (patch.status !== 0) throw new Error((patch.stderr || patch.stdout || "git diff failed").trim())
  const applied = git(root, ["apply", "--whitespace=nowarn", "-"], { input: patch.stdout })
  if (applied.status !== 0) {
    throw new Error((applied.stderr || applied.stdout || "git apply failed").trim())
  }

  if (!options.keep) await removeTaskSandbox(root, dir, { force: true, deleteBranch: true })
  return { integrated: true, changed, base: baseSha, empty: false }
}

/**
 * V16.15: list UES runtime artifact directories present inside a worktree.
 *
 * A sandbox may never carry `.ues-cache`, `.ues-work` and friends back into the
 * root, and the Git exclude pathspec alone is a single point of failure. This
 * reads the worktree directly so the forbidden-path check is defence in depth.
 * It is a bounded, read-only directory scan of the known runtime directory names.
 */
export function listRuntimeArtifacts(dir) {
  const found = []
  for (const name of UES_RUNTIME_DIRS) {
    if (existsSync(path.join(dir, name))) found.push(name)
  }
  return found.sort()
}

/**
 * V16.15: read-only sandbox preflight.
 *
 * This is the ONLY place that answers "can this sandbox still be integrated?".
 * It performs NO mutation of either tree: no `git add -N`, no `git apply`, no
 * worktree removal. `integrateTaskSandbox` above remains the single owner of the
 * actual apply. The integration transaction
 * (`lib/integration-transaction-v16-15.mjs`) calls this for EVERY patch before it
 * mutates the root, which is what makes a wave integration transactional.
 *
 * Returns a verdict object. It throws only on a hard Git failure.
 */
export async function preflightTaskSandbox(root, dir, options = {}) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  const checks = []
  const block = (reason, detail) => {
    checks.push({ check: reason, ok: false, detail: detail == null ? null : String(detail) })
    return false
  }
  const pass = (reason, detail) => {
    checks.push({ check: reason, ok: true, detail: detail == null ? null : String(detail) })
    return true
  }

  if (!existsSync(dir)) {
    block("sandbox-exists", dir)
    return { ok: false, dir, checks, reason: "sandbox-missing" }
  }
  pass("sandbox-exists", dir)

  const rootTop = git(root, ["rev-parse", "--show-toplevel"])
  const sandboxTop = git(dir, ["rev-parse", "--show-toplevel"])
  if (rootTop.status !== 0 || sandboxTop.status !== 0) {
    block("git-worktree-identity", "root or sandbox is not a Git worktree")
    return { ok: false, dir, checks, reason: "not-a-worktree" }
  }
  if (path.resolve(sandboxTop.stdout.trim()) !== dir) {
    block("sandbox-is-worktree-root", sandboxTop.stdout.trim())
    return { ok: false, dir, checks, reason: "sandbox-path-mismatch" }
  }
  pass("sandbox-is-worktree-root", dir)

  const metadata = await readSandboxMetadata(dir)
  if (!metadata) {
    block("sandbox-metadata", "metadata sidecar missing")
    return { ok: false, dir, checks, reason: "metadata-missing" }
  }
  pass("sandbox-metadata", metadata.createdAt || null)

  // The sandbox must belong to THIS repository and THIS run.
  if (path.resolve(String(metadata.root || "")) !== root) {
    block("sandbox-owner-root", metadata.root)
    return { ok: false, dir, checks, reason: "owner-root-mismatch" }
  }
  pass("sandbox-owner-root", root)
  if (options.ownerRoot != null && path.resolve(String(options.ownerRoot)) !== root) {
    block("integration-base-root", options.ownerRoot)
    return { ok: false, dir, checks, reason: "integration-root-mismatch" }
  }
  if (options.expectedRunId != null && String(metadata.runId || "") !== String(options.expectedRunId)) {
    block("sandbox-run-identity", `expected ${options.expectedRunId}, found ${metadata.runId ?? "none"}`)
    return { ok: false, dir, checks, reason: "run-mismatch" }
  }

  const baseSha = metadata.integrationBase
    || (() => {
      const rootHead = git(root, ["rev-parse", "HEAD"])
      const sandboxHead = git(dir, ["rev-parse", "HEAD"])
      if (rootHead.status !== 0 || sandboxHead.status !== 0) return null
      const base = git(dir, ["merge-base", rootHead.stdout.trim(), sandboxHead.stdout.trim()])
      return base.status === 0 ? base.stdout.trim() : null
    })()
  if (!baseSha) {
    block("integration-base", "could not resolve the sandbox integration base")
    return { ok: false, dir, checks, reason: "base-unresolved" }
  }
  pass("integration-base", baseSha)

  // A caller-declared wave base must match: a sandbox created against an older
  // base cannot be integrated into a newer root.
  if (options.expectedBaseSha != null && String(options.expectedBaseSha) !== String(baseSha)) {
    block("wave-base-match", `expected ${options.expectedBaseSha}, sandbox base ${baseSha}`)
    return { ok: false, dir, checks, reason: "stale-generation" }
  }
  if (options.currentRootHead != null) {
    const rootHead = git(root, ["rev-parse", "HEAD"])
    const head = rootHead.status === 0 ? rootHead.stdout.trim() : null
    if (head !== String(options.currentRootHead)) {
      block("root-generation-stable", `expected ${options.currentRootHead}, root HEAD ${head}`)
      return { ok: false, dir, checks, reason: "root-advanced" }
    }
  }

  // Changed files. `sourceGitPathspecs()` already excludes UES runtime artifact
  // directories, so a runtime file cannot reach the integration patch. That
  // pathspec is a single point of failure, so the sandbox is ALSO scanned
  // directly for runtime artifacts below: defence in depth, not a duplicate rule.
  const changedRun = git(dir, ["diff", "--name-only", baseSha, "--", ...sourceGitPathspecs()])
  if (changedRun.status !== 0) {
    block("changed-files", (changedRun.stderr || changedRun.stdout || "git diff failed").trim())
    return { ok: false, dir, checks, reason: "diff-failed" }
  }
  const changed = changedRun.stdout.split(/\r?\n/).filter(Boolean).map((value) => value.replaceAll("\\", "/"))
  const untrackedRun = git(dir, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...sourceGitPathspecs()])
  const untracked = untrackedRun.status === 0
    ? sourceFacingPaths(untrackedRun.stdout.split("\0").filter(Boolean)).map((value) => value.replaceAll("\\", "/"))
    : []
  const allChanged = [...new Set([...changed, ...untracked])].sort()
  pass("changed-files", `${allChanged.length} file(s)`)

  // Forbidden path: a sandbox may never carry a UES runtime artifact into root.
  // Scanned from the worktree directly so the check does not depend on the
  // exclude pathspec above being correct.
  const runtimeArtifacts = listRuntimeArtifacts(dir)
  if (runtimeArtifacts.length) {
    block("no-forbidden-path", runtimeArtifacts.slice(0, 10).join(", "))
    return { ok: false, dir, checks, reason: "forbidden-path", changed: allChanged, forbidden: runtimeArtifacts }
  }
  pass("no-forbidden-path", null)

  // A caller-declared write scope is a hard boundary. A file outside it means the
  // child escaped its declared scope and the patch is not admissible.
  if (Array.isArray(options.allowedFiles)) {
    const allowed = new Set(options.allowedFiles.map((value) => String(value).replaceAll("\\", "/")))
    const outside = allChanged.filter((file) => !allowed.has(file))
    if (outside.length) {
      block("write-scope", outside.slice(0, 10).join(", "))
      return { ok: false, dir, checks, reason: "scope-violation", changed: allChanged, outside }
    }
    pass("write-scope", `${allowed.size} allowed file(s)`)
  }

  // Root overlap since the wave started. An inherited-dirty sandbox may overlap
  // root ONLY where the inherited content is byte-identical (the V16.5 rule).
  const rootDirty = new Set(statusFiles(root))
  const overlap = allChanged.filter((file) => rootDirty.has(file))
  const unsafeOverlap = []
  for (const file of overlap) {
    if (!metadata.inheritedDirtyRoot) {
      unsafeOverlap.push(file)
      continue
    }
    const inheritedUntrackedHash = metadata?.inheritedUntrackedHashes?.[file]
    if (inheritedUntrackedHash) {
      try {
        const current = await readFile(path.join(root, file))
        const currentHash = createHash("sha256").update(current).digest("hex")
        if (currentHash !== inheritedUntrackedHash) unsafeOverlap.push(file)
      } catch {
        unsafeOverlap.push(file)
      }
      continue
    }
    const check = git(root, ["diff", "--quiet", baseSha, "--", file])
    if (check.status !== 0) unsafeOverlap.push(file)
  }
  if (unsafeOverlap.length) {
    block("no-root-overlap", unsafeOverlap.slice(0, 10).join(", "))
    return { ok: false, dir, checks, reason: "root-overlap", changed: allChanged, overlap: unsafeOverlap }
  }
  pass("no-root-overlap", overlap.length ? `${overlap.length} inherited-identical file(s)` : null)

  // The patch itself must be generatable and non-empty OR explicitly empty.
  const patch = git(dir, ["diff", "--binary", "--no-ext-diff", baseSha, "--", ...sourceGitPathspecs()])
  if (patch.status !== 0) {
    block("patch-generatable", (patch.stderr || patch.stdout || "git diff failed").trim())
    return { ok: false, dir, checks, reason: "patch-failed" }
  }
  const patchText = patch.stdout || ""
  pass("patch-generatable", `${patchText.length} chars`)

  // `--check` proves the patch applies to the CURRENT root without applying it.
  if (patchText.length > 0) {
    const check = git(root, ["apply", "--check", "--whitespace=nowarn", "-"], { input: patchText })
    if (check.status !== 0) {
      block("patch-applies-cleanly", (check.stderr || check.stdout || "git apply --check failed").trim())
      return { ok: false, dir, checks, reason: "patch-conflict", changed: allChanged }
    }
    pass("patch-applies-cleanly", null)
  }

  return {
    ok: true,
    dir,
    branch: metadata.branch || null,
    base: baseSha,
    changed: allChanged,
    patch: patchText,
    patchChars: patchText.length,
    empty: allChanged.length === 0 && patchText.length === 0,
    checks,
    reason: "preflight-ok",
  }
}

/**
 * V16.15: is the root working tree unchanged relative to a recorded snapshot?
 *
 * Used by the integration transaction to detect a concurrent root mutation
 * between PREFLIGHT and APPLY. It reads Git state only; it never writes.
 */
export function rootWorkspaceIdentity(root) {
  root = path.resolve(root)
  const head = git(root, ["rev-parse", "HEAD"])
  if (head.status !== 0) throw new Error((head.stderr || head.stdout || "git rev-parse HEAD failed").trim())
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...sourceGitPathspecs()])
  if (status.status !== 0) throw new Error((status.stderr || status.stdout || "git status failed").trim())
  const files = sourceFacingPaths(
    workspaceStatusEntries(status.stdout).filter((entry) => entry.renameSource !== true).map((entry) => entry.file),
  ).sort()
  return {
    head: head.stdout.trim(),
    dirtyFiles: files,
    identity: "root-identity:sha256:" + createHash("sha256")
      .update(head.stdout.trim() + "\0" + files.join("\0"))
      .digest("hex").slice(0, 24),
  }
}

/**
 * V16.15: does a candidate patch textually collide with patches already accepted
 * into the same wave?
 *
 * Two writers are supposed to be independent, but a wave-level guarantee must not
 * rely on the classifier being right. This detects a real file-level collision
 * BEFORE any root mutation, and it is the check that makes "preflight ALL patches
 * before applying ANY" meaningful.
 */
export function patchesOverlap(leftPatch, rightPatch) {
  const filesOf = (patch) => {
    const files = new Set()
    for (const line of String(patch || "").split(/\r?\n/)) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      if (match) {
        files.add(match[1].replaceAll("\\", "/"))
        files.add(match[2].replaceAll("\\", "/"))
      }
    }
    return files
  }
  const left = filesOf(leftPatch)
  const right = filesOf(rightPatch)
  return [...left].filter((file) => right.has(file)).sort()
}

function processAlive(pid) {
  const value = Number(pid)
  if (!Number.isInteger(value) || value <= 0) return false
  try {
    process.kill(value, 0)
    return true
  } catch {
    return false
  }
}

export async function pruneOrphanTaskSandboxes(root, options = {}) {
  root = path.resolve(root)
  const now = Date.now()
  const minAgeMs = Math.max(60_000, Number(options.minAgeMs || 5 * 60_000))
  const legacyMinAgeMs = Math.max(minAgeMs, Number(options.legacyMinAgeMs || 30 * 60_000))
  const ownedMinAgeMs = Math.max(0, Number(options.ownedMinAgeMs ?? 60_000))
  const reclaimOwnerPid = Number(options.reclaimOwnerPid || 0)
  const protectedDirs = new Set(
    (options.protectedDirs || []).map((value) => path.resolve(String(value))),
  )
  const expectedBase = path.resolve(
    options.baseDir || path.join(path.dirname(root), "." + path.basename(root) + ".ues-sandboxes"),
  )
  const removed = []
  const skipped = []
  const sidecarsRemoved = []

  for (const item of listTaskSandboxes(root)) {
    const branch = String(item.branch || "").replace(/^refs\/heads\//, "")
    const dir = path.resolve(String(item.path || ""))
    if (!branch.startsWith("ues/")) continue
    if (path.dirname(dir) !== expectedBase) continue
    if (protectedDirs.has(dir)) {
      skipped.push({ dir, reason: "protected-active" })
      continue
    }

    const metadata = await readSandboxMetadata(dir)
    if (!metadata || path.resolve(String(metadata.root || "")) !== root) {
      skipped.push({ dir, reason: "metadata-missing-or-root-mismatch" })
      continue
    }

    const createdAt = Date.parse(String(metadata.createdAt || ""))
    const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : Infinity
    const ownerPid = Number(metadata.ownerPid || 0)
    const reclaimOwned = reclaimOwnerPid > 0 && ownerPid === reclaimOwnerPid

    if (ownerPid > 0 && processAlive(ownerPid) && !reclaimOwned) {
      skipped.push({ dir, reason: "owner-alive", ownerPid })
      continue
    }

    const requiredAge = reclaimOwned
      ? ownedMinAgeMs
      : ownerPid > 0
        ? minAgeMs
        : legacyMinAgeMs
    if (ageMs < requiredAge) {
      skipped.push({ dir, reason: "too-recent", ageMs, ownerPid: ownerPid || null })
      continue
    }

    try {
      const result = await removeTaskSandbox(root, dir, {
        force: true,
        deleteBranch: true,
        branch,
      })
      removed.push({ ...result, ageMs, ownerPid: ownerPid || null, reclaimOwned })
    } catch (error) {
      skipped.push({
        dir,
        reason: "remove-failed",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Clean detached physical sandbox directories left after Git forgot the
  // worktree registration (for example after a crash/manual prune). Only remove
  // directories with UES metadata bound to this exact root repository.
  try {
    const registered = new Set(
      listTaskSandboxes(root).map((item) => path.resolve(String(item.path || ""))),
    )
    const entries = await readdir(expectedBase, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.resolve(expectedBase, entry.name)
      if (registered.has(dir) || protectedDirs.has(dir)) continue

      const metadata = await readSandboxMetadata(dir)
      if (!metadata || path.resolve(String(metadata.root || "")) !== root) continue

      const createdAt = Date.parse(String(metadata.createdAt || ""))
      const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : Infinity
      const ownerPid = Number(metadata.ownerPid || 0)
      const reclaimOwned = reclaimOwnerPid > 0 && ownerPid === reclaimOwnerPid

      if (ownerPid > 0 && processAlive(ownerPid) && !reclaimOwned) {
        skipped.push({ dir, reason: "detached-owner-alive", ownerPid })
        continue
      }

      const requiredAge = reclaimOwned
        ? ownedMinAgeMs
        : ownerPid > 0
          ? minAgeMs
          : legacyMinAgeMs
      if (ageMs < requiredAge) {
        skipped.push({ dir, reason: "detached-too-recent", ageMs, ownerPid: ownerPid || null })
        continue
      }

      try {
        await safeRemovePath(dir)
        await unlink(metadataFile(dir)).catch(() => {})
        const branch = String(metadata.branch || "")
        if (branch.startsWith("ues/")) git(root, ["branch", "-D", branch])
        removed.push({
          removed: !existsSync(dir),
          dir,
          branch: branch || null,
          ageMs,
          ownerPid: ownerPid || null,
          reclaimOwned,
          detached: true,
        })
      } catch (error) {
        skipped.push({
          dir,
          reason: "detached-remove-failed",
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  } catch {}

  // Clean metadata sidecars left after a crash or manual worktree removal.
  try {
    const entries = await readdir(expectedBase, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".ues-meta.json")) continue
      const sidecar = path.join(expectedBase, entry.name)
      const dir = sidecar.slice(0, -".ues-meta.json".length)
      if (existsSync(dir)) continue
      try {
        const metadata = JSON.parse(await readFile(sidecar, "utf8"))
        if (path.resolve(String(metadata.root || "")) !== root) continue
        const createdAt = Date.parse(String(metadata.createdAt || ""))
        const ageMs = Number.isFinite(createdAt) ? Math.max(0, now - createdAt) : Infinity
        if (ageMs < minAgeMs) continue
        await unlink(sidecar)
        sidecarsRemoved.push(sidecar)
      } catch {}
    }

    const remaining = await readdir(expectedBase)
    if (remaining.length === 0) {
      await safeRemovePath(expectedBase, { recursive: false })
    }
  } catch {}

  git(root, ["worktree", "prune"])
  return { removed, skipped, sidecarsRemoved, baseRemoved: !existsSync(expectedBase) }
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
    if (options.force) await safeRemovePath(dir)
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
  await unlink(metadataFile(dir)).catch(() => {})
  return { removed: !existsSync(dir), dir, branch: branch || null }
}

export async function rollbackTaskSandbox(root, dir, options = {}) {
  root = path.resolve(root)
  dir = path.resolve(dir)
  if (!existsSync(dir)) throw new Error("sandbox does not exist: " + dir)
  const metadata = await readSandboxMetadata(dir)
  if (!metadata?.integrationBase) throw new Error("sandbox rollback metadata is missing")

  const patch = git(dir, ["diff", "--binary", "--no-ext-diff", metadata.integrationBase, "--"])
  if (patch.status !== 0) throw new Error((patch.stderr || patch.stdout || "git diff for rollback failed").trim())
  if (patch.stdout) {
    const reversed = git(root, ["apply", "--reverse", "--whitespace=nowarn", "-"], { input: patch.stdout })
    if (reversed.status !== 0) throw new Error((reversed.stderr || reversed.stdout || "git rollback apply failed").trim())
  }

  if (!options.keep) {
    await removeTaskSandbox(root, dir, { force: true, deleteBranch: true })
  }
  return { rolledBack: true, dir, base: metadata.integrationBase }
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
