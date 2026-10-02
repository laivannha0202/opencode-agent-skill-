import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"

export const PLANNING_ERROR = Object.freeze({
  PARSE: "PLAN_PARSE_ERROR",
  SCHEMA: "PLAN_SCHEMA_ERROR",
  REQUIREMENT: "PLAN_REQUIREMENT_ERROR",
  TIMEOUT: "PLANNER_TIMEOUT",
  TRANSPORT: "TRANSPORT_ERROR",
})

const CRITICAL_OR_IRREVERSIBLE = /(?:npm\s+publish|force\s+push|push\s+--force|git\s+reset\s+--hard|git\s+clean\b|deploy(?:ment)?\s+(?:to\s+)?production|production\s+deploy|drop\s+table|truncate\s+table|rotate\s+(?:secret|credential)|database\s+migration|schema\s+migration|migrate\s+(?:database|schema)|payment.{0,48}(?:charge|capture|refund)|(?:auth|authorization|authentication|permission).{0,48}(?:bypass|remove|disable))/i
const DIRECT_LANE_SIDE_EFFECT = /(?:\bgit\s+push\b|\bgh\s+pr\s+(?:create|merge)\b|\bnpm\s+publish\b|\bdeploy\b|\brelease\s+to\b)/i
const BOUNDED_EDIT = /(?:\bmetadata\b|\bversion\b|current[- ]version|readme|changelog|package(?:-lock)?\.json|exact(?:ly)?\s+(?:one|1|two|2|three|3|four|4)|only\s+(?:change|edit|modify)|chỉ\s+sửa|đúng\s+(?:một|1|hai|2|ba|3|bốn|4)|from\s*:?\s*[\s\S]{0,300}\bto\s*:|replace\s+.+\s+with\s+)/i
const BROAD_SCOPE = /(?:whole\s+(?:repo|repository|project)|entire\s+(?:repo|repository|project)|across\s+(?:many|multiple|several)\s+(?:files|modules|packages)|large\s+refactor|major\s+refactor|toàn\s+bộ\s+(?:repo|repository|dự án|project)|nhiều\s+(?:file|tệp|module))/i
const PATH_TOKEN = /(?:^|[\s\x60'"(])((?:[A-Za-z]:)?(?:[.\w@-]+[\\/])*[\w@.-]+\.(?:md|json|ya?ml|toml|txt|ini|cfg|conf|[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|rb|php|swift|dart|vue|svelte|sql))(?=$|[\s\x60'"),:;])/gim
const NEGATED_ACTION = /(?:do\s+not|don't|never|must\s+not|without|không|khong|tuyệt\s+đối\s+không|tuyet\s+doi\s+khong|cấm|cam)[^\n.;]*/gi

function uniq(values) {
  return [...new Set(values)]
}

function actionableText(value) {
  return String(value || "").replace(NEGATED_ACTION, " ")
}

export function referencedPlanningFiles(task) {
  const text = String(task || "")
  const rows = []
  PATH_TOKEN.lastIndex = 0
  let match
  while ((match = PATH_TOKEN.exec(text))) {
    const raw = String(match[1] || "").replaceAll("\\", "/")
    if (!raw || /^[A-Za-z]:\//.test(raw)) continue
    const normalized = raw.replace(/^\.\//, "")
    if (!normalized || normalized.includes("../")) continue
    rows.push(normalized)
  }
  return uniq(rows).slice(0, 16)
}

function candidatePlanFiles(plan) {
  if (!Array.isArray(plan?.tasks)) return []
  const rows = []
  for (const task of plan.tasks) {
    for (const kind of ["create", "modify", "delete"]) {
      for (const value of Array.isArray(task?.files?.[kind]) ? task.files[kind] : []) {
        const relative = String(value || "").replaceAll("\\", "/")
        if (relative && !relative.includes("../") && !rows.includes(relative)) rows.push(relative)
      }
    }
  }
  return rows.slice(0, 16)
}

export function directLaneDecision(task, policy = {}, executionContract = null, options = {}) {
  const text = String(task || "")
  const actionText = actionableText(text)
  const taskFiles = referencedPlanningFiles(actionText)
  const fallbackFiles = options.afterPlannerFailure === true ? candidatePlanFiles(options.candidatePlan) : []
  const files = taskFiles.length ? taskFiles : fallbackFiles
  const explicitPhases = Number(executionContract?.phases?.length || 0)
  const irreversible = CRITICAL_OR_IRREVERSIBLE.test(actionText)
  const workflowSideEffect = DIRECT_LANE_SIDE_EFFECT.test(actionText)
  const broad = BROAD_SCOPE.test(actionText)
  const boundedSignal = BOUNDED_EDIT.test(text) || (options.afterPlannerFailure === true && fallbackFiles.length > 0)
  const fileBounded = files.length > 0 && files.length <= 4
  const criticalPolicy = String(policy?.risk || "").toLowerCase() === "critical"

  let eligible = false
  let reason = "not-bounded"
  if (policy?.readOnly === true) reason = "read-only-has-dedicated-lane"
  else if (criticalPolicy || irreversible) reason = "irreversible-or-critical-operation"
  else if (workflowSideEffect) reason = "external-workflow-side-effect"
  else if (explicitPhases > 0) reason = "explicit-phase-contract"
  else if (broad) reason = "broad-scope"
  else if (!boundedSignal) reason = "no-bounded-edit-signal"
  else if (!fileBounded) reason = "file-scope-not-bounded"
  else {
    eligible = true
    reason = options.afterPlannerFailure === true
      ? "bounded-direct-fallback-after-planner-failure"
      : "bounded-direct-lane"
  }

  return {
    schemaVersion: 1,
    eligible,
    reason,
    files,
    boundedSignal,
    broad,
    irreversible,
    workflowSideEffect,
    afterPlannerFailure: options.afterPlannerFailure === true,
    preservesVerification: true,
    bypassesPermissionChecks: false,
  }
}

function timeoutText(input = {}) {
  return [input.output, input.stderr, input.stopReason, input.errorMessage]
    .filter(Boolean)
    .join("\n")
}

export function classifyPlanningFailure(input = {}) {
  const text = timeoutText(input)
  if (/absolute-hard-timeout|hard-timeout|idle-timeout|timed out|timeout/i.test(text)) {
    return { code: PLANNING_ERROR.TIMEOUT, retryable: true, message: "planner runtime timed out" }
  }
  if (
    (input.exitCode !== undefined && Number(input.exitCode) !== 0) ||
    /rpc-runtime-error|transport|connection|socket|provider unavailable|ECONN/i.test(text)
  ) {
    return { code: PLANNING_ERROR.TRANSPORT, retryable: true, message: "planner transport/runtime failure" }
  }
  if (!input.plan || input.parseError) {
    return {
      code: PLANNING_ERROR.PARSE,
      retryable: true,
      message: String(input.parseError || "planner output did not contain parseable plan JSON"),
    }
  }
  if (input.validation && input.validation.valid !== true) {
    return {
      code: PLANNING_ERROR.SCHEMA,
      retryable: true,
      message: (input.validation.errors || []).join("; ") || "plan schema invalid",
    }
  }
  if (input.requirementGate && input.requirementGate.valid !== true) {
    return {
      code: PLANNING_ERROR.REQUIREMENT,
      retryable: true,
      message: (input.requirementGate.errors || []).join("; ") || "requirement coverage invalid",
    }
  }
  return { code: null, retryable: false, message: "no planning failure" }
}

export function planningFailureFingerprint(failure = {}, candidate = null) {
  const payload = JSON.stringify({
    code: failure?.code || null,
    message: String(failure?.message || "").replace(/\s+/g, " ").trim().slice(0, 1200),
    validation: candidate?.validation?.errors || [],
    requirementErrors: candidate?.requirementGate?.errors || [],
    repairs: candidate?.repairs || [],
  })
  return createHash("sha256").update(payload).digest("hex").slice(0, 20)
}

function declaredPathErrors(plan, root) {
  if (!root || !Array.isArray(plan?.tasks)) return []
  const base = path.resolve(root)
  const creates = new Set()
  for (const task of plan.tasks) {
    for (const value of Array.isArray(task?.files?.create) ? task.files.create : []) {
      creates.add(String(value || "").replaceAll("\\", "/"))
    }
  }
  const errors = []
  for (const task of plan.tasks) {
    for (const kind of ["read", "modify", "delete"]) {
      for (const raw of Array.isArray(task?.files?.[kind]) ? task.files[kind] : []) {
        const relative = String(raw || "").replaceAll("\\", "/")
        if (!relative || creates.has(relative)) continue
        const target = path.resolve(base, relative)
        if (target !== base && !target.startsWith(base + path.sep)) continue
        if (!existsSync(target)) errors.push("task " + task.id + " declares missing " + kind + " path " + relative)
      }
    }
  }
  return errors
}

export function plannerSelfCheck(input = {}) {
  const errors = []
  const validation = input.validation || null
  const requirementGate = input.requirementGate || null
  const phaseGate = input.phaseGate || null

  if (!input.plan) errors.push("plan missing")
  if (!validation || validation.valid !== true) {
    errors.push(...(validation?.errors || ["plan schema not verified"]))
  }
  if (requirementGate && requirementGate.valid !== true) {
    errors.push(...(requirementGate.errors || ["requirement coverage not verified"]))
  }
  if (phaseGate && phaseGate.valid !== true) {
    errors.push(...(phaseGate.errors || ["phase contract not verified"]))
  }
  const pathErrors = validation?.valid === true ? declaredPathErrors(input.plan, input.root) : []
  errors.push(...pathErrors)

  return {
    schemaVersion: 1,
    valid: errors.length === 0,
    errors: uniq(errors.map(String)),
    checks: {
      jsonSchema: Boolean(validation?.valid),
      dependencies: Boolean(validation?.valid),
      fileScope: validation?.valid === true ? pathErrors.length === 0 : false,
      commandShape: Boolean(validation?.valid),
      requirements: requirementGate ? requirementGate.valid === true : null,
      phases: phaseGate ? phaseGate.valid === true : null,
    },
  }
}

export function planningRecoveryDecision(input = {}) {
  const attempts = Math.max(1, Number(input.attempts || 1))
  const maxAttempts = Math.max(1, Math.min(2, Number(input.maxAttempts || 2)))
  const currentFingerprint = String(input.fingerprint || "")
  const previousFingerprints = Array.isArray(input.previousFingerprints)
    ? input.previousFingerprints.map(String)
    : []
  const repeat = Boolean(currentFingerprint && previousFingerprints.includes(currentFingerprint))
  const direct = directLaneDecision(input.task, input.policy, input.executionContract, {
    afterPlannerFailure: true,
    candidatePlan: input.candidatePlan || null,
  })

  if (direct.eligible) {
    return { action: "DIRECT_FALLBACK", reason: direct.reason, direct, repeat }
  }
  if (repeat) {
    return { action: "STOP", reason: "repeated-planning-failure", direct, repeat: true }
  }
  if (attempts < maxAttempts && input.failure?.retryable !== false) {
    return { action: "RETRY", reason: "bounded-targeted-recovery", direct, repeat: false }
  }
  return { action: "STOP", reason: "planning-recovery-exhausted", direct, repeat: false }
}
