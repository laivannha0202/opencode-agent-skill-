import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const packageName = "@laivannha0202/opencode-agent-skill"

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

  const install = runNpm(
    ["install", "-g", tarball, "--ignore-scripts", "--prefix", prefix],
    {
      cwd: temp,
      env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    },
  )
  requireSuccess(install, "packed global install")

  const root = runNpm(["root", "-g", "--prefix", prefix], { cwd: temp })
  requireSuccess(root, "npm root -g")
  const globalRoot = root.stdout.trim()
  assert.ok(globalRoot, "npm root -g returned an empty path")

  const packageDir = path.join(globalRoot, "@laivannha0202", "opencode-agent-skill")
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

  const sync = spawnSync(process.execPath, [cli, "install"], {
    cwd: temp,
    env,
    encoding: "utf8",
  })
  requireSuccess(sync, "ocskill install from packed copy")

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
  assert.ok(state.commands.length >= 9)
  assert.ok(state.agents.length >= 6)

  console.log(
    `Packed install smoke passed for ${packageName}@${packageJson.version}: ` +
      `${state.skills.length} skills, ${state.commands.length} commands, ${state.agents.length} subagents.`,
  )
} finally {
  await rm(temp, { recursive: true, force: true })
}
