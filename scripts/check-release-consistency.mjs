#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function readJson(root, relative) {
  const file = path.join(root, relative)
  if (!existsSync(file)) return { ok: false, error: `${relative}: file not found`, value: null }
  try {
    return { ok: true, error: null, value: JSON.parse(readFileSync(file, "utf8")) }
  } catch (error) {
    return {
      ok: false,
      error: `${relative}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
      value: null,
    }
  }
}

function readText(root, relative) {
  const file = path.join(root, relative)
  if (!existsSync(file)) return { ok: false, error: `${relative}: file not found`, value: null }
  return { ok: true, error: null, value: readFileSync(file, "utf8") }
}

function countDir(root, relative, predicate) {
  const dir = path.join(root, relative)
  if (!existsSync(dir)) return { ok: false, error: `${relative}: directory not found`, value: 0 }
  const entries = readdirSync(dir, { withFileTypes: true })
  return {
    ok: true,
    error: null,
    value: predicate ? entries.filter(predicate).length : entries.length,
  }
}

function countSkills(root) {
  return countDir(root, path.join("global-config", "skills"), (entry) =>
    entry.isDirectory() && existsSync(path.join(root, "global-config", "skills", entry.name, "SKILL.md"))
  )
}

function requireText(errors, result, relative) {
  if (result.ok) return result.value
  errors.push(result.error || `${relative}: unavailable`)
  return ""
}

export function checkReleaseConsistency(root = DEFAULT_ROOT) {
  const errors = []
  const warnings = []

  const pkgResult = readJson(root, "package.json")
  const lockResult = readJson(root, "package-lock.json")
  const pkg = pkgResult.ok ? pkgResult.value : null
  const lock = lockResult.ok ? lockResult.value : null
  if (!pkgResult.ok) errors.push(pkgResult.error)
  if (!lockResult.ok) errors.push(lockResult.error)

  const version = pkg?.version || "unknown"
  if (pkg && lock && pkg.version !== lock.version) {
    errors.push(`package.json version (${pkg.version}) != package-lock.json version (${lock.version})`)
  }
  if (pkg && lock?.packages?.[""]?.version && pkg.version !== lock.packages[""].version) {
    errors.push(`package-lock root package version (${lock.packages[""].version}) != package.json version (${pkg.version})`)
  }

  const expectedBins = { ues: "bin/ocskill.mjs", ocskill: "bin/ocskill.mjs" }
  if (pkg) {
    for (const [name, target] of Object.entries(expectedBins)) {
      if (pkg.bin?.[name] !== target) errors.push(`package.json: bin.${name} must be ${target}`)
      if (lock?.packages?.[""]?.bin?.[name] !== target) {
        errors.push(`package-lock.json: root bin.${name} must be ${target}`)
      }
    }
  }

  const skillResult = countSkills(root)
  const commandResult = countDir(root, path.join("global-config", "commands"), (entry) => entry.isFile() && entry.name.endsWith(".md"))
  const agentResult = countDir(root, path.join("global-config", "agents"), (entry) => entry.isFile() && entry.name.endsWith(".md"))
  const promptResult = countDir(root, path.join("pi", "prompts"), (entry) => entry.isFile() && entry.name.endsWith(".md"))
  for (const result of [skillResult, commandResult, agentResult, promptResult]) {
    if (!result.ok) errors.push(result.error)
  }
  const skillCount = skillResult.value || 0
  const commandCount = commandResult.value || 0
  const subagentCount = agentResult.value || 0
  const promptCount = promptResult.value || 0

  const routing = readJson(root, path.join("evals", "routing.json"))
  const routerTriggers = readJson(root, path.join("evals", "router-triggers.json"))
  if (!routing.ok) errors.push(routing.error)
  if (!routerTriggers.ok) errors.push(routerTriggers.error)
  const staticScenarioCount = routing.ok && Array.isArray(routing.value.scenarios) ? routing.value.scenarios.length : 0
  const routerCaseCount = routerTriggers.ok && Array.isArray(routerTriggers.value.cases) ? routerTriggers.value.cases.length : 0

  const readme = requireText(errors, readText(root, "README.md"), "README.md")
  if (readme) {
    const match = readme.match(/Phiên bản hiện tại:\s*\n```text\n(\S+)/)
    if (!match) errors.push("README.md: could not find current version block")
    else if (match[1] !== version) errors.push(`README.md: current version says ${match[1]}, expected ${version}`)
    for (const marker of ["**Pi Agent**", "`ues_execute`", "`ues_dispatch`", "`ues_cli`"]) {
      if (!readme.includes(marker)) errors.push(`README.md: missing Pi runtime marker ${marker}`)
    }
  }

  const piCompat = requireText(errors, readText(root, path.join("docs", "PI-COMPAT.md")), "docs/PI-COMPAT.md")
  if (piCompat) {
    for (const marker of ["# Pi Agent runtime", "ues_execute", "ues_dispatch", "ues_cli", "manifest is Pi-only"]) {
      if (!piCompat.includes(marker)) errors.push(`docs/PI-COMPAT.md: missing current Pi contract marker ${marker}`)
    }
  }

  const openCodeCompat = requireText(errors, readText(root, path.join("docs", "OPENCODE-COMPAT.md")), "docs/OPENCODE-COMPAT.md")
  if (openCodeCompat) {
    for (const marker of ["Deprecated compatibility surface", "supported runtime in this repository is **Pi Agent**", "canonical runtime lives under `pi/` and `lib/`", "compatibility shim"]) {
      if (!openCodeCompat.includes(marker)) errors.push(`docs/OPENCODE-COMPAT.md: missing legacy-boundary marker ${marker}`)
    }
  }

  const orchestrator = requireText(errors, readText(root, path.join("lib", "orchestrator-policy.mjs")), "lib/orchestrator-policy.mjs")
  const legacyPolicy = requireText(errors, readText(root, path.join("global-config", "plugins", "ues-router", "policy-runtime.js")), "global-config/plugins/ues-router/policy-runtime.js")
  const canonicalPolicy = requireText(errors, readText(root, path.join("lib", "task-policy.mjs")), "lib/task-policy.mjs")
  if (orchestrator && !/from "\.\/task-policy\.mjs"/.test(orchestrator)) {
    errors.push("lib/orchestrator-policy.mjs: must delegate to Pi-native lib/task-policy.mjs")
  }
  if (legacyPolicy && !/from "\.\.\/\.\.\/\.\.\/lib\/task-policy\.mjs"/.test(legacyPolicy)) {
    errors.push("global-config/plugins/ues-router/policy-runtime.js: must remain a shim to lib/task-policy.mjs")
  }
  if (canonicalPolicy) {
    if (!/export function classifyEngineeringTask/.test(canonicalPolicy)) errors.push("lib/task-policy.mjs: missing classifyEngineeringTask")
    if (!/export function recoveryPolicyForAttempt/.test(canonicalPolicy)) errors.push("lib/task-policy.mjs: missing recoveryPolicyForAttempt")
  }

  if (pkg) {
    const scripts = pkg.scripts || {}
    if (scripts.test !== "node --test") errors.push("package.json: npm test must run portable full Node test discovery")
    if (scripts["test:pi"] !== "node --test test/pi-package.test.mjs") errors.push("package.json: missing focused test:pi script")
    if (scripts["docs:check"] !== "node scripts/check-release-consistency.mjs") errors.push("package.json: missing docs:check release-consistency script")
    if (scripts["release:check-tag"] !== "node scripts/check-release-tag.mjs") errors.push("package.json: missing release:check-tag script")
    if (scripts["eval:pi"] !== "node scripts/eval-pi.mjs") errors.push("package.json: missing Pi-native eval:pi script")
    if (!String(scripts.ci || "").includes("npm run docs:check")) errors.push("package.json: ci must include docs:check")
    if (!String(scripts.ci || "").includes("npm test")) errors.push("package.json: ci must include full npm test")
    if (pkg.pi?.extensions?.[0] !== "./pi/extensions/ues.ts") errors.push("package.json: Pi extension entry drift")
    if (!Array.isArray(pkg.pi?.skills) || !pkg.pi.skills.includes("./global-config/skills")) errors.push("package.json: Pi skills entry drift")
    if (!Array.isArray(pkg.pi?.prompts) || !pkg.pi.prompts.includes("./pi/prompts/*.md")) errors.push("package.json: Pi prompts entry drift")
    if (!Array.isArray(pkg.files) || !pkg.files.includes("global-config/AGENTS.md")) errors.push("package.json: installer runtime data global-config/AGENTS.md must be packed")
    if (scripts["smoke:packed"] !== "node scripts/smoke-packed-install.mjs") errors.push("package.json: missing smoke:packed integration script")
  }

  const ci = requireText(errors, readText(root, path.join(".github", "workflows", "ci.yml")), ".github/workflows/ci.yml")
  if (ci) {
    if (!ci.includes("ubuntu-latest") || !ci.includes("windows-latest")) errors.push(".github/workflows/ci.yml: Pi runtime matrix must cover Linux and Windows")
    if (!ci.includes("npm run ci")) errors.push(".github/workflows/ci.yml: must execute canonical npm run ci")
    if (!/^\s*name:\s*CI Gate\s*$/m.test(ci)) errors.push(".github/workflows/ci.yml: missing CI Gate aggregate job name")
    if (!/needs:\s*\[\s*pi\s*\]/m.test(ci)) errors.push(".github/workflows/ci.yml: CI Gate must depend on pi")
    if (!/if:\s*always\(\)/m.test(ci)) errors.push(".github/workflows/ci.yml: aggregate gate must use if: always()")
  }

  const security = requireText(errors, readText(root, path.join(".github", "workflows", "security.yml")), ".github/workflows/security.yml")
  if (security) {
    if (!/^\s*name:\s*Security Gate\s*$/m.test(security)) errors.push(".github/workflows/security.yml: missing Security Gate aggregate job name")
    if (!/needs:\s*\[\s*codeql\s*,\s*dependency-review\s*\]/m.test(security)) {
      errors.push(".github/workflows/security.yml: Security Gate must depend on codeql and dependency-review")
    }
  }

  const publish = requireText(errors, readText(root, path.join(".github", "workflows", "publish.yml")), ".github/workflows/publish.yml")
  if (publish) {
    if (!publish.includes("npm run release:check-tag")) errors.push(".github/workflows/publish.yml: must verify release tag")
    if (!publish.includes("already published")) errors.push(".github/workflows/publish.yml: missing idempotency check for existing versions")
  }

  if (skillCount < 40) warnings.push(`skill catalog unexpectedly small: ${skillCount}`)
  if (promptCount < 10) warnings.push(`Pi prompt catalog unexpectedly small: ${promptCount}`)

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    version,
    skillCount,
    commandCount,
    subagentCount,
    promptCount,
    staticScenarioCount,
    routerCaseCount,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkReleaseConsistency(process.env.UES_BUNDLE_ROOT || DEFAULT_ROOT)
  if (result.warnings.length) {
    console.warn("Warnings:")
    for (const warning of result.warnings) console.warn(`  WARN: ${warning}`)
  }
  if (result.errors.length) {
    console.error("Release consistency check FAILED:")
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(
    `Release consistency check PASS: package=${result.version}, skills=${result.skillCount}, prompts=${result.promptCount}, subagents=${result.subagentCount}`,
  )
}
