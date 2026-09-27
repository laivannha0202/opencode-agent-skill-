import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import {
  createTaskSandbox,
  integrateTaskSandbox,
  listTaskSandboxes,
  pruneOrphanTaskSandboxes,
  rollbackTaskSandbox,
} from "../lib/worktree-sandbox.mjs"

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test("sandbox integration applies isolated changes and cleans worktree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-root-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-base-"))
  try {
    await mkdir(path.join(root, "src"), { recursive: true })
    await writeFile(path.join(root, "src", "value.js"), "export const value = 1\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const sandbox = await createTaskSandbox(root, "demo", "T1", { baseDir: base })
    await writeFile(path.join(sandbox.dir, "src", "value.js"), "export const value = 2\n")
    await writeFile(path.join(sandbox.dir, "src", "new.js"), "export const extra = true\n")

    const integrated = await integrateTaskSandbox(root, sandbox.dir)
    assert.equal(integrated.integrated, true)
    assert.ok(integrated.changed.includes("src/value.js"))
    assert.ok(integrated.changed.includes("src/new.js"))
    const valueSource = await readFile(path.join(root, "src", "value.js"), "utf8")
    const newSource = await readFile(path.join(root, "src", "new.js"), "utf8")
    assert.equal(valueSource.replaceAll("\r\n", "\n"), "export const value = 2\n")
    assert.equal(newSource.replaceAll("\r\n", "\n"), "export const extra = true\n")
    assert.equal(listTaskSandboxes(root).some((item) => path.resolve(item.path) === path.resolve(sandbox.dir)), false)
    assert.equal(git(root, ["branch", "--list", sandbox.branch]), "")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})

test("sandbox integration refuses overlap with dirty root files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-conflict-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-conflict-base-"))
  try {
    await writeFile(path.join(root, "value.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const sandbox = await createTaskSandbox(root, "demo", "T2", { baseDir: base })
    await writeFile(path.join(sandbox.dir, "value.txt"), "sandbox\n")
    await writeFile(path.join(root, "value.txt"), "root\n")

    await assert.rejects(
      integrateTaskSandbox(root, sandbox.dir, { keep: true }),
      /conflicts with existing root changes/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("sandbox creation refuses dirty root state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-dirty-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-dirty-base-"))
  try {
    await writeFile(path.join(root, "value.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])
    await writeFile(path.join(root, "value.txt"), "dirty\n")

    await assert.rejects(
      createTaskSandbox(root, "demo", "T3", { baseDir: base }),
      /clean root working tree/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("parallel sandbox inherits dirty root but only integrates its own delta", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-inherit-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-inherit-base-"))
  try {
    await writeFile(path.join(root, "upstream.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    await writeFile(path.join(root, "upstream.txt"), "integrated-a\n")
    const sandbox = await createTaskSandbox(root, "parallel", "T2", {
      baseDir: base,
      inheritDirtyRoot: true,
    })
    assert.equal((await readFile(path.join(sandbox.dir, "upstream.txt"), "utf8")).replaceAll("\r\n", "\n"), "integrated-a\n")

    await writeFile(path.join(sandbox.dir, "downstream.txt"), "task-b\n")
    const integrated = await integrateTaskSandbox(root, sandbox.dir, { keep: true })
    assert.deepEqual(integrated.changed, ["downstream.txt"])
    assert.equal((await readFile(path.join(root, "upstream.txt"), "utf8")).replaceAll("\r\n", "\n"), "integrated-a\n")
    assert.equal((await readFile(path.join(root, "downstream.txt"), "utf8")).replaceAll("\r\n", "\n"), "task-b\n")

    await rollbackTaskSandbox(root, sandbox.dir)
    await assert.rejects(readFile(path.join(root, "downstream.txt"), "utf8"), /ENOENT/)
    assert.equal((await readFile(path.join(root, "upstream.txt"), "utf8")).replaceAll("\r\n", "\n"), "integrated-a\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("parallel sandbox can modify an inherited untracked file without a false conflict", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-untracked-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-untracked-base-"))
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "tracked.txt"])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    await writeFile(path.join(root, "draft.txt"), "user-baseline\n")
    const sandbox = await createTaskSandbox(root, "parallel", "untracked-edit", {
      baseDir: base,
      inheritDirtyRoot: true,
    })
    assert.equal((await readFile(path.join(sandbox.dir, "draft.txt"), "utf8")), "user-baseline\n")

    await writeFile(path.join(sandbox.dir, "draft.txt"), "worker-edit\n")
    const integrated = await integrateTaskSandbox(root, sandbox.dir, { keep: true })
    assert.deepEqual(integrated.changed, ["draft.txt"])
    assert.equal((await readFile(path.join(root, "draft.txt"), "utf8")).replaceAll("\r\n", "\n"), "worker-edit\n")

    await rollbackTaskSandbox(root, sandbox.dir)
    assert.equal((await readFile(path.join(root, "draft.txt"), "utf8")).replaceAll("\r\n", "\n"), "user-baseline\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})

test("parallel sandbox rejects an inherited untracked file changed after snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-untracked-race-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-untracked-race-base-"))
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "tracked.txt"])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    await writeFile(path.join(root, "draft.txt"), "snapshot-baseline\n")
    const sandbox = await createTaskSandbox(root, "parallel", "untracked-race", {
      baseDir: base,
      inheritDirtyRoot: true,
    })
    await writeFile(path.join(sandbox.dir, "draft.txt"), "worker-edit\n")
    await writeFile(path.join(root, "draft.txt"), "user-later-edit\n")

    await assert.rejects(
      integrateTaskSandbox(root, sandbox.dir, { keep: true }),
      /conflicts with existing root changes/,
    )
    assert.equal(await readFile(path.join(root, "draft.txt"), "utf8"), "user-later-edit\n")
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})

test("parallel downstream sandbox can safely modify a file inherited from a predecessor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-chain-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-chain-base-"))
  try {
    await writeFile(path.join(root, "shared.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    await writeFile(path.join(root, "shared.txt"), "from-task-a\n")
    const sandbox = await createTaskSandbox(root, "parallel", "T3", {
      baseDir: base,
      inheritDirtyRoot: true,
    })
    await writeFile(path.join(sandbox.dir, "shared.txt"), "from-task-a-and-b\n")

    const integrated = await integrateTaskSandbox(root, sandbox.dir, { keep: true })
    assert.deepEqual(integrated.changed, ["shared.txt"])
    assert.equal(
      (await readFile(path.join(root, "shared.txt"), "utf8")).replaceAll("\r\n", "\n"),
      "from-task-a-and-b\n",
    )

    await rollbackTaskSandbox(root, sandbox.dir)
    assert.equal(
      (await readFile(path.join(root, "shared.txt"), "utf8")).replaceAll("\r\n", "\n"),
      "from-task-a\n",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("V15.6 orphan sandbox cleanup removes dead-owner worktrees but preserves live ownership", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-orphan-root-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-orphan-base-"))
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const live = await createTaskSandbox(root, "lease", "live", { baseDir: base })
    const liveMetaPath = path.resolve(live.dir) + ".ues-meta.json"
    const liveMeta = JSON.parse(await readFile(liveMetaPath, "utf8"))
    assert.equal(liveMeta.ownerPid, process.pid)

    const dead = await createTaskSandbox(root, "lease", "dead", { baseDir: base })
    const deadMetaPath = path.resolve(dead.dir) + ".ues-meta.json"
    const deadMeta = JSON.parse(await readFile(deadMetaPath, "utf8"))
    deadMeta.ownerPid = 2147483647
    deadMeta.createdAt = new Date(Date.now() - 60 * 60_000).toISOString()
    await writeFile(deadMetaPath, JSON.stringify(deadMeta, null, 2) + "\n")

    const cleanup = await pruneOrphanTaskSandboxes(root, {
      baseDir: base,
      minAgeMs: 60_000,
      legacyMinAgeMs: 60_000,
    })
    assert.equal(cleanup.removed.some((item) => path.resolve(item.dir) === path.resolve(dead.dir)), true)
    assert.equal(listTaskSandboxes(root).some((item) => path.resolve(item.path) === path.resolve(dead.dir)), false)
    assert.equal(listTaskSandboxes(root).some((item) => path.resolve(item.path) === path.resolve(live.dir)), true)

    await rm(live.dir, { recursive: true, force: true })
    spawnSync("git", ["worktree", "prune"], { cwd: root, encoding: "utf8" })
    spawnSync("git", ["branch", "-D", live.branch], { cwd: root, encoding: "utf8" })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("V15.7 cleanup reclaims ended same-process sandboxes but protects active ones", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-owned-root-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-owned-base-"))
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const active = await createTaskSandbox(root, "owned", "active", { baseDir: base })
    const ended = await createTaskSandbox(root, "owned", "ended", { baseDir: base })

    const cleanup = await pruneOrphanTaskSandboxes(root, {
      baseDir: base,
      minAgeMs: 60_000,
      legacyMinAgeMs: 60_000,
      ownedMinAgeMs: 0,
      reclaimOwnerPid: process.pid,
      protectedDirs: [active.dir],
    })

    assert.equal(cleanup.removed.some((item) => path.resolve(item.dir) === path.resolve(ended.dir)), true)
    assert.equal(cleanup.skipped.some((item) => path.resolve(item.dir) === path.resolve(active.dir) && item.reason === "protected-active"), true)
    assert.equal(listTaskSandboxes(root).some((item) => path.resolve(item.path) === path.resolve(active.dir)), true)
    assert.equal(listTaskSandboxes(root).some((item) => path.resolve(item.path) === path.resolve(ended.dir)), false)

    await rm(active.dir, { recursive: true, force: true })
    spawnSync("git", ["worktree", "prune"], { cwd: root, encoding: "utf8" })
    spawnSync("git", ["branch", "-D", active.branch], { cwd: root, encoding: "utf8" })
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})

test("V15.7 cleanup removes orphan metadata sidecars for missing sandboxes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-sidecar-root-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-sidecar-base-"))
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const ghostDir = path.join(base, "runtime-ghost")
    const sidecar = ghostDir + ".ues-meta.json"
    await writeFile(sidecar, JSON.stringify({
      root,
      dir: ghostDir,
      branch: "ues/runtime-ghost",
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      ownerPid: 2147483647,
    }, null, 2) + "\n")

    const cleanup = await pruneOrphanTaskSandboxes(root, {
      baseDir: base,
      minAgeMs: 60_000,
      legacyMinAgeMs: 60_000,
    })
    assert.equal(cleanup.sidecarsRemoved.includes(sidecar), true)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})


test("V15.8 cleanup removes detached physical sandbox folders with valid metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-detached-root-"))
  const base = await mkdtemp(path.join(os.tmpdir(), "ues-sandbox-detached-base-"))
  try {
    await writeFile(path.join(root, "tracked.txt"), "base\n")
    git(root, ["init"])
    git(root, ["add", "."])
    git(root, ["-c", "user.name=UES", "-c", "user.email=ues@example.invalid", "commit", "-m", "init"])

    const detachedDir = path.join(base, "runtime-detached")
    await mkdir(detachedDir, { recursive: true })
    await writeFile(path.join(detachedDir, "payload.txt"), "stale\n")
    await writeFile(detachedDir + ".ues-meta.json", JSON.stringify({
      root,
      dir: detachedDir,
      branch: "ues/runtime-detached",
      createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      ownerPid: 2147483647,
    }, null, 2) + "\n")

    const cleanup = await pruneOrphanTaskSandboxes(root, {
      baseDir: base,
      minAgeMs: 60_000,
      legacyMinAgeMs: 60_000,
    })

    assert.equal(cleanup.removed.some((item) => path.resolve(item.dir) === path.resolve(detachedDir) && item.detached === true), true)
    await assert.rejects(readFile(path.join(detachedDir, "payload.txt"), "utf8"), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(base, { recursive: true, force: true })
  }
})
