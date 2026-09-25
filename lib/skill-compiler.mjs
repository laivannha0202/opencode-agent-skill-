import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS_ROOT = path.join(PACKAGE_ROOT, "global-config", "skills")
const SKILL_SOURCE_CACHE = new Map()
const COMPILED_SKILL_CACHE = new Map()

const DOMAIN_SKILLS = Object.freeze({
  "auth-security": "auth-security",
  payment: "payment-engineering",
  database: "database-engineering",
  "api-contract": "api-contract",
  "react-native": "react-native-engineering",
  nextjs: "nextjs-engineering",
  react: "react-engineering",
  devops: "devops-engineering",
})

const ROLE_SKILLS = Object.freeze({
  architect: ["software-architect", "task-planner"],
  "codebase-mapper": ["repo-explorer", "context-engineering"],
  critic: ["code-review", "change-impact-analysis"],
  debugger: ["bug-diagnosis", "test-verification"],
  executor: ["implementation-engineer"],
  "integration-verifier": ["test-verification", "change-impact-analysis"],
  "merge-arbiter": ["git-safety", "change-impact-analysis"],
  "plan-checker": ["task-planner", "change-impact-analysis"],
  researcher: ["research-verification"],
  reviewer: ["code-review"],
  verifier: ["test-verification"],
  "visual-verifier": ["visual-fidelity", "responsive-verification", "browser-qa"],
})

function stripFrontmatter(raw) {
  return String(raw || "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "")
}

function priorityLine(line) {
  return /^#{1,4}\s/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /\b(must|never|always|verify|prefer|avoid|require|do not|don't|fail|evidence|security|safety|rollback|idempot|transaction|accessib)/i.test(line)
}

function compileText(raw, maxChars) {
  const source = stripFrontmatter(raw)
  const lines = source.split(/\r?\n/).map((line) => line.trimEnd())
  const selected = []
  let chars = 0

  // Keep a short orientation prefix, then the highest-value rules/checklists.
  for (const line of lines.slice(0, 20)) {
    if (!line.trim()) continue
    if (chars + line.length + 1 > Math.floor(maxChars * 0.35)) break
    selected.push(line)
    chars += line.length + 1
  }
  for (const line of lines) {
    if (!line.trim() || !priorityLine(line) || selected.includes(line)) continue
    if (chars + line.length + 1 > maxChars) break
    selected.push(line)
    chars += line.length + 1
  }
  return selected.join("\n").slice(0, maxChars)
}

export function selectSkillNames(taskPolicy = {}, role = "executor", options = {}) {
  const maxSkills = Math.max(1, Math.min(5, Number(options.maxSkills || taskPolicy.maxSkills || 3)))
  const names = []
  for (const name of ROLE_SKILLS[role] || []) names.push(name)
  for (const domain of taskPolicy.domains || []) {
    const mapped = DOMAIN_SKILLS[domain]
    if (mapped) names.push(mapped)
  }
  return [...new Set(names)].slice(0, maxSkills)
}

async function skillSource(name) {
  if (SKILL_SOURCE_CACHE.has(name)) return SKILL_SOURCE_CACHE.get(name)
  const file = path.join(SKILLS_ROOT, name, "SKILL.md")
  if (!existsSync(file)) {
    SKILL_SOURCE_CACHE.set(name, "")
    return ""
  }
  const raw = await readFile(file, "utf8").catch(() => "")
  SKILL_SOURCE_CACHE.set(name, raw)
  return raw
}

export async function compileSkillContext(taskPolicy = {}, role = "executor", options = {}) {
  const names = selectSkillNames(taskPolicy, role, options)
  const totalChars = Math.max(800, Math.min(8_000, Number(options.totalChars || 3_200)))
  const perSkill = Math.max(450, Math.floor(totalChars / Math.max(1, names.length)))
  const cacheKey = JSON.stringify([role, names, totalChars, perSkill])
  if (COMPILED_SKILL_CACHE.has(cacheKey)) {
    return { ...COMPILED_SKILL_CACHE.get(cacheKey), cacheHit: true }
  }

  const skills = []
  for (const name of names) {
    const raw = await skillSource(name)
    if (!raw) continue
    const text = compileText(raw, perSkill)
    if (text) skills.push({ name, text })
  }

  const result = {
    schemaVersion: 1,
    role,
    requested: names,
    loaded: skills.map((item) => item.name),
    chars: skills.reduce((sum, item) => sum + item.text.length, 0),
    text: skills
      .map((item) => `### Skill: ${item.name}\n${item.text}`)
      .join("\n\n")
      .slice(0, totalChars),
    cacheHit: false,
  }
}