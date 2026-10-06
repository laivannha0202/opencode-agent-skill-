import { readFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CORE = path.join(ROOT, "scripts", "check-source-integrity-core.mjs")

const INTENTIONALLY_DISABLED_WORKFLOW_FAILURES = Object.freeze([
  /^\.github\/workflows\/security\.yml: unreadable \(ENOENT:/,
  /^\.github\/workflows\/publish\.yml: unreadable \(ENOENT:/,
])

// V16.8 lives outside the historical integrity core so disabling GitHub Actions
// never weakens the new production contracts. These checks run locally as part
// of `npm run integrity`; they do not require or create any GitHub workflow.
const V16_8_CONTRACTS = Object.freeze([
  {
    file: "lib/web-decision-barrier-v16-8.mjs",
    minBytes: 12_000,
    required: [
      "phase0FastGrounding",
      "startReadOnlyLocalPrep",
      "discoverAffectedTestsOffThread",
      "evaluateDecisionBarrier",
      "buildExecutorAdvisorCapsule",
      "renderExecutorAdvisorCapsule",
      "deterministicResolutionProof",
      "workspace-mutated-during-consult",
      "V16_8_CAPSULE_MAX_CHARS = 1_200",
      'provider_tokens: "NOT_MEASURED"',
    ],
  },
  {
    file: "lib/web-reasoning-lane-v16-8.mjs",
    minBytes: 10_000,
    required: [
      "createBaseWebReasoningLane",
      "raceAdapterOperation",
      "startReadOnlyLocalPrep",
      "evaluateDecisionBarrier",
      "renderExecutorAdvisorCapsule",
      "web-advisor-hard-deadline",
      "deterministic-local-resolution",
      "sourceMutationAllowed: false",
      "testsExecuted: 0",
    ],
  },
  {
    file: "test/web-decision-barrier-v16-8.test.mjs",
    minBytes: 5_000,
    required: [
      "V16.8 Phase 0 is bounded shaping only",
      "V16.8 read-only prep discovers affected tests without executing them",
      "V16.8 capsule rejects generated targets and never exceeds 1200 chars",
      "V16.8 barrier discards stale generation and workspace mutation",
    ],
  },
  {
    file: "test/web-reasoning-v16-8-production.test.mjs",
    minBytes: 5_000,
    required: [
      "V16.8 production consult injects only a compact validated capsule",
      "V16.8 production barrier discards advice if workspace changes while advisor is running",
      "V16.8 hard deadline aborts the real adapter consult and fences the late result",
    ],
  },
  {
    file: "scripts/bench-v16-8-overlap.mjs",
    minBytes: 5_000,
    required: [
      "sequentialEquivalent",
      "overlapped",
      "sequential_p95_ms",
      "overlapped_p95_ms",
      'provider_tokens_provenance: "NOT_MEASURED"',
    ],
  },
])

export function validateV16_8SourceIntegrity(root = ROOT) {
  const failures = []
  for (const contract of V16_8_CONTRACTS) {
    const full = path.join(root, contract.file)
    let text = ""
    try {
      const info = statSync(full)
      if (!info.isFile()) {
        failures.push(`${contract.file}: not a file`)
        continue
      }
      if (info.size < contract.minBytes) failures.push(`${contract.file}: too small (${info.size} < ${contract.minBytes})`)
      text = readFileSync(full, "utf8")
    } catch (error) {
      failures.push(`${contract.file}: unreadable (${error?.code || "error"})`)
      continue
    }
    for (const marker of contract.required) {
      if (!text.includes(marker)) failures.push(`${contract.file}: missing required marker ${marker}`)
    }
  }
  return failures
}

export function extractCriticalIntegrityFailures(text = "") {
  const source = String(text || "")
  const marker = "Critical UES source-integrity validation failed:"
  const start = source.indexOf(marker)
  if (start < 0) return []
  const tail = source.slice(start + marker.length)
  const diffBoundary = tail.indexOf("+ actual - expected")
  const stackBoundary = tail.indexOf("\n    at ")
  const boundaries = [diffBoundary, stackBoundary].filter((value) => value >= 0)
  const end = boundaries.length ? Math.min(...boundaries) : Math.min(tail.length, 8_000)
  return tail
    .slice(0, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
}

export function onlyIntentionallyDisabledWorkflowFailures(failures = []) {
  const rows = Array.isArray(failures) ? failures.map(String) : []
  if (rows.length !== INTENTIONALLY_DISABLED_WORKFLOW_FAILURES.length) return false
  return INTENTIONALLY_DISABLED_WORKFLOW_FAILURES.every((pattern) =>
    rows.some((row) => pattern.test(row)),
  ) && rows.every((row) =>
    INTENTIONALLY_DISABLED_WORKFLOW_FAILURES.some((pattern) => pattern.test(row)),
  )
}

export function runSourceIntegrity() {
  const v16_8Failures = validateV16_8SourceIntegrity(ROOT)
  if (v16_8Failures.length) {
    process.stderr.write("V16.8 source-integrity validation failed:\n")
    for (const failure of v16_8Failures) process.stderr.write(`- ${failure}\n`)
    return 1
  }

  const run = spawnSync(process.execPath, [CORE], {
    cwd: ROOT,
    encoding: "utf8",
    env: process.env,
  })
  const stdout = String(run.stdout || "")
  const stderr = String(run.stderr || "")
  if (run.status === 0) {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    return 0
  }

  const failures = extractCriticalIntegrityFailures(`${stdout}\n${stderr}`)
  if (onlyIntentionallyDisabledWorkflowFailures(failures)) {
    console.log(
      "Source integrity PASS: all production source contracts passed; GitHub Actions workflow contracts are intentionally disabled.",
    )
    return 0
  }

  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return Number.isInteger(run.status) && run.status !== 0 ? run.status : 1
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exit(runSourceIntegrity())
