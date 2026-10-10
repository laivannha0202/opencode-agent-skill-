// V16.17.1 P0/P1 service-lifecycle regressions (§38 items 15-23).
//
// Every test runs the REAL production owner (lib/service-manager.mjs) with
// real OS processes on this machine: real readiness, real async log writer,
// real bounded shutdown. No test passes by raising a timeout.

import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  startService,
  waitForService,
  serviceStatus,
  serviceLogs,
  stopService,
  stopAllServices,
} from "../lib/service-manager.mjs"

const NODE = process.execPath

async function workspace(tag) {
  return mkdtemp(path.join(os.tmpdir(), `ues-svc-${tag}-${process.pid}-`))
}

async function cleanup(root) {
  await stopAllServices(root).catch(() => {})
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// 15. background-service-readiness-port: a real TCP server reaches readiness
// while start() returns control instead of occupying the foreground.
test("V16.17.1 background service reaches port readiness and frees the foreground", async () => {
  const root = await workspace("port")
  try {
    const { default: net } = await import("node:net")
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once("error", reject)
      probe.listen(0, "127.0.0.1", () => {
        const found = probe.address().port
        probe.close(() => resolve(found))
      })
    })
    const serverCode = `require('node:http').createServer((q,r)=>r.end('ok'))`
      + `.listen(${port},'127.0.0.1',()=>console.log('LISTEN'));setInterval(()=>{},1000)`
    const started = Date.now()
    const handle = await startService(root, {
      name: "web",
      command: NODE,
      args: ["-e", serverCode],
      readyPort: port,
      timeoutMs: 15_000,
    })
    const elapsed = Date.now() - started
    assert.equal(handle.ready, true)
    assert.equal(handle.status, "running")
    assert.ok(elapsed < 15_000, "readiness must resolve bounded")
    const stopped = await stopService(root, "web")
    assert.equal(stopped.stopped, true)
    assert.equal(stopped.status, "stopped")
  } finally {
    await cleanup(root)
  }
})

// 16. background-service-readiness-log: a log line drives readiness.
test("V16.17.1 background service reaches log readiness", async () => {
  const root = await workspace("log")
  try {
    const handle = await startService(root, {
      name: "worker",
      command: NODE,
      args: ["-e", "setTimeout(()=>console.log('SERVER READY on 3000'),300);setInterval(()=>{},1000)"],
      readyLog: "SERVER READY",
      timeoutMs: 15_000,
    })
    assert.equal(handle.ready, true)
    assert.equal(handle.status, "running")
    const status = await serviceStatus(root, "worker")
    assert.equal(status.ready, true)
  } finally {
    await cleanup(root)
  }
})

// 17. chatty-service: dense output never blocks the event loop (async writer).
test("V16.17.1 chatty service keeps the event loop responsive", async () => {
  const root = await workspace("chatty")
  try {
    await startService(root, {
      name: "chatty",
      command: NODE,
      args: ["-e", "let i=0;const t=setInterval(()=>{console.log('line-'+(i++));if(i>=3000)clearInterval(t)},1);setInterval(()=>{},1000)"],
      waitReady: false,
    })
    // Probe event-loop lag while 3000 chunks arrive: a synchronous per-chunk
    // disk write would stall the loop for hundreds of ms on Windows+Defender.
    let maxGap = 0
    let last = Date.now()
    const probe = setInterval(() => {
      const now = Date.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 25)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    clearInterval(probe)
    assert.ok(maxGap < 1000, `event loop stalled ${maxGap}ms under chatty output; writer must be async`)
    const status = await serviceStatus(root, "chatty")
    assert.equal(status.status, "running")
    assert.ok(status.logBytes > 0, "async writer must still persist the log")
  } finally {
    await cleanup(root)
  }
})

// 18. service-readiness-memory-tail: active readiness survives disk log loss.
test("V16.17.1 active readiness is served from the memory tail, not disk", async () => {
  const root = await workspace("tail")
  try {
    await startService(root, {
      name: "tailed",
      command: NODE,
      args: ["-e", "console.log('TAIL-READY-MARKER');setInterval(()=>{},1000)"],
      readyLog: "TAIL-READY-MARKER",
      timeoutMs: 15_000,
    })
    // Destroy the on-disk evidence: a disk-polling readiness would now fail.
    const logFile = path.join(root, ".ues-services", "tailed.log")
    await writeFile(logFile, "", "utf8")
    const again = await waitForService(root, "tailed", { timeoutMs: 5000 })
    assert.equal(again.ready, true, "readiness must come from the memory tail when disk is gone")
  } finally {
    await cleanup(root)
  }
})

// 19. service-stop: a running service stops boundedly and honestly.
test("V16.17.1 service stop is bounded and honest", async () => {
  const root = await workspace("stop")
  try {
    const handle = await startService(root, {
      name: "sleeper",
      command: NODE,
      args: ["-e", "setInterval(()=>{},1000)"],
      waitReady: false,
    })
    const pid = handle.pid
    assert.ok(pid > 0)
    const started = Date.now()
    const result = await stopService(root, "sleeper", { timeoutMs: 10_000 })
    const elapsed = Date.now() - started
    assert.equal(result.stopped, true)
    assert.equal(result.status, "stopped")
    assert.ok(elapsed < 15_000, `stop took ${elapsed}ms; must stay bounded`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(!alive(pid), "stopped service process must be reaped")
  } finally {
    await cleanup(root)
  }
})

// 20. service-stop-timeout: an unkillable stop is bounded, honest, and keeps
// ownership (never reports stopped=true for a living process).
test("V16.17.1 service stop-timeout stays bounded and keeps ownership", async () => {
  const root = await workspace("stoptimeout")
  try {
    const handle = await startService(root, {
      name: "stubborn",
      command: NODE,
      args: ["-e", "setInterval(()=>{},1000)"],
      waitReady: false,
    })
    const pid = handle.pid
    // A kill helper that never kills: proves the bounded wait, the honest
    // stop-timeout state, and retained ownership without an OS zombie.
    const neverKills = () => new Promise(() => {})
    const started = Date.now()
    const result = await stopService(root, "stubborn", { timeoutMs: 300, terminateImpl: neverKills })
    const elapsed = Date.now() - started
    assert.equal(result.stopped, false)
    assert.equal(result.reason, "stop-timeout")
    assert.equal(result.status, "stop-timeout")
    assert.ok(elapsed < 5000, `stop-timeout path took ${elapsed}ms; must stay bounded`)
    const status = await serviceStatus(root, "stubborn")
    assert.ok(["stopping", "stop-timeout"].includes(status.status), "ownership of the living process must be kept")
    assert.ok(alive(pid), "test setup requires the process to still live")
    const real = await stopService(root, "stubborn", { timeoutMs: 10_000 })
    assert.equal(real.stopped, true)
  } finally {
    await cleanup(root)
  }
})

// 21. stop-all-services: every owned service stops.
test("V16.17.1 stop-all-services stops every owned service", async () => {
  const root = await workspace("stopall")
  try {
    await startService(root, { name: "a", command: NODE, args: ["-e", "setInterval(()=>{},1000)"], waitReady: false })
    await startService(root, { name: "b", command: NODE, args: ["-e", "setInterval(()=>{},1000)"], waitReady: false })
    const results = await stopAllServices(root)
    assert.equal(results.length, 2)
    assert.ok(results.every((row) => row.stopped === true), "every owned service must stop")
  } finally {
    await cleanup(root)
  }
})

// 22. historical-service-metadata: dead history is never presented as alive.
test("V16.17.1 historical service metadata is never presented as alive", async () => {
  const root = await workspace("history")
  try {
    await startService(root, {
      name: "gone",
      command: NODE,
      args: ["-e", "setTimeout(()=>{},200)"],
      waitReady: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    await stopService(root, "gone").catch(() => {})
    const status = await serviceStatus(root, "gone")
    assert.equal(status.alive, false)
    assert.equal(status.ready, false)
    assert.ok(["not-owned", "not-found"].includes(status.status), `unexpected status ${status.status}`)
    if (status.status === "not-owned") {
      assert.equal(status.reason, "historical-service-metadata-only")
    }
  } finally {
    await cleanup(root)
  }
})

// 23. orphan-ownership: a stale pid in metadata is never blindly killed.
test("V16.17.1 stale metadata pid is reported, never blindly killed", async () => {
  const root = await workspace("orphan")
  let sentinel = null
  try {
    // A live process WE own: if the manager ever killed pids from metadata,
    // this is what would die. It must survive.
    const { spawn } = await import("node:child_process")
    sentinel = spawn(NODE, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true })
    const sentinelPid = sentinel.pid
    assert.ok(alive(sentinelPid))
    // Forge stale metadata pointing at the live sentinel pid.
    const dir = path.join(root, ".ues-services")
    await (await import("node:fs/promises")).mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "stale.json"), JSON.stringify({
      schemaVersion: 1,
      name: "stale",
      pid: sentinelPid,
      status: "running",
      command: NODE,
    }), "utf8")
    const status = await serviceStatus(root, "stale")
    assert.equal(status.alive, false, "historical metadata must never present a process as alive")
    assert.equal(status.status, "not-owned")
    assert.ok(alive(sentinelPid), "a pid read from metadata must never be killed without ownership proof")
    // Unknown services stop with an honest reason and spawn no kill.
    const stop = await stopService(root, "never-existed")
    assert.equal(stop.stopped, false)
    assert.equal(stop.reason, "service-not-active-in-this-runtime")
    assert.ok(alive(sentinelPid))
  } finally {
    try { sentinel?.kill("SIGKILL") } catch {}
    await cleanup(root)
  }
})

// Log writer honesty: drops under pressure are counted, never silent.
test("V16.17.1 service log pressure degrades bounded with honest counters", async () => {
  const root = await workspace("pressure")
  try {
    const handle = await startService(root, {
      name: "flood",
      command: NODE,
      args: ["-e", "for(let i=0;i<200;i++)console.log('F'.repeat(32768))"],
      waitReady: false,
      logLimitBytes: 128 * 1024,
    })
    void handle
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const status = await serviceStatus(root, "flood")
    assert.equal(status.logTruncated, true)
    assert.ok(status.logBytes <= 128 * 1024, `logBytes ${status.logBytes} exceeds the cap`)
    const onDisk = existsSync(path.join(root, ".ues-services", "flood.log"))
    assert.equal(onDisk, true)
  } finally {
    await cleanup(root)
  }
})
