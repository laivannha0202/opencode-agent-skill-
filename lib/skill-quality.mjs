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

function frontmatter(source) {
  const name = source.match(/^name:\s*([^\r\n]+)/m)?.[1]?.trim() || null
  const description = source.match(/^description:\s*([^\r\n]+)/m)?.[1]?.trim() || null
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
