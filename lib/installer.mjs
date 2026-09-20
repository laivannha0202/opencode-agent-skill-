import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { SKILL_PREFIX, validManagedMarkdown, validResourceID, validSkillID } from "./ids.mjs"
import { adaptAgentForOpenCode, detectOpenCodeMajor } from "./opencode-compat.mjs"
import { applyConfiguredModel, readModelPolicy } from "./model-config.mjs"

export { SKILL_PREFIX } from "./ids.mjs"

export const PACKAGE_NAME = "opencode-agent-skill"
export const LEGACY_PACKAGE_NAME = "@laivannha0202/opencode-agent-skill"
export const MANAGED_MARKER = "<!-- managed-by: @laivannha0202/opencode-agent-skill -->"
export const AGENTS_BEGIN = "<!-- BEGIN OCSKILL UNIVERSAL ENGINEERING SYSTEM -->"
export const AGENTS_END = "<!-- END OCSKILL UNIVERSAL ENGINEERING SYSTEM -->"

const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url))
const ROUTER_PLUGIN_STATE = "ues-router/index.js"

function validManagedPlugin(value) {
  return value === ROUTER_PLUGIN_STATE
}

function isOwnedPackageName(value) {
  return !value || value === PACKAGE_NAME || value === LEGACY_PACKAGE_NAME
}

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
  const next = source.replace(/^name:\s*[^\r\n]+/m, `name: ${SKILL_PREFIX}${name}`)
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

async function readManagedState(file, warnings = []) {
  const raw = await readText(file)
  if (!raw) return { kind: "empty", state: { skills: [], commands: [], agents: [], plugins: [] } }

  try {
    const parsed = JSON.parse(raw)
    if (parsed.package && !isOwnedPackageName(parsed.package)) {
      warnings.push(`Ignored state owned by another package: ${parsed.package}`)
      return {
        kind: "foreign",
        package: parsed.package,
        state: { skills: [], commands: [], agents: [], plugins: [] },
      }
    }
    return {
      kind: "managed",
      state: {
        ...parsed,
        skills: Array.isArray(parsed.skills) ? parsed.skills.filter(validSkillID) : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands.filter(validManagedMarkdown) : [],
        agents: Array.isArray(parsed.agents) ? parsed.agents.filter(validManagedMarkdown) : [],
        plugins: Array.isArray(parsed.plugins) ? parsed.plugins.filter(validManagedPlugin) : [],
      },
    }
  } catch {
    warnings.push(`Invalid UES state file; run 'ocskill install' to rebuild it: ${file}`)
    return { kind: "invalid", state: { skills: [], commands: [], agents: [], plugins: [] } }
  }
}

async function cleanupStaleManaged(configDir, previousState, installed, warnings) {
  const currentSkills = new Set(installed.skills)
  const currentCommands = new Set(installed.commands)
  const currentAgents = new Set(installed.agents)
  const currentPlugins = new Set(installed.plugins || [])

  for (const id of previousState.skills || []) {
    if (currentSkills.has(id) || !validSkillID(id)) continue
    const dir = path.join(configDir, "skills", id)
    const markerFile = path.join(dir, "SKILL.md")
    const current = await readText(markerFile)
    if (current.includes(MANAGED_MARKER)) {
      await rm(dir, { recursive: true, force: true })
    } else if (existsSync(dir)) {
      warnings.push(`Preserved stale skill without UES marker: ${dir}`)
    }
  }

  for (const name of previousState.commands || []) {
    if (currentCommands.has(name) || !validManagedMarkdown(name)) continue
    const file = path.join(configDir, "commands", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(file, { force: true })
    } else if (existsSync(file)) {
      warnings.push(`Preserved stale command without UES marker: ${file}`)
    }
  }

  for (const name of previousState.agents || []) {
    if (currentAgents.has(name) || !validManagedMarkdown(name)) continue
    const file = path.join(configDir, "agents", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(file, { force: true })
    } else if (existsSync(file)) {
      warnings.push(`Preserved stale subagent without UES marker: ${file}`)
    }
  }

  for (const name of previousState.plugins || []) {
    if (currentPlugins.has(name) || !validManagedPlugin(name)) continue
    const file = path.join(configDir, "plugins", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(path.dirname(file), { recursive: true, force: true })
    } else if (existsSync(file)) {
      warnings.push(`Preserved stale plugin without UES marker: ${file}`)
    }
  }
}

async function scanUntrackedManaged(configDir) {
  const found = { skills: [], commands: [], agents: [], plugins: [] }

  const skillsDir = path.join(configDir, "skills")
  for (const entry of await readdir(skillsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !validSkillID(entry.name)) continue
    const current = await readText(path.join(skillsDir, entry.name, "SKILL.md"))
    if (current.includes(MANAGED_MARKER)) found.skills.push(entry.name)
  }

  for (const [targetDir, key] of [
    [path.join(configDir, "commands"), "commands"],
    [path.join(configDir, "agents"), "agents"],
  ]) {
    for (const entry of await readdir(targetDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !validManagedMarkdown(entry.name)) continue
      const current = await readText(path.join(targetDir, entry.name))
      if (current.includes(MANAGED_MARKER)) found[key].push(entry.name)
    }
  }

  const routerFile = path.join(configDir, "plugins", ROUTER_PLUGIN_STATE)
  const routerCurrent = await readText(routerFile)
  if (routerCurrent.includes(MANAGED_MARKER)) found.plugins.push(ROUTER_PLUGIN_STATE)

  return found
}

async function warnUntrackedManaged(configDir, installed, warnings) {
  const currentSkills = new Set(installed.skills)
  const currentCommands = new Set(installed.commands)
  const currentAgents = new Set(installed.agents)
  const currentPlugins = new Set(installed.plugins || [])
  const untracked = await scanUntrackedManaged(configDir)

  for (const id of untracked.skills) {
    if (!currentSkills.has(id)) {
      warnings.push(`Untracked managed skill left over from an earlier install: ${id}`)
    }
  }
  for (const name of untracked.commands) {
    if (!currentCommands.has(name)) {
      warnings.push(`Untracked managed command left over from an earlier install: ${name}`)
    }
  }
  for (const name of untracked.agents) {
    if (!currentAgents.has(name)) {
      warnings.push(`Untracked managed subagent left over from an earlier install: ${name}`)
    }
  }
  for (const name of untracked.plugins || []) {
    if (!currentPlugins.has(name)) {
      warnings.push(`Untracked managed plugin left over from an earlier install: ${name}`)
    }
  }
}

async function removeManagedAgentsBlock(configDir) {
  const globalAgentsFile = path.join(configDir, "AGENTS.md")
  const existingAgents = await readText(globalAgentsFile)
  if (existingAgents.includes(AGENTS_BEGIN)) {
    const clean = removeManagedBlock(existingAgents)
    if (clean) await writeFile(globalAgentsFile, clean + "\n", "utf8")
    else await rm(globalAgentsFile, { force: true })
  }
}

async function installSkillDirectory(sourceDir, targetDir, sourceName, warnings) {
  const targetSkill = path.join(targetDir, "SKILL.md")

  if (existsSync(targetDir)) {
    if (!existsSync(targetSkill)) {
      warnings.push(`Skipped existing unmanaged skill directory: ${targetDir}`)
      return false
    }

    const current = await readText(targetSkill)
    if (!current.includes(MANAGED_MARKER)) {
      warnings.push(`Skipped existing unmanaged skill: ${targetSkill}`)
      return false
    }

    await rm(targetDir, { recursive: true, force: true })
  }

  await mkdir(path.dirname(targetDir), { recursive: true })
  await cp(sourceDir, targetDir, { recursive: true })

  const copiedSkill = await readFile(targetSkill, "utf8")
  await writeFile(targetSkill, installSkillName(copiedSkill, sourceName), "utf8")
  return true
}

async function installPluginDirectory(sourceDir, targetDir, warnings) {
  const targetEntry = path.join(targetDir, "index.js")

  if (existsSync(targetDir)) {
    if (!existsSync(targetEntry)) {
      warnings.push(`Skipped existing unmanaged plugin directory: ${targetDir}`)
      return false
    }

    const current = await readText(targetEntry)
    if (!current.includes(MANAGED_MARKER)) {
      warnings.push(`Skipped existing unmanaged plugin: ${targetEntry}`)
      return false
    }

    await rm(targetDir, { recursive: true, force: true })
  }

  await mkdir(path.dirname(targetDir), { recursive: true })
  await cp(sourceDir, targetDir, { recursive: true })

  const copiedEntry = await readFile(targetEntry, "utf8")
  await writeFile(
    targetEntry,
    copiedEntry.includes(MANAGED_MARKER)
      ? copiedEntry
      : `${copiedEntry.trimEnd()}\n\n// ${MANAGED_MARKER}\n`,
    "utf8",
  )
  return true
}

export async function installResources(options = {}) {
  const sourceRoot = options.sourceRoot ?? PACKAGE_ROOT
  const configDir = getConfigDir()
  const skillsTarget = path.join(configDir, "skills")
  const commandsTarget = path.join(configDir, "commands")
  const agentsTarget = path.join(configDir, "agents")
  const pluginsTarget = path.join(configDir, "plugins")
  const stateDir = path.join(configDir, ".ues")
  const stateFile = path.join(stateDir, "state.json")
  const warnings = []
  const openCodeMajor = options.openCodeMajor ?? detectOpenCodeMajor()
  const installed = { skills: [], commands: [], agents: [], plugins: [] }
  const previous = await readManagedState(stateFile, warnings)
  const previousState = previous.state
  const modelPolicy = await readModelPolicy(configDir)

  if (previous.kind === "foreign") {
    if (options.force) {
      const backupFile = `${stateFile}.foreign-${Date.now()}`
      warnings.push(
        `Backed up state owned by ${previous.package} before re-owning: ${backupFile}`,
      )
      await cp(stateFile, backupFile)
    } else {
      warnings.push(`Skipped install: state is owned by ${previous.package}`)
      return {
        configDir,
        version: await packageVersion(),
        stateError: `State belongs to another package: ${previous.package}`,
        skills: [],
        commands: [],
        agents: [],
        plugins: [],
        warnings,
      }
    }
  }

  if (previous.kind === "invalid") {
    const backupFile = `${stateFile}.invalid-${Date.now()}`
    warnings.push(`Backed up unreadable state file before rebuilding: ${backupFile}`)
    await cp(stateFile, backupFile)
  }

  await mkdir(skillsTarget, { recursive: true })
  await mkdir(commandsTarget, { recursive: true })
  await mkdir(agentsTarget, { recursive: true })
  await mkdir(pluginsTarget, { recursive: true })
  await mkdir(stateDir, { recursive: true })

  const sourceSkills = path.join(sourceRoot, "global-config", "skills")
  const skillEntries = await readdir(sourceSkills, { withFileTypes: true })

  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue

    const sourceDir = path.join(sourceSkills, entry.name)
    const targetID = `${SKILL_PREFIX}${entry.name}`
    const targetDir = path.join(skillsTarget, targetID)

    if (await installSkillDirectory(sourceDir, targetDir, entry.name, warnings)) {
      installed.skills.push(targetID)
    }
  }

  const sourceCommands = path.join(sourceRoot, "global-config", "commands")
  const commandEntries = await readdir(sourceCommands, { withFileTypes: true })

  for (const entry of commandEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const id = entry.name.slice(0, -3)
    if (!validResourceID(id)) {
      warnings.push(`Skipped command with invalid resource ID: ${id}`)
      continue
    }
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

  const sourceAgents = path.join(sourceRoot, "global-config", "agents")
  const agentEntries = await readdir(sourceAgents, { withFileTypes: true })

  for (const entry of agentEntries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const id = entry.name.slice(0, -3)
    if (!validResourceID(id)) {
      warnings.push(`Skipped subagent with invalid resource ID: ${id}`)
      continue
    }
    const targetName = `${SKILL_PREFIX}${id}.md`
    const targetFile = path.join(agentsTarget, targetName)
    const source = applyConfiguredModel(
      adaptAgentForOpenCode(
        await readFile(path.join(sourceAgents, entry.name), "utf8"),
        openCodeMajor,
      ),
      id,
      modelPolicy,
    )
    const content = source.includes(MANAGED_MARKER)
      ? source
      : `${source.trimEnd()}\n\n${MANAGED_MARKER}\n`

    if (await writeManagedFile(targetFile, content, warnings)) {
      installed.agents.push(targetName)
    }
  }

  if (openCodeMajor >= 2) {
    const sourcePluginDir = path.join(sourceRoot, "global-config", "plugins", "ues-router")
    const targetPluginDir = path.join(pluginsTarget, "ues-router")
    if (existsSync(path.join(sourcePluginDir, "index.js"))) {
      if (await installPluginDirectory(sourcePluginDir, targetPluginDir, warnings)) {
        installed.plugins.push(ROUTER_PLUGIN_STATE)
      }
    }

    const routerConfigFile = path.join(stateDir, "router.json")
    if (!existsSync(routerConfigFile)) {
      await writeFile(
        routerConfigFile,
        JSON.stringify({ enabled: true, maxSkills: 4 }, null, 2) + "\n",
        "utf8",
      )
    }
  }

  const globalAgentsFile = path.join(configDir, "AGENTS.md")
  const existingAgents = await readText(globalAgentsFile)
  const cleanAgents = removeManagedBlock(existingAgents)
  const workflow = (await readFile(
    path.join(sourceRoot, "global-config", "AGENTS.md"),
    "utf8",
  )).trim()

  const managedBlock = `${AGENTS_BEGIN}\n${workflow}\n${AGENTS_END}`
  const mergedAgents = [cleanAgents, managedBlock].filter(Boolean).join("\n\n") + "\n"
  await writeFile(globalAgentsFile, mergedAgents, "utf8")

  await cleanupStaleManaged(configDir, previousState, installed, warnings)

  if (previous.kind === "invalid" || (previous.kind === "foreign" && options.force)) {
    await warnUntrackedManaged(configDir, installed, warnings)
  }

  const state = {
    schemaVersion: 2,
    package: PACKAGE_NAME,
    version: await packageVersion(),
    configDir,
    installedAt: new Date().toISOString(),
    openCodeMajor,
    skills: installed.skills.sort(),
    commands: installed.commands.sort(),
    agents: installed.agents.sort(),
    plugins: installed.plugins.sort(),
  }

  await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n", "utf8")
  return { ...state, warnings }
}

export async function removeResources(options = {}) {
  const configDir = getConfigDir()
  const stateFile = path.join(configDir, ".ues", "state.json")
  const warnings = []
  const previous = await readManagedState(stateFile, warnings)

  if (options.force && (previous.kind === "foreign" || previous.kind === "invalid")) {
    const backupFile = path.join(
      configDir,
      `state.${previous.kind}-${Date.now()}.backup.json`,
    )
    warnings.push(`Backed up state before forced remove: ${backupFile}`)
    await cp(stateFile, backupFile)

    const untracked = await scanUntrackedManaged(configDir)
    for (const id of untracked.skills) {
      await rm(path.join(configDir, "skills", id), { recursive: true, force: true })
    }
    for (const [targetDir, key] of [
      [path.join(configDir, "commands"), "commands"],
      [path.join(configDir, "agents"), "agents"],
    ]) {
      for (const name of untracked[key]) {
        await rm(path.join(targetDir, name), { force: true })
      }
    }
    for (const name of untracked.plugins || []) {
      if (!validManagedPlugin(name)) continue
      await rm(path.join(configDir, "plugins", "ues-router"), { recursive: true, force: true })
    }
    const removed = {
      skills: untracked.skills.length,
      commands: untracked.commands.length,
      agents: untracked.agents.length,
      plugins: (untracked.plugins || []).length,
    }

    await removeManagedAgentsBlock(configDir)
    await rm(path.join(configDir, ".ues"), { recursive: true, force: true })
    return { configDir, ...removed, warnings }
  }

  const state = previous.state
  const removed = { skills: 0, commands: 0, agents: 0, plugins: 0 }

  if (previous.kind === "foreign") {
    warnings.push(`Skipped remove: state is owned by ${previous.package}`)
    return {
      configDir,
      stateError: `State belongs to another package: ${previous.package}`,
      ...removed,
      warnings,
    }
  }

  if (previous.kind === "invalid") {
    warnings.push("Skipped remove: state file is unreadable")
    return {
      configDir,
      stateError: "State file is invalid; refusing to modify it.",
      ...removed,
      warnings,
    }
  }

  for (const id of state.skills || []) {
    if (!validSkillID(id)) continue
    const dir = path.join(configDir, "skills", id)
    const file = path.join(dir, "SKILL.md")
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(dir, { recursive: true, force: true })
      removed.skills += 1
    }
  }

  for (const name of state.commands || []) {
    if (!validManagedMarkdown(name)) continue
    const file = path.join(configDir, "commands", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(file, { force: true })
      removed.commands += 1
    }
  }

  for (const name of state.agents || []) {
    if (!validManagedMarkdown(name)) continue
    const file = path.join(configDir, "agents", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(file, { force: true })
      removed.agents += 1
    }
  }

  for (const name of state.plugins || []) {
    if (!validManagedPlugin(name)) continue
    const file = path.join(configDir, "plugins", name)
    const current = await readText(file)
    if (current.includes(MANAGED_MARKER)) {
      await rm(path.dirname(file), { recursive: true, force: true })
      removed.plugins += 1
    }
  }

  await removeManagedAgentsBlock(configDir)
  await rm(path.join(configDir, ".ues"), { recursive: true, force: true })
  return { configDir, ...removed, warnings }
}

export async function getStatus() {
  const configDir = getConfigDir()
  const stateFile = path.join(configDir, ".ues", "state.json")
  const raw = await readText(stateFile)
  if (!raw) return { installed: false, configDir }

  let state
  try {
    state = JSON.parse(raw)
  } catch {
    return {
      installed: false,
      configDir,
      stateError: "Invalid UES state file; run ocskill install to rebuild it.",
    }
  }

  if (state.package && !isOwnedPackageName(state.package)) {
    return {
      installed: false,
      configDir,
      stateError: `State belongs to another package: ${state.package}`,
    }
  }

  state.skills = Array.isArray(state.skills) ? state.skills.filter(validSkillID) : []
  state.commands = Array.isArray(state.commands) ? state.commands.filter(validManagedMarkdown) : []
  state.agents = Array.isArray(state.agents) ? state.agents.filter(validManagedMarkdown) : []
  state.plugins = Array.isArray(state.plugins) ? state.plugins.filter(validManagedPlugin) : []

  let skillsPresent = 0
  let commandsPresent = 0
  let agentsPresent = 0
  let pluginsPresent = 0

  for (const id of state.skills || []) {
    if (existsSync(path.join(configDir, "skills", id, "SKILL.md"))) skillsPresent += 1
  }
  for (const name of state.commands || []) {
    if (existsSync(path.join(configDir, "commands", name))) commandsPresent += 1
  }
  for (const name of state.agents || []) {
    if (existsSync(path.join(configDir, "agents", name))) agentsPresent += 1
  }
  for (const name of state.plugins || []) {
    if (existsSync(path.join(configDir, "plugins", name))) pluginsPresent += 1
  }

  const agents = await readText(path.join(configDir, "AGENTS.md"))

  return {
    installed: true,
    ...state,
    skillsPresent,
    commandsPresent,
    agentsPresent,
    pluginsPresent,
    workflowPresent: agents.includes(AGENTS_BEGIN),
  }
}

export async function getPackageVersion() {
  return packageVersion()
}
