function add(list, id) {
  if (!list.includes(id)) list.push(id)
}

const PROCESS_SKILLS = new Set([
  "ues-engineering-orchestrator",
  "ues-long-task-state",
  "ues-task-planner",
  "ues-bug-diagnosis",
  "ues-research-verification",
  "ues-repo-explorer",
])

const DOMAIN_PATTERNS = [
  ["react-native", /(react native|expo|android|ios|gradle|xcode|metro)/],
  ["nextjs", /(next\.js|nextjs|app router|server component)/],
  ["react", /(\breact\b|\bhook\b|useeffect|usestate|\bcomponent\b)/],
  ["fastapi", /(fastapi|pydantic|uvicorn)/],
  ["django", /(django|django rest|drf)/],
  ["python", /(python|pytest|pip|poetry|pyproject)/],
  ["nestjs", /(nestjs|nest\.js)/],
  ["nodejs", /(node\.js|nodejs|express|npm|pnpm|yarn)/],
  ["dotnet", /(asp\.net|\.net|dotnet|nuget|c#)/],
  ["java-spring", /(spring boot|spring framework|maven|gradle java|\bjava\b)/],
  ["flutter", /(flutter|dart)/],
  ["database", /(database|migration|sql|query|index|transaction|schema changes?|cơ sở dữ liệu|truy vấn|chỉ mục|giao dịch|migrate dữ liệu)/],
  ["auth-security", /(auth|authorization|authentication|permission|role|tenant|idor|token|session|xác thực|phân quyền|quyền|vai trò)/],
  ["payment", /(payment|checkout|webhook|refund|idempotenc|thanh toán|hoàn tiền)/],
  ["api-contract", /(api contract|openapi|response schema|request schema|breaking api|public api|hợp đồng api|api công khai)/],
  ["devops", /(docker|github actions|ci\/cd|pipeline|deploy|kubernetes|container|triển khai|đường ống ci)/],
  ["performance", /(performance|slow|latency|memory leak|n\+1|bundle size|hiệu năng|chậm|rò rỉ bộ nhớ)/],
  ["accessibility", /(accessibility|accessible|a11y|screen reader|keyboard navigation|aria|focus management|focus handling)/],
  ["file-upload", /(upload|file upload|multipart|object storage)/],
  ["ecommerce", /(ecommerce|marketplace|inventory|cart|catalog|order)/],
]

const STACK_TO_DOMAIN = new Map([
  ["react-native", "react-native"],
  ["react", "react"],
  ["nextjs", "nextjs"],
  ["nestjs", "nestjs"],
  ["express", "nodejs"],
  ["fastify", "nodejs"],
  ["node", "nodejs"],
  ["python", "python"],
  ["django", "django"],
  ["java-maven", "java-spring"],
  ["java-gradle", "java-spring"],
  ["kotlin-gradle", "java-spring"],
  ["dotnet", "dotnet"],
  ["flutter", "flutter"],
])

export function classifyIntent(text, facts = {}) {
  const value = String(text || "").toLowerCase()
  const domains = []
  for (const [domain, pattern] of DOMAIN_PATTERNS) {
    if (pattern.test(value)) add(domains, domain)
  }

  const repoStacks = [...new Set(
    (facts.repoStacks || facts.stacks || [])
      .map((item) => String(item || "").toLowerCase())
      .filter(Boolean),
  )]
  const explicitFramework = domains.some((domain) => [
    "react-native", "nextjs", "react", "fastapi", "django", "python", "nestjs",
    "nodejs", "dotnet", "java-spring", "flutter",
  ].includes(domain))
  if (!explicitFramework) {
    for (const stack of repoStacks) add(domains, STACK_TO_DOMAIN.get(stack))
  }

  const actions = []
  if (/(\bfix\b|\bbug\b|crash|regression|failing|failure|error|exception|broken|\bdebug\b|sửa lỗi|lỗi|không chạy|bị hỏng|điều tra lỗi)/.test(value)) add(actions, "debug")
  if (/(implement|feature|add|build|create|triển khai tính năng|thêm|xây dựng)/.test(value)) add(actions, "implement")
  if (/(review|audit|kiểm tra code|đánh giá)/.test(value)) add(actions, "review")
  if (/(investigate|analy[sz]e|profile|optimi[sz]e|điều tra|phân tích|tối ưu)/.test(value)) add(actions, "investigate")
  if (/(refactor|cleanup|restructure|refactor toàn bộ)/.test(value)) add(actions, "refactor")
  if (/(latest|current docs|documentation|release notes|version compatibility|dependency|package version|api changed|tài liệu mới nhất|phiên bản mới|tương thích phiên bản|package mới)/.test(value)) add(actions, "research")

  const risky = /(migration|schema|database|sql|auth|permission|security|payment|webhook|public api|contract|dependency|deploy|ci|production|rollback|cơ sở dữ liệu|phân quyền|xác thực|bảo mật|thanh toán|triển khai|phụ thuộc)/.test(value)
  const longHorizon = value.length > 700 || /(large task|big task|long[- ]running|multi[- ]file|cross[- ]module|whole (?:repo|repository|project)|entire (?:repo|repository|project)|full refactor|refactor all|migrate all|resume this work|toàn bộ (?:repo|repository|dự án)|nhiều file|nhiều module|refactor toàn bộ|tiếp tục công việc)/.test(value)
  const nonTrivial = value.length > 220 || risky || actions.length > 0

  const feedbackDomains = [...new Set((facts.feedbackDomains || []).filter((item) => domains.includes(item)))]
  const confidence = Math.min(1, 0.35 + domains.length * 0.08 + actions.length * 0.08 + (repoStacks.length ? 0.08 : 0) + (feedbackDomains.length ? 0.08 : 0))

  return {
    schemaVersion: 1,
    actions,
    domains,
    repoStacks,
    feedbackDomains,
    nonTrivial,
    risk: risky ? "high" : nonTrivial ? "medium" : "low",
    scope: longHorizon ? "long-horizon" : nonTrivial ? "standard" : "inline",
    confidence: Number(confidence.toFixed(2)),
  }
}

function addDomainSkills(routed, value, intent) {
  if (/(react native|expo|android|ios|gradle|xcode|metro)/.test(value)) add(routed, "ues-react-native-engineering")
  else if (/(next\.js|nextjs|app router|server component)/.test(value)) add(routed, "ues-nextjs-engineering")
  else if (/(\breact\b|\bhook\b|useeffect|usestate|\bcomponent\b)/.test(value)) add(routed, "ues-react-engineering")
  else {
    for (const domain of intent.domains) {
      if (domain === "react-native") add(routed, "ues-react-native-engineering")
      else if (domain === "nextjs") add(routed, "ues-nextjs-engineering")
      else if (domain === "react") add(routed, "ues-react-engineering")
    }
  }

  if (/(fastapi|pydantic|uvicorn)/.test(value)) add(routed, "ues-fastapi-engineering")
  else if (/(django|django rest|drf)/.test(value)) add(routed, "ues-django-engineering")
  else if (/(python|pytest|pip|poetry|pyproject)/.test(value)) add(routed, "ues-python-engineering")
  else {
    if (intent.domains.includes("fastapi")) add(routed, "ues-fastapi-engineering")
    else if (intent.domains.includes("django")) add(routed, "ues-django-engineering")
    else if (intent.domains.includes("python")) add(routed, "ues-python-engineering")
  }

  if (/(nestjs|nest\.js)/.test(value)) add(routed, "ues-nestjs-engineering")
  else if (/(node\.js|nodejs|express|npm|pnpm|yarn)/.test(value)) add(routed, "ues-nodejs-engineering")
  else {
    if (intent.domains.includes("nestjs")) add(routed, "ues-nestjs-engineering")
    else if (intent.domains.includes("nodejs")) add(routed, "ues-nodejs-engineering")
  }

  if (/(asp\.net|\.net|dotnet|nuget|c#)/.test(value) || intent.domains.includes("dotnet")) add(routed, "ues-dotnet-engineering")
  if (/(spring boot|spring framework|maven|gradle java|\bjava\b)/.test(value) || intent.domains.includes("java-spring")) add(routed, "ues-java-spring-engineering")
  if (/(flutter|dart)/.test(value) || intent.domains.includes("flutter")) add(routed, "ues-flutter-engineering")

  if (intent.domains.includes("database")) {
    add(routed, "ues-database-engineering")
    add(routed, "ues-change-impact-analysis")
  }
  if (intent.domains.includes("auth-security")) {
    add(routed, "ues-auth-security")
    add(routed, "ues-change-impact-analysis")
  }
  if (intent.domains.includes("payment")) {
    add(routed, "ues-payment-engineering")
    add(routed, "ues-change-impact-analysis")
  }
  if (intent.domains.includes("api-contract")) {
    add(routed, "ues-api-contract")
    add(routed, "ues-change-impact-analysis")
  }
  if (intent.domains.includes("devops")) add(routed, "ues-devops-engineering")
  if (intent.domains.includes("performance")) add(routed, "ues-performance-engineering")
  if (intent.domains.includes("accessibility")) add(routed, "ues-accessibility")
  if (intent.domains.includes("file-upload")) add(routed, "ues-file-upload-engineering")
  if (intent.domains.includes("ecommerce")) add(routed, "ues-ecommerce-engineering")
}

export function routeSkills(text, maxSkills = 4, facts = {}) {
  const value = String(text || "").toLowerCase()
  const limit = Number.isInteger(maxSkills) ? Math.max(1, Math.min(maxSkills, 6)) : 4
  const routed = []
  const intent = classifyIntent(value, facts)

  if (intent.nonTrivial) add(routed, "ues-engineering-orchestrator")
  if (intent.scope === "long-horizon") {
    add(routed, "ues-engineering-orchestrator")
    add(routed, "ues-long-task-state")
    add(routed, "ues-task-planner")
  }
  if (intent.actions.includes("debug")) add(routed, "ues-bug-diagnosis")
  if (intent.actions.includes("research")) add(routed, "ues-research-verification")

  addDomainSkills(routed, value, intent)

  if (routed.length === 0 && /(code|repository|repo|project|function|class|endpoint|test|dự án|hàm|lớp|kiểm thử)/.test(value)) {
    add(routed, "ues-repo-explorer")
  }

  if (routed.length > limit) {
    const prioritized = []
    const domain = []
    const process = []
    for (const id of routed) {
      if (id === "ues-engineering-orchestrator") prioritized.push(id)
      else if (PROCESS_SKILLS.has(id)) process.push(id)
      else domain.push(id)
    }
    return prioritized.concat(domain, process).slice(0, limit)
  }

  return routed.slice(0, limit)
}

export function routeSkillsForPolicy(text, policy = {}, maxSkills = 4, facts = {}) {
  const limit = Number.isInteger(maxSkills) ? Math.max(1, Math.min(maxSkills, 6)) : 4
  const routed = routeSkills(text, 6, facts)
  const fast =
    policy?.executionProfile === "fast" &&
    policy?.risk !== "high" &&
    policy?.mode !== "long-horizon"

  if (!fast) return routed.slice(0, limit)

  const selected = routed.filter((id) =>
    ![
      "ues-engineering-orchestrator",
      "ues-change-impact-analysis",
      "ues-task-planner",
      "ues-long-task-state",
    ].includes(id),
  )

  const value = String(text || "").toLowerCase()
  if (/(review|audit|kiểm tra code|đánh giá)/.test(value)) add(selected, "ues-code-review")
  if (/(verify|verification|test|tests|kiểm thử|xác minh)/.test(value)) add(selected, "ues-test-verification")

  if (selected.length === 0 && /(code|repository|repo|project|function|class|endpoint|hàm|lớp|dự án)/.test(value)) {
    add(selected, "ues-repo-explorer")
  }

  return selected.slice(0, limit)
}

