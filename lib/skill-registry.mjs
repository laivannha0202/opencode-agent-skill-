// V16.5 Phase 2: Skill Registry V2.
//
// A machine-readable contract for every skill shipped in global-config/skills.
// Contracts are compiled from ONE bounded spec table plus the skill frontmatter,
// so nothing is duplicated per skill and no SKILL.md body is needed to route.
//
// Design constraints:
// - bounded: every serialized contract must stay under MAX_CONTRACT_CHARS.
// - deterministic: contracts depend only on the spec table + frontmatter.
// - cacheable: identical inputs produce an identical fingerprint.
// - inspectable: the router reads contracts without loading any skill body.
//
// The registry NEVER changes safety policy. forbiddenActions is advisory metadata
// for the router/model; runtime enforcement stays in permission-policy.mjs,
// tool-surface-economy.mjs and the Pi permission lattice.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS_ROOT = path.join(PACKAGE_ROOT, "global-config", "skills")

export const SKILL_REGISTRY_SCHEMA_VERSION = 2
export const MAX_CONTRACT_CHARS = 1_600
export const MAX_REGISTRY_CHARS = 120_000
export const DEFAULT_FORBIDDEN_ACTIONS = Object.freeze(["publish", "deploy", "force-push"])

// Capabilities are the vocabulary shared with deferred-tool-hydration.mjs so a
// skill that "requires" a capability maps to a hydratable tool, not a prose hint.
const CAPABILITY_TOOL = Object.freeze({
  "read-file": "read",
  "search-text": "grep",
  "find-paths": "find",
  "list-directory": "ls",
  "run-shell": "bash",
  "edit-file": "edit",
  "write-file": "write",
  "code-intelligence": "ues_code",
  "anchored-edit": "ues_code_edit",
  "diagnostics": "ues_code",
  "repo-map": "ues_code",
  "evidence-fetch": "ues_evidence_get",
  "background-service": "ues_service",
  "browser-automation": "playwright",
  "deepseek-advisor": "ues_web_reasoning",
  "verification-receipt": "bash",
  "memory": "ues_evidence_get",
})

// Compact spec table. One row per shipped skill.
//   i  intents              t  taskClasses
//   rc requiredCapabilities oc optionalCapabilities
//   rt requiredTools        ot optionalTools
//   fa extra forbidden      vr verification required
//   ctx contextClass override
const SPEC = Object.freeze({
  accessibility: {
    i: ["accessibility-review", "a11y-audit"],
    t: ["ui", "review"],
    rc: ["read-file", "search-text"],
    oc: ["browser-automation", "design-source"],
    ot: ["playwright"],
    ctx: "procedure",
  },
  "api-contract": {
    i: ["api-change", "contract-drift"],
    t: ["api", "review"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "rest-api-design"],
    ot: ["ues_code"],
  },
  "auth-security": {
    i: ["auth-review", "authorization-fix", "session-fix"],
    t: ["security", "feature", "bugfix"],
    rc: ["read-file", "search-text", "code-intelligence"],
    oc: ["web-security-review", "deepseek-advisor"],
    ot: ["ues_code"],
  },
  "browser-qa": {
    i: ["browser-verification", "e2e-verification"],
    t: ["verification", "ui"],
    rc: ["read-file", "browser-automation"],
    oc: ["visual-fidelity", "responsive-verification"],
    ot: ["playwright"],
    vr: true,
    ctx: "procedure",
  },
  "browser-security": {
    i: ["untrusted-content", "browser-safety"],
    t: ["security", "verification"],
    rc: ["read-file", "browser-automation"],
    ot: ["playwright"],
    ctx: "gate",
  },
  "bug-diagnosis": {
    i: ["ambiguous-failure", "regression", "root-cause", "test-failure"],
    t: ["bugfix", "verification"],
    rc: ["read-file", "search-text", "run-shell"],
    oc: ["code-intelligence", "diagnostics", "deepseek-advisor"],
    ot: ["ues_code", "bash"],
    ctx: "procedure",
  },
  "change-impact-analysis": {
    i: ["impact-analysis", "blast-radius"],
    t: ["review", "planning"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "repo-map"],
    ot: ["ues_code"],
  },
  "code-review": {
    i: ["code-review", "defect-hunt"],
    t: ["review"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "deepseek-advisor"],
    ot: ["ues_code"],
  },
  "component-visual-testing": {
    i: ["visual-regression", "component-isolation"],
    t: ["verification", "ui"],
    rc: ["read-file", "run-shell"],
    oc: ["browser-automation", "visual-fidelity"],
    ot: ["playwright", "bash"],
    vr: true,
    ctx: "procedure",
  },
  "context-engineering": {
    i: ["context-retrieval", "repo-reconnaissance"],
    t: ["exploration", "planning"],
    rc: ["read-file", "search-text"],
    oc: ["repo-map", "code-intelligence"],
    ot: ["ues_code"],
    ctx: "procedure",
  },
  "database-engineering": {
    i: ["data-model", "migration", "query-fix", "transaction-fix"],
    t: ["data", "migration", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "performance-engineering"],
    ot: ["ues_code"],
  },
  "dependency-management": {
    i: ["dependency-audit", "dependency-upgrade", "supply-chain-review"],
    t: ["infra", "review"],
    rc: ["read-file", "search-text", "run-shell"],
    ot: ["bash"],
    ctx: "procedure",
  },
  "design-source": {
    i: ["design-implementation", "screenshot-fidelity"],
    t: ["ui", "feature"],
    rc: ["read-file", "design-source"],
    oc: ["visual-fidelity", "browser-automation"],
    ot: ["playwright"],
  },
  "devops-engineering": {
    i: ["ci-cd", "container-build", "deployment-config"],
    t: ["infra", "release"],
    rc: ["read-file", "run-shell"],
    ot: ["bash"],
    ctx: "reference",
  },
  "django-engineering": {
    i: ["django-change"],
    t: ["feature", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "database-engineering"],
    ot: ["ues_code"],
  },
  "documentation-engineering": {
    i: ["docs-authoring", "docs-only", "readme-rewrite"],
    t: ["docs"],
    rc: ["read-file"],
    ot: ["write", "edit"],
    ctx: "procedure",
  },
  "dotnet-engineering": {
    i: ["dotnet-change"],
    t: ["feature", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "performance-engineering"],
    ot: ["ues_code"],
  },
  "dynamic-workflow": {
    i: ["workflow-orchestration", "fan-out-execution"],
    t: ["orchestration"],
    rc: ["read-file", "run-shell"],
    oc: ["code-intelligence"],
    ot: ["bash"],
    ctx: "procedure",
  },
  "ecommerce-engineering": {
    i: ["catalog-change", "cart-checkout", "order-lifecycle"],
    t: ["feature", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["payment-engineering", "api-contract"],
    ot: ["ues_code"],
  },
  "engineering-orchestrator": {
    i: ["agent-orchestration", "scope-classification"],
    t: ["orchestration", "planning"],
    rc: ["read-file", "search-text"],
    oc: ["repo-map", "code-intelligence"],
    ot: ["ues_code"],
    ctx: "gate",
  },
  "fastapi-engineering": {
    i: ["fastapi-change"],
    t: ["api", "feature", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "api-contract"],
    ot: ["ues_code"],
  },
  "file-upload-engineering": {
    i: ["file-upload", "media-handling"],
    t: ["feature", "security"],
    rc: ["read-file", "search-text"],
    oc: ["web-security-review", "auth-security"],
    ot: ["ues_code"],
  },
  "flutter-engineering": {
    i: ["flutter-change"],
    t: ["feature", "bugfix", "ui"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "ui-ux-engineering"],
    ot: ["ues_code"],
  },
  "git-safety": {
    i: ["git-operation", "conflict-resolution", "stage-selection"],
    t: ["review", "infra"],
    rc: ["read-file", "run-shell"],
    ot: ["bash"],
    ctx: "gate",
  },
  "implementation-engineer": {
    i: ["feature-add", "refactor", "code-change"],
    t: ["feature", "refactor", "bugfix"],
    rc: ["read-file", "edit-file", "search-text"],
    oc: ["code-intelligence", "run-shell"],
    ot: ["edit", "ues_code", "bash"],
    ctx: "procedure",
  },
  "java-spring-engineering": {
    i: ["spring-change"],
    t: ["feature", "bugfix", "api"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "api-contract"],
    ot: ["ues_code"],
  },
  "long-task-state": {
    i: ["state-durability", "resume-handoff", "long-horizon"],
    t: ["orchestration"],
    rc: ["read-file", "evidence-fetch"],
    oc: ["memory"],
    ot: ["ues_evidence_get"],
    ctx: "gate",
  },
  "nestjs-engineering": {
    i: ["nestjs-change", "dependency-injection-fix"],
    t: ["api", "feature", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "api-contract"],
    ot: ["ues_code"],
  },
  "nextjs-engineering": {
    i: ["nextjs-change", "rendering-fix", "route-change"],
    t: ["feature", "bugfix", "performance"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "performance-engineering"],
    ot: ["ues_code"],
  },
  "nodejs-engineering": {
    i: ["node-change", "process-lifecycle"],
    t: ["feature", "bugfix"],
    rc: ["read-file", "search-text", "run-shell"],
    oc: ["code-intelligence", "performance-engineering"],
    ot: ["ues_code", "bash"],
  },
  "payment-engineering": {
    i: ["payment-flow", "money-movement", "idempotency-fix"],
    t: ["feature", "bugfix", "security"],
    rc: ["read-file", "search-text"],
    oc: ["database-engineering", "api-contract", "deepseek-advisor"],
    ot: ["ues_code"],
  },
  "performance-engineering": {
    i: ["performance-tuning", "hot-path-analysis"],
    t: ["performance", "bugfix"],
    rc: ["read-file", "search-text", "run-shell"],
    oc: ["code-intelligence", "repo-map"],
    ot: ["ues_code", "bash"],
  },
  "python-engineering": {
    i: ["python-change"],
    t: ["feature", "bugfix"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "python-engineering"],
    ot: ["ues_code"],
  },
  "react-engineering": {
    i: ["react-change", "render-fix", "hook-fix"],
    t: ["feature", "bugfix", "ui"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "ui-ux-engineering"],
    ot: ["ues_code"],
  },
  "react-native-engineering": {
    i: ["react-native-change", "mobile-build-fix"],
    t: ["feature", "bugfix", "ui"],
    rc: ["read-file", "search-text", "run-shell"],
    oc: ["code-intelligence", "react-engineering"],
    ot: ["ues_code", "bash"],
  },
  "repo-explorer": {
    i: ["repo-reconnaissance", "locate-implementation", "map-architecture"],
    t: ["exploration"],
    rc: ["read-file", "search-text", "find-paths"],
    oc: ["repo-map", "code-intelligence"],
    ot: ["ues_code", "find"],
    ctx: "procedure",
  },
  "research-verification": {
    i: ["external-api-check", "version-compatibility", "primary-source-research"],
    t: ["planning", "review"],
    rc: ["read-file", "search-text"],
    oc: ["deepseek-advisor"],
    ot: [],
    ctx: "procedure",
  },
  "responsive-verification": {
    i: ["responsive-check", "breakpoint-check"],
    t: ["verification", "ui"],
    rc: ["read-file", "browser-automation"],
    ot: ["playwright"],
    vr: true,
    ctx: "procedure",
  },
  "rest-api-design": {
    i: ["endpoint-design", "status-code-fix", "pagination-design"],
    t: ["api", "planning"],
    rc: ["read-file", "search-text"],
    oc: ["api-contract"],
    ot: ["ues_code"],
  },
  "skill-authoring": {
    i: ["skill-authoring", "skill-structure-fix"],
    t: ["orchestration", "docs"],
    rc: ["read-file", "write-file"],
    oc: ["documentation-engineering"],
    ot: ["write", "edit"],
    ctx: "procedure",
  },
  "skill-evaluation": {
    i: ["skill-evaluation", "routing-benchmark"],
    t: ["orchestration", "verification"],
    rc: ["read-file", "run-shell"],
    oc: ["skill-authoring"],
    ot: ["bash"],
    vr: true,
    ctx: "procedure",
  },
  "software-architect": {
    i: ["architecture", "boundary-design", "migration-design"],
    t: ["planning"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "repo-map", "deepseek-advisor"],
    ot: ["ues_code"],
  },
  "task-planner": {
    i: ["planning", "task-decomposition", "sequencing"],
    t: ["planning"],
    rc: ["read-file", "search-text"],
    oc: ["code-intelligence", "change-impact-analysis"],
    ot: ["ues_code"],
    ctx: "procedure",
  },
  "test-driven-development": {
    i: ["test-authoring", "red-green-loop"],
    t: ["verification", "feature"],
    rc: ["read-file", "edit-file", "run-shell"],
    oc: ["diagnostics"],
    ot: ["edit", "bash", "ues_code"],
    ctx: "procedure",
  },
  "test-verification": {
    i: ["test-failure", "verification", "coverage-check"],
    t: ["verification"],
    rc: ["read-file", "run-shell"],
    oc: ["diagnostics", "evidence-fetch", "browser-automation"],
    ot: ["bash", "ues_code"],
    vr: true,
    ctx: "gate",
  },
  "ui-ux-engineering": {
    i: ["ui-implementation", "design-system-usage"],
    t: ["ui", "feature"],
    rc: ["read-file", "search-text"],
    oc: ["accessibility", "responsive-verification", "design-source"],
    ot: ["ues_code"],
  },
  "visual-fidelity": {
    i: ["visual-fidelity", "screenshot-match", "layout-check"],
    t: ["verification", "ui"],
    rc: ["read-file", "browser-automation"],
    oc: ["component-visual-testing", "design-source"],
    ot: ["playwright"],
    vr: true,
    ctx: "procedure",
  },
  "web-security-review": {
    i: ["security-review", "injection-audit", "ssrf-audit", "xss-audit"],
    t: ["security", "review"],
    rc: ["read-file", "search-text"],
    oc: ["auth-security", "deepseek-advisor"],
    ot: ["ues_code"],
    vr: true,
    ctx: "gate",
  },
})

// Skills that other skills may compose with when they share a task class.
// Derived deterministically below; declared here so composability stays stable
// even if a future skill shares a broad task class like "feature".
const ALWAYS_COMPOSABLE = Object.freeze([
  "bug-diagnosis",
  "change-impact-analysis",
  "code-review",
  "implementation-engineer",
  "task-planner",
  "test-verification",
])

function sortedUnique(values = []) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort()
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function frontmatterFor(skillId) {
  const file = path.join(SKILLS_ROOT, skillId, "SKILL.md")
  if (!existsSync(file)) return null
  const raw = readFileSync(file, "utf8")
  const match = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/)
  const block = match ? match[1] : ""
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim() || skillId
  const description = block.match(/^description:\s*([\s\S]+?)(?=\r?\n[a-zA-Z-]+:|$)/m)?.[1]?.trim() || ""
  return { name, description }
}

function outputContractFor(skillId) {
  if (/-engineering$/.test(skillId)) return `${skillId.replace(/-engineering$/, "")}-rules-v1`
  if (/verification$|review$|quality$/.test(skillId)) return `${skillId}-findings-v1`
  if (/planner$|architect$|orchestrator$|workflow$/.test(skillId)) return `${skillId}-plan-v1`
  if (/authoring$|documentation$/.test(skillId)) return `${skillId}-doc-v1`
  return `${skillId}-report-v1`
}

function contextClassFor(skillId, override) {
  if (override) return override
  if (/verification$|quality$|security$/.test(skillId)) return "gate"
  if (/engineering$/.test(skillId)) return "reference"
  return "procedure"
}

function toolsFor(capabilities = []) {
  return sortedUnique(capabilities.map((capability) => CAPABILITY_TOOL[capability]).filter(Boolean))
}

/**
 * Build the full machine-readable contract for one skill id.
 * Throws for an unknown id or an over-budget contract.
 */
export function buildSkillContract(skillId) {
  const id = String(skillId || "").trim()
  const spec = SPEC[id]
  if (!spec) throw new Error(`unknown skill id: ${id || "(empty)"}`)

  const front = frontmatterFor(id)
  const intents = sortedUnique(spec.i)
  const taskClasses = sortedUnique(spec.t)
  const requiredCapabilities = sortedUnique(spec.rc)
  const optionalCapabilities = sortedUnique(spec.oc).filter((capability) => !requiredCapabilities.includes(capability))
  const requiredTools = toolsFor(requiredCapabilities)
  const optionalTools = toolsFor(optionalCapabilities).filter((tool) => !requiredTools.includes(tool))
  const forbiddenActions = sortedUnique([...DEFAULT_FORBIDDEN_ACTIONS, ...sortedUnique(spec.fa)])

  const contract = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    id,
    name: front?.name || id,
    description: String(front?.description || "").slice(0, 400),
    intents,
    taskClasses,
    requiredCapabilities,
    optionalCapabilities,
    requiredTools,
    optionalTools,
    forbiddenActions,
    contextClass: contextClassFor(id, spec.ctx),
    sideEffectClass: "none",
    outputContract: outputContractFor(id),
    verificationRequirements: {
      required: spec.vr === true,
      independent: spec.vr === true,
    },
    composableWith: sortedUnique(ALWAYS_COMPOSABLE).filter((name) => name !== id),
    hostSupport: ["pi"],
    version: SKILL_REGISTRY_SCHEMA_VERSION,
  }

  const chars = JSON.stringify(contract).length
  if (chars > MAX_CONTRACT_CHARS) {
    throw new Error(`skill contract ${id} exceeds bounded budget (${chars} > ${MAX_CONTRACT_CHARS})`)
  }
  contract.contractChars = chars
  return contract
}

/** Validate a contract object; returns { ok, errors }. Never throws. */
export function validateSkillContract(contract) {
  const errors = []
  if (!contract || typeof contract !== "object") return { ok: false, errors: ["contract must be an object"] }
  const requiredFields = [
    "id", "intents", "taskClasses", "requiredCapabilities", "optionalCapabilities",
    "requiredTools", "optionalTools", "forbiddenActions", "contextClass",
    "sideEffectClass", "outputContract", "verificationRequirements", "composableWith",
    "hostSupport", "version",
  ]
  for (const field of requiredFields) {
    if (contract[field] === undefined || contract[field] === null) errors.push(`missing field: ${field}`)
  }
  if (contract.id && !SPEC[contract.id]) errors.push(`unknown skill id: ${contract.id}`)
  for (const field of ["intents", "taskClasses", "requiredTools", "forbiddenActions", "hostSupport"]) {
    if (contract[field] !== undefined && !Array.isArray(contract[field])) errors.push(`${field} must be an array`)
  }
  if (contract.sideEffectClass !== "none" && contract.sideEffectClass !== undefined) {
    errors.push(`sideEffectClass must be "none" for an advisory skill (got ${contract.sideEffectClass})`)
  }
  if (contract.version !== undefined && contract.version !== SKILL_REGISTRY_SCHEMA_VERSION) {
    errors.push(`contract version drift: ${contract.version}`)
  }
  const chars = JSON.stringify(contract).length
  if (chars > MAX_CONTRACT_CHARS) errors.push(`contract exceeds bounded budget (${chars} > ${MAX_CONTRACT_CHARS})`)
  return { ok: errors.length === 0, errors }
}

let registryCache = null

/** Compile the whole registry. Deterministic order, bounded total size. */
export function skillRegistry() {
  if (registryCache) return registryCache
  const ids = Object.keys(SPEC).sort()
  const contracts = ids.map((id) => buildSkillContract(id))
  const byTaskClass = new Map()
  for (const contract of contracts) {
    for (const taskClass of contract.taskClasses) {
      const bucket = byTaskClass.get(taskClass) || []
      bucket.push(contract.id)
      byTaskClass.set(taskClass, bucket)
    }
  }
  // composableWith is derived, never hand-maintained: skills sharing a task
  // class are mutually composable, capped for bounded metadata.
  for (const contract of contracts) {
    const peers = sortedUnique(
      contract.taskClasses.flatMap((taskClass) => byTaskClass.get(taskClass) || []),
    ).filter((id) => id !== contract.id)
    contract.composableWith = sortedUnique([...contract.composableWith, ...peers]).slice(0, 10)
    contract.contractChars = JSON.stringify(contract).length
    if (contract.contractChars > MAX_CONTRACT_CHARS) {
      throw new Error(`skill contract ${contract.id} exceeds bounded budget after composition expansion`)
    }
  }
  const registry = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    skillCount: contracts.length,
    contracts,
    byId: new Map(contracts.map((contract) => [contract.id, contract])),
    fingerprint: "skill-registry:sha256:" + hash(contracts.map((contract) => [contract.id, contract.contractChars, contract.intents, contract.taskClasses])),
  }
  registryCache = registry
  return registry
}

/** Bounded metadata-only view for the router. No skill bodies. */
export function skillRegistrySurface(options = {}) {
  const registry = skillRegistry()
  const limit = Math.max(1, Math.min(registry.contracts.length, Number(options.limit) || registry.contracts.length))
  const contracts = registry.contracts.slice(0, limit).map((contract) => ({
    id: contract.id,
    intents: contract.intents,
    taskClasses: contract.taskClasses,
    requiredCapabilities: contract.requiredCapabilities,
    optionalCapabilities: contract.optionalCapabilities,
    requiredTools: contract.requiredTools,
    optionalTools: contract.optionalTools,
    forbiddenActions: contract.forbiddenActions,
    contextClass: contract.contextClass,
    sideEffectClass: contract.sideEffectClass,
    outputContract: contract.outputContract,
    verificationRequirements: contract.verificationRequirements,
    hostSupport: contract.hostSupport,
  }))
  const payload = {
    schemaVersion: SKILL_REGISTRY_SCHEMA_VERSION,
    skillCount: contracts.length,
    totalSkills: registry.contracts.length,
    fullSkillBodiesLoaded: false,
    contracts,
  }
  const chars = JSON.stringify(payload).length
  if (chars > MAX_REGISTRY_CHARS) {
    throw new Error(`skill registry surface exceeds bounded budget (${chars} > ${MAX_REGISTRY_CHARS})`)
  }
  return Object.freeze({ ...payload, chars, fingerprint: registry.fingerprint })
}

/** Skill ids actually shipped on disk (reconciles the table against the package). */
export function shippedSkillIds() {
  if (!existsSync(SKILLS_ROOT)) return []
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(SKILLS_ROOT, name, "SKILL.md")))
    .sort()
}

export function skillRegistryDrift() {
  const registry = skillRegistry()
  const shipped = shippedSkillIds()
  const declared = registry.contracts.map((contract) => contract.id)
  return {
    schemaVersion: 1,
    shipped,
    declared,
    missingContracts: shipped.filter((id) => !declared.includes(id)),
    missingSkills: declared.filter((id) => !shipped.includes(id)),
    aligned: shipped.length === declared.length && shipped.every((id) => declared.includes(id)),
  }
}

export function clearSkillRegistryCache() {
  registryCache = null
}
