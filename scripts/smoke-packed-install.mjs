import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourcePackageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
const packageName = sourcePackageJson.name

function runNpm(args, options = {}) {
  const common = {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: "utf8",
  }

  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && existsSync(npmExecPath)) {
    return spawnSync(process.execPath, [npmExecPath, ...args], common)
  }

  return spawnSync("npm", args, {
    ...common,
    shell: process.platform === "win32",
  })
}

function requireSuccess(result, label) {
  if (result.status === 0) return
  const details = [result.stdout, result.stderr].filter(Boolean).join("\n")
  throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}\n${details}`)
}

const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-pack-smoke-"))
const packDir = path.join(temp, "pack")
const prefix = path.join(temp, "prefix")
const configDir = path.join(temp, "opencode")

try {
  await mkdir(packDir, { recursive: true })

  const pack = runNpm(["pack", "--pack-destination", packDir])
  requireSuccess(pack, "npm pack")

  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"))
  assert.equal(tarballs.length, 1, "expected exactly one packed tarball")
  const tarball = path.join(packDir, tarballs[0])

  const npmVersion = runNpm(["--version"], { cwd: temp })
  requireSuccess(npmVersion, "npm --version")
  const npmMajor = Number.parseInt(npmVersion.stdout.trim().split(".")[0], 10)
  const installArgs = ["install", "-g", tarball, "--prefix", prefix]
  if (Number.isFinite(npmMajor) && npmMajor >= 11) {
    installArgs.push(`--allow-scripts=${packageName}`)
  }

  const install = runNpm(installArgs, {
    cwd: temp,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir, UES_OPENCODE_MAJOR: "2" },
  })
  requireSuccess(install, "packed global install with automatic OpenCode sync")

  const root = runNpm(["root", "-g", "--prefix", prefix], { cwd: temp })
  requireSuccess(root, "npm root -g")
  const globalRoot = root.stdout.trim()
  assert.ok(globalRoot, "npm root -g returned an empty path")

  const packageDir = path.join(globalRoot, ...packageName.split("/"))
  const packedReal = await realpath(packageDir)
  const repoReal = await realpath(repoRoot)
  assert.notEqual(
    packedReal.toLowerCase(),
    repoReal.toLowerCase(),
    "packed global install unexpectedly points back to the source repository",
  )

  const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"))
  assert.equal(packageJson.name, packageName)

  const cli = path.join(packageDir, "bin", "ocskill.mjs")
  const env = { ...process.env, OPENCODE_CONFIG_DIR: configDir }

  const status = spawnSync(process.execPath, [cli, "status"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(status, "ocskill status from packed copy")

  const state = JSON.parse(
    await readFile(path.join(configDir, ".ues", "state.json"), "utf8"),
  )
  assert.equal(state.package, packageName)
  assert.equal(state.version, packageJson.version)
  assert.ok(state.skills.length >= 39)
  assert.ok(state.commands.length >= 11)
  assert.ok(state.agents.length >= 10)
  assert.equal(state.openCodeMajor, 2)
  assert.deepEqual(state.plugins, ["ues-router/index.js"])

  const routerPlugin = path.join(configDir, "plugins", "ues-router", "index.js")
  assert.ok(existsSync(routerPlugin), "v2 router plugin was not installed from packed package")
  assert.ok(existsSync(path.join(configDir, "plugins", "ues-router", "router.js")), "v2 router helper was not installed from packed package")
  assert.ok(existsSync(path.join(configDir, "plugins", "ues-router", "safety.js")), "v2 router safety gate was not installed from packed package")
  assert.ok(existsSync(path.join(configDir, "plugins", "ues-router", "capabilities.js")), "v7 router capability probe was not installed from packed package")
  const routerSource = await readFile(routerPlugin, "utf8")
  assert.match(routerSource, /name: "dispatch_task"/)
  assert.match(routerSource, /ctx\.session\.create/)
  assert.match(routerSource, /ctx\.session\.switchAgent/)
  assert.match(routerSource, /ctx\.session\.switchModel/)
  assert.match(routerSource, /name: "capabilities"/)
  assert.match(routerSource, /name: "task_policy"/)
  const reviewer = await readFile(path.join(configDir, "agents", "ues-reviewer.md"), "utf8")
  assert.match(reviewer, /permissions:/)
  assert.doesNotMatch(reviewer, /^permission:/m)

  for (const name of ["ues-codebase-mapper.md", "ues-plan-checker.md", "ues-executor.md", "ues-integration-verifier.md"]) {
    assert.ok(existsSync(path.join(configDir, "agents", name)), "missing packed V6 subagent " + name)
  }
  const executor = await readFile(path.join(configDir, "agents", "ues-executor.md"), "utf8")
  assert.match(executor, /permissions:/)
  assert.match(executor, /action: subagent/)
  assert.match(executor, /effect: deny/)
  assert.doesNotMatch(executor, /^permission:/m)

  const inspect = spawnSync(process.execPath, [cli, "inspect", temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(inspect, "ocskill inspect from packed copy")

  const planFile = path.join(temp, "PLAN.json")
  await writeFile(planFile, JSON.stringify({
    schemaVersion: 1,
    goal: "Packed V6 smoke",
    tasks: [{
      id: "T1",
      title: "Smoke",
      summary: "Validate packed task graph",
      files: { modify: ["README.md"] },
      dependsOn: [],
      acceptance: ["Task graph is valid"],
      verification: ["node --version"],
      risk: "low",
    }],
  }, null, 2) + "\n", "utf8")

  const graph = spawnSync(process.execPath, [cli, "task-graph", planFile], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(graph, "ocskill task-graph from packed copy")
  assert.match(graph.stdout, /"valid": true/)

  const workInit = spawnSync(process.execPath, [cli, "work", "init", "packed-smoke", temp, "--goal", "Packed V6 work smoke"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workInit, "ocskill work init from packed copy")

  const workPlan = spawnSync(process.execPath, [cli, "work", "plan", "packed-smoke", planFile, temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workPlan, "ocskill work plan from packed copy")

  const workStatusBeforeApproval = spawnSync(process.execPath, [cli, "work", "status", "packed-smoke", temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workStatusBeforeApproval, "ocskill work status before approval from packed copy")
  assert.match(workStatusBeforeApproval.stdout, /"status": "awaiting-plan-approval"/)
  assert.match(workStatusBeforeApproval.stdout, /"ready": \[\]/)

  const workStartBeforeApproval = spawnSync(process.execPath, [cli, "work", "start", "packed-smoke", "T1", temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  assert.notEqual(workStartBeforeApproval.status, 0)
  assert.match(workStartBeforeApproval.stderr, /plan is not approved/)

  const workApprove = spawnSync(process.execPath, [cli, "work", "approve-plan", "packed-smoke", temp, "--evidence", "packed plan checker PASS"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workApprove, "ocskill work approve-plan from packed copy")

  const workStatus = spawnSync(process.execPath, [cli, "work", "status", "packed-smoke", temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workStatus, "ocskill work status after approval from packed copy")
  assert.match(workStatus.stdout, /"T1"/)

  const workStart = spawnSync(process.execPath, [cli, "work", "start", "packed-smoke", "T1", temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workStart, "ocskill work start from packed copy")
  const started = JSON.parse(workStart.stdout)
  assert.ok(started.record.runId)

  const heartbeat = spawnSync(process.execPath, [cli, "work", "heartbeat", "packed-smoke", "T1", temp, "--run-id", started.record.runId], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(heartbeat, "ocskill work heartbeat from packed copy")

  const verifyCommand = spawnSync(process.execPath, [
    cli, "work", "verify-command", "packed-smoke", "T1", temp,
    "--run-id", started.record.runId,
    "--", process.execPath, "--version",
  ], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(verifyCommand, "ocskill work verify-command from packed copy")
  assert.match(verifyCommand.stdout, /"passed": true/)

  const workComplete = spawnSync(process.execPath, [
    cli, "work", "complete", "packed-smoke", "T1", temp,
    "--evidence", "node --version => PASS",
    "--run-id", started.record.runId,
  ], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workComplete, "ocskill work complete from packed copy")
  assert.match(workComplete.stdout, /"evidenceStrength": "receipt-backed"/)

  const finalizeBeforeVerify = spawnSync(process.execPath, [cli, "work", "finalize", "packed-smoke", temp, "--evidence", "should fail"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  assert.notEqual(finalizeBeforeVerify.status, 0)
  assert.match(finalizeBeforeVerify.stderr, /recorded integration PASS/)

  const workVerify = spawnSync(process.execPath, [cli, "work", "verify-integration", "packed-smoke", temp, "--verdict", "PASS", "--evidence", "packed integration PASS"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workVerify, "ocskill work verify-integration from packed copy")

  const workFinalize = spawnSync(process.execPath, [cli, "work", "finalize", "packed-smoke", temp, "--evidence", "packed final acceptance PASS"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(workFinalize, "ocskill work finalize from packed copy")
  assert.match(workFinalize.stdout, /"status": "completed"/)

  const adaptivePolicy = spawnSync(process.execPath, [
    cli, "task-policy",
    "Refactor the entire repository authentication schema migration and public API contracts",
  ], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(adaptivePolicy, "ocskill task-policy from packed copy")
  assert.match(adaptivePolicy.stdout, /"mode": "long-horizon"/)
  assert.match(adaptivePolicy.stdout, /"modelTier": "heavy"/)

  const dashboard = spawnSync(process.execPath, [cli, "dashboard", temp], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(dashboard, "ocskill dashboard from packed copy")
  assert.ok(existsSync(path.join(temp, ".ues-dashboard", "index.html")))

  const hermes = spawnSync(process.execPath, [cli, "hermes", "status"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(hermes, "ocskill hermes status from packed copy")
  assert.match(hermes.stdout, /"available":/)

  const modelStatus = spawnSync(process.execPath, [cli, "models", "status"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(modelStatus, "ocskill models status from packed copy")
  assert.match(modelStatus.stdout, /"enabled": false/)

  const modelSet = spawnSync(process.execPath, [cli, "models", "set", "standard", "provider/mid"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(modelSet, "ocskill models set from packed copy")

  const modelPolicy = spawnSync(process.execPath, [cli, "model-policy", "executor", "--attempt", "1"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(modelPolicy, "ocskill model-policy from packed copy")
  assert.match(modelPolicy.stdout, /"model": "provider\/mid"/)

  console.log(
    `One-command packed install smoke passed for ${packageName}@${packageJson.version}: ` +
      `${state.skills.length} skills, ${state.commands.length} commands, ${state.agents.length} subagents, ${state.plugins.length} v2 router plugin.`,
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
