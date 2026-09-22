#!/usr/bin/env node
import { readFile } from "node:fs/promises"
import path from "node:path"
import { compareEvalSummaries } from "../lib/eval-ablation.mjs"

const args = process.argv.slice(2)

function option(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}

function positional() {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      if (["--pass-rate-tolerance", "--min-initial-reduction", "--max-token-ratio", "--max-duration-ratio", "--min-cacheable-ratio", "--min-evidence-reuse-ratio"].includes(args[index])) index += 1
      continue
    }
    values.push(args[index])
  }
  return values
}

const [referenceFile, candidateFile] = positional()
if (!referenceFile || !candidateFile) {
  console.error("Usage: node scripts/eval-ablation.mjs <reference-summary.json> <candidate-summary.json> [--require-gate] [--min-initial-reduction 0.10]")
  process.exit(2)
}

const [reference, candidate] = await Promise.all([
  readFile(path.resolve(referenceFile), "utf8").then(JSON.parse),
  readFile(path.resolve(candidateFile), "utf8").then(JSON.parse),
])

const report = compareEvalSummaries(reference, candidate, {
  passRateTolerance: Number(option("--pass-rate-tolerance", "0")),
  minInitialInputReduction: Number(option("--min-initial-reduction", "0.10")),
  maxTotalTokenRatio: Number(option("--max-token-ratio", "1.05")),
  maxDurationRatio: Number(option("--max-duration-ratio", "1.10")),
  minCacheableRatio: option("--min-cacheable-ratio", null) == null ? null : Number(option("--min-cacheable-ratio", null)),
  minEvidenceReuseRatio: option("--min-evidence-reuse-ratio", null) == null ? null : Number(option("--min-evidence-reuse-ratio", null)),
})

console.log(JSON.stringify(report, null, 2))
if (args.includes("--require-gate") && !report.gateEligible) process.exitCode = 1
