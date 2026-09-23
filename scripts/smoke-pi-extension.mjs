import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { pathToFileURL, fileURLToPath } from "node:url"
import { resolveWindowsCommand } from "../lib/windows-shim.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const extensionPath = path.join(root, "pi", "extensions", "ues.ts")
const skillsPath = path.join(root, "global-config", "skills")
const promptsPath = path.join(root, "pi", "prompts")
const agentDir = path.join(root, ".tmp-pi-agent")
const PI_SMOKE_VERSION = process.env.UES_PI_SMOKE_VERSION || "0.87.1"
const TYPEBOX_SMOKE_VERSION = process.env.UES_TYPEBOX_SMOKE_VERSION || "1.3.27"

function run(executable, args, options = {}) {
  if (process.platform !== "win32") return spawnSync(executable, args, options)
  const resolved = resolveWindowsCommand(executable)
  if (!resolved) return { status: 127, stdout: "", stderr: "Unable to resolve command: " + executable }
  return spawnSync(resolved.executable, [...resolved.argsPrefix, ...args], options)
}

async function importSdkFromDir(nodeModulesRoot) {
  const entry = path.join(
    nodeModulesRoot,
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "index.js",
  )
  if (!existsSync(entry)) return null
  return import(pathToFileURL(entry).href)
}

async function loadPiSdk() {
  try {
    return {
      sdk: await import("@earendil-works/pi-coding-agent"),
      source: "local-node-modules",
      tempDir: null,
    }
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
  }

  const globalRoot = run("npm", ["root", "-g"], { encoding: "utf8" })
  if (globalRoot.status === 0) {
    const sdk = await importSdkFromDir(String(globalRoot.stdout || "").trim())
    if (sdk) return { sdk, source: "global-npm", tempDir: null }
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ues-pi-smoke-host-"))
  const installed = run(
    "npm",
    [
      "install",
      "--prefix", tempDir,
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      `@earendil-works/pi-coding-agent@${PI_SMOKE_VERSION}`,
      `typebox@${TYPEBOX_SMOKE_VERSION}`,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    },
  )

  if (installed.status !== 0) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw new Error(
      "Unable to provision Pi SDK for smoke test:\n" +
      String(installed.stderr || installed.stdout || "npm install failed"),
    )
  }

  const sdk = await importSdkFromDir(path.join(tempDir, "node_modules"))
  if (!sdk) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
    throw new Error("Provisioned Pi SDK is missing dist/index.js")
  }
  return { sdk, source: "isolated-temp-install", tempDir }
}

const loaded = await loadPiSdk()
const { DefaultResourceLoader } = loaded.sdk

try {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    additionalExtensionPaths: [extensionPath],
    additionalSkillPaths: [skillsPath],
    additionalPromptTemplatePaths: [promptsPath],
  })

  await loader.reload()
  const result = loader.getExtensions()

  assert.equal(
    result.errors.length,
    0,
    result.errors.map((entry) => `${entry.path}: ${entry.error}`).join("\n"),
  )
  assert.ok(result.extensions.length >= 1, "Pi did not load the UES extension")

  const skillResult = loader.getSkills()
  assert.equal(
    skillResult.diagnostics.length,
    0,
    skillResult.diagnostics.map((entry) => `${entry.path || entry.filePath || "skill"}: ${entry.message || entry.error || JSON.stringify(entry)}`).join("\n"),
  )
  assert.ok(skillResult.skills.length >= 40, "Pi did not load the bundled UES skills")

  const promptResult = loader.getPrompts()
  assert.equal(
    promptResult.diagnostics.length,
    0,
    promptResult.diagnostics.map((entry) => `${entry.path || entry.filePath || "prompt"}: ${entry.message || entry.error || JSON.stringify(entry)}`).join("\n"),
  )
  assert.ok(promptResult.prompts.length >= 11, "Pi did not load the bundled UES prompts")

  console.log(
    `Pi package smoke passed via ${loaded.source}: ${result.extensions.length} extension(s), ${skillResult.skills.length} skill(s), ${promptResult.prompts.length} prompt(s) loaded`,
  )
} finally {
  if (loaded.tempDir) {
    await rm(loaded.tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
