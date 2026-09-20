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

export function routeSkills(text, maxSkills = 4) {
  const value = String(text || "").toLowerCase()
  const limit = Number.isInteger(maxSkills) ? Math.max(1, Math.min(maxSkills, 6)) : 4
  const routed = []
  const risky = /(migration|schema|database|sql|auth|permission|security|payment|webhook|public api|contract|dependency|deploy|ci|production|rollback|cơ sở dữ liệu|phân quyền|xác thực|bảo mật|thanh toán|triển khai|phụ thuộc)/
  const nonTrivial = value.length > 220 || risky.test(value) || /(implement|feature|refactor|fix|debug|investigate|review|audit|bug|regression|failing|failure|error|exception|broken|triển khai tính năng|sửa lỗi|điều tra|kiểm tra code|đánh giá|lỗi)/.test(value)

  if (nonTrivial) add(routed, "ues-engineering-orchestrator")
  const longHorizon = value.length > 700 || /(large task|big task|long[- ]running|multi[- ]file|cross[- ]module|whole (?:repo|repository|project)|entire (?:repo|repository|project)|full refactor|refactor all|migrate all|resume this work|toàn bộ (?:repo|repository|dự án)|nhiều file|nhiều module|refactor toàn bộ|tiếp tục công việc)/.test(value)
  if (longHorizon) {
    add(routed, "ues-engineering-orchestrator")
    add(routed, "ues-long-task-state")
    add(routed, "ues-task-planner")
  }
  if (/(\bfix\b|\bbug\b|crash|regression|failing|failure|error|exception|broken|\bdebug\b|sửa lỗi|lỗi|không chạy|bị hỏng|điều tra lỗi)/.test(value)) add(routed, "ues-bug-diagnosis")
  if (/(latest|current docs|documentation|release notes|version compatibility|dependency|package version|api changed|tài liệu mới nhất|phiên bản mới|tương thích phiên bản|package mới)/.test(value)) add(routed, "ues-research-verification")

  if (/(react native|expo|android|ios|gradle|xcode|metro)/.test(value)) add(routed, "ues-react-native-engineering")
  else if (/(next\.js|nextjs|app router|server component)/.test(value)) add(routed, "ues-nextjs-engineering")
  else if (/(\breact\b|\bhook\b|useeffect|usestate|\bcomponent\b)/.test(value)) add(routed, "ues-react-engineering")

  if (/(fastapi|pydantic|uvicorn)/.test(value)) add(routed, "ues-fastapi-engineering")
  else if (/(django|django rest|drf)/.test(value)) add(routed, "ues-django-engineering")
  else if (/(python|pytest|pip|poetry|pyproject)/.test(value)) add(routed, "ues-python-engineering")
  if (/(nestjs|nest\.js)/.test(value)) add(routed, "ues-nestjs-engineering")
  else if (/(node\.js|nodejs|express|npm|pnpm|yarn)/.test(value)) add(routed, "ues-nodejs-engineering")
  if (/(asp\.net|\.net|dotnet|nuget|c#)/.test(value)) add(routed, "ues-dotnet-engineering")
  if (/(spring boot|spring framework|maven|gradle java|\bjava\b)/.test(value)) add(routed, "ues-java-spring-engineering")
  if (/(flutter|dart)/.test(value)) add(routed, "ues-flutter-engineering")

  if (/(database|migration|sql|query|index|transaction|schema changes?|cơ sở dữ liệu|truy vấn|chỉ mục|giao dịch|migrate dữ liệu)/.test(value)) {
    add(routed, "ues-database-engineering")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(auth|authorization|authentication|permission|role|tenant|idor|token|session|xác thực|phân quyền|quyền|vai trò)/.test(value)) {
    add(routed, "ues-auth-security")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(payment|checkout|webhook|refund|idempotenc|thanh toán|hoàn tiền)/.test(value)) {
    add(routed, "ues-payment-engineering")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(api contract|openapi|response schema|request schema|breaking api|public api|hợp đồng api|api công khai)/.test(value)) {
    add(routed, "ues-api-contract")
    add(routed, "ues-change-impact-analysis")
  }
  if (/(docker|github actions|ci\/cd|pipeline|deploy|kubernetes|container|triển khai|đường ống ci)/.test(value)) add(routed, "ues-devops-engineering")
  if (/(performance|slow|latency|memory leak|n\+1|bundle size|hiệu năng|chậm|rò rỉ bộ nhớ)/.test(value)) add(routed, "ues-performance-engineering")
  if (/(accessibility|accessible|a11y|screen reader|keyboard navigation|aria|focus management|focus handling)/.test(value)) add(routed, "ues-accessibility")
  if (/(upload|file upload|multipart|object storage)/.test(value)) add(routed, "ues-file-upload-engineering")
  if (/(ecommerce|marketplace|inventory|cart|catalog|order)/.test(value)) add(routed, "ues-ecommerce-engineering")

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
