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
    const versionMatches = [
      readme.match(/Phiên bản package hiện tại:\*\*\s*<code>([^<]+)<\/code>/i),
      readme.match(/Phiên bản hiện tại:\s*\n```text\n(\S+)/i),
    ].filter(Boolean)
    const readmeVersion = versionMatches[0]?.[1] || null
    if (!readmeVersion) errors.push("README.md: could not find current package version")
    else if (readmeVersion !== version) errors.push(`README.md: current version says ${readmeVersion}, expected ${version}`)
    for (const marker of ["**Pi Agent**", "ues_execute", "ues_dispatch", "ues_cli", "V14.2 Turbo Weak-Model Runtime", "**15.6.0:** Measured Runtime & Durable Execution", "**15.7.0:** Adaptive Efficiency Intelligence", "**15.8.0:** Measured Hardening", "ues optimize-report", "ues trial", "--require-promotion", "npm view opencode-agent-skill version --registry=https://registry.npmjs.org/"]) {
      if (!readme.includes(marker)) errors.push(`README.md: missing Pi runtime marker ${marker}`)
    }
  }

  const piCompat = requireText(errors, readText(root, path.join("docs", "PI-COMPAT.md")), "docs/PI-COMPAT.md")
  if (piCompat) {
    for (const marker of ["# Pi Agent runtime", "Current package runtime:** 15.8.0", "ues_execute", "ues_dispatch", "ues_cli", "manifest is Pi-only", "V14.2 Turbo Weak-Model Runtime", "V15.1 deterministic admission and managed services", "V15.2 Turbo Fast Path", "V15.3 DEEP Speed", "V15.4 ACP-safe child runtime", "V15.5 Per-Leaf Turbo", "V15.6 Fast Planning", "V15.7 Lightweight Sandbox Cleanup", "V15.8 Measured Hardening", "V15.8 Plan Gate Recovery", "V15.9 Runtime Artifact Isolation", "V15.10 Adaptive Stability Runtime", "V15.11 Session Identity Sync", "V15.12 Safe Autopilot + Disk Hygiene", "V15.13 Read-Only Completion Semantics", "V15.14 Deterministic Read-Only Fast Path", "V15.15 Execution Contracts + Phase Gates", "V15.16 Portable Cross-Tool Temp Paths", "V15.17 Zero-Friction Autopilot Admission", "V15.18 Three-Tier Zero-Friction Routing", "V15.19 Finalization Hardening", "ues_service"]) {
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
    if (!/CONCRETE_DIAGNOSIS/.test(canonicalPolicy) || !/diagnosisEvidence/.test(canonicalPolicy)) errors.push("lib/task-policy.mjs: missing V15.3 diagnosis deduplication contract")
  }

  if (pkg) {
    const scripts = pkg.scripts || {}
    if (scripts.test !== "node scripts/run-test-suite.mjs") {
      errors.push("package.json: npm test must run the bounded per-file test runner")
    }
    const focusedPi = String(scripts["test:pi"] || "").trim().split(/\s+/).filter(Boolean)
    if (
      focusedPi[0] !== "node" ||
      focusedPi[1] !== "scripts/run-test-suite.mjs" ||
      !focusedPi.includes("test/pi-package.test.mjs")
    ) {
      errors.push("package.json: missing bounded focused test:pi script")
    }
    if (scripts["test:node"] !== "node --test") {
      errors.push("package.json: test:node must preserve raw Node test discovery for diagnosis")
    }
    if (scripts["docs:check"] !== "node scripts/check-release-consistency.mjs") errors.push("package.json: missing docs:check release-consistency script")
    if (scripts["release:check-tag"] !== "node scripts/check-release-tag.mjs") errors.push("package.json: missing release:check-tag script")
    if (scripts["eval:pi"] !== "node scripts/eval-pi.mjs") errors.push("package.json: missing Pi-native eval:pi script")
    const focusedV15 = String(scripts["eval:v15"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredFocusedV15Tests = [
      "test/v15-runtime.test.mjs",
      "test/trajectory.test.mjs",
      "test/evidence-store-v11.test.mjs",
      "test/runtime-events.test.mjs",
      "test/v14.3-intelligence.test.mjs",
      "test/v14.2-runtime.test.mjs",
      "test/pi-package.test.mjs",
      "test/execution-contract.test.mjs",
    ]
    if (
      focusedV15[0] !== "node" ||
      focusedV15[1] !== "scripts/run-test-suite.mjs" ||
      !requiredFocusedV15Tests.every((file) => focusedV15.includes(file))
    ) {
      errors.push("package.json: focused eval:v15 must use the bounded runner and include the current V15 runtime, disk-safety, intelligence and Pi-package regression set")
    }
    if (!String(scripts.ci || "").includes("npm run integrity")) errors.push("package.json: ci must include source-integrity gate")
    if (scripts["runtime:exports"] !== "node scripts/check-runtime-exports.mjs") errors.push("package.json: missing runtime:exports import/export gate")
    if (!String(scripts.ci || "").includes("npm run runtime:exports")) errors.push("package.json: ci must include runtime export gate")
    if (!String(scripts.ci || "").includes("npm run docs:check")) errors.push("package.json: ci must include docs:check")
    if (!String(scripts.ci || "").includes("npm test")) errors.push("package.json: ci must include full npm test")
    if (!String(scripts.ci || "").includes("npm run smoke:packed")) errors.push("package.json: ci must include smoke:packed")
    if (pkg.pi?.extensions?.[0] !== "./pi/extensions/ues.ts") errors.push("package.json: Pi extension entry drift")
    if (!Array.isArray(pkg.pi?.skills) || !pkg.pi.skills.includes("./global-config/skills")) errors.push("package.json: Pi skills entry drift")
    if (!Array.isArray(pkg.pi?.prompts) || !pkg.pi.prompts.includes("./pi/prompts/*.md")) errors.push("package.json: Pi prompts entry drift")
    if (!Array.isArray(pkg.files) || !pkg.files.includes("global-config/AGENTS.md")) errors.push("package.json: installer runtime data global-config/AGENTS.md must be packed")
    if (!pkg.files.includes("docs/V14.2-TURBO-WEAK-MODEL-RUNTIME.md")) errors.push("package.json: V14.2 runtime documentation must be packed")
    if (!pkg.files.includes("docs/V15-MANAGED-RUNTIME.md")) errors.push("package.json: V15 managed-runtime documentation must be packed")
    if (scripts["smoke:packed"] !== "node scripts/smoke-packed-install.mjs") errors.push("package.json: missing smoke:packed integration script")
    const focusedV156 = String(scripts["eval:v15.6"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV156Tests = [
      "test/v15-6-runtime.test.mjs",
      "test/v15-5-runtime.test.mjs",
      "test/runtime-events.test.mjs",
      "test/compaction-resume-guard.test.mjs",
    ]
    if (
      focusedV156[0] !== "node" ||
      focusedV156[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV156Tests.every((file) => focusedV156.includes(file))
    ) {
      errors.push("package.json: eval:v15.6 must use the bounded runner and include durable/runtime regression coverage")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v15.6")) {
      errors.push("package.json: release:verify must include eval:v15.6")
    }
    if (scripts.prepublishOnly !== "npm run release:verify") {
      errors.push("package.json: prepublishOnly must run the full release:verify gate")
    }
    if (scripts["inspect:run"] !== "node scripts/inspect-run.mjs") {
      errors.push("package.json: missing v15.6 inspect:run command")
    }
    if (!pkg.files.includes("docs/V15.6-MEASURED-DURABLE-RUNTIME.md")) {
      errors.push("package.json: V15.6 runtime documentation must be packed")
    }
    const focusedV157 = String(scripts["eval:v15.7"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV157Tests = [
      "test/v15-7-runtime.test.mjs",
      "test/v15-6-runtime.test.mjs",
      "test/v15-5-runtime.test.mjs",
      "test/runtime-events.test.mjs",
      "test/compaction-resume-guard.test.mjs",
    ]
    if (
      focusedV157[0] !== "node" ||
      focusedV157[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV157Tests.every((file) => focusedV157.includes(file))
    ) {
      errors.push("package.json: eval:v15.7 must use the bounded runner and include adaptive-efficiency plus durable/runtime regressions")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v15.7")) {
      errors.push("package.json: release:verify must include eval:v15.7")
    }
    if (scripts.trial !== "node scripts/ues-trial.mjs") {
      errors.push("package.json: missing v15.7 trial command")
    }
    if (scripts["optimize:report"] !== "node scripts/runtime-waste-report.mjs") {
      errors.push("package.json: missing v15.7 optimize:report command")
    }
    if (!pkg.files.includes("docs/V15.7-ADAPTIVE-EFFICIENCY-INTELLIGENCE.md")) {
      errors.push("package.json: V15.7 runtime documentation must be packed")
    }
    const focusedV158 = String(scripts["eval:v15.8"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV158Tests = [
      "test/v15-8-runtime.test.mjs",
      "test/v15-7-runtime.test.mjs",
      "test/benchmark-confidence.test.mjs",
      "test/runtime-events.test.mjs",
      "test/compaction-resume-guard.test.mjs",
    ]
    if (
      focusedV158[0] !== "node" ||
      focusedV158[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV158Tests.every((file) => focusedV158.includes(file))
    ) {
      errors.push("package.json: eval:v15.8 must use the bounded runner and include measured-hardening regressions")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v15.8")) {
      errors.push("package.json: release:verify must include eval:v15.8")
    }
    if (scripts["trial:gate"] !== "node scripts/ues-trial.mjs --require-promotion") {
      errors.push("package.json: missing v15.8 fail-closed real-model promotion command")
    }
    if (!pkg.files.includes("docs/V15.8-MEASURED-HARDENING.md")) {
      errors.push("package.json: V15.8 runtime documentation must be packed")
    }
  }

  if (skillCount < 40) warnings.push(`skill catalog unexpectedly small: ${skillCount}`)
  if (promptCount !== 10) errors.push(`Pi must expose exactly 10 prompt templates; /ues-run is an extension command, found ${promptCount}`)
  if (existsSync(path.join(root, "pi", "prompts", "ues-run.md"))) {
    errors.push("pi/prompts/ues-run.md must not exist because it duplicates the deterministic extension /ues-run command")
  }

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