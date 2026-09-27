import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import path from "node:path"

const PHASE_HEADING = /^\s*(?:=+\s*)?PHASE\s+(\d+)\s*(?:[—–:-]+)\s*(.+?)\s*$/i
const LOCAL_ENV_BASENAME = /^\.env(?:\.[^/\\]+)?$/i
const ENV_TEMPLATE_BASENAME = /^\.env\.(?:example|sample|template)$/i

function normalizePath(value) {
  return String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "")
}

function slugify(value) {
  return String(value || "phase")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "phase"
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex")
}

export function isLocalEnvPath(value) {
  const normalized = normalizePath(value)
  const base = normalized.split("/").pop() || ""
  if (ENV_TEMPLATE_BASENAME.test(base)) return false
  return LOCAL_ENV_BASENAME.test(base)
}

export function taskExplicitlyAllowsLocalEnvWrite(task) {
  const value = String(task || "")
  const mentionsEnv = /(?:^|[\s"'\x60/])\.env(?:\.[\w.-]+)?(?=$|[\s"'\x60,;:.)/])/i.test(value)
  if (!mentionsEnv) return false
  return /(?:modify|edit|update|write|create|set|change|sửa|chỉnh sửa|cập nhật|ghi|tạo|thay đổi).{0,80}\.env|\.env.{0,80}(?:modify|edit|update|write|create|set|change|sửa|chỉnh sửa|cập nhật|ghi|tạo|thay đổi)/i.test(value)
}

export function localEnvWriteRisk(command) {
  const value = String(command || "")
  if (!value.trim()) return { risky: false, id: null }
  const patterns = [
    /(?:>|>>)[^\n;&|]*\.env(?:\.[\w.-]+)?\b/i,
    /\b(?:sed|perl)\b[^\n;&|]*\s-i\b[^\n;&|]*\.env(?:\.[\w.-]+)?\b/i,
    /\b(?:set-content|add-content|out-file|copy-item|move-item|rename-item)\b[^\n;&|]*\.env(?:\.[\w.-]+)?\b/i,
    /\b(?:cp|mv|install)\b[^\n;&|]*\s\.env(?:\.[\w.-]+)?\b/i,
  ]
  return patterns.some((pattern) => pattern.test(value))
    ? { risky: true, id: "local-env-write" }
    : { risky: false, id: null }
}

export function captureInheritedDirtyState(root) {
  const resolved = path.resolve(root)
  const probe = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: resolved,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (probe.status !== 0) {
    return {
      schemaVersion: 1,
      available: false,
      clean: false,
      root: resolved,
      entries: [],
      paths: [],
      error: String(probe.stderr || probe.stdout || "git status failed").trim(),
    }
  }

  const tokens = String(probe.stdout || "").split("\0").filter(Boolean)
  const entries = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.length < 3) continue
    const status = token.slice(0, 2)
    const separator = token[2]
    if (separator !== " ") continue
    const currentPath = normalizePath(token.slice(3))
    let originalPath = null
    if (/[RC]/.test(status) && index + 1 < tokens.length) {
      originalPath = normalizePath(tokens[index + 1])
      index += 1
    }
    if (!currentPath) continue
    entries.push({ status, path: currentPath, originalPath })
  }

  const paths = [...new Set(entries.flatMap((entry) => [entry.path, entry.originalPath].filter(Boolean)))].sort()
  return {
    schemaVersion: 1,
    available: true,
    clean: paths.length === 0,
    root: resolved,
    entries,
    paths,
  }
}

export function extractExplicitPhases(task) {
  const lines = String(task || "").split(/\r?\n/)
  const phases = []
  let current = null

  const flush = () => {
    if (!current) return
    const body = current.lines.join("\n").trim()
    const number = Number(current.number)
    const title = current.title.trim()
    const slug = slugify(title)
    phases.push({
      number,
      title,
      slug,
      body,
      bodyHash: sha256(body),
      artifact: `phases/phase-${String(number).padStart(2, "0")}-${slug}.json`,
    })
    current = null
  }

  for (const line of lines) {
    const match = line.match(PHASE_HEADING)
    if (match) {
      flush()
      current = { number: match[1], title: match[2], lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  flush()

  phases.sort((a, b) => a.number - b.number)
  return phases
}

export function dataCleanupSafetyRequired(task) {
  const value = String(task || "")
  return /(?:cleanup|clean up|dọn|don dep|dọn dẹp|xóa fixture|xoá fixture)/i.test(value) &&
    /(?:database|\bdb\b|fixture|seed|catalog|dữ liệu|du lieu|prisma|sql)/i.test(value)
}

export function deviceVerificationRequired(task) {
  return /(?:expo go|real device|physical device|manual mobile acceptance|test thiết bị|thiết bị thật|device verification)/i.test(String(task || ""))
}

export function runtimeVerificationRequired(task) {
  return /(?:runtime|smoke|e2e|integration|api thật|api real|endpoint|build|typecheck|lint|test|verify|xác minh|kiểm tra)/i.test(String(task || ""))
}

export function buildExecutionContract(task, inheritedDirty = null) {
  const phases = extractExplicitPhases(task)
  const dirty = inheritedDirty || {
    schemaVersion: 1,
    available: false,
    clean: false,
    entries: [],
    paths: [],
  }
  const dbCleanup = dataCleanupSafetyRequired(task)
  const device = deviceVerificationRequired(task)
  const runtime = runtimeVerificationRequired(task)

  return {
    schemaVersion: 1,
    taskHash: sha256(task),
    inheritedDirty: dirty,
    localEnvWriteExplicitlyAllowed: taskExplicitlyAllowsLocalEnvWrite(task),
    phases,
    gates: {
      source: true,
      runtime,
      dbClean: dbCleanup,
      device,
    },
    invariants: [
      "Preserve pre-existing dirty work. Never restore, checkout-away, clean, stash, or overwrite inherited changes unless the file is explicitly in the approved task write scope.",
      "Treat .env and .env.* as local runtime inputs. Do not modify them unless the user explicitly requested that exact local env mutation. Prefer .env.example/sample/template and docs for repository changes.",
      "Never claim cleanup success from frontend filtering or hidden presentation logic; prove cleanup at the data/source layer.",
      "Do not cross an explicit PHASE boundary without verified evidence for prerequisite work represented in the approved plan.",
    ],
    databaseCleanupGate: dbCleanup
      ? {
          requireProductionRefusal: true,
          requireDryRun: true,
          requireExactIds: true,
          requirePrePostCounts: true,
          requireDeterministicMarkers: true,
          requireCanonicalPreservation: true,
          requireIdempotencyProof: true,
          preferTransactionRollback: true,
        }
      : null,
  }
}

export function executionContractPrompt(contract) {
  if (!contract) return ""
  const dirtyPaths = Array.isArray(contract.inheritedDirty?.paths)
    ? contract.inheritedDirty.paths.slice(0, 120)
    : []
  const phaseSummary = Array.isArray(contract.phases)
    ? contract.phases.map((phase) => `PHASE ${phase.number}: ${phase.title} -> ${phase.artifact}`)
    : []
  const lines = [
    "## UES deterministic execution contract",
    "These constraints are controller-owned and must not be weakened by the model.",
    ...contract.invariants.map((item) => "- " + item),
    dirtyPaths.length
      ? "\nInherited dirty paths present before this UES run (preserve unless explicitly approved in task write scope):\n" +
        dirtyPaths.map((item) => "- " + item).join("\n")
      : "\nInherited dirty paths: none detected.",
    contract.localEnvWriteExplicitlyAllowed
      ? "\nLocal .env mutation: explicitly requested by the user for this task."
      : "\nLocal .env mutation: NOT authorized. Do not edit .env/.env.local/.env.development/etc.; use templates/docs or report NEEDS_USER_ENV.",
    phaseSummary.length
      ? "\nExplicit phase contract:\n" + phaseSummary.map((item) => "- " + item).join("\n")
      : "",
  ]

  if (contract.databaseCleanupGate) {
    lines.push(
      "",
      "Database cleanup gate:",
      "- refuse production targets;",
      "- perform a dry-run before deletion;",
      "- record exact candidate IDs and pre/post entity counts;",
      "- delete only fixtures linked to deterministic audited markers/source;",
      "- preserve canonical seed and user history;",
      "- prove idempotency with a second cleanup pass;",
      "- use transaction/rollback protection when the stack supports it.",
    )
  }

  lines.push(
    "",
    "Final verdict markers:",
    "- SOURCE_PASS only after source/task verification and integration gates pass.",
    contract.gates.runtime
      ? "- RUNTIME_PASS only with fresh executable/runtime evidence; otherwise RUNTIME_NOT_VERIFIED."
      : "- RUNTIME_NOT_REQUIRED.",
    contract.gates.dbClean
      ? "- DB_CLEAN_PASS only with data-layer cleanup/public-data evidence; otherwise DB_CLEAN_NOT_VERIFIED."
      : "- DB_CLEAN_NOT_REQUIRED.",
    contract.gates.device
      ? "- DEVICE_PASS only after a real requested device check; otherwise DEVICE_NOT_VERIFIED."
      : "- DEVICE_NOT_REQUIRED.",
  )

  return lines.filter(Boolean).join("\n")
}

export function buildFinalVerdictMatrix(task, evidence = {}) {
  const contract = evidence.contract || buildExecutionContract(task)
  const text = [
    evidence.primaryOutput,
    evidence.integrationOutput,
    evidence.visualOutput,
  ].filter(Boolean).join("\n")

  const sourcePass = evidence.primaryPass === true && evidence.integrationPass !== false
  const runtime = !contract.gates.runtime
    ? "RUNTIME_NOT_REQUIRED"
    : /\bRUNTIME_PASS\b/i.test(text)
      ? "RUNTIME_PASS"
      : "RUNTIME_NOT_VERIFIED"
  const dbClean = !contract.gates.dbClean
    ? "DB_CLEAN_NOT_REQUIRED"
    : /\bDB_CLEAN_PASS\b/i.test(text)
      ? "DB_CLEAN_PASS"
      : "DB_CLEAN_NOT_VERIFIED"
  const device = !contract.gates.device
    ? "DEVICE_NOT_REQUIRED"
    : /\bDEVICE_PASS\b/i.test(text)
      ? "DEVICE_PASS"
      : "DEVICE_NOT_VERIFIED"

  const source = sourcePass ? "SOURCE_PASS" : "SOURCE_NOT_VERIFIED"
  const requiredPass =
    sourcePass &&
    (!contract.gates.runtime || runtime === "RUNTIME_PASS") &&
    (!contract.gates.dbClean || dbClean === "DB_CLEAN_PASS") &&
    (!contract.gates.device || device === "DEVICE_PASS")

  return {
    schemaVersion: 1,
    source,
    runtime,
    dbClean,
    device,
    final: requiredPass
      ? "PASS"
      : sourcePass && device === "DEVICE_NOT_VERIFIED"
        ? "SOURCE_RUNTIME_PASS_DEVICE_NOT_VERIFIED"
        : "PARTIAL_OR_NOT_VERIFIED",
  }
}

export function phaseArtifactPayloads(contract) {
  return (contract?.phases || []).map((phase) => ({
    file: phase.artifact,
    value: {
      schemaVersion: 1,
      phase: phase.number,
      title: phase.title,
      sourceBodyHash: phase.bodyHash,
      sourceBody: phase.body,
      status: "PENDING",
      evidence: [],
    },
  }))
}
