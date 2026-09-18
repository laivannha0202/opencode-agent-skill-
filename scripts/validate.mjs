import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const skillsRoot = path.join(root, "global-config", "skills")
const commandsRoot = path.join(root, "global-config", "commands")
const errors = []
const ids = new Set()

for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const file = path.join(skillsRoot, entry.name, "SKILL.md")
  const source = await readFile(file, "utf8")
  const name = source.match(/^name:\s*([^\r\n]+)/m)?.[1]?.trim()
  const description = source.match(/^description:\s*([^\r\n]+)/m)?.[1]?.trim()

  if (!name) errors.push(`${entry.name}: missing name`)
  if (!description) errors.push(`${entry.name}: missing description`)
  if (name && name !== entry.name) errors.push(`${entry.name}: frontmatter name must match directory`)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name)) errors.push(`${entry.name}: invalid skill id`)
  if (ids.has(entry.name)) errors.push(`${entry.name}: duplicate skill id`)
  ids.add(entry.name)
}

let commands = 0
for (const entry of await readdir(commandsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".md")) continue
  commands += 1
  const source = await readFile(path.join(commandsRoot, entry.name), "utf8")
  if (!source.includes("description:")) errors.push(`${entry.name}: missing command description`)
}

if (ids.size === 0) errors.push("no skills found")
if (commands === 0) errors.push("no commands found")

if (errors.length) {
  console.error("Validation failed:")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${ids.size} skills and ${commands} commands.`)
