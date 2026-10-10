// V16.17.1 P0 process-lifecycle regressions (§38 items 1-14).
//
// Every test runs the REAL production owner (lib/process-supervisor.mjs):
// real spawns, real taskkill/signal tree termination, real bounded drains.
// No test passes by raising a timeout: each asserts an UPPER bound.

import assert from "node:assert/strict"
import test from "node:test"
import { spawn } from "node:child_process"
import {
  createBoundedOutputBuffer,
  runSupervisedProcess,
  terminateProcessTreeAsync,
} from "../lib/process-supervisor.mjs"

const NODE = process.execPath
const IS_WINDOWS = process.platform === "win32"

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 1. instant-exit: a process that exits at once resolves fast, exactly,
// without waiting out the drain timeout.
test("V16.17.1 instant-exit resolves fast without waiting the drain timeout", async () => {
  const started = Date.now()
  const result = await runSupervisedProcess(NODE, ["-e", "process.stdout.write('ok')"], {
    hardTimeoutMs: 10_000,
    drainTimeoutMs: 1500,
  })
  const elapsed = Date.now() - started
  assert.equal(result.exitCode, 0)
  assert.equal(result.stopReason, null)
  assert.equal(result.stdout, "ok")
  assert.equal(result.stdoutTruncated, false)
  assert.ok(elapsed < 1200, `instant exit took ${elapsed}ms; drain fallback must not be waited out`)
})

// 2. silent-valid-command: a quiet but healthy command is not a hang.
test("V16.17.1 silent valid command completes without a false hang", async () => {
  const result = await runSupervisedProcess(NODE, ["-e", "setTimeout(()=>{}, 400)"], {
    hardTimeoutMs: 10_000,
    idleTimeoutMs: 5_000,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stopReason, null)
  assert.equal(result.stdout, "")
})

// 3. infinite-process: a hung process is reaped on the hard deadline.
test("V16.17.1 infinite process is reaped on a bounded hard timeout", async () => {
  const started = Date.now()
  const result = await runSupervisedProcess(NODE, ["-e", "setInterval(()=>{}, 1000)"], {
    hardTimeoutMs: 300,
    drainTimeoutMs: 500,
  })
  const elapsed = Date.now() - started
  assert.equal(result.stopReason, "hard-timeout")
  assert.equal(result.exitCode, 124)
  assert.ok(elapsed < 8000, `hard-timeout settlement took ${elapsed}ms; must stay bounded`)
  assert.ok(!alive(result.pid), "timed-out process tree must be reaped")
})

// 4. parent-exit-grandchild-holds-pipe: close never arrives, exit still settles.
//
// Construction (verified on real Windows + POSIX): the parent spawns a
// DETACHED grandchild with inherited stdio and unrefs it, then exits. The
// detached grandchild survives the parent and holds OUR pipe write-end open,
// so "close" never fires. A non-detached grandchild is torn down with the
// parent on Windows and would make this test vacuous.
test("V16.17.1 parent exit with a pipe-holding grandchild still settles bounded", async () => {
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    "const gc=spawn(process.execPath,['-e','setInterval(()=>{},30000)'],{stdio:'inherit',detached:true})",
    "gc.unref()",
    "console.log('GC='+gc.pid)",
  ].join(";")
  const started = Date.now()
  const result = await runSupervisedProcess(NODE, ["-e", parentCode], {
    hardTimeoutMs: 15_000,
    drainTimeoutMs: 800,
  })
  const elapsed = Date.now() - started
  const match = String(result.stdout || "").match(/GC=(\d+)/)
  assert.ok(match, "parent must report the grandchild pid for owned cleanup")
  const gcPid = Number(match[1])
  try {
    assert.equal(result.exitCode, 0)
    assert.equal(result.stopReason, null)
    assert.ok(alive(gcPid), "the test setup requires a grandchild that actually outlives the parent")
    assert.ok(elapsed < 5000, `drain fallback took ${elapsed}ms; close must not be waited on forever`)
  } finally {
    // Owned cleanup: the grandchild is ours (this tree spawned it).
    await terminateProcessTreeAsync({ pid: gcPid }, { graceMs: 100 }).catch(() => {})
    try { process.kill(gcPid, "SIGKILL") } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.ok(!alive(gcPid), "pipe-holding grandchild must be reaped by owned cleanup")
})

// 5. termination-helper-timeout: even a hanging kill helper stays bounded and
// never blocks the event loop (a 100ms timer must fire during a 1500ms kill).
test("V16.17.1 hanging kill helper stays bounded and never blocks the event loop", async () => {
  const hangingSpawn = () => ({ once() {}, kill() {} })
  const target = await new Promise((resolve, reject) => {
    const proc = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true })
    proc.once("spawn", () => resolve(proc))
    proc.once("error", reject)
  })
  try {
    let loopFired = false
    const loopProbe = new Promise((resolve) => setTimeout(() => {
      loopFired = true
      resolve()
    }, 100))
    const started = Date.now()
    const result = await terminateProcessTreeAsync(target, {
      killTimeoutMs: 600,
      spawnImpl: IS_WINDOWS ? hangingSpawn : undefined,
      graceMs: 50,
    })
    const elapsed = Date.now() - started
    await loopProbe
    assert.equal(result.attempted, true)
    assert.ok(loopFired, "the event loop must stay responsive during termination")
    if (IS_WINDOWS) {
      assert.equal(result.timedOut, true)
      assert.equal(result.method, "taskkill-timeout")
    }
    assert.ok(elapsed < 8000, `kill attempt took ${elapsed}ms; must stay bounded`)
  } finally {
    await terminateProcessTreeAsync(target, { graceMs: 100 }).catch(() => {})
    try { target.kill("SIGKILL") } catch {}
  }
})

// 6. descendant-tree-cleanup: no owned descendant survives timeout/cancel.
test("V16.17.1 descendant tree is cleaned up on timeout", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { existsSync } = await import("node:fs")
  const root = await mkdtemp(join(tmpdir(), "ues-descendant-"))
  const sentinel = join(root, "grandchild-survived.txt")
  const grandchildCode = [
    "const fs=require('node:fs')",
    `setTimeout(()=>fs.writeFileSync(${JSON.stringify(sentinel)},'survived'),1200)`,
    "setTimeout(()=>{},5000)",
  ].join(";")
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    `spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'ignore',detached:${process.platform !== "win32"}})`,
    "setTimeout(()=>{},5000)",
  ].join(";")
  try {
    const result = await runSupervisedProcess(NODE, ["-e", parentCode], {
      hardTimeoutMs: 200,
      drainTimeoutMs: 500,
    })
    assert.equal(result.stopReason, "hard-timeout")
    await new Promise((resolve) => setTimeout(resolve, 1600))
    assert.equal(existsSync(sentinel), false, "owned grandchild survived process-tree termination")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 7. spawn-error: a missing executable settles exactly once with a clear error.
test("V16.17.1 missing executable settles once with a clear error", async () => {
  const started = Date.now()
  const result = await runSupervisedProcess("ues-definitely-missing-binary-xyz", [], {
    hardTimeoutMs: 5000,
    drainTimeoutMs: 500,
  })
  const elapsed = Date.now() - started
  assert.notEqual(result.exitCode, 0)
  assert.ok(String(result.stderr || "").length > 0, "spawn failure must carry an error message")
  assert.ok(elapsed < 5000, `spawn-error settlement took ${elapsed}ms`)
})

// 8. abort-during-process: AbortSignal reaps the process with reason aborted.
test("V16.17.1 AbortSignal during a running process reaps it as aborted", async () => {
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const started = Date.now()
  const result = await runSupervisedProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
    hardTimeoutMs: 15_000,
    drainTimeoutMs: 500,
  })
  const elapsed = Date.now() - started
  assert.equal(result.stopReason, "aborted")
  assert.equal(result.exitCode, 130)
  assert.ok(elapsed < 8000, `abort settlement took ${elapsed}ms`)
  assert.ok(!alive(result.pid), "aborted process tree must be reaped")
})

// 9. abort-during-drain: abort after natural exit is a single bounded settle
// and must not reclassify the real exit as an abort.
test("V16.17.1 abort during drain settles once and keeps the natural exit", async () => {
  const parentCode = [
    "const {spawn}=require('node:child_process')",
    "const gc=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'inherit',detached:true})",
    "gc.unref()",
    "console.log('GC='+gc.pid)",
    "setTimeout(()=>{},50)",
  ].join(";")
  const controller = new AbortController()
  // Exit lands well under 500ms; abort at 800ms while close is still held by
  // the grandchild, inside the 2000ms drain window.
  setTimeout(() => controller.abort(), 800)
  const started = Date.now()
  const result = await runSupervisedProcess(NODE, ["-e", parentCode], {
    signal: controller.signal,
    hardTimeoutMs: 15_000,
    drainTimeoutMs: 2000,
  })
  const elapsed = Date.now() - started
  const gcPid = Number(String(result.stdout || "").match(/GC=(\d+)/)?.[1] || 0)
  assert.ok(gcPid > 0 && alive(gcPid), "the test setup requires a grandchild holding the pipe at settle time")
  await terminateProcessTreeAsync({ pid: gcPid }, { graceMs: 100 }).catch(() => {})
  try { process.kill(gcPid, "SIGKILL") } catch {}
  assert.equal(result.stopReason, null)
  assert.equal(result.exitCode, 0)
  assert.ok(elapsed < 6000, `drain+abort race took ${elapsed}ms`)
})

// 10. late-close-after-finish: events arriving after settlement are side-effect free.
test("V16.17.1 late events after finish cause no double settle", async () => {
  const result = await runSupervisedProcess(NODE, ["-e", "setInterval(()=>{},1000)"], {
    hardTimeoutMs: 200,
    drainTimeoutMs: 300,
  })
  assert.equal(result.stopReason, "hard-timeout")
  const snapshot = JSON.stringify({ exitCode: result.exitCode, stopReason: result.stopReason })
  // Late exit/close events from the reaped tree arrive in this window; the
  // settled guard must absorb them without a second settlement or a throw.
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert.equal(JSON.stringify({ exitCode: result.exitCode, stopReason: result.stopReason }), snapshot)
})

// 11. huge-stdout: megabytes of output stay memory-bounded with head+tail.
test("V16.17.1 huge stdout stays bounded and preserves head and tail", async () => {
  const code = "process.stdout.write('H'.repeat(64*1024));"
    + "for(let i=0;i<80;i++)process.stdout.write('m'.repeat(64*1024));"
    + "process.stdout.write('T'.repeat(64*1024))"
  const result = await runSupervisedProcess(NODE, ["-e", code], {
    hardTimeoutMs: 20_000,
    stdoutLimit: 128 * 1024,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutTruncated, true)
  assert.ok(result.stdoutOmittedBytes > 0, "omitted bytes must be reported")
  assert.ok(result.stdout.startsWith("H".repeat(16)), "head must be preserved")
  assert.ok(result.stdout.endsWith("T".repeat(16)), "tail must be preserved")
  assert.ok(result.stdout.includes("[omitted "), "omission marker must be present")
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") < 128 * 1024 + 4096,
    "rendered text must stay near the byte budget",
  )
})

// 12. huge-stderr: same bound applies to stderr.
test("V16.17.1 huge stderr stays bounded", async () => {
  const code = "for(let i=0;i<40;i++)process.stderr.write('e'.repeat(64*1024))"
  const result = await runSupervisedProcess(NODE, ["-e", code], {
    hardTimeoutMs: 20_000,
    stderrLimit: 64 * 1024,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stderrTruncated, true)
  assert.ok(result.stderrOmittedBytes > 0)
  assert.ok(Buffer.byteLength(result.stderr, "utf8") < 64 * 1024 + 4096)
})

// 13. unicode-output-byte-accounting: byte caps use bytes, not JS chars.
test("V16.17.1 output accounting is byte-accurate for multibyte text", async () => {
  // "đ" is 2 bytes in UTF-8: 1000 chars = 2000 bytes.
  const small = await runSupervisedProcess(NODE, ["-e", "process.stdout.write('đ'.repeat(1000))"], {
    hardTimeoutMs: 10_000,
  })
  assert.equal(small.exitCode, 0)
  assert.equal(small.stdoutTruncated, false)
  assert.equal(small.stdout, "đ".repeat(1000))
  assert.equal(small.stdoutBytes, 2000)

  const big = await runSupervisedProcess(NODE, ["-e", "process.stdout.write('đ'.repeat(20000))"], {
    hardTimeoutMs: 10_000,
    stdoutLimit: 8192,
  })
  assert.equal(big.stdoutTruncated, true)
  assert.equal(big.stdoutBytes, 40000)
  assert.ok(big.stdoutOmittedBytes > 0, "omitted bytes must be byte-counted")
  // Omitted + kept head/tail bytes (minus the ASCII marker) must reconcile
  // with the true total: no silent char/byte confusion.
  const marker = big.stdout.match(/\.\.\.\[omitted (\d+) bytes of output\]\.\.\./)
  assert.ok(marker, "omission marker must carry the byte count")
  assert.equal(Number(marker[1]), big.stdoutOmittedBytes)
})

// 14. head-tail-preservation: omitted middle is counted exactly.
test("V16.17.1 truncated output keeps exact head, tail and omitted count", async () => {
  const limit = 8192
  const total = 20000
  const code = `process.stdout.write('HEAD-MARKER:'+'a'.repeat((${total}-24))+':TAIL-MARKER')`
  const result = await runSupervisedProcess(NODE, ["-e", code], {
    hardTimeoutMs: 10_000,
    stdoutLimit: limit,
  })
  assert.equal(result.stdoutTruncated, true)
  assert.ok(result.stdout.startsWith("HEAD-MARKER:"), "head marker must survive truncation")
  assert.ok(result.stdout.endsWith(":TAIL-MARKER"), "tail marker must survive truncation")
  const headBytes = Math.min(limit, Math.max(4096, Math.floor(limit / 4)))
  const tailBytes = limit - headBytes
  assert.equal(result.stdoutOmittedBytes, total - headBytes - tailBytes)
  assert.equal(result.stdoutBytes, total)
})

// Buffer owner unit pin: small outputs are byte-identical (no marker).
test("V16.17.1 bounded buffer resolves small outputs byte-identical", () => {
  const buffer = createBoundedOutputBuffer(1024)
  buffer.append(Buffer.from("héllo "))
  buffer.append("world")
  assert.equal(buffer.truncated, false)
  assert.equal(buffer.omittedBytes, 0)
  assert.equal(buffer.text(), "héllo world")
  assert.equal(buffer.bytes, Buffer.byteLength("héllo world", "utf8"))
})

// 15. storage-bounded: STORAGE (not just rendered text) stays O(limit) while
// tens of MiB flow through many chunks. retainedBytes is the deterministic
// owner invariant; RSS is not used because it is noisy.
test("V16.17.1 bounded buffer storage stays O(limit) across tens of MiB", () => {
  const limit = 8 * 1024
  const buffer = createBoundedOutputBuffer(limit)
  const headBytes = buffer.headBytes
  const tailBytes = buffer.tailBytes
  assert.equal(headBytes + tailBytes, limit)

  buffer.append("HEAD-MARKER:" + "H".repeat(5000))
  let peakRetained = buffer.retainedBytes
  const middle = Buffer.alloc(64 * 1024, 0x6d)
  const middleChunks = 400
  for (let i = 0; i < middleChunks; i += 1) {
    buffer.append(middle)
    if (buffer.retainedBytes > peakRetained) peakRetained = buffer.retainedBytes
  }
  buffer.append("Z".repeat(5000) + ":TAIL-MARKER")
  if (buffer.retainedBytes > peakRetained) peakRetained = buffer.retainedBytes

  const total = buffer.bytes
  assert.ok(total > 20 * 1024 * 1024, `total must be tens of MiB, got ${total}`)
  assert.equal(buffer.truncated, true)
  assert.ok(buffer.retainedBytes <= limit, `retained ${buffer.retainedBytes} must stay <= limit ${limit}`)
  assert.ok(peakRetained <= limit, `peak retained ${peakRetained} must stay <= limit ${limit}`)
  assert.equal(buffer.omittedBytes, total - headBytes - tailBytes)
  const rendered = buffer.text()
  assert.ok(rendered.startsWith("HEAD-MARKER:"), "head marker must survive")
  assert.ok(rendered.endsWith(":TAIL-MARKER"), "tail marker must survive")
  const marker = rendered.match(/\.\.\.\[omitted (\d+) bytes of output\]\.\.\./)
  assert.ok(marker, "omission marker must be present")
  assert.equal(Number(marker[1]), buffer.omittedBytes)
  assert.ok(
    Buffer.byteLength(rendered, "utf8") < limit + 4096,
    "rendered text must stay near the byte budget",
  )
})

// 16. unicode + copy-isolation: byte accounting stays exact at volume and
// trimmed slices are copies (mutating a giant original after append cannot
// change the retained head/tail).
test("V16.17.1 bounded buffer stays byte-accurate for multibyte streams", () => {
  const limit = 8 * 1024
  const buffer = createBoundedOutputBuffer(limit)
  buffer.append("HEAD-")
  const repeat = "đ".repeat(20000)
  buffer.append(Buffer.from(repeat, "utf8"))
  buffer.append(":TAIL-é")
  assert.equal(buffer.truncated, true)
  assert.equal(buffer.bytes, Buffer.byteLength("HEAD-" + repeat + ":TAIL-é", "utf8"))
  assert.ok(buffer.retainedBytes <= limit)
  assert.equal(buffer.omittedBytes, buffer.bytes - buffer.headBytes - buffer.tailBytes)
  const rendered = buffer.text()
  assert.ok(rendered.startsWith("HEAD-"), "head must survive multibyte truncation")
  assert.ok(rendered.endsWith(":TAIL-é") || rendered.endsWith("TAIL-é"), "tail must survive multibyte truncation")
  const marker = rendered.match(/\.\.\.\[omitted (\d+) bytes of output\]\.\.\./)
  assert.ok(marker)
  assert.equal(Number(marker[1]), buffer.omittedBytes)

  const giant = Buffer.alloc(1024 * 1024, 0x41)
  const copyBuffer = createBoundedOutputBuffer(limit)
  copyBuffer.append(giant)
  giant.fill(0x42)
  const copyRendered = copyBuffer.text()
  assert.ok(copyRendered.startsWith("A"), "retained head must be a copy, not a view onto the giant original")
  assert.ok(!copyRendered.startsWith("B"), "mutating the giant original must not change retained output")
  assert.ok(copyBuffer.retainedBytes <= limit)
})

// 17. production wiring: a real child emitting megabytes through
// runSupervisedProcess stays bounded via the same fixed owner.
test("V16.17.1 supervised process wiring stays bounded on multi-megabyte output", async () => {
  const code = "process.stdout.write('HEAD-WIRE:'.repeat(512));"
    + "for(let i=0;i<40;i++)process.stdout.write('m'.repeat(64*1024));"
    + "process.stdout.write(':TAIL-WIRE'.repeat(512))"
  const result = await runSupervisedProcess(NODE, ["-e", code], {
    hardTimeoutMs: 20_000,
    stdoutLimit: 8 * 1024,
  })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdoutTruncated, true)
  assert.ok(result.stdoutOmittedBytes > 0)
  assert.ok(result.stdout.startsWith("HEAD-WIRE:"), "wired head must be preserved")
  assert.ok(result.stdout.endsWith(":TAIL-WIRE"), "wired tail must be preserved")
  assert.ok(result.stdout.includes("[omitted "), "wired omission marker must be present")
  assert.ok(
    Buffer.byteLength(result.stdout, "utf8") < 8 * 1024 + 4096,
    "wired rendered text must stay near the byte budget",
  )
  const marker = String(result.stdout).match(/\.\.\.\[omitted (\d+) bytes of output\]\.\.\./)
  assert.ok(marker, "wired omission marker must carry the byte count")
  assert.equal(Number(marker[1]), result.stdoutOmittedBytes)
  assert.ok(result.stdoutBytes > 2 * 1024 * 1024, `wired total must be megabytes, got ${result.stdoutBytes}`)
})
