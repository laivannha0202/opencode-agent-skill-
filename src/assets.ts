import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

export interface ParsedMarkdown {
  meta: Record<string, string>
  body: string
}

export interface LoadedSkill {
  id: string
  name: string
  description: string
  location: string
  content: string
}

export interface LoadedCommand {
  id: string
  description?: string
  template: string
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const normalized = source.replace(/\r\n/g, "\n")
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)

  if (!match) {
    return { meta: {}, body: normalized.trim() }
  }

  const meta: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1)
    if (key) meta[key] = unquote(value)
  }

  return { meta, body: match[2].trim() }
}

export async function loadSkills(packageRoot: string): Promise<LoadedSkill[]> {
  const skillsRoot = path.join(packageRoot, "global-config", "skills")
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const skills: LoadedSkill[] = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const location = path.join(skillsRoot, entry.name, "SKILL.md")
    const parsed = parseMarkdown(await readFile(location, "utf8"))
    const id = parsed.meta.name || entry.name
    const description = parsed.meta.description

    if (!description) {
      throw new Error(`Skill ${id} is missing a description`)
    }

    skills.push({
      id,
      name: id,
      description,
      location,
      content: parsed.body,
    })
  }

  return skills.sort((a, b) => a.id.localeCompare(b.id))
}

export async function loadCommands(packageRoot: string): Promise<LoadedCommand[]> {
  const commandsRoot = path.join(packageRoot, "global-config", "commands")
  const entries = await readdir(commandsRoot, { withFileTypes: true })
  const commands: LoadedCommand[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue

    const parsed = parseMarkdown(
      await readFile(path.join(commandsRoot, entry.name), "utf8"),
    )

    commands.push({
      id: entry.name.slice(0, -3),
      description: parsed.meta.description,
      template: parsed.body,
    })
  }

  return commands.sort((a, b) => a.id.localeCompare(b.id))
}
