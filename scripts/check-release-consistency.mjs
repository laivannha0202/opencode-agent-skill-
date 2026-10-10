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
    // Version comes from a machine-readable marker, not from prose layout.
    const versionMatches = [
      readme.match(/<!--\s*ues-version:\s*([^\s>]+)\s*-->/i),
      readme.match(/\*\*Current package version:\*\*\s*`?([0-9][^`\s<]*)/i),
      readme.match(/Phiên bản package hiện tại:\*\*\s*<code>([^<]+)<\/code>/i),
    ].filter(Boolean)
    const readmeVersion = versionMatches[0]?.[1] || null
    if (!readmeVersion) errors.push("README.md: could not find a machine-readable current-version marker (<!-- ues-version: X.Y.Z -->)")
    else if (readmeVersion !== version) errors.push(`README.md: current version says ${readmeVersion}, expected ${version}`)

    // Semantic section contract for the public landing page.
    for (const section of ["## What is UES?", "## Why UES?", "## Highlights", "## Architecture", "## Quick Start", "## Safety Model", "## Commands", "## Documentation", "## Development", "## Release Philosophy", "## License"]) {
      if (!readme.includes(section)) errors.push(`README.md: missing required section ${section}`)
    }
    // Pi runtime surface markers that must stay documented. The Pi-side command
    // contract (ues_execute / ues_dispatch / ues_cli) is asserted against
    // docs/PI-COMPAT.md below; the landing page only has to link that contract.
    for (const marker of ["Pi Agent", "npm install -g opencode-agent-skill", "pi package add opencode-agent-skill", "ues version", "ues doctor", "ues status", "ues trial", "docs/PI-COMPAT.md", "npm run eval:v16.5"]) {
      if (!readme.includes(marker)) errors.push(`README.md: missing Pi runtime marker ${marker}`)
    }
    // Anti-bloat gate: the landing page must stay a landing page.
    const readmeLines = readme.split(/\r?\n/).length
    if (readmeLines > 450) errors.push(`README.md: must stay under 450 lines for a public landing page (found ${readmeLines})`)
    if (/^>\s*\*\*\d+\.\d+\.\d+/m.test(readme)) errors.push("README.md: per-version release history must live in CHANGELOG.md, not in the landing page")
    if (/\b\d+% faster\b/i.test(readme)) errors.push("README.md: unmeasured speed claims are not allowed")
    for (const link of [...readme.matchAll(/\]\((\.[^)]+)\)/g)].map((match) => match[1])) {
      if (!existsSync(path.join(root, link))) errors.push(`README.md: broken relative link ${link}`)
    }
  }

  const changelog = requireText(errors, readText(root, "CHANGELOG.md"), "CHANGELOG.md")
  let changelogVersion = null
  if (changelog) {
    const match = changelog.match(/^## \[(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\]/m)
    changelogVersion = match?.[1] || null
    if (!changelogVersion) errors.push("CHANGELOG.md: could not find latest release version")
    else if (changelogVersion !== version) errors.push(`CHANGELOG.md: latest release says ${changelogVersion}, expected ${version}`)
  }
  if (lock && lock.version !== version) {
    errors.push(`package-lock.json version (${lock.version}) != package.json version (${version})`)
  }
  if (changelog && !changelog.includes("## [16.0.0] - 2026-10-02")) {
    errors.push("CHANGELOG.md: missing V16.0.0 release entry")
  }

  const piCompat = requireText(errors, readText(root, path.join("docs", "PI-COMPAT.md")), "docs/PI-COMPAT.md")
  if (piCompat) {
    for (const marker of ["# Pi Agent runtime", "Current package runtime:** 16.0.0", "V16 Deterministic Trust & Correctness Hardening", "V15.9 Adaptive Agent Intelligence", "ues_execute", "ues_dispatch", "ues_cli", "manifest is Pi-only", "V14.2 Turbo Weak-Model Runtime", "V15.1 deterministic admission and managed services", "V15.2 Turbo Fast Path", "V15.3 DEEP Speed", "V15.4 ACP-safe child runtime", "V15.5 Per-Leaf Turbo", "V15.6 Fast Planning", "V15.7 Lightweight Sandbox Cleanup", "V15.8 Measured Hardening", "V15.8 Plan Gate Recovery", "V15.9 Runtime Artifact Isolation", "V15.10 Adaptive Stability Runtime", "V15.11 Session Identity Sync", "V15.12 Safe Autopilot + Disk Hygiene", "V15.13 Read-Only Completion Semantics", "V15.14 Deterministic Read-Only Fast Path", "V15.15 Execution Contracts + Phase Gates", "V15.16 Portable Cross-Tool Temp Paths", "V15.17 Zero-Friction Autopilot Admission", "V15.18 Three-Tier Zero-Friction Routing", "V15.19 Finalization Hardening", "ues_service"]) {
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
    const focusedV159 = String(scripts["eval:v15.9"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV159Tests = [
      "test/v15-9-runtime.test.mjs",
      "test/v15-8-runtime.test.mjs",
      "test/permission-policy.test.mjs",
      "test/compaction-resume-guard.test.mjs",
      "test/runtime-events.test.mjs",
    ]
    if (
      focusedV159[0] !== "node" ||
      focusedV159[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV159Tests.every((file) => focusedV159.includes(file))
    ) {
      errors.push("package.json: eval:v15.9 must use the bounded runner and include adaptive-agent plus V15.8/durable regressions")
    }
    if (scripts["eval:skills:v15.9"] !== "node scripts/eval-skills-v15-9.mjs") {
      errors.push("package.json: missing V15.9 skill activation evaluation")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v15.9")) {
      errors.push("package.json: release:verify must include eval:v15.9")
    }
    if (!pkg.files.includes("docs/V15.9-ADAPTIVE-AGENT-INTELLIGENCE.md")) {
      errors.push("package.json: V15.9 runtime documentation must be packed")
    }
    const focusedV16 = String(scripts["eval:v16"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV16Tests = [
      "test/v16-runtime.test.mjs",
      "test/fast-verification-gate.test.mjs",
      "test/fast-static-verification-v16.test.mjs",
      "test/evidence-store-active-work-v16.test.mjs",
      "test/fs-cleanup-v16.test.mjs",
      "test/execution-capability-v16.test.mjs",
      "test/untrusted-output.test.mjs",
      "test/model-performance-v12.test.mjs",
      "test/compaction-resume-guard.test.mjs",
      "test/v15-9-runtime.test.mjs",
    ]
    if (
      focusedV16[0] !== "node" ||
      focusedV16[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV16Tests.every((file) => focusedV16.includes(file))
    ) {
      errors.push("package.json: eval:v16 must use the bounded runner and include V16 correctness/security/reliability/efficiency regressions")
    }
    // V16.3 (browser execution reliability + DeepSeek web reasoning bridge).
    // These two files ARE the phase; an eval that quietly drops them would leave
    // the release claiming a subsystem nobody ran.
    const requiredV163Tests = [
      "test/browser-reliability-v16-3.test.mjs",
      "test/deepseek-web-bridge-v16-3.test.mjs",
      "test/v16-3-controller-integration.test.mjs",
      "test/v16-3-live-deepseek.test.mjs",
      "test/v16-3-manual-auth-wait.test.mjs",
      "test/v16-3-live-regressions.test.mjs",
      "test/v16-3-auth-ui-detection.test.mjs",
      "test/v16-3-deepseek-history-detector.test.mjs",
    ]
    if (!requiredV163Tests.every((file) => focusedV16.includes(file))) {
      errors.push("package.json: eval:v16 must include the V16.3 browser-reliability and deepseek-web-bridge suites")
    }
    const focusedV163 = String(scripts["eval:v16.3"] || "").trim().split(/\s+/).filter(Boolean)
    if (
      focusedV163[0] !== "node" ||
      focusedV163[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV163Tests.every((file) => focusedV163.includes(file))
    ) {
      errors.push("package.json: eval:v16.3 must use the bounded runner and cover both V16.3 suites")
    }
    if (scripts["bench:web-reasoning"] !== "node scripts/bench-web-reasoning-ab.mjs") {
      errors.push("package.json: missing measured V16.3 web-reasoning A/B benchmark command")
    }
    // The live DeepSeek smoke is deliberately MANUAL and separately gated. It must
    // not be reachable from `ci` / `release:verify`, because it drives a real
    // third-party web UI.
    if (scripts["smoke:deepseek-web"] !== "node scripts/smoke-deepseek-web-v16-3.mjs") {
      errors.push("package.json: missing the manually gated V16.3 DeepSeek web smoke")
    }
    for (const gate of ["ci", "release:verify", "test", "eval:v16", "eval:v16.3", "eval:v16.3.workers"]) {
      if (String(scripts[gate] || "").includes("smoke:deepseek-web")) {
        errors.push(`package.json: ${gate} must NOT run the live DeepSeek web smoke`)
      }
    }
    // The read-only diagnostic drives a third-party site too, so it is gated the
    // same way even though it submits nothing.
    if (String(scripts["smoke:deepseek-web"] || "").includes("--auth-diagnose")) {
      errors.push("package.json: smoke:deepseek-web must not default to the third-party diagnostic")
    }
    for (const required of [
      "scripts/browser-worker-v16-3.mjs",
      "scripts/smoke-deepseek-web-v16-3.mjs",
      "lib/browser-profile.mjs",
      "lib/browser-worker-mode.mjs",
      "lib/browser-dom-inspect.mjs",
    ]) {
      if (!pkg.files.includes(required)) {
        errors.push(`package.json: V16.3 runtime integration file must be packed: ${required}`)
      }
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16")) {
      errors.push("package.json: release:verify must include eval:v16")
    }
    const focusedV164 = String(scripts["eval:v16.4"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV164Tests = [
      "test/release-consistency-v16-4.test.mjs",
      "test/lazy-runtime-v16-4.test.mjs",
      "test/lazy-runtime-production-v16-4.test.mjs",
      "test/structural-escalation-v16-4.test.mjs",
      "test/fresh-evidence-v16-4.test.mjs",
      "test/decision-packet-tiers-v16-4.test.mjs",
      "test/verified-cost-learner-v16-4.test.mjs",
      "test/web-reasoning-corpus-v16-4.test.mjs",
      "test/consult-prep-v16-4.test.mjs",
      "test/repo-map-measurements-v16-4.test.mjs",
      "test/release-coordinator-v16-4.test.mjs",
    ]
    if (
      focusedV164[0] !== "node" ||
      focusedV164[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV164Tests.every((file) => focusedV164.includes(file))
    ) {
      errors.push("package.json: eval:v16.4 must use the bounded runner and include the V16.4 adaptive-runtime suites")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.4")) {
      errors.push("package.json: release:verify must include eval:v16.4")
    }
    if (scripts["release:coordinator"] !== "node scripts/release-test-coordinator.mjs") {
      errors.push("package.json: missing V16.4 release test coordinator command")
    }
    if (!pkg.files.includes("docs/V16-DETERMINISTIC-HARDENING.md")) {
      errors.push("package.json: V16 runtime documentation must be packed")
    }
    if (!pkg.files.includes("docs/V16.3-BROWSER-WEB-REASONING.md")) {
      errors.push("package.json: V16.3 browser/web-reasoning documentation must be packed")
    }
    if (!pkg.files.includes("docs/V16.4-MEASURED-ADAPTIVE-RUNTIME.md")) {
      errors.push("package.json: V16.4 measured-adaptive-runtime documentation must be packed")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.7")) {
      errors.push("package.json: release:verify must include eval:v16.7")
    }
    if (!pkg.files.includes("docs/V16.7-DEEPSEEK-ACCOUNT-PROFILE-AUTH.md")) {
      errors.push("package.json: V16.7 DeepSeek account/profile/auth documentation must be packed")
    }
    if (!scripts["eval:v16.7"] || !String(scripts["eval:v16.7"]).includes("test/deepseek-profile-v16-7.test.mjs")) {
      errors.push("package.json: eval:v16.7 must run test/deepseek-profile-v16-7.test.mjs")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.9")) {
      errors.push("package.json: release:verify must include eval:v16.9")
    }
    const focusedV169 = String(scripts["eval:v16.9"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV169Tests = [
      "test/workspace-state-owner-v16-9.test.mjs",
      "test/evidence-broker-v16-9.test.mjs",
      "test/advisor-admission-v16-9.test.mjs",
      "test/advisor-admission-weak-models-v16-9.test.mjs",
      "test/advisor-runtime-v16-9.test.mjs",
      "test/advisor-dialogue-e2e-v16-9.test.mjs",
      "test/web-reasoning-lane-v16-9-equivalence.test.mjs",
      "test/web-reasoning-v16-9-production.test.mjs",
      "test/source-integrity-v16-9.test.mjs",
    ]
    if (
      focusedV169[0] !== "node" ||
      focusedV169[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV169Tests.every((file) => focusedV169.includes(file))
    ) {
      errors.push("package.json: eval:v16.9 must use the bounded runner and include the V16.9 lifecycle/evidence suites")
    }
    if (scripts["bench:v16.9"] !== "node scripts/bench-v16-9-admission.mjs") {
      errors.push("package.json: missing V16.9 admission benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.10")) {
      errors.push("package.json: release:verify must include eval:v16.10")
    }
    if (!pkg.files.includes("docs/V16.10-CONTEXT-INTELLIGENCE-ECONOMY.md")) {
      errors.push("package.json: V16.10 context-intelligence/economy documentation must be packed")
    }
    const focusedV1610 = String(scripts["eval:v16.10"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1610Tests = [
      "test/tool-output-budgeter-v16-10.test.mjs",
      "test/context-kernel-v16-10.test.mjs",
      "test/repo-intelligence-v16-10.test.mjs",
      "test/semantic-tool-router-v16-10.test.mjs",
      "test/verification-ladder-v16-10.test.mjs",
      "test/efficiency-metrics-v16-10.test.mjs",
      "test/source-integrity-v16-10.test.mjs",
    ]
    if (
      focusedV1610[0] !== "node" ||
      focusedV1610[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1610Tests.every((file) => focusedV1610.includes(file))
    ) {
      errors.push("package.json: eval:v16.10 must use the bounded runner and include the V16.10 capability suites")
    }
    if (scripts["bench:v16.10"] !== "node scripts/bench-v16-10-capabilities.mjs") {
      errors.push("package.json: missing V16.10 capability benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.11")) {
      errors.push("package.json: release:verify must include eval:v16.11")
    }
    if (!pkg.files.includes("docs/V16.11-ADVISOR-LIFECYCLE-EVENT-FIRST.md")) {
      errors.push("package.json: V16.11 advisor-lifecycle/event-first documentation must be packed")
    }
    const focusedV1611 = String(scripts["eval:v16.11"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1611Tests = [
      "test/advisor-worker-epoch-v16-11.test.mjs",
      "test/browser-transport-v16-11.test.mjs",
      "test/advisor-session-manager-v16-11.test.mjs",
      "test/advisor-answer-observer-v16-11.test.mjs",
      "test/advisor-recovery-v16-11.test.mjs",
      "test/advisor-latency-metrics-v16-11.test.mjs",
      "test/advisor-resource-hygiene-v16-11.test.mjs",
      "test/web-reasoning-v16-11-production.test.mjs",
      "test/source-integrity-v16-11.test.mjs",
    ]
    if (
      focusedV1611[0] !== "node" ||
      focusedV1611[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1611Tests.every((file) => focusedV1611.includes(file))
    ) {
      errors.push("package.json: eval:v16.11 must use the bounded runner and include the V16.11 advisor-lifecycle suites")
    }
    if (scripts["bench:v16.11"] !== "node scripts/bench-v16-11-runtime.mjs") {
      errors.push("package.json: missing V16.11 advisor-runtime benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.12")) {
      errors.push("package.json: release:verify must include eval:v16.12")
    }
    if (!pkg.files.includes("docs/V16.12-EXECUTION-ACCELERATION-RUNTIME.md")) {
      errors.push("package.json: V16.12 execution-acceleration documentation must be packed")
    }
    const focusedV1612 = String(scripts["eval:v16.12"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1612Tests = [
      "test/verification-receipt-cache-v16-12.test.mjs",
      "test/task-dag-scheduler-v16-12.test.mjs",
      "test/tool-result-reuse-v16-12.test.mjs",
      "test/incremental-verification-v16-12.test.mjs",
      "test/warm-service-reuse-v16-12.test.mjs",
      "test/execution-acceleration-v16-12.test.mjs",
      "test/execution-acceleration-wiring-v16-12.test.mjs",
      "test/waste-detector-v16-12.test.mjs",
      "test/source-integrity-v16-12.test.mjs",
    ]
    if (
      focusedV1612[0] !== "node" ||
      focusedV1612[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1612Tests.every((file) => focusedV1612.includes(file))
    ) {
      errors.push("package.json: eval:v16.12 must use the bounded runner and include the V16.12 execution-acceleration suites")
    }
    if (scripts["bench:v16.12"] !== "node scripts/bench-v16-12-acceleration.mjs") {
      errors.push("package.json: missing V16.12 execution-acceleration benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.13")) {
      errors.push("package.json: release:verify must include eval:v16.13")
    }
    if (!pkg.files.includes("docs/V16.13-EXTERNAL-RESEARCH-INTELLIGENCE.md")) {
      errors.push("package.json: V16.13 external-research documentation must be packed")
    }
    const focusedV1613 = String(scripts["eval:v16.13"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1613Tests = [
      "test/research-brief-v16-13.test.mjs",
      "test/research-provider-router-v16-13.test.mjs",
      "test/research-network-policy-v16-13.test.mjs",
      "test/research-version-join-v16-13.test.mjs",
      "test/research-official-github-v16-13.test.mjs",
      "test/research-cache-v16-13.test.mjs",
      "test/research-dedup-v16-13.test.mjs",
      "test/research-freshness-v16-13.test.mjs",
      "test/research-evidence-v16-13.test.mjs",
      "test/research-claims-v16-13.test.mjs",
      "test/research-speed-path-v16-13.test.mjs",
      "test/research-broker-v16-13.test.mjs",
      "test/research-production-wiring-v16-13.test.mjs",
      "test/source-integrity-v16-13.test.mjs",
    ]
    if (
      focusedV1613[0] !== "node" ||
      focusedV1613[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1613Tests.every((file) => focusedV1613.includes(file))
    ) {
      errors.push("package.json: eval:v16.13 must use the bounded runner and include the V16.13 external-research suites")
    }
    if (scripts["bench:v16.13"] !== "node scripts/bench-v16-13-research.mjs") {
      errors.push("package.json: missing V16.13 external-research benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.14")) {
      errors.push("package.json: release:verify must include eval:v16.14")
    }
    if (!pkg.files.includes("docs/V16.14-ULTRA-FAST-TOKEN-ECONOMY.md")) {
      errors.push("package.json: V16.14 token-economy documentation must be packed")
    }
    const focusedV1614 = String(scripts["eval:v16.14"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1614Tests = [
      "test/research-cancellation-network-v16-14.test.mjs",
      "test/token-economy-v16-14.test.mjs",
      "test/source-integrity-v16-14.test.mjs",
    ]
    if (
      focusedV1614[0] !== "node" ||
      focusedV1614[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1614Tests.every((file) => focusedV1614.includes(file))
    ) {
      errors.push("package.json: eval:v16.14 must use the bounded runner and include the V16.14 cancellation/network, token-economy and source-integrity suites")
    }
    if (scripts["bench:v16.14"] !== "node scripts/bench-v16-14-economy.mjs") {
      errors.push("package.json: missing V16.14 token-economy benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.15")) {
      errors.push("package.json: release:verify must include eval:v16.15")
    }
    if (!pkg.files.includes("docs/V16.15-SINGLE-SHOT-PARALLEL-CODING.md")) {
      errors.push("package.json: V16.15 parallel-coding documentation must be packed")
    }
    const focusedV1615 = String(scripts["eval:v16.15"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1615Tests = [
      "test/parallel-execution-policy-v16-15.test.mjs",
      "test/execution-conflict-graph-v16-15.test.mjs",
      "test/wave-shared-context-v16-15.test.mjs",
      "test/integration-transaction-v16-15.test.mjs",
      "test/parallel-coding-runtime-v16-15.test.mjs",
      "test/parallel-coding-wiring-v16-15.test.mjs",
      "test/delegation-safety-v16-15.test.mjs",
      "test/source-integrity-v16-15.test.mjs",
    ]
    if (
      focusedV1615[0] !== "node" ||
      focusedV1615[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1615Tests.every((file) => focusedV1615.includes(file))
    ) {
      errors.push("package.json: eval:v16.15 must use the bounded runner and include the V16.15 parallel-coding suites")
    }
    if (scripts["bench:v16.15"] !== "node scripts/bench-v16-15-parallel-coding.mjs") {
      errors.push("package.json: missing V16.15 parallel-coding benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.16")) {
      errors.push("package.json: release:verify must include eval:v16.16")
    }
    if (!pkg.files.includes("docs/V16.16-CRITICAL-PATH-EXECUTION-COST-RUNTIME.md")) {
      errors.push("package.json: V16.16 critical-path documentation must be packed")
    }
    const focusedV1616 = String(scripts["eval:v16.16"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1616Tests = [
      "test/v16-16-economy.test.mjs",
      "test/v16-16-conflict.test.mjs",
      "test/v16-16-context.test.mjs",
      "test/v16-16-identity.test.mjs",
      "test/v16-16-crash-recovery.test.mjs",
      "test/v16-16-git-async.test.mjs",
      "test/v16-16-runtime.test.mjs",
      "test/v16-16-cold-start.test.mjs",
      "test/source-integrity-v16-16.test.mjs",
    ]
    if (
      focusedV1616[0] !== "node" ||
      focusedV1616[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1616Tests.every((file) => focusedV1616.includes(file))
    ) {
      errors.push("package.json: eval:v16.16 must use the bounded runner and include the V16.16 critical-path suites")
    }
    if (scripts["bench:v16.16"] !== "node scripts/bench-v16-16-critical-path.mjs") {
      errors.push("package.json: missing V16.16 critical-path benchmark command")
    }
    if (!String(scripts["release:verify"] || "").includes("npm run eval:v16.17")) {
      errors.push("package.json: release:verify must include eval:v16.17")
    }
    if (!pkg.files.includes("docs/V16.17-EXECUTION-CORE-CONSOLIDATION.md")) {
      errors.push("package.json: V16.17 execution-core consolidation documentation must be packed")
    }
    const focusedV1617 = String(scripts["eval:v16.17"] || "").trim().split(/\s+/).filter(Boolean)
    const requiredV1617Tests = [
      "test/v16-17-execution-core.test.mjs",
      "test/v16-17-execution-plan.test.mjs",
      "test/v16-17-prepared-execution.test.mjs",
      "test/v16-17-prepared-execution-production.test.mjs",
      "test/v16-17-structured-plan-production.test.mjs",
      "test/v16-17-structured-plan-smoke.test.mjs",
      "test/source-integrity-v16-17.test.mjs",
    ]
    if (
      focusedV1617[0] !== "node" ||
      focusedV1617[1] !== "scripts/run-test-suite.mjs" ||
      !requiredV1617Tests.every((file) => focusedV1617.includes(file))
    ) {
      errors.push("package.json: eval:v16.17 must use the bounded runner and include every V16.17 execution-core suite")
    }
    if (scripts["bench:v16.17"] !== "node scripts/bench-v16-17-execution-core.mjs") {
      errors.push("package.json: missing V16.17 execution-core benchmark command")
    }
    // An eval script naming a test file that does not exist would be silently
    // dropped by the bounded runner, leaving the release claiming a suite nobody
    // ran. Every test file an eval script names must exist on disk.
    //
    // This rule is only meaningful for a real source tree. Synthetic fixture
    // roots (e.g. the release-consistency fixture) ship a package.json but no
    // `test/` directory, so every token would be reported as missing and the
    // fixture would be testing nothing but its own incompleteness. The contract
    // is additionally enforced against the real root by
    // test/source-integrity-v16-15.test.mjs, so it cannot be silently dropped by
    // removing a file from this script.
    if (existsSync(path.join(root, "test"))) {
      for (const [name, command] of Object.entries(scripts)) {
        if (!name.startsWith("eval:") || typeof command !== "string") continue
        for (const token of command.split(/\s+/)) {
          if (!token.startsWith("test/") || !token.endsWith(".mjs")) continue
          if (!existsSync(path.join(root, token))) {
            errors.push(`package.json: ${name} names a test file that does not exist: ${token}`)
          }
        }
      }
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