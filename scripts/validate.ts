import { fileURLToPath } from "node:url"
import path from "node:path"
import { loadCommands, loadSkills } from "../src/assets.ts"

const root = fileURLToPath(new URL("../", import.meta.url))
const skills = await loadSkills(root)
const commands = await loadCommands(root)

const errors: string[] = []
const skillIDs = new Set<string>()

for (const skill of skills) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.id)) {
    errors.push(`invalid skill id: ${skill.id}`)
  }
  if (skillIDs.has(skill.id)) {
    errors.push(`duplicate skill id: ${skill.id}`)
  }
  skillIDs.add(skill.id)
  if (!skill.content.trim()) {
    errors.push(`empty skill body: ${skill.id}`)
  }
}

const commandIDs = new Set<string>()
for (const command of commands) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(command.id)) {
    errors.push(`invalid command id: ${command.id}`)
  }
  if (commandIDs.has(command.id)) {
    errors.push(`duplicate command id: ${command.id}`)
  }
  commandIDs.add(command.id)
  if (!command.template.trim()) {
    errors.push(`empty command body: ${command.id}`)
  }
}

if (skills.length < 1) errors.push("no packaged skills found")
if (commands.length < 1) errors.push("no packaged commands found")

if (errors.length > 0) {
  console.error("Validation failed:")
  for (const error of errors) console.error(`- ${error}`)
  process.exit(1)
}

console.log(`Validated ${skills.length} skills and ${commands.length} commands.`)
