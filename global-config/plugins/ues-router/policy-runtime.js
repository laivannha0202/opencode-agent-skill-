const SENSITIVE_DOMAIN = /(\bauth\b|authorization|authentication|security|permission|payment|schema|database|production|deploy|public api|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|triển khai|api công khai|bí mật|thông tin xác thực)/i
const HIGH_RISK_MUTATION = /((?:fix|change|modify|update|alter|migrate|drop|truncate|delete|remove|rotate|deploy|publish|push|sửa|thay đổi|cập nhật|xóa|xoá|di trú|chuyển đổi|triển khai).{0,64}(?:\bauth\b|authorization|authentication|security|permission|payment(?: handling| flow)?|schema|database|production|public api|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|api công khai|bí mật|thông tin xác thực)|(?:\bauth\b|authorization|authentication|security|permission|payment(?: handling| flow)?|schema|database|production|public api|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|api công khai|bí mật|thông tin xác thực).{0,64}(?:fix|change|modify|update|alter|migrate|drop|truncate|delete|remove|rotate|deploy|publish|push|sửa|thay đổi|cập nhật|xóa|xoá|di trú|chuyển đổi|triển khai)|database migration|schema migration|migrate database|migrate schema|drop table|truncate table|deploy(?:ment)?\s+(?:to\s+)?production|production\s+deploy(?:ment)?|rotate\s+(?:secret|credential)|breaking\s+(?:change\s+to\s+)?(?:public\s+)?api|npm publish|git push|force push|reset --hard|git clean)/i
const LONG = /(whole repo|whole repository|whole project|entire repo|entire project|large refactor|major refactor|long[- ](?:running|horizon)|durable state|dependency graph|integration verification|resume|refactor all|multi[- ]step migration|migration across|toàn bộ repo|toàn bộ repository|toàn bộ dự án|toàn bộ project|refactor lớn|tác vụ dài|nhiều file|nhiều module|tiếp tục công việc|refactor toàn bộ|xác minh tích hợp|kiểm tra tích hợp|chia (?:công việc|task|tác vụ).*(?:dependency|phụ thuộc))/i
const DEBUG = /(fix|bug|debug|crash|regression|failure|error|broken|sửa lỗi|lỗi|điều tra lỗi|không chạy)/i
const CONTRACT = /(public api|api contract|openapi|response schema|request schema|breaking api|hợp đồng api|api công khai)/i
const DATA = /(database|sql|migration|schema|transaction|index|cơ sở dữ liệu|dữ liệu|migrate)/i

function riskTextFor(value) {
  return String(value || "")
    .replace(/\b(?:do not|don't|without)\s+(?:edit|modify|change|write|delete|remove)[^.\n]*/gi, "")
    .replace(/\b(?:no|read[- ]only)\s+(?:edits?|changes?|writes?)[^.\n]*/gi, "")
    .replace(/không\s+(?:sửa|chỉnh sửa|thay đổi|ghi|xóa|xoá)[^.\n]*/gi, "")
    .replace(/chỉ\s+đọc[^.\n]*/gi, "")
}

function signal(name, matched, weight) {
  return matched ? { name, weight } : null
}

function profileFor(mode, risk) {
  if (mode === "inline" && risk === "low") {
    return {
      name: "fast",
      maxSkills: 2,
      contextBudget: 8_000,
      contextStrategy: "incremental-semantic",
      skillLoading: "direct-only",
      durableState: false,
      worktree: "off",
      critic: "off",
      verification: "targeted",
      fullCI: false,
      containerVerification: "off",
    }
  }
  if (mode === "long-horizon" || risk === "high") {
    return {
      name: "deep",
      maxSkills: 5,
      contextBudget: 48_000,
      contextStrategy: "semantic+graph+git",
      skillLoading: "orchestrated",
      durableState: true,
      worktree: "auto-writers",
      critic: "required-for-high-risk-or-final",
      verification: "targeted+integration",
      fullCI: true,
      containerVerification: risk === "high" ? "preferred-if-capable" : "optional",
    }
  }
  return {
    name: "standard",
    maxSkills: 4,
    contextBudget: 20_000,
    contextStrategy: "incremental-semantic+git",
    skillLoading: "selective",
    durableState: false,
    worktree: "auto-on-conflict",
    critic: "on-failure-or-elevated-risk",
    verification: "targeted+affected",
    fullCI: false,
    containerVerification: "off",
  }
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

export function recoveryPolicyForAttempt(taskPolicy = {}, attempt = 1) {
  const normalizedAttempt = boundedInt(attempt, 1, 1, 99)
  const baseBudget = boundedInt(
    taskPolicy.contextBudget ?? taskPolicy.profile?.contextBudget,
    20_000,
    4_000,
    48_000,
  )
  const baseSkills = boundedInt(
    taskPolicy.maxSkills ?? taskPolicy.profile?.maxSkills,
    4,
    1,
    5,
  )
  const baseStrategy = taskPolicy.profile?.contextStrategy || "incremental-semantic+git"

  if (normalizedAttempt <= 1) {
    return {
      schemaVersion: 1,
      stage: "initial",
      attempt: normalizedAttempt,
      contextBudget: baseBudget,
      maxSkills: baseSkills,
      contextStrategy: baseStrategy,
      requireDiagnosis: false,
      requireCritic: false,
      modelEscalation: false,
      directives: [],
    }
  }

  if (normalizedAttempt === 2) {
    return {
      schemaVersion: 1,
      stage: "diagnose",
      attempt: normalizedAttempt,
      contextBudget: Math.min(48_000, Math.max(baseBudget, Math.round(baseBudget * 1.35))),
      maxSkills: Math.min(5, baseSkills + 1),
      contextStrategy:
        taskPolicy.executionProfile === "fast"
          ? "incremental-semantic+git"
          : baseStrategy,
      requireDiagnosis: true,
      requireCritic: false,
      modelEscalation: true,
      directives: [
        "reproduce or capture the exact previous failure before editing",
        "inspect the direct caller, nearest test and failure-adjacent evidence",
        "do not stack another speculative patch on top of the failed attempt",
      ],
    }
  }

  return {
    schemaVersion: 1,
    stage: "deep-recovery",
    attempt: normalizedAttempt,
    contextBudget: Math.min(48_000, Math.max(20_000, Math.round(baseBudget * 1.75))),
    maxSkills: Math.min(5, baseSkills + 2),
    contextStrategy: "semantic+graph+git",
    requireDiagnosis: true,
    requireCritic: true,
    modelEscalation: true,
    directives: [
      "re-investigate from fresh evidence and explicitly reject the failed hypothesis",
      "expand to callers, dependencies, tests and boundary contracts before editing",
      "challenge the architecture or coupling if repeated fixes expose a wider problem",
      "run an independent critic or review pass before accepting the recovery",
    ],
  }
}

export function classifyEngineeringTask(text, facts = {}) {
  const value = String(text || "")
  const riskText = riskTextFor(value)
  const sensitiveDomain = SENSITIVE_DOMAIN.test(value)
  const sensitiveMutation = HIGH_RISK_MUTATION.test(riskText)
  const declaredHighRisk =
    ["high", "critical"].includes(String(facts.risk || "").toLowerCase()) ||
    /\b(?:risk|rủi ro)\s*[:=\/-]?\s*(?:high|critical|cao|nghiêm trọng)\b/i.test(value) ||
    /\b(?:high|critical)[-\s]?(?:risk|rủi ro)\b/i.test(value)
  const declaredLongHorizon =
    facts.longHorizon === true ||
    ["long", "long-horizon", "deep"].includes(String(facts.mode || "").toLowerCase())
  const compoundLongRisk =
    /\blong\s*[/|,+]\s*(?:high|critical)[-\s]?risk\b/i.test(value) ||
    /\b(?:high|critical)[-\s]?risk\s*[/|,+]\s*long\b/i.test(value)
  const explicitLongHorizon = declaredLongHorizon || compoundLongRisk || LONG.test(value)
  const signals = [
    signal("long-request-text", value.length > 700, 1),
    signal("medium-request-text", value.length > 250, 1),
    signal("high-risk-domain", sensitiveDomain, 1),
    signal("high-risk-operation", sensitiveMutation, 2),
    signal("declared-high-risk", declaredHighRisk, 2),
    signal("explicit-long-horizon", explicitLongHorizon, 2),
    signal("debugging", DEBUG.test(value), 1),
    signal("public-contract", CONTRACT.test(value) || facts.hasPublicContract, 2),
    signal("data-migration", (DATA.test(riskText) && /migration|schema|migrate|di trú|chuyển đổi/i.test(riskText)) || facts.hasMigration, 2),
    signal("many-changed-files", Number(facts.changedFiles || 0) > 5, 1),
    signal("very-many-changed-files", Number(facts.changedFiles || 0) > 12, 1),
    signal("large-repository", Number(facts.repoFiles || 0) > 1500, 1),
    signal("monorepo", facts.monorepo === true, 1),
  ].filter(Boolean)

  const score = signals.reduce((sum, item) => sum + item.weight, 0)
  const highRisk = declaredHighRisk || sensitiveMutation || Boolean(facts.hasMigration) || Boolean(facts.hasPublicContract)
  const risk = highRisk ? "high" : score >= 3 ? "medium" : "low"
  const mode = explicitLongHorizon || score >= 4 ? "long-horizon" : score >= 2 ? "standard" : "inline"
  const modelTier = risk === "high" || mode === "long-horizon" ? "heavy" : score >= 2 ? "standard" : "light"
  const maxAttempts = risk === "high" ? 2 : 3
  const profile = profileFor(mode, risk)

  const domains = []
  if (/(auth|permission|tenant|token|session|phân quyền|xác thực)/i.test(value)) domains.push("auth-security")
  if (/(payment|checkout|refund|webhook|thanh toán|hoàn tiền)/i.test(value)) domains.push("payment")
  if (DATA.test(value)) domains.push("database")
  if (CONTRACT.test(value)) domains.push("api-contract")
  if (/(react native|expo|android|ios|gradle|xcode)/i.test(value)) domains.push("react-native")
  else if (/(next\.js|nextjs|app router|server component)/i.test(value)) domains.push("nextjs")
  else if (/\breact\b|useeffect|usestate|component/i.test(value)) domains.push("react")
  if (/(docker|kubernetes|terraform|github actions|ci\/cd|deploy|triển khai)/i.test(value)) domains.push("devops")

  return {
    schemaVersion: 4,
    score,
    signals,
    risk,
    mode,
    executionProfile: profile.name,
    modelTier,
    maxAttempts,
    contextBudget: profile.contextBudget,
    maxSkills: profile.maxSkills,
    requirePlanCheck: profile.durableState || risk === "high",
    requireIntegrationVerification: mode !== "inline" || risk === "high",
    requireFreshEvidence: true,
    profile,
    domains: [...new Set(domains)],
    recovery: {
      escalateAfterFailure: true,
      diagnosisBeforePatch: true,
      deepRecoveryFromAttempt: 3,
    },
    antiHallucination: {
      evidenceFirst: true,
      noCompletionWithoutVerification: mode !== "inline" || risk === "high",
      noUnsupportedSemanticClaims: true,
      failClosedOnMissingCapability: risk === "high",
    },
  }
}
