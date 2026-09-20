#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { summarizeEvalResults } from "../lib/eval-report.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)

function argValue(name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
function has(name) { return args.includes(name) }
function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const model = argValue("--model", process.env.UES_EVAL_MODEL)
const variant = argValue("--variant", process.env.UES_EVAL_VARIANT)
const trials = Math.min(positiveInt(argValue("--trials"), 3), 10)
const auth = argValue("--auth", "current")
const outputDir = path.resolve(argValue("--output-dir", path.join(process.cwd(), ".ues-evals", "matrix")))
const timeoutMs = positiveInt(argValue("--timeout-ms"), 20 * 60_000)
const idleTimeoutMs = positiveInt(argValue("--idle-timeout-ms"), 5 * 60_000)
const heartbeatMs = positiveInt(argValue("--heartbeat-ms"), 30_000)
const onlyLong = has("--long-only")
const onlyLive = has("--standard-only")
const onlyPolyglot = has("--polyglot-only")
const withoutPolyglot = has("--without-polyglot")

if (!model) {
  console.error("Usage: node scripts/eval-matrix.mjs --model provider/model [--trials 3] [--auth current|env-only] [--variant high] [--without-polyglot|--long-only|--standard-only|--polyglot-only]")
  process.exit(2)
}
const exclusiveCount = [onlyLong, onlyLive, onlyPolyglot].filter(Boolean).length
if (exclusiveCount > 1) {
  console.error("--long-only, --standard-only and --polyglot-only are mutually exclusive")
  process.exit(2)
}

await mkdir(outputDir, { recursive: true })
const suites = onlyLong
  ? ["long"]
  : onlyLive
    ? ["live"]
    : onlyPolyglot
      ? ["polyglot"]
      : withoutPolyglot
        ? ["long", "live"]
        : ["long", "live", "polyglot"]
const startedAt = new Date().toISOString()
const before = new Set(await readdir(outputDir).catch(() => []))

for (const suite of suites) {
  const command = [
    path.join(root, "scripts", "eval-live.mjs"),
    "--suite", suite,
    "--model", model,
    "--mode", "both",
    "--trials", String(trials),
    "--auth", auth,
    "--output-dir", outputDir,
    "--timeout-ms", String(timeoutMs),
    "--idle-timeout-ms", String(idleTimeoutMs),
    "--heartbeat-ms", String(heartbeatMs),
  ]
  if (variant) command.push("--variant", variant)

  console.log("\n[matrix] Running " + suite + " suite: " + trials + " trial(s) per task per mode")
  const result = spawnSync(process.execPath, command, { cwd: process.cwd(), stdio: "inherit" })
  if ((result.status ?? 1) !== 0) {
    console.error("[matrix] " + suite + " suite failed with exit code " + (result.status ?? 1))
    process.exit(result.status ?? 1)
  }
}

const after = await readdir(outputDir)
const created = after
  .filter((name) => name.endsWith(".json") && !before.has(name))
  .sort()

const runs = []
const results = []
for (const name of created) {
  const file = path.join(outputDir, name)
  const payload = JSON.parse(await readFile(file, "utf8"))
  if (!suites.includes(payload.suite) || payload.model !== model) continue
  runs.push({
    file: name,
    suite: payload.suite,
    suiteVersion: payload.suiteVersion,
    trials: payload.trials,
    results: payload.results?.length || 0,
  })
  results.push(...(payload.results || []))
}

const expectedPerMode = suites.reduce((sum, suite) => {
  if (suite === "long") return sum + 5 * trials
  if (suite === "live") return sum + 20 * trials
  if (suite === "polyglot") return sum + 8 * trials
  return sum
}, 0)
const baselineCount = results.filter((item) => item.mode === "baseline").length
const uesCount = results.filter((item) => item.mode === "ues").length
const coverageComplete = baselineCount === expectedPerMode && uesCount === expectedPerMode
const summary = summarizeEvalResults(results)

const report = {
  schemaVersion: 1,
  kind: "ues-benchmark-matrix",
  startedAt,
  finishedAt: new Date().toISOString(),
  model,
  variant: variant || null,
  trials,
  auth,
  suites,
  expectedPerMode,
  baselineCount,
  uesCount,
  coverageComplete,
  runs,
  summary,
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-")
const reportFile = path.join(outputDir, "matrix-summary-" + stamp + ".json")
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", "utf8")

console.log("\n[matrix] Benchmark matrix summary")
console.log("- baseline: " + (summary.modes.baseline?.passed || 0) + "/" + (summary.modes.baseline?.total || 0))
console.log("- UES: " + (summary.modes.ues?.passed || 0) + "/" + (summary.modes.ues?.total || 0))
console.log("- pass-rate delta: " + (summary.passRateDelta == null ? "n/a" : (summary.passRateDelta * 100).toFixed(1) + " pp"))
console.log("- coverage: " + (coverageComplete ? "COMPLETE" : "INCOMPLETE"))
console.log("- report: " + reportFile)

if (!coverageComplete) process.exitCode = 1
