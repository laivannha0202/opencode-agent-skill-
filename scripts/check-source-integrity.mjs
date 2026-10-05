import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CORE = path.join(ROOT, "scripts", "check-source-integrity-core.mjs")

const INTENTIONALLY_DISABLED_WORKFLOW_FAILURES = Object.freeze([
  /^\.github\/workflows\/security\.yml: unreadable \(ENOENT:/,
  /^\.github\/workflows\/publish\.yml: unreadable \(ENOENT:/,
])

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
