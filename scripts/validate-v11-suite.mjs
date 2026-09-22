import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const file = path.join(root, "evals", "v11", "tasks.json")
const suite = JSON.parse(await readFile(file, "utf8"))
const errors = []
const ids = new Set()
const categories = new Set()

if (!Array.isArray(suite.tasks) || suite.tasks.length < 10) errors.push("V11 suite must contain at least 10 tasks")

for (const task of suite.tasks || []) {
  if (!task.id || ids.has(task.id)) errors.push("missing/duplicate id: " + (task.id || "<missing>"))
  ids.add(task.id)
  if (!task.category) errors.push((task.id || "<missing>") + ": missing category")
  categories.add(task.category)
  if (!task.objective || task.objective.length < 30) errors.push((task.id || "<missing>") + ": objective is too weak")
  if (!Array.isArray(task.requiredFiles) || !task.requiredFiles.length) errors.push((task.id || "<missing>") + ": requiredFiles missing")
  for (const relative of task.requiredFiles || []) {
    if (!existsSync(path.join(root, relative))) errors.push((task.id || "<missing>") + ": missing required file " + relative)
  }
}

for (const category of ["context","routing","visual","browser","workflow","sidecar"]) {
  if (!categories.has(category)) errors.push("V11 suite missing category: " + category)
}

if (errors.length) {
  console.error("V11 suite validation failed:")
  for (const error of errors) console.error("- " + error)
  process.exit(1)
}

console.log("Validated " + suite.tasks.length + " V11 contract tasks across " + categories.size + " categories.")
