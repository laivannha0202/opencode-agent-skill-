#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function readJson(root, relative) {
  const file = path.join(root, relative)
  if (!existsSync(file)) {
    return { ok: false, error: `${relative}: file not found`, value: null }
  }
  try {
    return { ok: true, error: null, value: JSON.parse(readFileSync(file, "utf8")) }
  } catch (e) {
    return { ok: false, error: `${relative}: invalid JSON (${e.message})`, value: null }
  }
}

function readText(root, relative) {
  const file = path.join(root, relative)
  if (!existsSync(file)) {
    return { ok: false, error: `${relative}: file not found`, value: null }
  }
  return { ok: true, error: null, value: readFileSync(file, "utf8") }
}

function countSkillDirs(root) {
  const fullPath = path.join(root, "global-config", "skills")
  if (!existsSync(fullPath)) return { ok: false, error: "global-config/skills: directory not found", value: 0 }
  const entries = readdirSync(fullPath, { withFileTypes: true })
  const count = entries.filter((entry) => entry.isDirectory() && existsSync(path.join(fullPath, entry.name, "SKILL.md"))).length
  return { ok: true, error: null, value: count }
}

function countDir(root, dirPath, filter) {
  const fullPath = path.join(root, dirPath)
  if (!existsSync(fullPath)) {
    return { ok: false, error: `${dirPath}: directory not found`, value: 0 }
  }
  const entries = readdirSync(fullPath, { withFileTypes: true })
  const count = filter ? entries.filter(filter).length : entries.length
  return { ok: true, error: null, value: count }
}

export function checkReleaseConsistency(root) {
  root = root || DEFAULT_ROOT
  const errors = []
  const warnings = []

  function rJson(relative) {
    return readJson(root, relative)
  }
  function rText(relative) {
    return readText(root, relative)
  }
  function rCount(dirPath, filter) {
    return countDir(root, dirPath, filter)
  }

  // 1. package.json version == package-lock.json version
  const pkg = rJson("package.json")
  const lock = rJson("package-lock.json")
  if (pkg.ok && lock.ok) {
    const pkgVersion = pkg.value.version
    const lockVersion = lock.value.version
    if (pkgVersion !== lockVersion) {
      errors.push(`package.json version (${pkgVersion}) != package-lock.json version (${lockVersion})`)
    }
  } else {
    if (!pkg.ok) errors.push(pkg.error)
    if (!lock.ok) errors.push(lock.error)
  }

  // 2. Count skills, commands, subagents
  const skillRes = countSkillDirs(root)
  const commandRes = rCount("global-config/commands", (e) => e.isFile() && e.name.endsWith(".md"))
  const agentRes = rCount("global-config/agents", (e) => e.isFile() && e.name.endsWith(".md"))
  const skillCount = skillRes.ok ? skillRes.value : 0
  const commandCount = commandRes.ok ? commandRes.value : 0
  const agentCount = agentRes.ok ? agentRes.value : 0
  if (!skillRes.ok) errors.push(skillRes.error)
  if (!commandRes.ok) errors.push(commandRes.error)
  if (!agentRes.ok) errors.push(agentRes.error)

  const expectedVersion = pkg.ok ? pkg.value.version : "unknown"
  const routing = rJson("evals/routing.json")
  const routerTriggers = rJson("evals/router-triggers.json")
  const staticScenarioCount = routing.ok && Array.isArray(routing.value.scenarios) ? routing.value.scenarios.length : 0
  const routerCaseCount = routerTriggers.ok && Array.isArray(routerTriggers.value.cases) ? routerTriggers.value.cases.length : 0
  if (!routing.ok) errors.push(routing.error)
  if (!routerTriggers.ok) errors.push(routerTriggers.error)

  // 3. Check README current version block
  const readme = rText("README.md")
  if (readme.ok) {
    const versionMatch = readme.value.match(/Phiên bản hiện tại:\s*\n```text\n(\S+)/)
    if (versionMatch && versionMatch[1] !== expectedVersion) {
      errors.push(`README.md: current version says ${versionMatch[1]}, expected ${expectedVersion}`)
    } else if (!versionMatch) {
      errors.push("README.md: could not find current version block")
    }
    if (staticScenarioCount && !readme.value.includes("**" + staticScenarioCount + " static skill-routing scenarios**")) {
      errors.push("README.md: static routing scenario count drift (actual: " + staticScenarioCount + ")")
    }
    if (routerCaseCount && !readme.value.includes("**" + routerCaseCount + " V2 router cases**")) {
      errors.push("README.md: router case count drift (actual: " + routerCaseCount + ")")
    }
  } else {
    errors.push(readme.error)
  }

  // 4. Check V11 docs for stale status markers
  const v11Docs = ["docs/V11-PERCEPTION-ADAPTIVE.md", "docs/V11-PERCEPTION-ADAPTIVE-EXECUTION.md"]
  for (const doc of v11Docs) {
    const content = rText(doc)
    if (!content.ok) {
      errors.push(content.error)
      continue
    }
    if (content.value.includes("Status: development")) {
      errors.push(`${doc}: still marked as development`)
    }
    if (content.value.includes("11.0.0-dev.")) {
      errors.push(`${doc}: still references dev version 11.0.0-dev.*`)
    }
    if (content.value.includes("npm `latest` remains V10")) {
      errors.push(`${doc}: still says V10 remains npm latest`)
    }
  }

  // 5. Verify docs reflect actual counts (skip historical sections)
  const docsToCheck = ["README.md", "docs/ENGINEERING-DESIGN.md", "docs/OPENCODE-COMPAT.md"]
  for (const doc of docsToCheck) {
    const content = rText(doc)
    if (!content.ok) {
      errors.push(content.error)
      continue
    }
    const sections = content.value.split(/\n(?=#{1,6}\s)/)
    for (const section of sections) {
      const isHistorical = /^\s*#{1,6}\s+.*(V\d+\.|UES\s+\d+\.|historical|Historical)/im.test(section)
      if (isHistorical) continue
      if (section.includes("39 skills") || section.includes("39 namespaced skills")) {
        errors.push(`${doc}: current section still references 39 skills (actual: ${skillCount})`)
      }
      if (section.includes("10 namespaced subagents") || section.includes("10 subagents")) {
        errors.push(`${doc}: current section still references 10 subagents (actual: ${agentCount})`)
      }
      if (section.includes("34 static") && section.includes("scenarios")) {
        errors.push(`${doc}: current section still references 34 static scenarios (actual: ${staticScenarioCount})`)
      }
    }
  }

  // 6. Check CI workflow
  const ciYaml = rText(".github/workflows/ci.yml")
  if (ciYaml.ok) {
    if (!ciYaml.value.includes("evals:v11:validate")) {
      errors.push(".github/workflows/ci.yml: missing evals:v11:validate job")
    }
    if (!/^\s*name:\s*CI Gate\s*$/m.test(ciYaml.value)) errors.push(".github/workflows/ci.yml: missing CI Gate aggregate job name")
    if (!/needs:\s*\[\s*static\s*,\s*unit\s*,\s*package\s*\]/m.test(ciYaml.value)) errors.push(".github/workflows/ci.yml: CI Gate must depend on static, unit and package")
    if (!/if:\s*always\(\)/m.test(ciYaml.value)) errors.push(".github/workflows/ci.yml: aggregate gate must use if: always()")
    if (!ciYaml.value.includes("docs:check")) errors.push(".github/workflows/ci.yml: missing docs:check job")
    for (const check of ["evals:v12:validate","evals:repo-scale:validate"]) {
      if (!ciYaml.value.includes(check)) errors.push(".github/workflows/ci.yml: missing " + check + " job")
    }
  } else {
    errors.push(ciYaml.error)
  }

  // 7. Check Security workflow
  const securityYaml = rText(".github/workflows/security.yml")
  if (securityYaml.ok) {
    if (!/^\s*name:\s*Security Gate\s*$/m.test(securityYaml.value)) errors.push(".github/workflows/security.yml: missing Security Gate aggregate job name")
    if (!/needs:\s*\[\s*codeql\s*,\s*dependency-review\s*\]/m.test(securityYaml.value)) errors.push(".github/workflows/security.yml: Security Gate must depend on codeql and dependency-review")
  } else {
    errors.push(securityYaml.error)
  }

  // 8. Check publish workflow idempotency
  const publishYaml = rText(".github/workflows/publish.yml")
  if (publishYaml.ok) {
    if (!publishYaml.value.includes("already published")) {
      errors.push(".github/workflows/publish.yml: missing idempotency check for existing versions")
    }
  } else {
    errors.push(publishYaml.error)
  }

  // 9. Check npm script docs:check exists
  if (pkg.ok) {
    const pkgScripts = pkg.value.scripts || {}
    if (!pkgScripts["docs:check"]) {
      warnings.push("package.json: missing docs:check npm script")
    }
  }

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    version: expectedVersion,
    skillCount,
    commandCount,
    subagentCount: agentCount,
    staticScenarioCount,
    routerCaseCount,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkReleaseConsistency(process.env.UES_BUNDLE_ROOT || DEFAULT_ROOT)
  if (result.warnings.length) {
    console.warn("Warnings:")
    for (const w of result.warnings) console.warn(`  WARN: ${w}`)
  }
  if (result.errors.length) {
    console.error("Release consistency check FAILED:")
    for (const e of result.errors) console.error(`  - ${e}`)
    process.exit(1)
  }
  console.log(
    `Release consistency check PASS: package=${result.version}, skills=${result.skillCount}, commands=${result.commandCount}, subagents=${result.subagentCount}`,
  )
}
