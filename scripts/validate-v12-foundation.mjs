#!/usr/bin/env node
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const errors = []
const required = [
  "lib/model-performance.mjs","lib/context-quality.mjs","lib/work-plan-scope.mjs",
  "lib/decision-policy.mjs","lib/repo-scale-fixture.mjs","evals/repo-scale/tasks.json",
  "scripts/validate-repo-scale-suite.mjs",
]
for (const relative of required) if (!existsSync(path.join(root, relative))) errors.push("missing V12 foundation file: " + relative)
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
for (const script of ["evals:v12:validate","evals:repo-scale:validate"]) if (!pkg.scripts?.[script]) errors.push("package.json missing script " + script)
const tasks = JSON.parse(await readFile(path.join(root, "evals", "repo-scale", "tasks.json"), "utf8"))
if ((tasks.tasks || []).length < 4) errors.push("V12 repo-scale suite needs at least 4 contract tasks")
if (errors.length) {
  console.error("V12 foundation validation failed:")
  for (const error of errors) console.error("- " + error)
  process.exit(1)
}
console.log("Validated V12 weak-model intelligence foundation files and repo-scale contracts.")
