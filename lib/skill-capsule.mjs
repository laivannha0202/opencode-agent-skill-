// V16.5 Phase 4: Skill Capsule / Skill Composition.
//
// Concatenating four SKILL.md bodies to answer a payment+auth+Next.js+bug task is
// how skill noise is created. A capsule instead compiles a bounded, ordered,
// provenance-tagged block: task contract, required constraints, procedure, rules.
//
// Invariants:
// - required constraints (MUST / MUST NOT / never / always / rollback / verify)
//   are allocated budget FIRST and are never truncated or dropped;
// - ordering is deterministic for identical inputs;
// - identical inputs produce an identical cache fingerprint;
// - the capsule is always expandable back to full sections on explicit request.

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { skillRegistry } from "./skill-registry.mjs"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS_ROOT = path.join(PACKAGE_ROOT, "global-config", "skills")

export const SKILL_CAPSULE_SCHEMA_VERSION = 1
export const CAPSULE_CLASSES = Object.freeze(["constraints", "procedure", "rules", "reference"])
export const DEFAULT_CAPSULE_CHARS = 2_600
export const MIN_CAPSULE_CHARS = 600
export const MAX_CAPSULE_CHARS = 8_000

const SECTION_CACHE = new Map()
const CAPSULE_CACHE = new Map()
const CAPSULE_CACHE_LIMIT = 64

const CONSTRAINT_PATTERN = /\b(must|must not|mustn't|never|always|shall|require[sd]?|forbidden|prohibited|do not|don't|no\b|cannot|rollback|revert|idempot|verify|verified|verification|security|safety|integrity|transaction|atomic|fail.closed|secret|permission|authoriz)/i

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function stripFrontmatter(raw) {
  return String(raw || "").replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "")
}

/**
 * Parse a SKILL.md body into ordered sections with provenance.
 * Returns { title, sections: [{ heading, kind, lines:[{text,lineStart}] }] }.
 */
export function parseSkillSource(raw) {
  const body = stripFrontmatter(raw)
  const lines = body.split(/\r?\n/)
  const sections = []
  let heading = "(preamble)"
  let buffer = []
  const flush = () => {
    const kept = buffer.filter((entry) => entry.text.trim())
    if (kept.length) sections.push({ heading, kind: classifyHeading(heading), lines: kept })
    buffer = []
  }
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].trim()
    const match = text.match(/^#{1,3}\s+(.*)$/)
    if (match) {
      flush()
      heading = match[1].trim()
      continue
    }
    if (!text) continue
    buffer.push({ text, lineStart: index + 1 })
  }
  flush()
  return { sections }
}

function classifyHeading(heading) {
  const value = String(heading || "").toLowerCase()
  if (/\b(must|rule|constraint|invariant|boundary|forbidden|prohibited|safety|security|never|guard|gate|policy)\b/.test(value)) return "constraints"
  if (/\b(steps?|procedure|process|workflow|how|playbook|diagnos\w*|checklist|do this|fix)\b/.test(value)) return "procedure"
  if (/\b(reference|api|schema|config|option|table|example|note|detail|compatib)\b/.test(value)) return "reference"
  return "rules"
}

async function skillSource(name) {
  if (SECTION_CACHE.has(name)) return SECTION_CACHE.get(name)
  const file = path.join(SKILLS_ROOT, name, "SKILL.md")
  if (!existsSync(file)) return { name, raw: "", rawChars: 0, parsed: { sections: [] } }
  const raw = await readFile(file, "utf8").catch(() => "")
  const value = { name, raw, rawChars: raw.length, parsed: parseSkillSource(raw) }
  SECTION_CACHE.set(name, value)
  return value
}

/** Split one section into constraint vs non-constraint entries, deterministically. */
function splitSection(section) {
  const constraints = []
  const rest = []
  for (const entry of section.lines) {
    const isConstraint = CONSTRAINT_PATTERN.test(entry.text) || /^\s*[-*]\s*\*\*/.test(entry.text)
    ;(isConstraint ? constraints : rest).push({ ...entry, heading: section.heading, kind: section.kind })
  }
  return { constraints, rest }
}

/**
 * Compile a bounded capsule for a set of skill ids.
 *
 * @param {object} input
 * @param {string[]} input.skillIds        activated skills (V16.5 router output)
 * @param {string}   [input.taskContract]  one-line task contract prepended to the capsule
 * @param {number}   [input.budgetChars]   bounded model-facing char budget
 * @param {number}   [input.skillsConsidered] router candidate count for telemetry
 */
export async function compileSkillCapsule(input = {}) {
  const registry = skillRegistry()
  const skillIds = [...new Set((input.skillIds || []).map(String).filter((id) => registry.byId.has(id)))].sort()
  const budgetChars = Math.max(MIN_CAPSULE_CHARS, Math.min(MAX_CAPSULE_CHARS, Number(input.budgetChars) || DEFAULT_CAPSULE_CHARS))
  const taskContract = String(input.taskContract || "").trim().slice(0, 400)

  const cacheKey = hash([skillIds, budgetChars, taskContract, input.registryFingerprint || registry.fingerprint])
  const cached = CAPSULE_CACHE.get(cacheKey)
  if (cached) {
    const hit = {
      ...cached,
      cacheHit: true,
      telemetry: { ...cached.telemetry, skillCacheHit: true },
    }
    return hit
  }

  const sources = await Promise.all(skillIds.map((name) => skillSource(name)))
  const buckets = { constraints: [], procedure: [], rules: [], reference: [] }
  const provenance = []

  for (const source of sources) {
    const seen = new Set()
    for (const section of source.parsed.sections) {
      const { constraints, rest } = splitSection(section)
      for (const entry of constraints) buckets.constraints.push({ ...entry, skillId: source.name })
      for (const entry of rest) {
        const target = entry.kind === "constraints" ? "constraints" : entry.kind
        buckets[target].push({ ...entry, skillId: source.name })
      }
      if (!seen.has(section.heading)) {
        seen.add(section.heading)
        provenance.push({
          skillId: source.name,
          heading: section.heading,
          sectionKind: section.kind,
          lineStart: section.lines[0]?.lineStart || 1,
          entryCount: section.lines.length,
        })
      }
    }
  }

  // Deterministic ordering: skill id, then source line.
  for (const key of CAPSULE_CLASSES) {
    buckets[key].sort((a, b) => a.skillId.localeCompare(b.skillId) || a.lineStart - b.lineStart || a.text.localeCompare(b.text))
  }

  const rawSkillChars = sources.reduce((sum, source) => sum + source.rawChars, 0)
  const contractChars = taskContract ? taskContract.length + 2 : 0

  // Budget allocation: constraints are non-negotiable and are charged first.
  const selected = { constraints: [], procedure: [], rules: [], reference: [] }
  let used = contractChars + 16
  const maxPerClass = { constraints: budgetChars, procedure: Math.floor(budgetChars * 0.3), rules: Math.floor(budgetChars * 0.2), reference: Math.floor(budgetChars * 0.1) }
  const classUsed = { constraints: 0, procedure: 0, rules: 0, reference: 0 }

  for (const entry of buckets.constraints) {
    const cost = entry.text.length + 1
    if (used + cost > budgetChars && selected.constraints.length) continue
    selected.constraints.push(entry)
    used += cost
    classUsed.constraints += cost
  }
  for (const key of ["procedure", "rules", "reference"]) {
    for (const entry of buckets[key]) {
      const cost = entry.text.length + 1
      if (used + cost > budgetChars) break
      if (classUsed[key] + cost > maxPerClass[key]) break
      selected[key].push(entry)
      used += cost
      classUsed[key] += cost
    }
  }

  const renderSections = (key, heading) => {
    if (!selected[key].length) return ""
    const lines = selected[key].map((entry) => `- [${entry.skillId}] ${entry.text}`)
    return `### ${heading}\n${lines.join("\n")}`
  }

  const parts = []
  if (taskContract) parts.push(`## Task contract\n${taskContract}`)
  if (selected.constraints.length) parts.push(renderSections("constraints", "Required constraints (never relaxed)"))
  if (selected.procedure.length) parts.push(renderSections("procedure", "Procedure"))
  if (selected.rules.length) parts.push(renderSections("rules", "Applicable rules"))
  if (selected.reference.length) parts.push(renderSections("reference", "Reference notes"))
  const text = parts.join("\n\n").slice(0, budgetChars + taskContract.length + 200)

  const capsule = {
    schemaVersion: SKILL_CAPSULE_SCHEMA_VERSION,
    skillsActivated: skillIds,
    skillsConsidered: Number(input.skillsConsidered || 0),
    sections: CAPSULE_CLASSES.filter((key) => selected[key].length).map((key) => ({
      section: key,
      skillIds: [...new Set(selected[key].map((entry) => entry.skillId))],
      entryCount: selected[key].length,
    })),
    provenance,
    constraintCount: selected.constraints.length,
    text,
    chars: text.length,
    budgetChars,
    rawSkillChars,
    fingerprint: "skill-capsule:sha256:" + cacheKey,
    cacheHit: false,
    telemetry: {
      skillsConsidered: Number(input.skillsConsidered || 0),
      skillsActivated: skillIds.length,
      skillCapsuleChars: text.length,
      rawSkillCharsAvoided: Math.max(0, rawSkillChars - text.length),
      skillCacheHit: false,
      skillExpansionCount: Number(input.expansionCount || 0),
      evidence: rawSkillChars ? "MEASURED" : "NOT_MEASURED",
    },
  }

  if (CAPSULE_CACHE.size >= CAPSULE_CACHE_LIMIT) CAPSULE_CACHE.delete(CAPSULE_CACHE.keys().next().value)
  CAPSULE_CACHE.set(cacheKey, capsule)
  return capsule
}

/**
 * Expand the capsule back to full source text for an explicit skill/section.
 * This is the escape hatch that keeps the capsule reversible.
 */
export async function expandSkillCapsule(input = {}) {
  const skillIds = [...new Set((input.skillIds || []).map(String))].sort()
  const maxChars = Math.max(400, Math.min(24_000, Number(input.maxChars) || 6_000))
  const sources = await Promise.all(skillIds.map((name) => skillSource(name)))
  const parts = []
  let used = 0
  for (const source of sources) {
    if (!source.raw) continue
    for (const section of source.parsed.sections) {
      if (input.section && section.kind !== input.section) continue
      const body = section.lines.map((entry) => entry.text).join("\n")
      const rendered = `### ${source.name} :: ${section.heading}\n${body}`
      if (used + rendered.length > maxChars) break
      parts.push(rendered)
      used += rendered.length
    }
  }
  const text = parts.join("\n\n")
  return {
    schemaVersion: SKILL_CAPSULE_SCHEMA_VERSION,
    expanded: true,
    skillIds,
    section: input.section || null,
    chars: text.length,
    maxChars,
    truncated: used >= maxChars,
    fingerprint: "skill-capsule-expand:sha256:" + hash([skillIds, input.section || null, maxChars]),
    text,
  }
}

export function clearSkillCapsuleCache() {
  SECTION_CACHE.clear()
  CAPSULE_CACHE.clear()
}
