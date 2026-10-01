import { createHash } from "node:crypto"

const ROLE_RULES = Object.freeze({
  architect: { readOnly: true, include: ["task","contract","repoFacts","repoMap","context","evidence","failures","plan"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 24 },
  "codebase-mapper": { readOnly: true, include: ["task","repoFacts","repoMap","context","evidence"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 20 },
  "plan-checker": { readOnly: true, include: ["task","contract","plan","repoFacts","evidence","failures"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 24 },
  executor: { readOnly: false, include: ["task","contract","plan","repoFacts","repoMap","context","evidence","failures","writeIntent"], exclude: [], maxEvidenceRefs: 32 },
  debugger: { readOnly: true, include: ["task","contract","failures","context","evidence","repoFacts"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 28 },
  reviewer: { readOnly: true, include: ["task","contract","diff","evidence","failures","repoFacts"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 28 },
  critic: { readOnly: true, include: ["task","contract","plan","diff","evidence","failures"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 24 },
  verifier: { readOnly: true, include: ["task","contract","acceptanceCriteria","diff","verificationPlan","evidence","failures","repoFacts"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 32 },
  "integration-verifier": { readOnly: true, include: ["task","contract","acceptanceCriteria","diff","verificationPlan","evidence","failures","repoFacts","integrationState"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 40 },
  "visual-verifier": { readOnly: true, include: ["task","contract","acceptanceCriteria","visualSpec","browserEvidence","evidence","failures"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 32 },
  "merge-arbiter": { readOnly: false, include: ["task","contract","diff","evidence","failures","repoFacts","writeIntent"], exclude: ["executorRationale"], maxEvidenceRefs: 36 },
  researcher: { readOnly: true, include: ["task","repoFacts","context","evidence"], exclude: ["executorRationale","writeIntent"], maxEvidenceRefs: 24 },
})

function cleanRole(value) {
  return String(value || "executor").replace(/^ues-/, "")
}

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function roleContextABI(role, options = {}) {
  const normalizedRole = cleanRole(role)
  const base = ROLE_RULES[normalizedRole] || ROLE_RULES.executor
  const payload = {
    schemaVersion: 1,
    role: normalizedRole,
    readOnly: base.readOnly,
    include: [...base.include],
    exclude: [...base.exclude],
    maxEvidenceRefs: Math.max(4, Math.min(64, Number(options.maxEvidenceRefs || base.maxEvidenceRefs))),
    freshContextRequired: options.freshContextRequired === true || normalizedRole.includes("verifier") || normalizedRole === "critic" || normalizedRole === "reviewer",
    executorRationaleVisible: false,
    hiddenChainOfThoughtRecorded: false,
  }
  return Object.freeze({ ...payload, id: "role-context:sha256:" + hash(payload) })
}

export function applyRoleContextABI(input = {}, role, options = {}) {
  const abi = roleContextABI(role, options)
  const output = {}
  for (const key of abi.include) {
    if (input[key] !== undefined) output[key] = input[key]
  }
  if (Array.isArray(output.evidence)) output.evidence = output.evidence.slice(0, abi.maxEvidenceRefs)
  return { schemaVersion: 1, abi, context: output }
}
