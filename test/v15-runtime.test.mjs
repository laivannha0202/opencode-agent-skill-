import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { defaultCapabilityRegistry } from "../lib/capability-fabric.mjs"
import { turboFastPathDecision, turboFastTimeoutBudget } from "../lib/turbo-fast-path.mjs"
import { classifyEngineeringTask, shouldRunDedicatedDiagnosis } from "../lib/task-policy.mjs"
import { looksLikePiCliEntrypoint, resolvePiChildInvocation } from "../lib/pi-child-invocation.mjs"
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

test("V15.4 ACP host never reuses an ACP entrypoint as the Pi child", () => {
  assert.equal(looksLikePiCliEntrypoint("C:/tools/pi-acp/dist/index.js"), false)
  assert.equal(
    looksLikePiCliEntrypoint("C:/Users/Admin/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    true,
  )

  const args = ["--mode", "rpc"]
  const acp = resolvePiChildInvocation(args, {
    currentScript: "C:/tools/pi-acp/dist/index.js",
    execPath: "C:/Program Files/nodejs/node.exe",
    platform: "win32",
    existsSync: () => true,
    managedPi: {
      executable: "C:/Program Files/nodejs/node.exe",
      argsPrefix: ["C:/Users/Admin/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"],
    },
    pathPi: null,
  })
  assert.equal(acp.source, "managed-pi")
  assert.match(acp.args[0], /pi-coding-agent/)
  assert.deepEqual(acp.args.slice(-2), ["--mode", "rpc"])

  const terminal = resolvePiChildInvocation(args, {
    currentScript: "C:/Users/Admin/.pi/agent/install/releases/0.87.1/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    execPath: "C:/Program Files/nodejs/node.exe",
    platform: "win32",
    existsSync: () => true,
    managedPi: null,
    pathPi: null,
  })
  assert.equal(terminal.source, "host-pi-cli")
  assert.match(terminal.args[0], /pi-coding-agent/)
})

test("V15.3 DEEP planning skips redundant diagnosis without concrete failure evidence", () => {
  const generic = classifyEngineeringTask(
    "Fix all remaining issues across the entire project, preserve behavior, run integration verification, and ensure no regressions.",
  )
  assert.equal(generic.mode, "long-horizon")
  assert.equal(generic.diagnosisEvidence, false)
  assert.equal(shouldRunDedicatedDiagnosis(generic, 1), false)

  const failing = classifyEngineeringTask(
    "Fix the entire project checkout flow. The failure affects several callers and the failing test reports AssertionError: expected paid but actual pending.",
  )
  assert.equal(failing.mode, "long-horizon")
  assert.equal(failing.diagnosisEvidence, true)
  assert.equal(shouldRunDedicatedDiagnosis(failing, 1), true)
})

test("V15.2 quick discount benchmark remains FAST and Turbo-eligible", () => {
  const prompt =
    "Fix calculateDiscount(price, percent) in src/discount.mjs. Percent is 0..100, so 20 means a 20% discount. Reject non-finite/non-number price or percent with TypeError and percent outside 0..100 with RangeError. Preserve the export and do not weaken the requested semantics."
  const policy = classifyEngineeringTask(prompt)
  assert.equal(policy.executionProfile, "fast")
  assert.equal(policy.singleFileBounded, true)
  assert.equal(policy.risk, "low")
  assert.equal(policy.requireIntegrationVerification, false)

  const decision = turboFastPathDecision(policy, {
    role: "executor",
    attempt: 1,
    browserRequested: false,
    visualRequired: false,
  })
  assert.equal(decision.eligible, true)
})

test("V15.2 Turbo Fast Path is fail-closed and bounded", () => {
  const fastPolicy = {
    executionProfile: "fast",
    singleFileBounded: true,
    risk: "low",
    requireIntegrationVerification: false,
  }
  const eligible = turboFastPathDecision(fastPolicy, {
    role: "executor",
    attempt: 1,
    browserRequested: false,
    visualRequired: false,
  })
  assert.equal(eligible.eligible, true)
  assert.equal(eligible.deterministicFirst, true)
  assert.equal(eligible.verifierOnDemand, true)
  assert.equal(eligible.failClosed, true)
  assert.equal(eligible.maxModelLanes, 1)

  assert.equal(turboFastPathDecision(fastPolicy, { role: "executor", attempt: 2 }).eligible, false)
  assert.equal(turboFastPathDecision({ ...fastPolicy, risk: "high" }, { role: "executor", attempt: 1 }).eligible, false)
  assert.equal(turboFastPathDecision({ ...fastPolicy, requireIntegrationVerification: true }, { role: "executor", attempt: 1 }).eligible, false)
  assert.equal(turboFastPathDecision(fastPolicy, { role: "executor", attempt: 1, browserRequested: true }).eligible, false)

  const budget = turboFastTimeoutBudget()
  assert.equal(budget.hardTimeoutMs, 180_000)
  assert.equal(budget.idleTimeoutMs, 60_000)
  assert.equal(budget.postToolErrorIdleTimeoutMs, 30_000)
  assert.equal(budget.verificationTimeoutSec, 90)
})

test("V15 capability fabric exposes managed background services", () => {
  const registry = defaultCapabilityRegistry(root)
  const providers = registry.capabilities?.["runtime.service"] || []
  assert.equal(providers[0]?.id, "ues-managed-service")
  assert.equal(providers[0]?.metadata?.shellFree, true)
  assert.equal(providers[0]?.metadata?.boundedLifetime, true)
})

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
    assert.equal(started.lifetimeMs, 30 * 60_000)
    assert.equal(started.idleTimeoutMs, 0)
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
  const fingerprint = await readFile(path.join(root, "lib", "workspace-fingerprint.mjs"), "utf8")
  const artifacts = await readFile(path.join(root, "lib", "runtime-artifacts.mjs"), "utf8")
  assert.match(fingerprint, /UES_RUNTIME_DIRS/)
  assert.match(fingerprint, /runtime-artifacts\.mjs/)
  assert.match(artifacts, /\.ues-services/)

  for (const file of [
    ".gitignore",
    "lib/semantic-index.mjs",
    "lib/repo-graph.mjs",
    "lib/affected-tests.mjs",
    "lib/repo-inspect.mjs",
  ]) {
    const source = await readFile(path.join(root, file), "utf8")
    assert.match(source, /\.ues-services/)
  }
})

test("V15 deterministic controller admission and service tool are wired into Pi", async () => {
  const parent = await readFile(path.join(root, "pi", "extensions", "ues.ts"), "utf8")
  const child = await readFile(path.join(root, "pi", "extensions", "ues-child-runtime.ts"), "utf8")
  const evalPi = await readFile(path.join(root, "scripts", "eval-pi.mjs"), "utf8")
  const rpcPool = await readFile(path.join(root, "lib", "pi-rpc-pool.mjs"), "utf8")
  const architectPrompt = await readFile(path.join(root, "global-config", "agents", "architect.md"), "utf8")

  assert.match(parent, /pi\.registerCommand\("ues-status"/)
  assert.match(parent, /pi\.registerCommand\("ues-run"/)
  assert.match(parent, /PACKAGE_VERSION/)
  assert.match(parent, /const uesExecuteTool: any = \{/)
  assert.match(parent, /ues_controller_direct/)
  assert.match(parent, /ues_controller_progress/)
  assert.match(parent, /process\.stderr\.write/)
  assert.match(parent, /taskPolicyOverride \|\| classifyEngineeringTask/)
  assert.match(parent, /traceID,\s*policy,\s*\);/)
  assert.match(parent, /turboFastPathDecision/)
  assert.match(parent, /normalizePlanForValidation/)
  assert.match(parent, /deepExplorationContract/)
  assert.match(parent, /resolvePiChildInvocation/)
  assert.match(parent, /leafTaskPolicy/)
  assert.match(parent, /failureDelta/)
  assert.match(parent, /contextCacheNamespace/)
  assert.match(parent, /UES Per-Leaf Turbo/)
  assert.match(parent, /rootPolicy: policy/)
  assert.match(parent, /planningRuntimeBudget/)
  assert.match(parent, /shouldSoftSteerArchitect/)
  assert.match(parent, /planning fast-stop/)
  assert.match(parent, /pruneOrphanTaskSandboxes/)
  assert.match(parent, /bounded fast-planning recovery/)
  assert.match(parent, /ACTIVE_TASK_SANDBOXES/)
  assert.match(parent, /cleanupTraceSandboxes/)
  assert.match(parent, /registerCommand\("ues-clean"/)
  assert.match(parent, /legacyMinAgeMs: 30 \* 60_000/)
  assert.match(parent, /reclaimOwnerPid: process.pid/)
  assert.match(parent, /shouldSoftSteerPlanningRole/)
  assert.match(parent, /planCheckTransportFailure/)
  assert.match(parent, /plan-verification-recovery/)
  assert.match(parent, /plan-checker budget reached/)
  assert.match(parent, /sourceFacingPaths/)
  assert.match(parent, /sourceGitPathspecs/)
  assert.match(parent, /changed real source files outside declared write scope/)
  assert.match(parent, /Do not silently broaden scope/)
  assert.match(parent, /failureByTask\.set\(String\(item\.task\.id\)/)
  assert.match(parent, /git", \["diff", "--name-only", base, "--", \.\.\.pathspecs\]/)
  assert.match(parent, /UES DEEP bounded exploration/)
  assert.match(parent, /Do not inventory the repository/)
  assert.match(parent, /DEEP efficiency rule/)
  assert.match(parent, /STRICT JSON CONTRACT/)
  assert.match(parent, /extractValidatedPlan/)
  assert.match(parent, /absoluteHardTimeoutMs/)
  assert.match(parent, /activityExtensionMs/)
  assert.match(parent, /UES planning salvage/)
  assert.match(parent, /first substantive output/)
  assert.match(parent, /partialOutput/)
  assert.match(rpcPool, /createAdaptiveDeadline/)
  assert.match(rpcPool, /absoluteHardTimeoutMs/)
  assert.match(rpcPool, /partialAssistantMessage/)
  assert.match(rpcPool, /rich timeout error before transport teardown/)
  assert.match(architectPrompt, /machine-first planning mode/)
  assert.match(architectPrompt, /before the prose sections/)
  assert.match(parent, /riskNotes/)
  assert.match(parent, /TURBO_FAST_TIMEOUTS/)
  assert.match(parent, /"ues_service"/)
  assert.match(parent, /lifetimeMs:\s*Type\.Optional/)
  assert.match(parent, /idleTimeoutMs:\s*Type\.Optional/)
  assert.match(parent, /Never launch a persistent dev server\/watcher in foreground/)
  assert.match(child, /name:\s*"ues_service"/)
  assert.match(child, /lifetimeMs:\s*Type\.Optional/)
  assert.match(child, /idleTimeoutMs:\s*Type\.Optional/)
  assert.match(child, /looksLikeLongRunningServiceCommand/)
  assert.match(child, /Use the ues_service tool/)
  assert.match(child, /stopAllServices\(ctx\.cwd\)/)
  assert.match(evalPi, /prompt = "\/ues-run " \+ task\.prompt/)
  assert.match(evalPi, /UES_EVAL_DIRECT_TELEMETRY/)
  assert.match(evalPi, /event\.type === "ues_controller_direct"/)
  assert.match(evalPi, /controller progress/)
  assert.match(evalPi, /agentRun\.stdout, agentRun\.stderr/)
  assert.match(evalPi, /onStderr: \(chunk\) => consumeControllerProgress/)
  assert.match(evalPi, /controllerValid=/)
})
