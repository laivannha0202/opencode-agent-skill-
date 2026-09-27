const SENSITIVE_DOMAIN = /(\bauth\b|authorization|authentication|security|permission|payment|schema|database|production|deploy|public api|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|triển khai|api công khai|bí mật|thông tin xác thực)/i
const HIGH_RISK_MUTATION = /((?:fix|change|modify|update|alter|migrate|drop|truncate|delete|remove|rotate|deploy|publish|push|sửa|thay đổi|cập nhật|xóa|xoá|di trú|chuyển đổi|triển khai).{0,64}(?:\bauth\b|authorization|authentication|security|permission|payment(?: handling| flow)?|schema|database|production|public api|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|api công khai|bí mật|thông tin xác thực)|(?:\bauth\b|authorization|authentication|security|permission|payment(?: handling| flow)?|schema|database|production|public api|secret|credential|phân quyền|bảo mật|thanh toán|cơ sở dữ liệu|api công khai|bí mật|thông tin xác thực).{0,64}(?:fix|change|modify|update|alter|migrate|drop|truncate|delete|remove|rotate|deploy|publish|push|sửa|thay đổi|cập nhật|xóa|xoá|di trú|chuyển đổi|triển khai)|database migration|schema migration|migrate database|migrate schema|drop table|truncate table|deploy(?:ment)?\s+(?:to\s+)?production|production\s+deploy(?:ment)?|rotate\s+(?:secret|credential)|breaking\s+(?:change\s+to\s+)?(?:public\s+)?api|npm publish|git push|force push|reset --hard|git clean)/i
const LONG = /(whole repo|whole repository|whole project|entire repo|entire project|large refactor|major refactor|long[- ](?:running|horizon)|durable state|dependency graph|integration verification|resume|refactor all|multi[- ]step migration|migration across|toàn bộ repo|toàn bộ repository|toàn bộ dự án|toàn bộ project|refactor lớn|tác vụ dài|nhiều file|nhiều module|tiếp tục công việc|refactor toàn bộ|xác minh tích hợp|kiểm tra tích hợp|chia (?:công việc|task|tác vụ).*(?:dependency|phụ thuộc))/i
const DEBUG = /(fix|bug|debug|crash|regression|failure|error|broken|sửa lỗi|lỗi|điều tra lỗi|không chạy)/i
const CONCRETE_DIAGNOSIS = /(\bdebug\b|diagnos|reproduce|stack\s*trace|exception|\bcrash(?:es|ed|ing)?\b|failing\s+test|tests?\s+(?:currently\s+)?fail(?:ing|ed)?|failure\s+(?:affects|occurs|happens|when|on)|error\s*[:=]|expected.{0,48}actual|actual.{0,48}expected|exit\s+code\s*[1-9]|\b(?:ECONN\w*|SQLSTATE|TypeError|ReferenceError|AssertionError)\b|điều\s+tra\s+lỗi|tái\s+hiện\s+lỗi|lỗi\s*[:=]|test.{0,32}(?:thất\s+bại|fail))/i
const CONTRACT = /(public api|api contract|openapi|response schema|request schema|breaking api|hợp đồng api|api công khai)/i
const DATA = /(database|sql|migration|schema|transaction|index|cơ sở dữ liệu|dữ liệu|migrate)/i
const BROAD_FILE_SCOPE = /(across\s+(?:multiple|several|many)\s+(?:files|modules|packages)|multiple\s+(?:files|modules|packages)|several\s+(?:files|modules|packages)|many\s+(?:files|modules|packages)|nhiều\s+(?:file|tệp|module)|toàn bộ\s+(?:repo|repository|project|dự án))/i
const CRITICAL_LOCAL_MUTATION = /(drop\s+table|truncate\s+table|reset\s+--hard|git\s+clean|force\s+push|npm\s+publish|deploy(?:ment)?\s+(?:to\s+)?production|production\s+deploy(?:ment)?|rotate\s+(?:secret|credential)|(?:secret|credential|token).{0,48}(?:rotate|replace|revoke|delete)|(?:authorization|authentication|permission|phân quyền|xác thực).{0,64}(?:change|modify|update|bypass|remove|delete|sửa|thay đổi)|(?:database|sql|schema).{0,64}(?:migration|migrate|drop|truncate|alter)|(?:migration|migrate).{0,64}(?:database|sql|schema)|payment.{0,64}(?:charge|capture|refund|webhook|checkout)|(?:charge|capture|refund|webhook|checkout).{0,64}payment|breaking\s+(?:change\s+to\s+)?(?:public\s+)?api)/i
const EXPLICIT_READ_ONLY = /(?:\bread[- ]?only\b|\bdo not\s+(?:edit|modify|change|write|create|delete|remove)\b|\bwithout\s+(?:editing|modifying|changing|writing|creating|deleting|removing)\b|\bno\s+(?:source|file|code)?\s*(?:edits?|changes?|writes?)\b|không\s+(?:sửa|chỉnh sửa|thay đổi|ghi|tạo|xóa|xoá)\b|chỉ\s+(?:đọc|kiểm tra|rà soát)\b)/i
const READ_ONLY_MODE = /(?:\bread[- ]?only\b|chế\s+độ\s+chỉ\s+đọc|chế\s+độ\s+read[- ]?only)/i
const MUTATION_INTENT = /(?:\b(?:fix|repair|implement|add|edit|modify|change|write|create|delete|remove|update|refactor|migrate|rename)\b|(?:sửa|chỉnh sửa|thay đổi|ghi|tạo|xóa|xoá|cập nhật|refactor|di trú|đổi tên))/i
const SOURCE_FILE_RE = /(?:^|[\s("'\x60])((?:[A-Za-z]:)?(?:[./\\\w@-]+[\\/])*[\w@.-]+\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|cs|rb|php|swift|dart|vue|svelte))(?=$|[\s"'\x60),:;.])/gi

const COMMAND_ONLY_READ_ONLY = /(?:chỉ\s+(?:chạy|thực hiện)(?:\s+đúng)?|only\s+(?:run|execute)|run\s+only|execute\s+only|exactly\s+(?:run|execute))/i

const AUTO_ENGINEERING_ACTION = /(?:\b(?:fix|repair|debug|implement|add|edit|modify|change|update|refactor|migrate|review|audit|verify|test|build|run|inspect|scan|check|analy[sz]e|optimi[sz]e|cleanup|clean up|commit|push|continue|resume)\b|(?:sửa|chỉnh sửa|xử lý|điều tra|thêm|tạo|cập nhật|thay đổi|refactor|di trú|rà soát|kiểm tra|xác minh|chạy|test|build|xem|phân tích|tối ưu|dọn|commit|push|tiếp tục))/i
const AUTO_ENGINEERING_TARGET = /(?:\b(?:repo(?:sitory)?|project|code|source|file|module|package|branch|commit|git|npm|pnpm|yarn|node|typescript|javascript|python|java|kotlin|swift|react|expo|android|ios|api|backend|frontend|mobile|web|database|db|sql|prisma|test|e2e|ci|build|lint|typecheck|runtime|server|client|bug|error|failure|exception)\b|(?:dự án|mã nguồn|tệp|nhánh|cơ sở dữ liệu|dữ liệu|kiểm thử|lỗi|ứng dụng|giao diện|máy chủ))/i
const AUTO_INFORMATIONAL_ONLY = /(?:^|\b)(?:explain|what\s+is|what\s+are|how\s+does|why\s+does|compare|difference\s+between|giải\s+thích|là\s+gì|hoạt\s+động\s+(?:ra\s+sao|thế\s+nào)|tại\s+sao|so\s+sánh)(?:\b|\s)/i
const AUTO_NON_TASK_CHAT = /^(?:xin\s*chào|chào|hello|hi|hey|cảm\s*ơn|cam\s*on|thanks?|ok(?:ay)?|được|ừ|uh|vâng|vang)[!?.\s]*$/i
const AUTO_ACTIVE_CONTINUATION = /^(?:continue|resume|keep\s+going|go\s+on|tiếp\s+tục|làm\s+tiếp|lam\s+tiep|sửa\s+tiếp|sua\s+tiep|kiểm\s+tra\s+tiếp|kiem\s+tra\s+tiep)(?:\b|[.!?,;:\s])/i

const SAFE_READ_ONLY_GIT_CHECKS = [
  { id: "git-status-short", label: "git status --short", match: /^git\s+status\s+--short\b/i, args: ["status", "--short"] },
  { id: "git-branch-current", label: "git branch --show-current", match: /^git\s+branch\s+--show-current\b/i, args: ["branch", "--show-current"] },
  { id: "git-rev-parse-head", label: "git rev-parse HEAD", match: /^git\s+rev-parse\s+head\b/i, args: ["rev-parse", "HEAD"] },
  { id: "git-rev-parse-root", label: "git rev-parse --show-toplevel", match: /^git\s+rev-parse\s+--show-toplevel\b/i, args: ["rev-parse", "--show-toplevel"] },
  { id: "git-status", label: "git status", match: /^git\s+status\b/i, args: ["status"] },
]

function referencedSourceFiles(value) {
  const files = []
  const seen = new Set()
  SOURCE_FILE_RE.lastIndex = 0
  let match
  while ((match = SOURCE_FILE_RE.exec(String(value || "")))) {
    const normalized = String(match[1] || "").replaceAll("\\", "/").toLowerCase()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    files.push(normalized)
  }
  return files
}

function singleFileBoundedTask(value, facts = {}) {
  const declaredFiles = Array.isArray(facts.declaredFiles) ? facts.declaredFiles.map(String).filter(Boolean) : []
  const changedFileCount = Array.isArray(facts.changedFiles)
    ? facts.changedFiles.length
    : Number.isFinite(Number(facts.changedFiles)) ? Number(facts.changedFiles) : 0
  const referencedFiles = referencedSourceFiles(value)
  const counts = [declaredFiles.length, changedFileCount, referencedFiles.length].filter((count) => count > 0)
  if (!counts.length || counts.some((count) => count > 1)) return false
  if (BROAD_FILE_SCOPE.test(String(value || "")) || LONG.test(String(value || ""))) return false
  return counts.some((count) => count === 1) && (
    declaredFiles.length === 1 ||
    changedFileCount === 1 ||
    /\b(?:fix|repair|change|update|modify|rename|implement|correct|sửa|chỉnh sửa|thay đổi|cập nhật)\b/i.test(String(value || ""))
  )
}


function riskTextFor(value) {
  return String(value || "")
    .replace(/\b(?:do not|don't|without)\s+(?:edit|modify|change|write|delete|remove)[^.\n]*/gi, "")
    .replace(/\b(?:no|read[- ]only)\s+(?:edits?|changes?|writes?)[^.\n]*/gi, "")
    .replace(/không\s+(?:sửa|chỉnh sửa|thay đổi|ghi|xóa|xoá)[^.\n]*/gi, "")
    .replace(/chỉ\s+đọc[^.\n]*/gi, "")
}

export function automaticUesContinuation(value, facts = {}) {
  const text = String(value || "").trim()
  if (!facts.activeRun) return { forward: false, reason: "no-active-run" }
  if (!text || text.startsWith("/")) return { forward: false, reason: "not-continuation" }
  if (!AUTO_ACTIVE_CONTINUATION.test(text)) return { forward: false, reason: "not-continuation" }
  return { forward: true, reason: "active-run-continuation" }
}

export function automaticUesAdmission(value, facts = {}) {
  const text = String(value || "").trim()
  const native = (reason, policy = null) => ({
    admit: false,
    route: "native",
    confidence: "low",
    reason,
    policy,
  })

  if (!text) return native("empty")
  if (text.startsWith("/")) return native("explicit-command")
  if (AUTO_NON_TASK_CHAT.test(text)) return native("casual-chat")
  if (facts.inGitWorkspace === false) return native("not-git-workspace")

  const policy = classifyEngineeringTask(text, facts)
  const action = AUTO_ENGINEERING_ACTION.test(text)
  const target = AUTO_ENGINEERING_TARGET.test(text)
  const informationalOnly =
    AUTO_INFORMATIONAL_ONLY.test(text) &&
    !/(?:\b(?:fix|repair|debug|implement|edit|modify|change|update|refactor|migrate|test|build|run|commit|push)\b|(?:sửa|chỉnh sửa|xử lý|thay đổi|cập nhật|refactor|chạy|test|build|commit|push))/i.test(text)
  const longStructured =
    target &&
    (
      text.length >= 700 ||
      policy.mode === "long-horizon" ||
      /(?:^|\n)\s*(?:phase\s+\d+|mục\s+tiêu|requirements?|acceptance criteria|final report)\b/i.test(text)
    )
  const readOnlyEngineering =
    policy.readOnly === true &&
    /(?:repo(?:sitory)?|project|code|source|git|file|test|dự án|mã nguồn|tệp|kiểm tra repository)/i.test(text)

  if (informationalOnly && !longStructured && !readOnlyEngineering) {
    return native("informational-question", policy)
  }

  const admit = longStructured || (action && target) || readOnlyEngineering
  if (!admit) return native("not-confident-engineering-task", policy)

  const route = policy.risk === "high" ? "guarded" : "auto"
  return {
    admit: true,
    route,
    confidence: longStructured || readOnlyEngineering ? "high" : "medium",
    reason:
      route === "guarded"
        ? "high-risk-engineering-task"
        : longStructured
          ? "long-structured-engineering-task"
          : readOnlyEngineering
            ? "read-only-engineering-task"
            : "engineering-action-target",
    policy,
  }
}

export function deterministicReadOnlyGitCommands(value) {
  const text = String(value || "")
  if (!COMMAND_ONLY_READ_ONLY.test(text)) return []

  const mentions = []
  const lower = text.toLowerCase()
  const gitRe = /\bgit\s+/g
  let hit
  while ((hit = gitRe.exec(lower))) {
    const tail = text.slice(hit.index)
    const matched = SAFE_READ_ONLY_GIT_CHECKS.find((item) => item.match.test(tail))
    if (!matched) return []
    mentions.push({ index: hit.index, id: matched.id, label: matched.label, command: "git", args: [...matched.args] })
  }

  if (!mentions.length) return []
  const seen = new Set()
  return mentions
    .sort((a, b) => a.index - b.index)
    .filter((item) => {
      if (seen.has(item.id)) return false
      seen.add(item.id)
      return true
    })
    .map(({ id, label, command, args }) => ({ id, label, command, args }))
}

function readOnlyTask(value, facts = {}) {
  if (facts.readOnly === true) return true
  const text = String(value || "")
  if (READ_ONLY_MODE.test(text)) return true
  if (!EXPLICIT_READ_ONLY.test(text)) return false
  // Negative file-scope constraints ("fix X, but do not modify Y") must not
  // convert a mutating engineering task into a read-only inspection.
  return !MUTATION_INTENT.test(riskTextFor(text))
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

export function shouldRunDedicatedDiagnosis(taskPolicy = {}, attempt = 1) {
  const hasDebugSignal = Array.isArray(taskPolicy.signals) &&
    taskPolicy.signals.some((item) => item?.name === "debugging")
  if (!hasDebugSignal) return false

  const normalizedAttempt = boundedInt(attempt, 1, 1, 99)
  if (normalizedAttempt > 1) {
    return recoveryPolicyForAttempt(taskPolicy, normalizedAttempt).requireDiagnosis === true
  }

  // Long-horizon work already has an architect + independent plan gate. A generic
  // word such as "fix" must not force a redundant debugger pass before planning.
  // Keep first-pass diagnosis when the request contains concrete failure evidence.
  if (
    taskPolicy.mode === "long-horizon" &&
    taskPolicy.requirePlanCheck === true &&
    taskPolicy.diagnosisEvidence !== true
  ) {
    return false
  }

  return taskPolicy.executionProfile !== "fast" || taskPolicy.risk !== "low"
}

export function classifyEngineeringTask(text, facts = {}) {
  const value = String(text || "")
  const riskText = riskTextFor(value)
  const sensitiveDomain = SENSITIVE_DOMAIN.test(value)
  const readOnly = readOnlyTask(value, facts)
  const singleFileBounded = readOnly ? false : singleFileBoundedTask(value, facts)
  const rawSensitiveMutation = HIGH_RISK_MUTATION.test(riskText)
  const sensitiveMutation =
    rawSensitiveMutation &&
    (!singleFileBounded || CRITICAL_LOCAL_MUTATION.test(riskText))
  const dataMigration =
    Boolean(facts.hasMigration) ||
    (
      !singleFileBounded &&
      DATA.test(riskText) &&
      /migration|schema|migrate|di trú|chuyển đổi/i.test(riskText)
    )
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
    signal("read-only", readOnly, -1),
    signal("single-file-bounded", singleFileBounded, -2),
    signal("public-contract", CONTRACT.test(value) || facts.hasPublicContract, 2),
    signal("data-migration", dataMigration, 2),
    signal("many-changed-files", Number(facts.changedFiles || 0) > 5, 1),
    signal("very-many-changed-files", Number(facts.changedFiles || 0) > 12, 1),
    signal("large-repository", Number(facts.repoFiles || 0) > 1500, 1),
    signal("monorepo", facts.monorepo === true, 1),
  ].filter(Boolean)

  const score = Math.max(0, signals.reduce((sum, item) => sum + item.weight, 0))
  const highRisk = declaredHighRisk || sensitiveMutation || Boolean(facts.hasMigration) || Boolean(facts.hasPublicContract)
  const diagnosisEvidence = facts.failureEvidence === true || CONCRETE_DIAGNOSIS.test(value)
  const risk = highRisk ? "high" : singleFileBounded ? "low" : score >= 3 ? "medium" : "low"
  const mode =
    explicitLongHorizon
      ? "long-horizon"
      : singleFileBounded && !highRisk
        ? "inline"
        : score >= 4
          ? "long-horizon"
          : score >= 2
            ? "standard"
            : "inline"
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
    requirePlanCheck: readOnly ? false : profile.durableState || risk === "high",
    requireIntegrationVerification: readOnly ? false : mode !== "inline" || risk === "high",
    requireFreshEvidence: true,
    requireBehavioralReceipt: !readOnly,
    readOnly,
    singleFileBounded,
    diagnosisEvidence,
    profile: readOnly
      ? {
          ...profile,
          worktree: "off",
          verification: "command-evidence",
          fullCI: false,
          containerVerification: "off",
        }
      : profile,
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
