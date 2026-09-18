import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const skillsRoot = path.join(root, "global-config", "skills")
const commandsRoot = path.join(root, "global-config", "commands")
const agentsRoot = path.join(root, "global-config", "agents")
const errors = []
const ids = new Set()

function localMarkdownLinks(source) {
  return [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim())
    .filter((value) =>
      value &&
      !value.startsWith("#") &&
      !value.startsWith("http://") &&
      !value.startsWith("https://") &&
      !value.startsWith("mailto:"),
    )
}

for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const dir = path.join(skillsRoot, entry.name)
  const file = path.join(dir, "SKILL.md")
  if (!existsSync(file)) {
    errors.push(`${entry.name}: missing SKILL.md`)
    continue
  }

  const source = await readFile(file, "utf8")
  const name = source.match(/^name:\s*([^\r\n]+)/m)?.[1]?.trim()
  const description = source.match(/^description:\s*([^\r\n]+)/m)?.[1]?.trim()

  if (!name) errors.push(`${entry.name}: missing name`)
  if (!description) errors.push(`${entry.name}: missing description`)
  if (name && name !== entry.name) errors.push(`${entry.name}: frontmatter name must match directory`)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) errors.push(`${entry.name}: invalid skill id`)
  if (ids.has(entry.name)) errors.push(`${entry.name}: duplicate skill id`)
  ids.add(entry.name)

  for (const link of localMarkdownLinks(source)) {
    const relative = link.split("#", 1)[0]
    if (!relative) continue
    if (!existsSync(path.resolve(dir, relative))) {
      errors.push(`${entry.name}: broken local reference ${link}`)
    }
  }
}

const agentIDs = new Set()
for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  agentIDs.add(`ues-${entry.name.slice(0, -3)}`)
}

let commands = 0
for (const entry of await readdir(commandsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  commands += 1
  const source = await readFile(path.join(commandsRoot, entry.name), "utf8")
  if (!source.includes("description:")) errors.push(`${entry.name}: missing command description`)
  const agent = source.match(/^agent:\s*([^\r\n]+)/m)?.[1]?.trim()
  if (agent?.startsWith("ues-") && !agentIDs.has(agent)) {
    errors.push(`${entry.name}: references missing subagent ${agent}`)
  }
}

let agents = 0
for (const entry of await readdir(agentsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  agents += 1
  const source = await readFile(path.join(agentsRoot, entry.name), "utf8")
  if (!source.includes("description:")) errors.push(`${entry.name}: missing agent description`)
  if (!/mode:\s*subagent/.test(source)) errors.push(`${entry.name}: agent must use mode: subagent`)
}

if (ids.size === 0) errors.push("no skills found")
if (commands === 0) errors.push("no commands found")
if (agents === 0) errors.push("no subagents found")

if (errors.length) {
  console.error("Validation failed:")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${ids.size} skills, ${commands} commands and ${agents} subagents.`)
