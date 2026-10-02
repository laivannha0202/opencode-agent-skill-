const REQUIREMENT_KINDS = Object.freeze(["MUST", "MUST_NOT", "VERIFY"])

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function stripFencedBlocks(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
}

function cleanClause(value) {
  return normalizeSpace(
    String(value || "")
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*(?:[-*+•]|\d+[.)]|[A-Za-z][.)])\s+/, "")
      .replace(/^\s*["'“”‘’]+|["'“”‘’]+\s*$/g, ""),
  )
}

const ACTION_START = String.raw`(?:must|do\s+not|don't|never|fix|repair|implement|add|remove|delete|update|change|keep|preserve|ensure|support|remember|verify|test|run|check|build|lint|typecheck|smoke|phải|phai|hãy|hay|cần|can|không|khong|đừng|dung|cấm|cam|sửa|sua|thêm|them|xóa|xoá|xoa|cập\s+nhật|cap\s+nhat|thay\s+đổi|thay\s+doi|giữ|giu|đảm\s+bảo|dam\s+bao|kiểm\s+tra|kiem\s+tra|xác\s+minh|xac\s+minh|chạy|chay)`

function splitRequirementClauses(task) {
  const output = []
  const source = stripFencedBlocks(task)
  for (const rawLine of source.split(/\r?\n/)) {
    const line = cleanClause(rawLine)
    if (!line) continue
    if (/^(?:=+\s*)?PHASE\s+\d+\b/i.test(line)) continue
    if (/^(?:requirements?|acceptance criteria|verification|constraints?|notes?|context)\s*:?\s*$/i.test(line)) continue

    let parts = line.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ỹ0-9])/u)
    parts = parts.flatMap((part) =>
      part.split(new RegExp(`,\\s+(?=${ACTION_START}\\b)`, "i")),
    )
    parts = parts.flatMap((part) =>
      part.split(new RegExp(`\\s+(?:and|và)\\s+(?=${ACTION_START}\\b)`, "i")),
    )
    parts = parts.flatMap((part) => part.split(/\s*;\s*/))

    for (const part of parts) {
      const cleaned = cleanClause(part).replace(/[.!?]+$/g, "").trim()
      if (cleaned) output.push(cleaned)
    }
  }
  return output
}

const MUST_NOT_PATTERN =
  /(?:\bmust\s+not\b|\bdo\s+not\b|\bdon't\b|\bnever\b|\bwithout\s+(?:changing|modifying|editing|touching|rewriting)\b|(?:không|khong)\s+(?:được|duoc|sửa|sua|đổi|doi|thay|chỉnh|chinh|xóa|xoá|xoa|ghi|tạo|tao|đụng|dung)|(?:cấm|cam|đừng|dung)\s+)/i

const VERIFY_PATTERN =
  /(?:\bverify\b|\bverification\b|\btests?\b|\btesting\b|\bcheck\b|\bbuild\b|\btypecheck\b|\blint\b|\be2e\b|\bsmoke\b|\bplaywright\b|\bjest\b|\bvitest\b|\bpytest\b|\bgradle\b|\bmaven\b|\bcargo\s+test\b|\bgo\s+test\b|kiểm\s+tra|kiem\s+tra|xác\s+minh|xac\s+minh|chạy\s+(?:test|kiểm|kiem)|chay\s+(?:test|kiem))/i

const MUST_PATTERN =
  /(?:\bmust\b|\bfix\b|\brepair\b|\bimplement\b|\badd\b|\bremove\b|\bdelete\b|\bupdate\b|\bchange\b|\bkeep\b|\bpreserve\b|\bensure\b|\bsupport\b|\bremember\b|\brefactor\b|\bmigrate\b|phải|phai|hãy|hay|cần|can|sửa|sua|thêm|them|xóa|xoá|xoa|cập\s+nhật|cap\s+nhat|thay\s+đổi|thay\s+doi|giữ|giu|đảm\s+bảo|dam\s+bao|làm|lam|tạo|tao)/i

function classifyClause(clause) {
  if (MUST_NOT_PATTERN.test(clause)) return "MUST_NOT"
  if (VERIFY_PATTERN.test(clause)) return "VERIFY"
  if (MUST_PATTERN.test(clause)) return "MUST"
  return null
}

function requirementKey(value) {
  return normalizeSpace(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

export function compileRequirementLedger(task, options = {}) {
  const maxRequirements = Math.max(1, Math.min(96, Number(options.maxRequirements || 48)))
  const clauses = splitRequirementClauses(task)
  const requirements = []
  const seen = new Set()

  for (const clause of clauses) {
    const kind = classifyClause(clause)
    if (!kind) continue
    const key = requirementKey(clause)
    if (!key || seen.has(key)) continue
    seen.add(key)
    requirements.push({
      id: "R" + (requirements.length + 1),
      kind,
      text: clause,
      status: "PENDING",
    })
    if (requirements.length >= maxRequirements) break
  }

  if (!requirements.length) {
    const fallback = cleanClause(clauses[0] || stripFencedBlocks(task))
    if (fallback) {
      requirements.push({
        id: "R1",
        kind: "MUST",
        text: fallback.slice(0, 1200),
        status: "PENDING",
      })
    }
  }

  const counts = Object.fromEntries(REQUIREMENT_KINDS.map((kind) => [
    kind,
    requirements.filter((item) => item.kind === kind).length,
  ]))

  return {
    schemaVersion: 1,
    requirements,
    counts,
    total: requirements.length,
  }
}

export function renderRequirementLedger(ledger) {
  const requirements = Array.isArray(ledger?.requirements) ? ledger.requirements : []
  if (!requirements.length) return ""

  return [
    "## V16.1 requirement correctness contract",
    "The following requirement IDs are controller-owned. Do not merge, weaken, silently drop, or reinterpret them.",
    ...requirements.map((item) => `- [${item.id}] ${item.kind}: ${item.text}`),
    "",
    "Planning contract:",
    "- Every structured-plan task must declare requirementIds: [\"R#\", ...].",
    "- Every requirement ID must map to at least one planned task. Unknown IDs are invalid.",
    "- MUST_NOT requirements are global invariants as well as task-scoped obligations; evidence must show the prohibited change did not occur.",
    "",
    "Verification contract:",
    "- Verifier and integration-verifier outputs must include one evidence line for every requirement:",
    "  UES_REQUIREMENT: R# PASS - <fresh concrete evidence>",
    "  UES_REQUIREMENT: R# FAIL - <contradicting evidence>",
    "  UES_REQUIREMENT: R# NOT_VERIFIED - <missing evidence>",
    "- PASS without a concrete evidence description is treated as NOT_VERIFIED.",
    "- Implementation claims are not evidence. Use current diff/state, executable checks, static diagnostics, API/schema comparison, or other fresh proof appropriate to the requirement.",
    "- Final UES PASS is forbidden unless every requirement is PASS.",
  ].join("\n")
}

export function normalizeRequirementIds(value) {
  const items = Array.isArray(value)
    ? value
    : value === undefined || value === null
      ? []
      : [value]
  return [...new Set(items
    .map((item) => String(item || "").trim().toUpperCase())
    .filter((item) => /^R\d+$/.test(item)))]
}

export function validateRequirementPlanCoverage(plan, ledger) {
  const requirements = Array.isArray(ledger?.requirements) ? ledger.requirements : []
  if (!requirements.length) {
    return {
      schemaVersion: 1,
      valid: true,
      errors: [],
      warnings: [],
      coverage: 1,
      covered: 0,
      total: 0,
      mappings: {},
    }
  }

  const known = new Set(requirements.map((item) => item.id))
  const mappings = Object.fromEntries(requirements.map((item) => [item.id, []]))
  const errors = []
  const warnings = []
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []

  if (!tasks.length) {
    return {
      schemaVersion: 1,
      valid: false,
      errors: ["requirement coverage requires a non-empty structured plan"],
      warnings,
      coverage: 0,
      covered: 0,
      total: requirements.length,
      mappings,
    }
  }

  for (const task of tasks) {
    const taskId = String(task?.id || "").trim() || "<unknown>"
    const raw = task?.requirementIds
    if (!Array.isArray(raw) || !raw.length) {
      errors.push(`task ${taskId} must declare non-empty requirementIds`)
      continue
    }
    const normalized = normalizeRequirementIds(raw)
    if (normalized.length !== raw.length) {
      errors.push(`task ${taskId} has malformed requirementIds; expected only R# identifiers`)
    }
    for (const id of normalized) {
      if (!known.has(id)) {
        errors.push(`task ${taskId} references unknown requirement ${id}`)
        continue
      }
      mappings[id].push(taskId)
    }
  }

  const missing = requirements
    .map((item) => item.id)
    .filter((id) => !mappings[id]?.length)
  for (const id of missing) errors.push(`requirement ${id} is not mapped to any planned task`)

  const covered = requirements.length - missing.length
  return {
    schemaVersion: 1,
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings,
    coverage: requirements.length ? covered / requirements.length : 1,
    covered,
    total: requirements.length,
    mappings,
  }
}

function normalizeEvidenceSources(outputs) {
  const items = Array.isArray(outputs) ? outputs : [outputs]
  return items
    .map((item, index) => {
      if (typeof item === "string") return { source: "source-" + (index + 1), text: item }
      if (!item || typeof item !== "object") return null
      return {
        source: String(item.source || "source-" + (index + 1)),
        text: String(item.text || item.output || ""),
      }
    })
    .filter((item) => item && item.text.trim())
}

export function evaluateRequirementEvidence(ledger, outputs = []) {
  const requirements = Array.isArray(ledger?.requirements) ? ledger.requirements : []
  if (!requirements.length) {
    return {
      schemaVersion: 1,
      status: "REQUIREMENTS_NOT_REQUIRED",
      coverage: 1,
      passed: 0,
      total: 0,
      missing: [],
      failed: [],
      notVerified: [],
      requirements: [],
    }
  }

  const known = new Map(requirements.map((item) => [item.id, item]))
  const observations = new Map(requirements.map((item) => [item.id, []]))
  const linePattern = /^\s*UES_REQUIREMENT:\s*(R\d+)\s+(PASS|FAIL|NOT_VERIFIED)\s*(?:-\s*(.*))?\s*$/gim

  for (const source of normalizeEvidenceSources(outputs)) {
    for (const match of source.text.matchAll(linePattern)) {
      const id = String(match[1] || "").toUpperCase()
      if (!known.has(id)) continue
      const rawStatus = String(match[2] || "").toUpperCase()
      const detail = normalizeSpace(match[3] || "")
      const status = rawStatus === "PASS" && detail.length < 4 ? "NOT_VERIFIED" : rawStatus
      observations.get(id).push({
        status,
        detail,
        source: source.source,
      })
    }
  }

  const rows = requirements.map((requirement) => {
    const evidence = observations.get(requirement.id) || []
    const hasFail = evidence.some((item) => item.status === "FAIL")
    const hasNotVerified = evidence.some((item) => item.status === "NOT_VERIFIED")
    const passEvidence = evidence.filter((item) => item.status === "PASS")
    const status = hasFail
      ? "FAIL"
      : hasNotVerified
        ? "NOT_VERIFIED"
        : passEvidence.length
          ? "PASS"
          : "NOT_VERIFIED"
    return {
      ...requirement,
      status,
      evidence,
    }
  })

  const failed = rows.filter((item) => item.status === "FAIL").map((item) => item.id)
  const notVerified = rows.filter((item) => item.status === "NOT_VERIFIED").map((item) => item.id)
  const passed = rows.filter((item) => item.status === "PASS").length
  const missing = rows.filter((item) => (item.evidence || []).length === 0).map((item) => item.id)
  const status = failed.length
    ? "REQUIREMENTS_FAIL"
    : notVerified.length
      ? "REQUIREMENTS_NOT_VERIFIED"
      : "REQUIREMENTS_PASS"

  return {
    schemaVersion: 1,
    status,
    coverage: rows.length ? passed / rows.length : 1,
    passed,
    total: rows.length,
    missing,
    failed,
    notVerified,
    requirements: rows,
  }
}

export function requirementLedgerAllowsDeterministicFastPass(ledger) {
  const requirements = Array.isArray(ledger?.requirements) ? ledger.requirements : []
  if (!requirements.length) {
    return { allowed: true, reason: "no-explicit-requirements" }
  }
  if (requirements.length === 1 && requirements[0]?.kind === "MUST") {
    return { allowed: true, reason: "single-must-requirement" }
  }
  return {
    allowed: false,
    reason: "requirement-ledger-needs-explicit-verifier",
  }
}
