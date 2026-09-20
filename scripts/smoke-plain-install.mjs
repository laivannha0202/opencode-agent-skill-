import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"))
const packageName = packageJson.name

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
  return spawnSync("npm", args, { ...common, shell: process.platform === "win32" })
}

function requireSuccess(result, label) {
  if (result.status === 0) return
  throw new Error(
    label + " failed with exit code " + (result.status ?? "unknown") + "\n" +
    [result.stdout, result.stderr].filter(Boolean).join("\n"),
  )
}

const temp = await mkdtemp(path.join(os.tmpdir(), "ocskill-plain-install-"))
const packDir = path.join(temp, "pack")
const prefix = path.join(temp, "prefix")
const configDir = path.join(temp, "opencode")

try {
  await mkdir(packDir, { recursive: true })
  const pack = runNpm(["pack", "--pack-destination", packDir])
  requireSuccess(pack, "npm pack")
  const tarballs = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"))
  assert.equal(tarballs.length, 1)

  const npmVersionRun = runNpm(["--version"], { cwd: temp })
  requireSuccess(npmVersionRun, "npm --version")
  const npmVersion = npmVersionRun.stdout.trim()
  const npmMajor = Number.parseInt(npmVersion.split(".")[0], 10)

  // Intentionally mirrors the user's exact install shape: no --allow-scripts.
  const install = runNpm(["install", "-g", tarballs.map((name) => path.join(packDir, name))[0], "--prefix", prefix], {
    cwd: temp,
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir, UES_OPENCODE_MAJOR: "2" },
  })
  requireSuccess(install, "plain global install")

  const root = runNpm(["root", "-g", "--prefix", prefix], { cwd: temp })
  requireSuccess(root, "npm root -g")
  const packageDir = path.join(root.stdout.trim(), ...packageName.split("/"))
  assert.equal((await realpath(packageDir)).toLowerCase() === (await realpath(repoRoot)).toLowerCase(), false)

  const cli = path.join(packageDir, "bin", "ocskill.mjs")
  assert.ok(existsSync(cli), "plain install did not install the ocskill CLI")

  const stateFile = path.join(configDir, ".ues", "state.json")
  const autoSynced = existsSync(stateFile)
  assert.equal(
    autoSynced,
    true,
    "plain npm install installed the CLI but did not auto-sync OpenCode resources; one-command installation is not release-safe",
  )

  const state = JSON.parse(await readFile(stateFile, "utf8"))
  assert.equal(state.package, packageName)
  assert.ok(state.skills.length >= 39)
  assert.ok(state.commands.length >= 11)
  assert.ok(state.agents.length >= 10)

  console.log(
    "Plain npm install compatibility smoke passed for " + packageName + "@" + packageJson.version +
    ": npm " + npmVersion + ", lifecycle auto-sync=" + autoSynced +
    ", final resources=" + state.skills.length + "/" + state.commands.length + "/" + state.agents.length + ".",
  )

  if (Number.isFinite(npmMajor) && npmMajor >= 11) {
    console.warn("[smoke] npm 11+ completed the one-command install and resource auto-sync contract.")
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
