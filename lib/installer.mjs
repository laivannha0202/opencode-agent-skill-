import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const PACKAGE_NAME = "@laivannha0202/opencode-agent-skill"
export const SKILL_PREFIX = "ues-"
export const MANAGED_MARKER = "<!-- managed-by: @laivannha0202/opencode-agent-skill -->"
export const AGENTS_BEGIN = "<!-- BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM -->"
export const AGENTS_END = "<!-- END OCSKILL UNIVERSAL ENGINEERING SYSTEM -->"

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url))

export function getConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR
    ? path.resolve(process.env.OPENCODE_CONFIG_DIR)
    : path.join(os.homedir(), ".config", "opencode")
}

async function readText(file, fallback = "") {
  try {
    return await readFile(file, "utf8")
  } catch (error) {
    if (error && error.code === "ENOENT") return fallback
    throw error
  }
}

async function packageVersion() {
  const json = JSON.parse(await readFile(path.join(PACKAGE_ROOT, "package.json"), "utf8"))
  return json.version
}

function installSkillName(source, name) {
  const next = source.replace(
    /^name:\s*[^\r\n]+/m,
    `name: ${SKILL_PREFIX}${name}`,
  )
  return next.includes(MANAGED_MARKER)
    ? next
    : `${next.trimEnd()}\n\n${MANAGED_MARKER}\n`
}

function removeManagedBlock(source) {
  const start = source.indexOf(AGENTS_BEGIN)
  if (start < 0) return source

  const end = source.indexOf(AGENTS_END, start)
  if (end < 0) return source

  const after = end + AGENTS_END.length
  return (source.slice(0, start) + source.slice(after))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

async function writeManagedFile(file, content, warnings) {
  if (existsSync(file)) {
    const current = await readText(file)
    if (!current.includes(MANAGED_MARKER)) {
      warnings.push(`Skipped existing unmanaged file: ${file}`)
      return false
    }
  }

  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, "utf8")
  return true
}

export async function installResources() {
  const configDir = getConfigDir()
  const skillsTarget = path.join(configDir, "skills")
  const commandsTarget = path.join(configDir, "commands")
  const stateDir = path.join(configDir, ".ues")
  const stateFile = path.join(stateDir, "state.json")
  const warnings = []
  const installed = { skills: [], commands: [] }

  await mkdir(skillsTarget, { recursive: true })
  await mkdir(commandsTarget, { recursive: true })
  await mkdir(stateDir, { recursive: true })

  const sourceSkills = path.join(PACKAGE_ROOT, "global-config", "skills")
  const skillEntries = await readdir(sourceSkills, { withFileTypes: true })

  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue

    const sourceFile = path.join(sourceSkills, entry.name, "SKILL.md")
    const targetID = `${SKILL_PREFIX}${entry.name}`
    const targetFile = path.join(skillsTarget, targetID, "SKILL.md")
    const source = await readFile(sourceFile, "utf8")
    const content = installSkillName(source, entry.name)

    if (await writeManagedFile(targetFile, content, warnings)) {
      installed.skills.push(targetID)
    }
  }

  const sourceCommands = path.join(PACKAGE_ROOT, "global-config", "commands")
  const commandEntries = await readdir(sourceCommands, { withFileTypes: true })

  for (const entry of commandEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const id = entry.name.slice(0, -3)
    const targetName = `${SKILL_PREFIX}${id}.md`
    const targetFile = path.join(commandsTarget, targetName)
    const source = await readFile(path.join(sourceCommands, entry.name), "utf8")
    const content = source.includes(MANAGED_MARKER)
      ? source
      : `${source.trimEnd()}\n\n${MANAGED_MARKER}\n`

    if (await writeManagedFile(targetFile, content, warnings)) {
      installed.commands.push(targetName)
    }
  }

  const globalAgentsFile = path.join(configDir, "AGENTS.md")
  const existingAgents = await readText(globalAgentsFile)
  const cleanAgents = removeManagedBlock(existingAgents)
  const workflow = (await readFile(
    path.join(PACKAGE_ROOT, "global-config", "AGENTS.md"),
    "utf8",
  )).trim()

  const managedBlock = `${AGENTS_BEGIN}\n${workflow}\n${AGENTS_END}`
  const mergedAgents = [cleanAgents, managedBlock].filter(Boolean).join("\n\n") + "\n"
  await writeFile(globalAgentsFile, mergedAgents, "utf8")

  const state = {
    package: PACKAGE_NAME,
    version: await packageVersion(),
    configDir,
    installedAt: new Date().toISOString(),
    skills: installed.skills,
    commands: installed.commands,
  }

  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8")
  return { ...state, warnings }
}

export async function removeResources() {
  const configDir = getConfigDir()
  const stateFile = path.join(configDir, ".ues", "state.json")
  const rawState = await readText(stateFile)
  const state = rawState ? JSON.parse(rawState) : { skills: [], commands: [] }
  const removed = { skills: 0, commands: 0 }

  for (const id of state.skills || []) {
    const dir = path.join(configDir, "skills", id)
    const file = path.join(dir, "SKILL.md")
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(dir, { recursive: true, force: true })
      removed.skills += 1
    }
  }

  for (const name of state.commands || []) {
    const file = path.join(configDir, "commands", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(file, { force: true })
      removed.commands += 1
    }
  }

  const globalAgentsFile = path.join(configDir, "AGENTS.md")
  const existingAgents = await readText(globalAgentsFile)
  if (existingAgents.includes(AGENTS_BEGIN)) {
    const clean = removeManagedBlock(existingAgents)
    if (clean) await writeFile(globalAgentsFile, clean + "\n", "utf8")
    else await rm(globalAgentsFile, { force: true })
  }

  await rm(path.join(configDir, ".ues"), { recursive: true, force: true })
  return { configDir, ...removed }
}

export async function getStatus() {
  const configDir = getConfigDir()
  const stateFile = path.join(configDir, ".ues", "state.json")
  const raw = await readText(stateFile)
  if (!raw) return { installed: false, configDir }

  const state = JSON.parse(raw)
  let skillsPresent = 0
  let commandsPresent = 0

  for (const id of state.skills || []) {
    if (existsSync(path.join(configDir, "skills", id, "SKILL.md"))) skillsPresent += 1
  }
  for (const name of state.commands || []) {
    if (existsSync(path.join(configDir, "commands", name))) commandsPresent += 1
  }

  const agents = await readText(path.join(configDir, "AGENTS.md"))

  return {
    installed: true,
    ...state,
    skillsPresent,
    commandsPresent,
    workflowPresent: agents.includes(AGENTS_BEGIN),
  }
}

export async function getPackageVersion() {
  return packageVersion()
}
