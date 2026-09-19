import { existsSync } from "node:fs"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { summarizeEvalResults } from "../lib/eval-report.mjs"

const args = process.argv.slice(2)
let files = []

if (args.length) {
  for (const value of args) {
    const resolved = path.resolve(value)
    if (!existsSync(resolved)) {
      console.error("Eval result path not found: " + resolved)
      process.exit(2)
    }
    if (resolved.endsWith(".json")) files.push(resolved)
    else {
      const entries = await readdir(resolved)
      files.push(...entries.filter((name) => name.endsWith(".json")).map((name) => path.join(resolved, name)))
    }
  }
} else {
  const dir = path.resolve(".ues-evals")
  if (existsSync(dir)) {
    const entries = await readdir(dir)
    files = entries.filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name))
  }
}

if (files.length === 0) {
  console.error("No eval result JSON files found. Pass files/directories or run live evals first.")
  process.exit(2)
}

const runs = []
const results = []
for (const file of [...new Set(files)].sort()) {
  const parsed = JSON.parse(await readFile(file, "utf8"))
  runs.push({ file, model: parsed.model, variant: parsed.variant, trials: parsed.trials })
  results.push(...(parsed.results || []))
}

const summary = summarizeEvalResults(results)
console.log(JSON.stringify({
  schemaVersion: 1,
  files: runs,
  totalResults: results.length,
  ...summary,
}, null, 2))
