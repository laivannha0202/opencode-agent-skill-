import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { routeSkills } from "../global-config/plugins/ues-router/router.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const suite = JSON.parse(await readFile(path.join(root, "evals", "router-triggers.json"), "utf8"))
const failures = []
let positives = 0
let positiveHits = 0
let negatives = 0
let negativeHits = 0

for (const item of suite.cases || []) {
  const routed = routeSkills(item.prompt, item.maxSkills || 6)

  for (const id of item.include || []) {
    positives += 1
    if (routed.includes(id)) positiveHits += 1
    else failures.push(item.id + ": missing required route " + id + " from [" + routed.join(", ") + "]")
  }

  for (const id of item.exclude || []) {
    negatives += 1
    if (!routed.includes(id)) negativeHits += 1
    else failures.push(item.id + ": unexpected route " + id + " in [" + routed.join(", ") + "]")
  }
}

const recall = positives ? positiveHits / positives : 1
const specificity = negatives ? negativeHits / negatives : 1

if (failures.length) {
  console.error("Router trigger evaluation failed:")
  for (const failure of failures) console.error("- " + failure)
  console.error("Recall: " + (recall * 100).toFixed(1) + "%")
  console.error("Negative guard accuracy: " + (specificity * 100).toFixed(1) + "%")
  process.exit(1)
}

console.log(
  "Validated " + suite.cases.length + " router cases: " +
  positiveHits + "/" + positives + " required routes and " +
  negativeHits + "/" + negatives + " negative guards passed.",
)
