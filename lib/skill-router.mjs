// V16.5 Phase 3: Adaptive Skill Router V3.
//
// Pipeline: task -> intent -> evidence -> candidates -> rank -> minimal activation.
//
// Ranking signals (all deterministic, all explainable):
//   exact intent match | stack match | repo evidence | previous verified usefulness
//   | task class | required capability | risk domain | negative guard | context cost
//
// The router NEVER deletes skills and NEVER changes safety policy. The utility
// learner below only reorders already-declared candidates and stays NEUTRAL until
// the sample floor is met.

import { skillRegistry } from "./skill-registry.mjs"

export const SKILL_ROUTER_SCHEMA_VERSION = 3
export const DEFAULT_ACTIVE_SKILLS = 3
export const MIN_ACTIVE_SKILLS = 1
export const ABSOLUTE_ACTIVE_CEILING = 6
export const SKILL_UTILITY_LIMIT = Object.freeze({
  minSamples: 8,
  maxKeys: 600,
  hysteresisMargin: 0.12,
})

/** @type {Readonly<Record<string,string>>} */
const SKILL_UTILITY = Object.freeze({ NEUTRAL: "neutral", PROMOTE: "promote", DEMOTE: "demote" })
/** @type {(verdict: string) => "neutral"|"promote"|"demote"} */
const utilityVerdict = (verdict) => /** @type {any} */ (verdict)

// Stack token -> framework/domain skill. Deterministic; no model involvement.
const STACK_SKILL = Object.freeze([
  ["react native", "react-native-engineering"],
  ["react-native", "react-native-engineering"],
  ["expo", "react-native-engineering"],
  ["reactnative", "react-native-engineering"],
  ["next.js", "nextjs-engineering"],
  ["nextjs", "nextjs-engineering"],
  ["app router", "nextjs-engineering"],
  ["pages router", "nextjs-engineering"],
  ["nest.js", "nestjs-engineering"],
  ["nestjs", "nestjs-engineering"],
  ["@nestjs", "nestjs-engineering"],
  ["flutter", "flutter-engineering"],
  ["dart", "flutter-engineering"],
  ["fastapi", "fastapi-engineering"],
  ["django", "django-engineering"],
  ["spring boot", "java-spring-engineering"],
  ["springboot", "java-spring-engineering"],
  ["hibernate", "java-spring-engineering"],
  ["dotnet", "dotnet-engineering"],
  [".net core", "dotnet-engineering"],
  ["c#", "dotnet-engineering"],
  ["tailwind", "ui-ux-engineering"],
  ["react", "react-engineering"],
  ["express", "nodejs-engineering"],
  ["node.js", "nodejs-engineering"],
  ["nodejs", "nodejs-engineering"],
  ["python", "python-engineering"],
  ["postgres", "database-engineering"],
  ["mysql", "database-engineering"],
  ["sqlite", "database-engineering"],
  ["mongodb", "database-engineering"],
  ["prisma", "database-engineering"],
  ["docker", "devops-engineering"],
  ["kubernetes", "devops-engineering"],
  ["terraform", "devops-engineering"],
  ["github actions", "devops-engineering"],
  ["playwright", "browser-qa"],
])

// Keyword -> intent. English + Vietnamese, diacritic-insensitive.
const INTENT_LEXICON = Object.freeze([
  ["sua loi", "regression"],
  ["loi", "ambiguous-failure"],
  ["hong", "regression"],
  ["crash", "ambiguous-failure"],
  ["regression", "regression"],
  ["debug", "root-cause"],
  ["root cause", "root-cause"],
  ["diagnose", "root-cause"],
  ["khong chay", "ambiguous-failure"],
  ["not reproducible", "ambiguous-failure"],
  ["intermittent", "ambiguous-failure"],
  ["flaky", "ambiguous-failure"],
  ["sometimes", "ambiguous-failure"],
  ["wrong value", "ambiguous-failure"],
  ["khong on dinh", "ambiguous-failure"],
  ["thi thuong", "ambiguous-failure"],
  ["test fail", "test-failure"],
  ["test that fail", "test-failure"],
  ["failing test", "test-failure"],
  ["build fail", "ambiguous-failure"],
  ["them tinh nang", "feature-add"],
  ["tinh nang moi", "feature-add"],
  ["feature", "feature-add"],
  ["implement", "code-change"],
  ["refactor", "refactor"],
  ["viet lai", "refactor"],
  ["them file", "code-change"],
  ["tao file", "code-change"],
  ["review", "code-review"],
  ["xem lai", "code-review"],
  ["kiem tra code", "code-review"],
  ["security", "security-review"],
  ["bao mat", "security-review"],
  ["an toan", "security-review"],
  ["vulnerab", "security-review"],
  ["xss", "xss-audit"],
  ["injection", "injection-audit"],
  ["ssrf", "ssrf-audit"],
  ["auth", "auth-review"],
  ["login", "auth-review"],
  ["dang nhap", "auth-review"],
  ["xac thuc", "auth-review"],
  ["phan quyen", "authorization-fix"],
  ["permission", "authorization-fix"],
  ["session", "session-fix"],
  ["jwt", "auth-review"],
  ["oauth", "auth-review"],
  ["payment", "payment-flow"],
  ["thanh toan", "payment-flow"],
  ["checkout", "cart-checkout"],
  ["stripe", "payment-flow"],
  ["idempot", "idempotency-fix"],
  ["webhook", "money-movement"],
  ["database", "data-model"],
  ["co so du lieu", "data-model"],
  ["schema", "data-model"],
  ["migration", "migration"],
  ["index", "query-fix"],
  ["query", "query-fix"],
  ["transaction", "transaction-fix"],
  ["performance", "performance-tuning"],
  ["hieu nang", "performance-tuning"],
  ["toi do", "performance-tuning"],
  ["cham", "performance-tuning"],
  ["slow", "performance-tuning"],
  ["latency", "hot-path-analysis"],
  ["optimi", "performance-tuning"],
  ["browser", "browser-verification"],
  ["playwright", "browser-verification"],
  ["e2e", "e2e-verification"],
  ["screenshot", "screenshot-match"],
  ["giao dien", "ui-implementation"],
  ["hien thi", "ui-implementation"],
  ["responsive", "responsive-check"],
  ["mobile", "responsive-check"],
  ["accessib", "accessibility-review"],
  ["wcag", "accessibility-review"],
  ["aria", "accessibility-review"],
  ["a11y", "accessibility-review"],
  ["tai lieu", "docs-authoring"],
  ["readme", "docs-authoring"],
  ["readme", "readme-rewrite"],
  ["viet tai lieu", "docs-authoring"],
  ["documentation", "docs-authoring"],
  ["ke hoach", "planning"],
  ["planning", "planning"],
  ["ke hoach hoa", "task-decomposition"],
  ["kien truc", "architecture"],
  ["architecture", "architecture"],
  ["thiet ke", "boundary-design"],
  ["phan tich", "impact-analysis"],
  ["impact", "impact-analysis"],
  ["explore", "repo-reconnaissance"],
  ["kham pha", "repo-reconnaissance"],
  ["repo", "repo-reconnaissance"],
  ["tim cho", "locate-implementation"],
  ["o dau", "locate-implementation"],
  ["git", "git-operation"],
  ["commit", "git-operation"],
  ["merge", "conflict-resolution"],
  ["conflict", "conflict-resolution"],
  ["rebase", "git-operation"],
  ["dependency", "dependency-audit"],
  ["phu thuoc", "dependency-audit"],
  ["npm audit", "supply-chain-review"],
  ["docker", "ci-cd"],
  ["deploy", "ci-cd"],
  ["trien khai", "ci-cd"],
  ["pipeline", "ci-cd"],
  ["test", "verification"],
  ["kiem chung", "verification"],
  ["verify", "verification"],
  ["xac nhan", "verification"],
  ["viet test", "test-authoring"],
  ["coverage", "coverage-check"],
  ["upload", "file-upload"],
  ["agent", "agent-orchestration"],
  ["orchestr", "agent-orchestration"],
  ["workflow", "workflow-orchestration"],
  ["skill", "skill-authoring"],
  ["upload file", "file-upload"],
  ["stripe webhook", "money-movement"],
  ["charge", "money-movement"],
  ["refund", "money-movement"],
  ["thanh toan that bai", "money-movement"],
  ["migration online", "migration"],
  ["responsive layout", "responsive-check"],
  ["breakpoint", "breakpoint-check"],
  ["mobile layout", "responsive-check"],
  ["oauth", "auth-review"],
  ["token refresh", "session-fix"],
  ["refresh token", "session-fix"],
  ["tenant", "authorization-fix"],
])

// Intent -> task class boost. Keeps task-class routing meaningful even when the
// literal intent word is absent.
const INTENT_TASK_CLASS = Object.freeze({
  "docs-authoring": "docs",
  "readme-rewrite": "docs",
  "code-review": "review",
  "security-review": "security",
  "auth-review": "security",
  "xss-audit": "security",
  "injection-audit": "security",
  "ssrf-audit": "security",
  "payment-flow": "feature",
  "money-movement": "feature",
  "migration": "migration",
  "data-model": "data",
  "query-fix": "data",
  "transaction-fix": "data",
  "performance-tuning": "performance",
  "hot-path-analysis": "performance",
  "browser-verification": "verification",
  "e2e-verification": "verification",
  "verification": "verification",
  "coverage-check": "verification",
  "test-failure": "verification",
  "test-authoring": "verification",
  "planning": "planning",
  "task-decomposition": "planning",
  "architecture": "planning",
  "boundary-design": "planning",
  "repo-reconnaissance": "exploration",
  "locate-implementation": "exploration",
  "context-retrieval": "exploration",
  "ci-cd": "infra",
  "git-operation": "infra",
  "agent-orchestration": "orchestration",
  "workflow-orchestration": "orchestration",
})

const RISK_DOMAINS = Object.freeze({
  security: ["auth-security", "web-security-review", "browser-security"],
  payment: ["payment-engineering"],
  data: ["database-engineering"],
})

// An intent that is a subset of a broader risk domain co-activates that domain's
// review skill. Declared per intent so it stays explainable and auditable.
const INTENT_DOMAIN_ESCALATION = Object.freeze({
  "authorization-fix": ["web-security-review"],
  "money-movement": ["payment-engineering"],
  "ssrf-audit": ["file-upload-engineering"],
})

const signalStore = new Map()

function clamp(value, fallback, min, max) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback
}

/** Diacritic-insensitive, lowercased token stream. Deterministic on all platforms. */
export function normalizeTask(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim()
}

// ASCII technical/common words used only to separate pure Vietnamese from a
// Vietnamese+English mixed task. Kept small and technical on purpose.
const ENGLISH_TECH_TOKENS = new Set([
  "fix", "fixed", "race", "condition", "payment", "webhook", "implement", "implementation",
  "readme", "next", "nextjs", "react", "native", "expo", "node", "nodejs", "api", "route",
  "build", "test", "tests", "deploy", "docker", "kubernetes", "database", "page", "pages",
  "error", "bug", "security", "auth", "oauth", "login", "logout", "update", "config", "code",
  "file", "files", "run", "npm", "pnpm", "yarn", "git", "commit", "merge", "branch", "endpoint",
  "schema", "migration", "component", "server", "client", "token", "refresh", "callback",
  "checkout", "cart", "order", "query", "index", "cache", "render", "layout", "upload", "module",
])

export function detectTaskLanguage(text) {
  const raw = String(text || "")
  const accents = (raw.match(/[ăâđêôơưĂÂĐÊÔƠƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g) || []).length
  if (accents === 0) return "en"
  const words = normalizeTask(raw).split(/[^a-z0-9+#.]+/).filter(Boolean)
  const englishWords = words.filter((word) => ENGLISH_TECH_TOKENS.has(word.replace(/[.#]/g, "")))
  const englishRatio = englishWords.length / Math.max(1, words.length)
  if (accents >= 1 && englishRatio >= 0.3) return "mixed"
  return "vi"
}

/**
 * Deterministic intent + task-class detection. No model, no network.
 */
export function detectIntent(task, options = {}) {
  const normalized = normalizeTask(task)
  const raw = String(task || "")
  const language = detectTaskLanguage(raw)
  const intents = []
  for (const [token, intent] of INTENT_LEXICON) {
    if (!normalized.includes(token)) continue
    if (!intents.some((row) => row.intent === intent)) intents.push({ intent, token })
  }

  const stackSignals = []
  for (const [token, skill] of STACK_SKILL) {
    if (normalized.includes(token) && !stackSignals.some((row) => row.token === token)) {
      stackSignals.push({ token, skill })
    }
  }

  const taskClasses = []
  for (const { intent } of intents) {
    const taskClass = INTENT_TASK_CLASS[intent]
    if (taskClass && !taskClasses.includes(taskClass)) taskClasses.push(taskClass)
  }

  const repoEvidence = Array.isArray(options.repoEvidence) ? options.repoEvidence.map(String) : []
  const evidenceStacks = []
  for (const [token] of STACK_SKILL) {
    if (token.length < 4 && !/^[a-z@.]+$/.test(token)) continue
    if (repoEvidence.some((file) => normalizeTask(file).includes(token))) {
      const skill = STACK_SKILL.find((row) => row[0] === token)?.[1]
      if (skill && !evidenceStacks.includes(skill)) evidenceStacks.push(skill)
    }
  }

  return {
    schemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
    language,
    normalized,
    intents: intents.map((row) => row.intent).sort(),
    intentHits: intents,
    stackSignals,
    evidenceStacks,
    taskClasses: taskClasses.sort(),
    repoEvidence,
  }
}

function skillUtilityKey(skillId, taskClass) {
  return `${skillId}|${taskClass || "any"}`
}

export function resetSkillUtilityForTests() {
  signalStore.clear()
}

/**
 * Record one measured skill activation outcome.
 * Fields mirror the V16.5 Skill Utility contract; missing values stay absent.
 */
export function recordSkillUtility(sample = {}) {
  const skillId = String(sample.skillId || "")
  if (!skillId) throw new Error("skill utility sample requires skillId")
  const key = skillUtilityKey(skillId, sample.taskClass)
  let row = signalStore.get(key)
  if (!row) {
    if (signalStore.size >= SKILL_UTILITY_LIMIT.maxKeys) {
      signalStore.delete(signalStore.keys().next().value)
    }
    row = {
      skillId,
      taskClass: String(sample.taskClass || "any"),
      activationCount: 0,
      usefulActivationCount: 0,
      falseActivationCount: 0,
      verifiedContribution: 0,
      contextCharsLoaded: 0,
      toolCallsAttributed: 0,
      recallRequests: 0,
      wallTimeContributionMs: 0,
      verificationContribution: 0,
      samples: 0,
    }
    signalStore.set(key, row)
  }
  row.samples += 1
  row.activationCount += 1
  if (sample.useful === true) row.usefulActivationCount += 1
  if (sample.falseActivation === true) row.falseActivationCount += 1
  if (Number.isFinite(Number(sample.verifiedContribution))) row.verifiedContribution += Number(sample.verifiedContribution)
  if (Number.isFinite(Number(sample.contextCharsLoaded))) row.contextCharsLoaded += Number(sample.contextCharsLoaded)
  if (Number.isFinite(Number(sample.toolCallsAttributed))) row.toolCallsAttributed += Number(sample.toolCallsAttributed)
  if (Number.isFinite(Number(sample.recallRequests))) row.recallRequests += Number(sample.recallRequests)
  if (Number.isFinite(Number(sample.wallTimeContributionMs))) row.wallTimeContributionMs += Number(sample.wallTimeContributionMs)
  if (Number.isFinite(Number(sample.verificationContribution))) row.verificationContribution += Number(sample.verificationContribution)
  return { key, samples: row.samples }
}

export function skillUtilityRow(skillId, taskClass = "any") {
  const row = signalStore.get(skillUtilityKey(skillId, taskClass)) || signalStore.get(skillUtilityKey(skillId, "any"))
  return row || null
}

/**
 * SkillUtility = verified usefulness - context cost - unnecessary tool cost
 *                - false activation penalty.
 * Below the sample floor this is NEUTRAL by construction.
 */
export function skillUtility(skillId, taskClass = "any", options = {}) {
  const row = skillUtilityRow(skillId, taskClass)
  const minSamples = clamp(options.minSamples, SKILL_UTILITY_LIMIT.minSamples, 1, 10_000)
  if (!row || row.activationCount < minSamples) {
    return {
      skillId,
      taskClass,
      evidence: "NOT_MEASURED",
      verdict: utilityVerdict(SKILL_UTILITY.NEUTRAL),
      score: 0,
      samples: row?.activationCount || 0,
      minSamples,
      safetyPolicyMutable: false,
    }
  }
  const n = row.activationCount
  const verifiedRate = row.usefulActivationCount / n
  const falseRate = row.falseActivationCount / n
  const contextCost = row.contextCharsLoaded / n / 1000
  const toolWaste = row.recallRequests / n / 2
  const verifyGain = row.verificationContribution / n / 4
  const score = verifiedRate - contextCost * 0.1 - toolWaste * 0.1 - falseRate * 0.5 + verifyGain * 0.05
  /** @type {"neutral"|"promote"|"demote"} */
  let verdict = utilityVerdict(SKILL_UTILITY.NEUTRAL)
  if (score > SKILL_UTILITY_LIMIT.hysteresisMargin) verdict = utilityVerdict(SKILL_UTILITY.PROMOTE)
  else if (score < -SKILL_UTILITY_LIMIT.hysteresisMargin) verdict = utilityVerdict(SKILL_UTILITY.DEMOTE)
  return {
    skillId,
    taskClass,
    evidence: "MEASURED",
    verdict,
    score: Number(score.toFixed(4)),
    samples: n,
    minSamples,
    falseActivationRate: falseRate,
    safetyPolicyMutable: false,
    deletionAllowed: false,
  }
}

function tokenEvidenceScore(contract, intentSet) {
  return contract.intents.filter((intent) => intentSet.has(intent))
}

function repoEvidenceScore(contract, evidenceStacks, repoEvidence) {
  if (evidenceStacks.includes(contract.id)) return { score: 55, reason: "repo-evidence-stack" }
  // Framework-specific path evidence, e.g. Next.js app/pages routes.
  const evidence = repoEvidence.map(normalizeTask)
  if (contract.id === "nextjs-engineering" && evidence.some((file) => /(^|\/)(app|pages)\/.+route\.(ts|tsx|js|jsx)$/.test(file))) {
    return { score: 45, reason: "repo-evidence-next-route" }
  }
  if (contract.id === "database-engineering" && evidence.some((file) => /migration|schema\.(sql|prisma)$/.test(file))) {
    return { score: 45, reason: "repo-evidence-schema" }
  }
  if (contract.id === "test-verification" && evidence.some((file) => /\.(test|spec)\.[a-z]+$/.test(file))) {
    return { score: 25, reason: "repo-evidence-tests" }
  }
  return { score: 0, reason: null }
}

/**
 * Rank all registry skills for a task. Returns the full candidate list with an
 * explicit score breakdown; activation happens separately in routeSkills().
 */
export function rankSkills(input = {}) {
  const registry = skillRegistry()
  const task = String(input.task || "")
  const normalized = normalizeTask(task)
  const intent = detectIntent(task, { repoEvidence: input.repoEvidence })
  const intentSet = new Set(intent.intents)
  void normalized
  const taskClassSet = new Set(intent.taskClasses)
  const policyDomains = new Set((input.taskPolicy?.domains || []).map(String))
  const evidenceStacks = intent.evidenceStacks
  const repoEvidence = intent.repoEvidence
  const candidates = []

  for (const contract of registry.contracts) {
    const reasons = []
    let score = 0

    const intentHits = tokenEvidenceScore(contract, intentSet)
    if (intentHits.length) {
      score += Math.min(90, 60 + intentHits.length * 10)
      reasons.push({ signal: "exact-intent", detail: intentHits.join(",") })
    }

    const stackHit = intent.stackSignals.find((row) => row.skill === contract.id)
    if (stackHit) {
      score += 70
      reasons.push({ signal: "stack-match", detail: stackHit.token })
    }

    const repo = repoEvidenceScore(contract, evidenceStacks, repoEvidence)
    if (repo.score) {
      score += repo.score
      reasons.push({ signal: "repo-evidence", detail: repo.reason })
    }

    const classHits = contract.taskClasses.filter((taskClass) => taskClassSet.has(taskClass))
    if (classHits.length) {
      score += Math.min(45, classHits.length * 20)
      reasons.push({ signal: "task-class", detail: classHits.join(",") })
    }

    const requiredOverlap = contract.requiredCapabilities.filter((capability) =>
      (input.requiredCapabilities || []).includes(capability),
    )
    if (requiredOverlap.length) {
      score += 20
      reasons.push({ signal: "required-capability", detail: requiredOverlap.join(",") })
    }

    for (const [domain, skills] of Object.entries(RISK_DOMAINS)) {
      if (policyDomains.has(domain) && skills.includes(contract.id)) {
        score += 60
        reasons.push({ signal: "risk-domain", detail: domain })
      }
    }

    for (const intent of intentSet) {
      const escalated = INTENT_DOMAIN_ESCALATION[intent]
      if (escalated?.includes(contract.id)) {
        score += 45
        reasons.push({ signal: "intent-domain-escalation", detail: intent })
      }
    }

    const utility = skillUtility(contract.id, input.taskClass, { minSamples: input.minSamples })
    if (utility.evidence === "MEASURED") {
      if (utility.verdict === SKILL_UTILITY.PROMOTE) {
        score += 15
        reasons.push({ signal: "learned-utility", detail: "promote" })
      } else if (utility.verdict === SKILL_UTILITY.DEMOTE) {
        score -= 15
        reasons.push({ signal: "learned-utility", detail: "demote" })
      }
    }

    // Context cost: gate/procedure skills load more model-facing prose than a
    // narrow reference skill. This is a tie-breaker, never a hard exclusion.
    const costPenalty = contract.contextClass === "gate" ? 4 : contract.contextClass === "procedure" ? 2 : 0
    if (costPenalty) {
      score -= costPenalty
      reasons.push({ signal: "context-cost", detail: contract.contextClass })
    }

    // Negative guard: a task that is purely documentation must never pull a
    // framework skill in through a stack word alone.
    const docsOnly = taskClassSet.has("docs") && !intentSet.has("feature-add") && !intentSet.has("code-change") && !intentSet.has("refactor")
    if (docsOnly && contract.contextClass === "reference" && !intentHits.length) {
      score -= 40
      reasons.push({ signal: "negative-guard", detail: "docs-only-task" })
    }
    if (intentSet.has("docs-only") && contract.id !== "documentation-engineering" && !intentHits.length) {
      score -= 20
      reasons.push({ signal: "negative-guard", detail: "docs-only-intent" })
    }

    candidates.push({
      id: contract.id,
      score,
      reasons,
      contextClass: contract.contextClass,
      verificationRequired: contract.verificationRequirements.required,
      composableWith: contract.composableWith,
      outputContract: contract.outputContract,
      utility: { evidence: utility.evidence, verdict: utility.verdict, samples: utility.samples },
    })
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return {
    schemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
    intent,
    candidates,
    considered: candidates.length,
    consideredPositive: candidates.filter((row) => row.score > 0).length,
  }
}

/**
 * Activate a minimal set. Default target is 1-3 skills.
 *
 * Selection is a score cutoff relative to the leader, not "top N unconditionally",
 * because unconditional top-N is what pulls irrelevant skills into context.
 * Going beyond the default target is allowed, but only through composition with
 * an explicit, recorded reason.
 */
export function routeSkills(input = {}) {
  const ranked = input.ranked || rankSkills(input)
  const intent = ranked.intent
  const requested = clamp(input.maxSkills, DEFAULT_ACTIVE_SKILLS, MIN_ACTIVE_SKILLS, ABSOLUTE_ACTIVE_CEILING)
  const positives = ranked.candidates.filter((row) => row.score > 0)
  const ambiguous = positives.length === 0
  const leaderScore = positives.length ? positives[0].score : 0
  const cutoff = Math.max(8, leaderScore * 0.4)

  const aboveCutoff = positives.filter((row) => row.score >= cutoff)
  let selected = aboveCutoff.slice(0, requested)
  // Overflow above the default target is legitimate when more skills clear the
  // evidence cutoff than the default target allows. It is always reported; the
  // extra slot is capped at one so activation cannot grow without bound.
  const overflowExpanded = aboveCutoff.length > requested && selected.length === requested
  let overflowSkill = null
  if (overflowExpanded) {
    overflowSkill = aboveCutoff[requested] || null
    if (overflowSkill) selected = [...selected, overflowSkill]
  }

  // Composition: a strongly-matched skill may pull in one direct peer that has
  // its own independent evidence (exact intent or stack match). This is the only
  // path past the default target, and it is always reported.
  const expanded = []
  if (input.compose !== false) {
    const strong = selected.filter((row) =>
      row.reasons.some((reason) => reason.signal === "exact-intent") &&
      (row.reasons.some((reason) => reason.signal === "stack-match") || row.reasons.filter((reason) => reason.signal === "exact-intent").length >= 2),
    )
    const expansionBudget = Math.min(ABSOLUTE_ACTIVE_CEILING, Math.max(requested, DEFAULT_ACTIVE_SKILLS) + 1)
    for (const anchor of strong) {
      if (selected.length + expanded.length >= expansionBudget) break
      const anchorTaskClasses = new Set(
        skillRegistry().byId.get(anchor.id)?.taskClasses || [],
      )
      for (const peerId of anchor.composableWith) {
        if (selected.length + expanded.length >= expansionBudget) break
        if ([...selected, ...expanded].some((row) => row.id === peerId)) continue
        const peer = ranked.candidates.find((row) => row.id === peerId)
        if (!peer || peer.score <= cutoff / 2) continue
        const hasOwnEvidence = peer.reasons.some((reason) => reason.signal === "exact-intent" || reason.signal === "stack-match")
        if (!hasOwnEvidence) continue
        const peerTaskClasses = new Set(skillRegistry().byId.get(peerId)?.taskClasses || [])
        const redundant = [...peerTaskClasses].every((taskClass) => anchorTaskClasses.has(taskClass))
        if (redundant) continue
        expanded.push({ ...peer, reasons: [...peer.reasons, { signal: "composition", detail: anchor.id }] })
        break
      }
    }
  }

  const activated = [...selected, ...expanded]
  const expandedReason = overflowExpanded && overflowSkill
    ? { expanded: true, reason: "above-default-cutoff", detail: overflowSkill.id }
    : expanded.length
      ? { expanded: true, reason: "composition-with-independent-evidence", detail: expanded.map((row) => row.id).join(",") }
      : null

  return {
    schemaVersion: SKILL_ROUTER_SCHEMA_VERSION,
    activated: activated.map((row) => row.id),
    defaultTarget: DEFAULT_ACTIVE_SKILLS,
    requested,
    expandedReason,
    ambiguous,
    confidence: ambiguous ? "none" : confidenceFor(activated),
    language: intent.language,
    detectedIntents: intent.intents,
    detectedTaskClasses: intent.taskClasses,
    scoreCutoff: Number(cutoff.toFixed(2)),
    considered: ranked.considered,
    consideredPositive: ranked.consideredPositive,
    aboveCutoff: aboveCutoff.length,
    activationRatio: ranked.considered ? Number((activated.length / ranked.considered).toFixed(4)) : 0,
    candidates: ranked.candidates.map((row) => ({
      id: row.id,
      score: Number(row.score.toFixed(2)),
      reasons: row.reasons,
      activated: activated.some((item) => item.id === row.id),
    })),
  }
}

function confidenceFor(activated) {
  if (!activated.length) return "none"
  const top = activated[0]
  const second = activated[1]
  if (!second) return top.score >= 80 ? "high" : top.score >= 40 ? "medium" : "low"
  if (top.score - second.score >= 45) return "high"
  return top.score >= 80 ? "medium" : "low"
}

export function clearSkillRouterCache() {
  signalStore.clear()
}
