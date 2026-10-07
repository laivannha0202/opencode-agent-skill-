// V16.11 Windows resource hygiene tests.
//
// These prove the cleanup CONTRACT: an ordered teardown, a per-step verdict, a
// COMPLETE receipt only when nothing is retained, and -- on Windows -- a REAL
// taskkill of a spawned process tree that holds a locked file. The real-process
// test is skipped on non-Windows because it asserts the platform-specific kill.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

import {
  HYGIENE_STEP,
  HYGIENE_VERDICT,
  WINDOWS_HYGIENE_POLICY,
  detectRetainedResources,
  proveBrowserResourceCleanup,
} from "../lib/windows-resource-hygiene-v16-11.mjs"

test("hygiene: a session with nothing to clean is NOTHING_TO_DO and clean", async () => {
  const receipt = await proveBrowserResourceCleanup({})
  assert.equal(receipt.verdict, HYGIENE_VERDICT.NOTHING_TO_DO)
  assert.equal(receipt.clean, true)
  assert.equal(receipt.policy, WINDOWS_HYGIENE_POLICY)
})

test("hygiene: a fully removable session is COMPLETE and clean", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ues-hygiene-"))
  const userDataDir = path.join(dir, "profile")
  const artifacts = path.join(dir, "artifacts")
  writeFileSync(path.join(dir, "marker"), "x")
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(artifacts, { recursive: true })
  writeFileSync(path.join(userDataDir, "Cookies"), "secret")
  writeFileSync(path.join(artifacts, "shot.png"), "png")

  const receipt = await proveBrowserResourceCleanup({
    id: "s1",
    userDataDir,
    artifactDirs: [artifacts],
  })
  assert.equal(receipt.verdict, HYGIENE_VERDICT.COMPLETE)
  assert.equal(receipt.clean, true)
  assert.equal(existsSync(userDataDir), false, "the profile dir must actually be gone")
  assert.equal(existsSync(artifacts), false)
  rmSync(dir, { recursive: true, force: true })
})

test("hygiene: a profile that cannot be removed is PARTIAL, retained and NOT clean", async () => {
  // A fs double that refuses the user-data removal, proving a leak is REPORTED
  // rather than hidden behind a generic success.
  const fsImpl = {
    existsSync: () => true,
    rmSync: (target) => {
      if (String(target).includes("profile")) {
        const error = new Error("EPERM: operation not permitted")
        error.code = "EPERM"
        throw error
      }
    },
  }
  const receipt = await proveBrowserResourceCleanup(
    { id: "s2", userDataDir: "C:/tmp/profile", artifactDirs: ["C:/tmp/artifacts"] },
    { fsImpl },
  )
  assert.equal(receipt.verdict, HYGIENE_VERDICT.PARTIAL)
  assert.equal(receipt.clean, false)
  assert.ok(receipt.retainedPaths.some((p) => p.includes("profile")), "the retained path must be named")
  assert.ok(receipt.errors.some((e) => e.includes(HYGIENE_STEP.REMOVE_USER_DATA)))
})

test("hygiene: the teardown order kills the process tree BEFORE removing files", async () => {
  const order = []
  const session = {
    id: "s3",
    process: { pid: 12345 },
    userDataDir: "C:/tmp/profile3",
    releaseLock: async () => { order.push(HYGIENE_STEP.RELEASE_PROFILE_LOCK) },
  }
  await proveBrowserResourceCleanup(session, {
    killTree: () => { order.push(HYGIENE_STEP.KILL_PROCESS_TREE); return true },
    fsImpl: { existsSync: () => true, rmSync: () => { order.push(HYGIENE_STEP.REMOVE_USER_DATA) } },
  })
  const killIndex = order.indexOf(HYGIENE_STEP.KILL_PROCESS_TREE)
  const removeIndex = order.indexOf(HYGIENE_STEP.REMOVE_USER_DATA)
  assert.ok(killIndex >= 0 && removeIndex >= 0)
  assert.ok(killIndex < removeIndex, "on Windows the process tree must die before the dir is removed")
})

test("hygiene: a retained profile lock is its own failed step", async () => {
  const receipt = await proveBrowserResourceCleanup({
    id: "s4",
    releaseLock: async () => { throw new Error("lock still held") },
  })
  assert.ok(receipt.errors.some((e) => e.includes(HYGIENE_STEP.RELEASE_PROFILE_LOCK)))
  assert.equal(receipt.lockReleased, false)
})

test("hygiene: a dry run reports intent without removing", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ues-hygiene-dry-"))
  const profile = path.join(dir, "profile")
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, "f"), "x")
  const receipt = await proveBrowserResourceCleanup({ id: "s5", userDataDir: profile }, { dryRun: true })
  assert.equal(existsSync(profile), true, "a dry run must not delete anything")
  assert.equal(receipt.verdict, HYGIENE_VERDICT.COMPLETE)
  rmSync(dir, { recursive: true, force: true })
})

test("hygiene: the retained-resource detector finds a non-empty dir", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ues-detect-"))
  const empty = path.join(dir, "empty")
  const full = path.join(dir, "full")
  mkdirSync(empty, { recursive: true })
  mkdirSync(full, { recursive: true })
  writeFileSync(path.join(full, "leftover"), "x")
  const result = detectRetainedResources(dir, [empty, full], { listImpl: (p) => readdirSync(p) })
  assert.equal(result.clean, false)
  assert.ok(result.retained.some((r) => r.dir === full))
  assert.ok(!result.retained.some((r) => r.dir === empty))
  rmSync(dir, { recursive: true, force: true })
})

test("hygiene: a real spawned process tree is killed and its locked dir removed on Windows", { skip: process.platform !== "win32" }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ues-win-kill-"))
  const profile = path.join(dir, "profile")
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, "locked.bin"), "x")
  // Spawn a long-lived child that holds the cwd inside the profile dir.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { cwd: profile, stdio: "ignore" })
  await new Promise((resolve) => setTimeout(resolve, 300))
  const receipt = await proveBrowserResourceCleanup({ id: "win", process: child, userDataDir: profile })
  assert.equal(receipt.processTreeTerminated, true, "taskkill must report success")
  assert.equal(receipt.verdict, HYGIENE_VERDICT.COMPLETE)
  assert.equal(existsSync(profile), false, "the locked profile dir must be removable after the tree is killed")
  rmSync(dir, { recursive: true, force: true })
})
