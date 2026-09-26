import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import {
  looksLikeLongRunningServiceCommand,
  serviceLogs,
  serviceStatus,
  startService,
  stopAllServices,
  stopService,
} from "../lib/service-manager.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "ues-v15-service-"))
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  if (!port) throw new Error("failed to allocate test port")
  return port
}

test("V15 foreground-service classifier catches common blocking server commands", () => {
  for (const command of [
    "npm run dev",
    "pnpm start:dev",
    "node apps/api/dist/main.js",
    "nest start --watch",
    "next dev",
    "vite",
    "python -m http.server 8000",
    "uvicorn app:app",
    "dotnet run",
    "docker compose up",
  ]) {
    assert.equal(looksLikeLongRunningServiceCommand(command), true, command)
  }

  for (const command of [
    "npm test",
    "node --test",
    "node scripts/check.mjs",
    "git status",
    "docker compose up -d",
  ]) {
    assert.equal(looksLikeLongRunningServiceCommand(command), false, command)
  }
})

test("V15 managed service starts, proves readiness, captures evidence and stops", async () => {
  const workspace = await tempDir()
  const port = await freePort()
  try {
    const script = [
      "const http=require('node:http');",
      `const s=http.createServer((_req,res)=>res.end('ok'));`,
      `s.listen(${port},'127.0.0.1',()=>console.log('SERVICE_READY'));`,
      "setInterval(()=>{},1000);",
    ].join("")

    const started = await startService(workspace, {
      name: "demo-api",
      command: process.execPath,
      args: ["-e", script],
      readyPort: port,
      readyHost: "127.0.0.1",
      readyLog: "SERVICE_READY",
      timeoutMs: 5000,
    })

    assert.equal(started.ready, true, JSON.stringify(started))
    assert.equal(started.alive, true)
    assert.ok(Number(started.pid) > 0)
    assert.match(String(started.evidenceRef || ""), /^evidence:sha256:/)

    const status = await serviceStatus(workspace, "demo-api")
    assert.equal(status.alive, true)
    assert.equal(status.ready, true)

    const logs = await serviceLogs(workspace, "demo-api", { evidence: true })
    assert.match(logs.content, /SERVICE_READY/)
    assert.match(String(logs.evidenceRef || ""), /^evidence:sha256:/)

    const stopped = await stopService(workspace, "demo-api")
    assert.equal(stopped.stopped, true, JSON.stringify(stopped))

    const after = await serviceStatus(workspace, "demo-api")
    assert.equal(after.alive, false)
  } finally {
    await stopAllServices(workspace).catch(() => [])
    await rm(workspace, { recursive: true, force: true })
  }
})

test("V15 service runtime state is excluded from source-facing scans", async () => {
  for (const file of [
    ".gitignore",
    "lib/workspace-fingerprint.mjs",
    "lib/semantic-index.mjs",
    "lib/repo-graph.mjs",
    "lib/affected-tests.mjs",
  ]) {
    const source = await readFile(path.join(root, file), "utf8")
    assert.match(source, /\.ues-services/)
  }
})

test("V15 deterministic controller admission and service tool are wired into Pi", async () => {
  const parent = await readFile(path.join(root, "pi", "extensions", "ues.ts"), "utf8")
  const child = await readFile(path.join(root, "pi", "extensions", "ues-child-runtime.ts"), "utf8")
  const evalPi = await readFile(path.join(root, "scripts", "eval-pi.mjs"), "utf8")

  assert.match(parent, /pi\.registerCommand\("ues-run"/)
  assert.match(parent, /const uesExecuteTool: any = \{/)
  assert.match(parent, /ues_controller_direct/)
  assert.match(parent, /"ues_service"/)
  assert.match(parent, /Never launch a persistent dev server\/watcher in foreground/)
  assert.match(child, /name:\s*"ues_service"/)
  assert.match(child, /looksLikeLongRunningServiceCommand/)
  assert.match(child, /Use the ues_service tool/)
  assert.match(child, /stopAllServices\(ctx\.cwd\)/)
  assert.match(evalPi, /prompt = "\/ues-run " \+ task\.prompt/)
  assert.match(evalPi, /UES_EVAL_DIRECT_TELEMETRY/)
  assert.match(evalPi, /event\.type === "ues_controller_direct"/)
})
