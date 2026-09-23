import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

function words(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9-]{3,}/g) || [])
}

function similarity(a, b) {
  const left = words(a)
  const right = words(b)
  const union = new Set([...left, ...right])
  let intersection = 0
  for (const item of left) if (right.has(item)) intersection += 1
  return union.size ? intersection / union.size : 0
}

export function validateFrontmatterSource(source, options = {}) {
  const text = String(source || "")
  const errors = []
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { valid: false, errors: [{ issue: "missing-frontmatter-open", file: options.file || null }] }
  }

  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) {
    return { valid: false, errors: [{ issue: "missing-frontmatter-close", file: options.file || null }] }
  }

  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#")) continue
    if (/\t/.test(line)) {
      errors.push({ issue: "frontmatter-tab", line: index + 2, file: options.file || null })
      continue
    }
    const field = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/)
    if (!field) {
      errors.push({ issue: "invalid-frontmatter-line", line: index + 2, file: options.file || null })
      continue
    }
    const value = String(field[2] || "").trim()
    if (!value) continue
    const quoted = (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    const blockScalar = value === "|" || value === ">"
    const flowValue = value.startsWith("[") || value.startsWith("{")
    if (!quoted && !blockScalar && !flowValue && /:\s/.test(value)) {
      errors.push({
        issue: "unquoted-colon-in-scalar",
        field: field[1],
        line: index + 2,
        file: options.file || null,
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

function frontmatter(source) {
  const name = source.match(/^name:\s*([^\r\n]+)/m)?.[1]?.trim()?.replace(/^(["'])(.*)\1$/, "$2") || null
  const description = source.match(/^description:\s*([^\r\n]+)/m)?.[1]?.trim()?.replace(/^(["'])(.*)\1$/, "$2") || null
  return { name, description }
}

export async function lintSkillCatalog(root = process.cwd(), options = {}) {
  const skillsRoot = path.join(path.resolve(root), "global-config", "skills")
  const entries = await readdir(skillsRoot, { withFileTypes: true })
  const skills = []
  const errors = []
  const warnings = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(skillsRoot, entry.name, "SKILL.md")
    if (!existsSync(file)) {
      errors.push({ skill: entry.name, issue: "missing-skill-md" })
      continue
    }
    const source = await readFile(file, "utf8")
    const yaml = validateFrontmatterSource(source, { file })
    for (const error of yaml.errors) errors.push({ skill: entry.name, ...error })
    const meta = frontmatter(source)
    const body = source.replace(/^---[\s\S]*?---\s*/m, "")
    const row = {
      id: entry.name,
      description: meta.description,
      chars: source.length,
      bodyChars: body.length,
      estimatedTokens: Math.ceil(source.length / 4),
    }
    skills.push(row)
    if (meta.name !== entry.name) errors.push({ skill: entry.name, issue: "frontmatter-name-mismatch" })
    if (!meta.description) errors.push({ skill: entry.name, issue: "missing-description" })
    if (row.estimatedTokens > Number(options.maxSkillTokens || 1800)) warnings.push({ skill: entry.name, issue: "large-entrypoint", estimatedTokens: row.estimatedTokens })
  }

  const collisions = []
  const threshold = Number(options.collisionThreshold || 0.58)
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const score = similarity(skills[i].description, skills[j].description)
      if (score >= threshold) collisions.push({ a: skills[i].id, b: skills[j].id, score: Number(score.toFixed(3)) })
    }
  }

  return {
    schemaVersion: 1,
    valid: errors.length === 0,
    skillCount: skills.length,
    errors,
    warnings,
    collisions: collisions.sort((a, b) => b.score - a.score),
    skills: skills.sort((a, b) => a.id.localeCompare(b.id)),
  }
}
