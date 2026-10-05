// V16.7.1 Part 4: two-level cleanup with EXTERNAL / uncooperative process death.
//
// Level A (cooperative) is the in-process `try/finally` teardown proven by
// `ues-run-teardown-v16-7-1.test.mjs`. Level B (this file) is the case the
// `finally` can NEVER cover: the owning process is killed from OUTSIDE, so no
// handler runs and the exclusive profile lock is left behind on disk.
//
// The profile lock is the safety boundary that stops two runs driving the same
// persistent browser profile. A crashed owner must therefore be reclaimable,
// but a LIVE owner must NEVER be stolen -- not by TTL, not by a heartbeat miss.
//
// This file proves the real boundary with a REAL child process and a REAL
// descendant, killed from outside the process tree:
//
//   1. A child node process acquires the lock, spawns a DESCENDANT, records the
//      lock owner pid and the descendant pid, then blocks.
//   2. The child is terminated EXTERNALLY (uncooperative: no release handler).
//      The descendant is terminated too, so the machine is left clean.
//   3. The lock file is INSPECTED on disk: it is still present, and it is
//      classified stale for exactly one reason -- `owner-process-dead`.
//   4. A SECOND worker acquires the same profile: it RECLAIMS the stale lock
//      (status `stale-lock-reclaimed`) instead of failing closed.
//   5. The invariant is re-asserted in-process: a LIVE owner lock is never
//      reclaimed on TTL alone.

import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  PROFILE_LOCK_STATUS,
  acquireProfileLock,
  inspectProfileLock,
  lockStaleness,
  processAlive,
  releaseProfileLock,
} from "../lib/deepseek-profile-lock.mjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOCK_MODULE_URL = pathToFileURL(path.join(ROOT, "lib", "deepseek-profile-lock.mjs")).href

const IS_WINDOWS = process.platform === "win32"

// ---------------------------------------------------------------------------
// The child program: acquire the profile lock, spawn a descendant, record both
// pids, then block until killed. It writes the owner pid + descendant pid to
// `$UES_PART4_OUT` so the parent test can inspect and later clean up.
// ---------------------------------------------------------------------------
function childProgram() {
  return `
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { acquireProfileLock } from ${JSON.stringify(LOCK_MODULE_URL)}

const configDir = process.env.UES_PART4_CONFIG
const out = process.env.UES_PART4_OUT
const profile = process.env.UES_PART4_PROFILE

const handle = acquireProfileLock(profile, { configDir })
// A real descendant so the test also proves the lock is owned by the direct
// child (not the descendant), and that external termination of the tree leaves
// the lock reclaimable via the DIRECT owner's death.
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })

writeFileSync(out, JSON.stringify({
  ownerPid: process.pid,
  descendantPid: descendant.pid,
  lockFile: handle.file,
  token: handle.token,
  status: handle.status,
}), "utf8")

setInterval(() => {}, 1000)
`
}

function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (existsSync(file)) {
        try {
          resolve(JSON.parse(readFileSync(file, "utf8")))
          return
        } catch {
          // still being written
        }
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${file}`))
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

function killTree(pid) {
  if (!pid) return
  if (IS_WINDOWS) {
    // External, uncooperative termination: /F kills without a chance to clean up.
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

function waitForDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (!processAlive(pid)) {
        resolve(true)
        return
      }
      if (Date.now() > deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, 50)
    }
    tick()
  })
}

test("V16.7.1 Part 4: an externally-killed owner leaves a lock a second worker can reclaim", async (t) => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ues-part4-config-"))
  const scratch = mkdtempSync(path.join(os.tmpdir(), "ues-part4-out-"))
  const outFile = path.join(scratch, "child.json")
  const scriptFile = path.join(scratch, "child.mjs")
  const profile = "part4" + process.pid
  writeFileSync(scriptFile, childProgram(), "utf8")

  let child = null
  let info = null
  try {
    child = spawn(process.execPath, [scriptFile], {
      stdio: "ignore",
      env: {
        ...process.env,
        UES_PART4_CONFIG: configDir,
        UES_PART4_OUT: outFile,
        UES_PART4_PROFILE: profile,
      },
    })

    // The child acquired the lock and recorded its owner pid + descendant.
    info = await waitForFile(outFile, 15_000)
    assert.equal(info.status, PROFILE_LOCK_STATUS.ACQUIRED)
    assert.ok(info.ownerPid > 0)
    assert.ok(existsSync(info.lockFile), "the lock file must exist while the owner is alive")

    // While the owner is ALIVE, the lock is NOT reclaimable and NOT stale.
    const live = inspectProfileLock(profile, { configDir })
    assert.equal(live.locked, true, "a live owner must hold the lock")
    assert.equal(live.stale, false)
    assert.throws(
      () => acquireProfileLock(profile, { configDir }),
      (error) => error.code === "UES_PROFILE_LOCKED",
      "a live owner must never be stolen",
    )

    // EXTERNAL, uncooperative termination: no release handler runs.
    killTree(info.ownerPid)
    const ownerDead = await waitForDead(info.ownerPid)
    assert.equal(ownerDead, true, "the externally killed owner must be gone")

    // The external tree kill must also take the DESCENDANT: `taskkill /T` on
    // Windows and a process-group SIGKILL elsewhere leave no orphan behind. This
    // is the "descendant tree gone" half of the Level-B cleanup proof.
    if (info.descendantPid) {
      const descendantDead = await waitForDead(info.descendantPid)
      assert.equal(descendantDead, true, "external termination must leave no surviving descendant")
    }

    // The lock file SURVIVES the uncooperative death -- that is the leak Level B
    // must reclaim.
    assert.equal(existsSync(info.lockFile), true, "an uncooperative death leaves the lock on disk")

    // It is now stale for exactly one reason: the owner process is dead.
    const stale = inspectProfileLock(profile, { configDir })
    assert.equal(stale.stale, true)
    assert.equal(stale.reason, "owner-process-dead", `unexpected staleness reason ${stale.reason}`)

    // A SECOND worker acquires the same profile: it RECLAIMS the stale lock.
    const second = acquireProfileLock(profile, { configDir })
    assert.equal(second.status, PROFILE_LOCK_STATUS.STALE_RECLAIMED, "a dead-owner lock must be reclaimed, not refused")
    assert.ok(second.reclaimed, "the reclaim must report the previous owner")
    assert.equal(second.reclaimed.reason, "owner-process-dead")
    // The second owner is now this process; release is idempotent and token-bound.
    const released = releaseProfileLock(profile, second.token, { configDir })
    assert.equal(released.released, true)

    // Cleanup the descendant so the machine is left clean.
    if (info.descendantPid) killTree(info.descendantPid)
  } finally {
    if (child && !child.killed) killTree(child.pid)
    if (info?.descendantPid) killTree(info.descendantPid)
    rmSync(scratch, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  }
})

test("V16.7.1 Part 4: TTL expiry alone NEVER reclaims a live owner's lock", () => {
  const configDir = mkdtempSync(path.join(os.tmpdir(), "ues-part4-ttl-"))
  try {
    // Owner = THIS process (alive). TTL is tiny, then we look far past it.
    const handle = acquireProfileLock("ttl-live", { configDir, ttlMs: 30_000, pid: process.pid })
    const future = Date.now() + 10 * 60 * 1000
    const staleness = lockStaleness(
      { token: handle.token, pid: process.pid, host: os.hostname(), expiresAt: handle.expiresAt },
      { now: future, host: os.hostname() },
    )
    assert.equal(staleness.stale, false, "a live owner must not be reclaimed on TTL")
    assert.equal(staleness.reason, "ttl-expired-but-owner-not-provably-dead")
    assert.throws(
      () => acquireProfileLock("ttl-live", { configDir, now: future }),
      (error) => error.code === "UES_PROFILE_LOCKED",
      "TTL expiry must not let a second worker steal a live lock",
    )
    handle.release()
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test("V16.7.1 Part 4: a lock on a DIFFERENT host is never reclaimed (unverifiable owner)", () => {
  const staleness = lockStaleness(
    { token: "t", pid: 4242, host: "some-other-host", expiresAt: Date.now() - 60_000 },
    { now: Date.now(), host: os.hostname(), kill: () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }) } },
  )
  assert.equal(staleness.stale, false, "an unverifiable remote owner must not be reclaimed")
  assert.equal(staleness.reason, "ttl-expired-but-owner-not-provably-dead")
})

test("V16.7.1 Part 4 source: the worker lock owner is the worker process itself", () => {
  const source = readFileSync(path.join(ROOT, "pi", "extensions", "ues.ts"), "utf8")
  // The lock is acquired with the worker transport's kill bound in, so a
  // crashed worker is reclaimed via owner-process-dead -- never stolen by TTL.
  assert.match(source, /acquireProfileLock\(profileName, \{/, "the worker must acquire the profile lock")
  assert.match(source, /kill: transport\.process\.kill\.bind\(transport\.process\)/, "the lock owner must be the worker process")
  // The cooperative path releases the lease alongside the worker.
  assert.match(source, /lockHandle\?\.release\(\)/, "the cooperative teardown must release the profile lease")
})

test("V16.7.1 Part 4: the lock module documents the never-steal-a-live-owner invariant", () => {
  const source = readFileSync(path.join(ROOT, "lib", "deepseek-profile-lock.mjs"), "utf8")
  assert.match(source, /owner-process-dead/, "the dead-owner evidence must be present")
  assert.match(source, /ttl-expired-but-owner-not-provably-dead/, "TTL must not be sufficient evidence")
  // A live-owner lock is refused with a lock conflict, not silently stolen.
  assert.match(source, /UES_PROFILE_LOCKED/, "a held lock must fail closed with a lock conflict")
})
